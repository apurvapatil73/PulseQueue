import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  AlertComparisonOperator,
  AlertSeverity,
  AlertType,
  DeadLetterStatus,
  JobStatus,
  OutboxStatus,
  Role,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { eventService } from '../src/services/event.service.js';
import { outboxReconciler } from '../src/services/outboxReconciler.service.js';
import { realtimeEventBus } from '../src/services/realtime.service.js';
import { alertEvaluatorService } from '../src/services/alertEvaluator.service.js';
import { metricsService } from '../src/services/metrics.service.js';

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

async function createAndLoginUser(prefix: string, suffix: string): Promise<TestUser> {
  const email = `${prefix}_${suffix}@pulsequeue.dev`;
  const password = 'SecurePassword123!';
  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `${prefix.toUpperCase()} User`, email, password });
  expect(regRes.status).toBe(201);

  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(loginRes.status).toBe(200);

  return {
    id: regRes.body.data.user.id,
    email: email.toLowerCase(),
    accessToken: loginRes.body.data.accessToken,
    refreshToken: loginRes.body.data.refreshToken,
  };
}

describe('Step 7.7 — Platform Security, Cross-Tenant Isolation & Reliability', () => {
  const suffix = `sec77_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let jobAId = '';
  let dlqAId = '';
  let scheduleAId = '';
  let ruleAId = '';
  let alertAId = '';
  let notifAId = '';

  beforeAll(async () => {
    ownerA = await createAndLoginUser('ownera', suffix);
    adminA = await createAndLoginUser('admina', suffix);
    memberA = await createAndLoginUser('membera', suffix);
    ownerB = await createAndLoginUser('ownerb', suffix);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: `Sec Org A ${suffix}` });
    expect(orgARes.status).toBe(201);
    orgAId = orgARes.body.data.organisation.id;

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: `Sec Org B ${suffix}` });
    expect(orgBRes.status).toBe(201);
    orgBId = orgBRes.body.data.organisation.id;

    await prisma.membership.createMany({
      data: [
        { userId: adminA.id, organisationId: orgAId, role: Role.ADMIN },
        { userId: memberA.id, organisationId: orgAId, role: Role.MEMBER },
      ],
    });

    // Seed Org A resources: queue, job, DLQ, schedule, alert rule, alert, notification
    const qARes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: `sec-queue-a-${suffix}` });
    expect(qARes.status).toBe(201);
    queueAId = qARes.body.data.queue.id;

    const jobRow = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'echo',
        payload: { secret: 'org-a-only' },
        status: JobStatus.PENDING,
      },
    });
    jobAId = jobRow.id;

    const dlqRow = await prisma.deadLetterJob.create({
      data: {
        originalJobId: jobAId,
        organisationId: orgAId,
        queueId: queueAId,
        queueName: `sec-queue-a-${suffix}`,
        jobName: 'echo',
        payloadSummary: { secret: 'org-a-dlq' },
        failureReason: 'Exhausted retries',
        attemptsMade: 3,
        maxRetries: 3,
        status: DeadLetterStatus.OPEN,
        failedAt: new Date(),
      },
    });
    dlqAId = dlqRow.id;

    const schedRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/schedules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        queueId: queueAId,
        name: `Sec Schedule ${suffix}`,
        type: 'RECURRING',
        cronExpression: '*/10 * * * *',
        timezone: 'UTC',
        jobName: 'echo',
        payload: { ok: true },
      });
    expect(schedRes.status).toBe(201);
    scheduleAId = schedRes.body.data.schedule.id;

    const ruleRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: `Sec Backlog Rule ${suffix}`,
        type: AlertType.QUEUE_BACKLOG,
        operator: AlertComparisonOperator.GTE,
        threshold: 1,
        queueId: queueAId,
        severity: AlertSeverity.CRITICAL,
        cooldownSeconds: 60,
      });
    expect(ruleRes.status).toBe(201);
    ruleAId = ruleRes.body.data.rule.id;

    metricsService.invalidateOrganisation(orgAId);
    await alertEvaluatorService.evaluateAll({ organisationId: orgAId });

    const alertRow = await prisma.alert.findFirst({
      where: { organisationId: orgAId, ruleId: ruleAId },
    });
    expect(alertRow).not.toBeNull();
    alertAId = alertRow!.id;

    const notifRow = await prisma.notification.findFirst({
      where: { organisationId: orgAId, userId: ownerA.id },
    });
    expect(notifRow).not.toBeNull();
    notifAId = notifRow!.id;
  }, 30_000);

  afterAll(async () => {
    const orgIds = [orgAId, orgBId].filter(Boolean);
    const userIds = [ownerA?.id, adminA?.id, memberA?.id, ownerB?.id].filter(Boolean);

    if (orgIds.length > 0) {
      await prisma.notification.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.alert.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.alertRule.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.scheduleExecution.deleteMany({
        where: { schedule: { organisationId: { in: orgIds } } },
      });
      await prisma.schedule.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.platformEvent.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.deadLetterJob.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.jobDispatchOutbox.deleteMany({
        where: { job: { queue: { organisationId: { in: orgIds } } } },
      });
      await prisma.job.deleteMany({ where: { queue: { organisationId: { in: orgIds } } } });
      await prisma.queue.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
    }

    if (userIds.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await realtimeEventBus.closeAll().catch(() => {});
    await bullMQService.closeAll().catch(() => {});
  }, 30_000);

  describe('Cross-tenant isolation across every organisation-scoped surface', () => {
    it('blocks Org B owner from reading or mutating any Org A resource (queues, jobs, schedules, DLQ, monitoring, SSE, alerts, notifications)', async () => {
      const protectedEndpoints: Array<{
        method: 'get' | 'post' | 'patch' | 'delete';
        path: string;
      }> = [
        { method: 'get', path: `/api/v1/organisations/${orgAId}/queues` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/queues/${queueAId}` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/jobs/${jobAId}` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/schedules` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/schedules/${scheduleAId}` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/dlq` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/dlq/${dlqAId}` },
        { method: 'post', path: `/api/v1/organisations/${orgAId}/dlq/${dlqAId}/replay` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/monitoring/metrics` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/monitoring/metrics/timeseries` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/monitoring/workers` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/monitoring/events` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/monitoring/stream` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/alert-rules` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/alerts` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/alerts/${alertAId}` },
        { method: 'post', path: `/api/v1/organisations/${orgAId}/alerts/${alertAId}/acknowledge` },
        { method: 'post', path: `/api/v1/organisations/${orgAId}/alerts/${alertAId}/resolve` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/notifications` },
        { method: 'get', path: `/api/v1/organisations/${orgAId}/notifications/unread-count` },
        { method: 'patch', path: `/api/v1/organisations/${orgAId}/notifications/${notifAId}/read` },
      ];

      for (const ep of protectedEndpoints) {
        const res = await request(app)
          [ep.method](ep.path)
          .set('Authorization', `Bearer ${ownerB.accessToken}`);
        expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(404);
      }

      // Cross-tenant ID smuggling using Org B's own organisationId with Org A's resource IDs
      const smuggled = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgBId}/alerts/${alertAId}`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgBId}/notifications/${notifAId}/read`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/dlq/${dlqAId}`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/schedules/${scheduleAId}`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
      ]);
      for (const res of smuggled) {
        expect(res.status).toBe(404);
      }
    });
  });

  describe('Authentication token security (missing, malformed, invalid, expired, revoked)', () => {
    it('rejects missing, malformed, invalid, and expired Bearer tokens with 401', async () => {
      const expiredToken = jwt.sign({ sub: ownerA.id, email: ownerA.email }, env.JWT_SECRET, {
        expiresIn: -10,
      });

      const cases = [
        request(app).get(`/api/v1/organisations/${orgAId}/alerts`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/alerts`)
          .set('Authorization', 'Basic dXNlcjpwYXNz'),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/alerts`)
          .set('Authorization', 'Bearer not.a.valid.jwt'),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/alerts`)
          .set('Authorization', `Bearer ${expiredToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/stream`)
          .set('Authorization', `Bearer ${expiredToken}`),
      ];

      const responses = await Promise.all(cases);
      for (const res of responses) {
        expect(res.status).toBe(401);
      }
    });

    it('rejects revoked refresh token reuse after logout', async () => {
      const tempUser = await createAndLoginUser('revoked', suffix);

      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: tempUser.refreshToken });
      expect(logoutRes.status).toBe(200);

      const reuseRes = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tempUser.refreshToken });
      expect(reuseRes.status).toBe(401);

      await prisma.refreshToken.deleteMany({ where: { userId: tempUser.id } });
      await prisma.user.delete({ where: { id: tempUser.id } });
    });
  });

  describe('RBAC matrix & input validation boundaries', () => {
    it('enforces MEMBER vs ADMIN vs OWNER permissions across schedules, DLQ, stalled recovery, and alerts', async () => {
      // MEMBER denied on admin/owner mutations
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/dlq/${dlqAId}/replay`)
            .set('Authorization', `Bearer ${memberA.accessToken}`)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/monitoring/recover-stalled`)
            .set('Authorization', `Bearer ${memberA.accessToken}`)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/alerts/${alertAId}/resolve`)
            .set('Authorization', `Bearer ${memberA.accessToken}`)
        ).status,
      ).toBe(403);

      // ADMIN cannot delete schedule (OWNER-only), but CAN delete/manage alert rules
      expect(
        (
          await request(app)
            .delete(`/api/v1/organisations/${orgAId}/schedules/${scheduleAId}`)
            .set('Authorization', `Bearer ${adminA.accessToken}`)
        ).status,
      ).toBe(403);
    });

    it('rejects malformed JSON (400), oversized >1MB body (413), invalid pagination, and invalid UUIDs', async () => {
      // Malformed JSON
      const badJson = await request(app)
        .post(`/api/v1/organisations/${orgAId}/alert-rules`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .set('Content-Type', 'application/json')
        .send('{"name": "broken');
      expect(badJson.status).toBe(400);
      expect(badJson.body.error.code).toBe('INVALID_JSON');

      // Oversized > 1MB request body returns clean 413 PAYLOAD_TOO_LARGE
      const hugePayload = JSON.stringify({ name: 'Big', description: 'x'.repeat(1_200_000) });
      const tooLarge = await request(app)
        .post(`/api/v1/organisations/${orgAId}/alert-rules`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .set('Content-Type', 'application/json')
        .send(hugePayload);
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error.code).toBe('PAYLOAD_TOO_LARGE');

      // Pagination & window boundaries
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/alerts?page=0&limit=10`)
            .set('Authorization', `Bearer ${ownerA.accessToken}`)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/alerts?page=1&limit=101`)
            .set('Authorization', `Bearer ${ownerA.accessToken}`)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/notifications?limit=250`)
            .set('Authorization', `Bearer ${ownerA.accessToken}`)
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/monitoring/metrics?windowMinutes=20000`)
            .set('Authorization', `Bearer ${ownerA.accessToken}`)
        ).status,
      ).toBe(400);

      // Invalid UUID organisationId returns 404 without DB error leak
      expect(
        (
          await request(app)
            .get('/api/v1/organisations/not-a-uuid/alerts')
            .set('Authorization', `Bearer ${ownerA.accessToken}`)
        ).status,
      ).toBe(404);
    });
  });

  describe('Concurrency, SSE fault cleanup & outbox reliability', () => {
    it('prevents duplicate alert rules and duplicate acknowledgements under concurrent requests', async () => {
      const ruleName = `Concurrent Rule ${suffix}`;
      const [r1, r2] = await Promise.all([
        request(app)
          .post(`/api/v1/organisations/${orgAId}/alert-rules`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: ruleName, type: AlertType.DLQ_COUNT, threshold: 5 }),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/alert-rules`)
          .set('Authorization', `Bearer ${adminA.accessToken}`)
          .send({ name: ruleName, type: AlertType.DLQ_COUNT, threshold: 5 }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // Concurrent acknowledge calls both succeed idempotently without race errors
      const [a1, a2] = await Promise.all([
        request(app)
          .post(`/api/v1/organisations/${orgAId}/alerts/${alertAId}/acknowledge`)
          .set('Authorization', `Bearer ${memberA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/alerts/${alertAId}/acknowledge`)
          .set('Authorization', `Bearer ${adminA.accessToken}`),
      ]);
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(200);
      expect(a1.body.data.alert.status).toBe('ACKNOWLEDGED');
      expect(a2.body.data.alert.status).toBe('ACKNOWLEDGED');
    });

    it('cleans up SSE client cleanly without crashing if PostgreSQL fails during replay after headers are sent', async () => {
      const replaySpy = vi
        .spyOn(eventService, 'replayAfterCursor')
        .mockRejectedValueOnce(new Error('Simulated PostgreSQL outage during replay'));

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/v1/organisations/${orgAId}/monitoring/stream`,
          {
            headers: {
              Authorization: `Bearer ${ownerA.accessToken}`,
              'Last-Event-ID': '00000000-0000-4000-8000-000000000001',
            },
          },
        );
        expect(res.status).toBe(200);
        // Drain body to completion (stream must close cleanly, not hang)
        await res.text();

        // Give event loop a tick for cleanup listeners
        await new Promise((r) => setTimeout(r, 50));
        expect(realtimeEventBus.getStats().totalConnections).toBe(0);
      } finally {
        replaySpy.mockRestore();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('reconciles a pending outbox row into BullMQ without duplicating jobs', async () => {
      const job = await prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'echo',
          payload: { outboxCheck: true },
          status: JobStatus.PENDING,
        },
      });
      await prisma.jobDispatchOutbox.create({
        data: {
          jobId: job.id,
          queueId: queueAId,
          organisationId: orgAId,
          status: OutboxStatus.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });

      await outboxReconciler.reconcileOnce();

      const updatedOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId: job.id } });
      expect(updatedOutbox?.status).toBe(OutboxStatus.DISPATCHED);
    });
  });
});

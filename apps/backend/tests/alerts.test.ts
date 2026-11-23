import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import {
  AlertComparisonOperator,
  AlertSeverity,
  AlertStatus,
  AlertType,
  DeadLetterStatus,
  JobStatus,
  PlatformEventType,
  WorkerHealthStatus,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { alertEvaluatorService, compareMetric } from '../src/services/alertEvaluator.service.js';
import { realtimeEventBus } from '../src/services/realtime.service.js';
import { metricsService } from '../src/services/metrics.service.js';

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
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
  };
}

describe('Step 7.6 — Alerting & In-App Notification System', () => {
  const suffix = `alert76_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  const queueAName = `alert-q-a-${Date.now()}`;
  const queueBName = `alert-q-b-${Date.now()}`;

  beforeAll(async () => {
    ownerA = await createAndLoginUser('ownera', suffix);
    memberA = await createAndLoginUser('membera', suffix);
    ownerB = await createAndLoginUser('ownerb', suffix);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: `Alert Org A ${suffix}` });
    expect(orgARes.status).toBe(201);
    orgAId = orgARes.body.data.organisation.id;

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: `Alert Org B ${suffix}` });
    expect(orgBRes.status).toBe(201);
    orgBId = orgBRes.body.data.organisation.id;

    // Add memberA to orgA
    await prisma.membership.create({
      data: {
        userId: memberA.id,
        organisationId: orgAId,
        role: 'MEMBER',
      },
    });

    // Create queues
    const qARes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: queueAName });
    expect(qARes.status).toBe(201);
    queueAId = qARes.body.data.queue.id;

    const qBRes = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: queueBName });
    expect(qBRes.status).toBe(201);
    queueBId = qBRes.body.data.queue.id;
  }, 30_000);

  afterAll(async () => {
    const orgIds = [orgAId, orgBId].filter(Boolean);
    const userIds = [ownerA?.id, memberA?.id, ownerB?.id].filter(Boolean);

    if (orgIds.length > 0) {
      await prisma.notification.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.alert.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.alertRule.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.platformEvent.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.deadLetterJob.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.job.deleteMany({ where: { queue: { organisationId: { in: orgIds } } } });
      await prisma.queue.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
    }

    await prisma.workerHeartbeat.deleteMany({
      where: { workerInstanceId: { startsWith: `test-alert-worker-${suffix}` } },
    });

    if (userIds.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await bullMQService.closeAll().catch(() => {});
  }, 30_000);

  it('evaluates comparison operators accurately', () => {
    expect(compareMetric(10, AlertComparisonOperator.GT, 10)).toBe(false);
    expect(compareMetric(10.1, AlertComparisonOperator.GT, 10)).toBe(true);
    expect(compareMetric(10, AlertComparisonOperator.GTE, 10)).toBe(true);
    expect(compareMetric(9.9, AlertComparisonOperator.GTE, 10)).toBe(false);
    expect(compareMetric(5, AlertComparisonOperator.LT, 5)).toBe(false);
    expect(compareMetric(4.9, AlertComparisonOperator.LT, 5)).toBe(true);
    expect(compareMetric(5, AlertComparisonOperator.LTE, 5)).toBe(true);
    expect(compareMetric(5.1, AlertComparisonOperator.LTE, 5)).toBe(false);
  });

  it('validates alert rule input and enforces RBAC + queue ownership', async () => {
    // MEMBER cannot create rule
    const memberCreate = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({
        name: 'Member Blocked Rule',
        type: AlertType.QUEUE_BACKLOG,
        threshold: 5,
      });
    expect(memberCreate.status).toBe(403);

    // Invalid percentage > 100
    const badPct = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Bad Failure Rate',
        type: AlertType.JOB_FAILURE_RATE,
        threshold: 150,
      });
    expect(badPct.status).toBe(400);

    // Queue scope rejected for WORKER_STALE
    const badScope = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Bad Worker Scope',
        type: AlertType.WORKER_STALE,
        threshold: 1,
        queueId: queueAId,
      });
    expect(badScope.status).toBe(400);

    // Cross-org queue rejected
    const crossOrgQueue = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Cross Org Queue Rule',
        type: AlertType.QUEUE_BACKLOG,
        threshold: 1,
        queueId: queueBId,
      });
    expect(crossOrgQueue.status).toBe(404);

    // Valid rule creation by OWNER
    const created = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Backlog High',
        description: 'Fires when pending jobs >= 2',
        type: AlertType.QUEUE_BACKLOG,
        operator: AlertComparisonOperator.GTE,
        threshold: 2,
        windowMinutes: 15,
        cooldownSeconds: 120,
        queueId: queueAId,
        severity: AlertSeverity.CRITICAL,
      });
    expect(created.status).toBe(201);
    const ruleId = created.body.data.rule.id;
    expect(created.body.data.rule.queueName).toBe(queueAName);

    // Duplicate rule name returns 409
    const dup = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Backlog High',
        type: AlertType.QUEUE_BACKLOG,
        threshold: 5,
      });
    expect(dup.status).toBe(409);

    // MEMBER can list and read rules
    const memberList = await request(app)
      .get(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${memberA.accessToken}`);
    expect(memberList.status).toBe(200);
    expect(memberList.body.data.rules.some((r: { id: string }) => r.id === ruleId)).toBe(true);

    // Toggle and update rule
    const toggled = await request(app)
      .patch(`/api/v1/organisations/${orgAId}/alert-rules/${ruleId}/toggle`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ isEnabled: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.data.rule.isEnabled).toBe(false);

    const updated = await request(app)
      .patch(`/api/v1/organisations/${orgAId}/alert-rules/${ruleId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ threshold: 3, isEnabled: true });
    expect(updated.status).toBe(200);
    expect(updated.body.data.rule.threshold).toBe(3);
    expect(updated.body.data.rule.isEnabled).toBe(true);

    // Clean up this rule for later isolated evaluation tests
    const del = await request(app)
      .delete(`/api/v1/organisations/${orgAId}/alert-rules/${ruleId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(del.status).toBe(200);
  });

  it('does not fire false alerts when metric data is missing (null)', async () => {
    // JOB_FAILURE_RATE is null when no jobs have been processed in window
    const ruleRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Zero-Data Failure Rate',
        type: AlertType.JOB_FAILURE_RATE,
        operator: AlertComparisonOperator.GTE,
        threshold: 0,
        severity: AlertSeverity.WARNING,
      });
    expect(ruleRes.status).toBe(201);
    const ruleId = ruleRes.body.data.rule.id;

    metricsService.invalidateOrganisation(orgAId);
    await alertEvaluatorService.evaluateAll();

    const alerts = await prisma.alert.findMany({ where: { ruleId } });
    expect(alerts).toHaveLength(0);

    await prisma.alertRule.delete({ where: { id: ruleId } });
  });

  it('fires, deduplicates across concurrent runs, delivers notifications & SSE, acknowledges, recovers, and enforces cooldown', async () => {
    const publishedEventTypes: string[] = [];
    const publishSpy = vi.spyOn(realtimeEventBus, 'publish').mockImplementation(async (evt) => {
      if (evt.organisationId === orgAId) {
        publishedEventTypes.push(evt.type);
      }
      return true;
    });

    // Create a QUEUE_BACKLOG rule (threshold >= 2, cooldown 60s)
    const ruleRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'Queue Backlog Spike',
        type: AlertType.QUEUE_BACKLOG,
        operator: AlertComparisonOperator.GTE,
        threshold: 2,
        windowMinutes: 15,
        cooldownSeconds: 60,
        queueId: queueAId,
        severity: AlertSeverity.CRITICAL,
      });
    expect(ruleRes.status).toBe(201);
    const ruleId = ruleRes.body.data.rule.id;

    // Seed 2 pending jobs in queueA
    const createdJobs = await Promise.all([
      prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'alert-test-job-1',
          payload: { idx: 1 },
          status: JobStatus.PENDING,
        },
      }),
      prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'alert-test-job-2',
          payload: { idx: 2 },
          status: JobStatus.PENDING,
        },
      }),
    ]);

    metricsService.invalidateOrganisation(orgAId);

    // Concurrent evaluation — advisory lock + partial unique index must produce only 1 active alert
    await Promise.all([alertEvaluatorService.evaluateAll(), alertEvaluatorService.evaluateAll()]);

    const alertsAfterFirst = await prisma.alert.findMany({
      where: { organisationId: orgAId, ruleId },
    });
    expect(alertsAfterFirst).toHaveLength(1);
    const alertId = alertsAfterFirst[0].id;
    expect(alertsAfterFirst[0].status).toBe(AlertStatus.FIRING);
    expect(alertsAfterFirst[0].metricValue).toBeGreaterThanOrEqual(2);

    // Second sequential evaluation within cooldown updates lastEvaluatedAt without duplicating alert or bumping occurrenceCount
    await alertEvaluatorService.evaluateAll();
    const alertsWithinCooldown = await prisma.alert.findMany({
      where: { organisationId: orgAId, ruleId },
    });
    expect(alertsWithinCooldown).toHaveLength(1);
    expect(alertsWithinCooldown[0].occurrenceCount).toBe(1);

    // Evaluation after cooldown elapsed bumps occurrenceCount on the SAME active alert (no duplicate alert)
    await alertEvaluatorService.evaluateAll({ now: new Date(Date.now() + 65_000) });
    const alertsAfterCooldown = await prisma.alert.findMany({
      where: { organisationId: orgAId, ruleId },
    });
    expect(alertsAfterCooldown).toHaveLength(1);
    expect(alertsAfterCooldown[0].occurrenceCount).toBe(2);

    // Notifications created for BOTH ownerA and memberA (exactly 1 firing notification each)
    const ownerNotifs = await request(app)
      .get(`/api/v1/organisations/${orgAId}/notifications`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(ownerNotifs.status).toBe(200);
    expect(ownerNotifs.body.data.unreadCount).toBe(1);
    expect(ownerNotifs.body.data.notifications).toHaveLength(1);
    expect(ownerNotifs.body.data.notifications[0].alertId).toBe(alertId);

    const memberUnread = await request(app)
      .get(`/api/v1/organisations/${orgAId}/notifications/unread-count`)
      .set('Authorization', `Bearer ${memberA.accessToken}`);
    expect(memberUnread.status).toBe(200);
    expect(memberUnread.body.data.unreadCount).toBe(1);

    // Cross-org isolation: ownerB sees 0 alerts and 0 notifications in orgB, and gets 403 on orgA
    const orgBAlerts = await request(app)
      .get(`/api/v1/organisations/${orgBId}/alerts`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(orgBAlerts.status).toBe(200);
    expect(orgBAlerts.body.data.alerts).toHaveLength(0);

    const crossOrgAccess = await request(app)
      .get(`/api/v1/organisations/${orgAId}/alerts/${alertId}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect([403, 404]).toContain(crossOrgAccess.status);

    const crossOrgAlertByOrgB = await request(app)
      .get(`/api/v1/organisations/${orgBId}/alerts/${alertId}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(crossOrgAlertByOrgB.status).toBe(404);

    // MEMBER can acknowledge the alert
    const ackRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alerts/${alertId}/acknowledge`)
      .set('Authorization', `Bearer ${memberA.accessToken}`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.data.alert.status).toBe(AlertStatus.ACKNOWLEDGED);
    expect(ackRes.body.data.alert.acknowledgedById).toBe(memberA.id);

    // MEMBER cannot resolve the alert
    const memberResolve = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alerts/${alertId}/resolve`)
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({ reason: 'Member attempt' });
    expect(memberResolve.status).toBe(403);

    // Recover condition by completing the pending jobs
    await prisma.job.updateMany({
      where: { id: { in: createdJobs.map((j) => j.id) } },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
    metricsService.invalidateOrganisation(orgAId);

    // Evaluator auto-resolves the acknowledged alert and sends resolution notification
    await alertEvaluatorService.evaluateAll();

    const resolvedAlert = await prisma.alert.findUnique({ where: { id: alertId } });
    expect(resolvedAlert?.status).toBe(AlertStatus.RESOLVED);
    expect(resolvedAlert?.resolvedAt).not.toBeNull();

    // Cannot acknowledge a resolved alert (409)
    const ackResolved = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alerts/${alertId}/acknowledge`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(ackResolved.status).toBe(409);

    // Owner now has 2 unread notifications (fired + resolved)
    const ownerNotifsAfterResolve = await request(app)
      .get(`/api/v1/organisations/${orgAId}/notifications`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(ownerNotifsAfterResolve.body.data.unreadCount).toBe(2);

    // Mark 1 read, then mark all read
    const firstNotifId = ownerNotifsAfterResolve.body.data.notifications[0].id;
    const markOne = await request(app)
      .patch(`/api/v1/organisations/${orgAId}/notifications/${firstNotifId}/read`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(markOne.status).toBe(200);
    expect(markOne.body.data.notification.isRead).toBe(true);

    const markAll = await request(app)
      .post(`/api/v1/organisations/${orgAId}/notifications/read-all`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(markAll.status).toBe(200);
    expect(markAll.body.data.updatedCount).toBe(1);

    const unreadZero = await request(app)
      .get(`/api/v1/organisations/${orgAId}/notifications/unread-count`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(unreadZero.body.data.unreadCount).toBe(0);

    // Cooldown enforcement: re-breach immediately while within 60s cooldown should NOT fire a new alert
    await prisma.job.updateMany({
      where: { id: { in: createdJobs.map((j) => j.id) } },
      data: { status: JobStatus.PENDING, completedAt: null },
    });
    metricsService.invalidateOrganisation(orgAId);
    await alertEvaluatorService.evaluateAll();

    const alertsDuringCooldown = await prisma.alert.findMany({
      where: { organisationId: orgAId, ruleId },
    });
    expect(alertsDuringCooldown).toHaveLength(1);

    // Deleting rule preserves historical alert with ruleId = null
    const delRule = await request(app)
      .delete(`/api/v1/organisations/${orgAId}/alert-rules/${ruleId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(delRule.status).toBe(200);

    const preserved = await prisma.alert.findUnique({ where: { id: alertId } });
    expect(preserved).not.toBeNull();
    expect(preserved?.ruleId).toBeNull();
    expect(preserved?.ruleName).toBe('Queue Backlog Spike');

    publishSpy.mockRestore();
    expect(publishedEventTypes).toContain(PlatformEventType.ALERT_FIRED);
    expect(publishedEventTypes).toContain(PlatformEventType.ALERT_ACKNOWLEDGED);
    expect(publishedEventTypes).toContain(PlatformEventType.ALERT_RESOLVED);
  });

  it('preserves durable alert recording even if Redis Pub/Sub publishing fails', async () => {
    const publishSpy = vi
      .spyOn(realtimeEventBus, 'publish')
      .mockRejectedValueOnce(new Error('Simulated Redis outage'));

    // Seed a DLQ item + DLQ rule
    const dlqRuleRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/alert-rules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'DLQ Alert Resilience',
        type: AlertType.DLQ_COUNT,
        operator: AlertComparisonOperator.GTE,
        threshold: 1,
        cooldownSeconds: 0,
        severity: AlertSeverity.WARNING,
      });
    expect(dlqRuleRes.status).toBe(201);
    const dlqRuleId = dlqRuleRes.body.data.rule.id;

    const job = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'dlq-resilience-job',
        payload: {},
        status: JobStatus.FAILED,
      },
    });
    await prisma.deadLetterJob.create({
      data: {
        originalJobId: job.id,
        organisationId: orgAId,
        queueId: queueAId,
        queueName: queueAName,
        jobName: job.name,
        payloadSummary: {},
        failureReason: 'Simulated failure',
        attemptsMade: 3,
        maxRetries: 3,
        status: DeadLetterStatus.OPEN,
        failedAt: new Date(),
      },
    });

    // Also create a stale worker to verify WORKER_STALE stats endpoint
    await prisma.workerHeartbeat.create({
      data: {
        workerInstanceId: `test-alert-worker-${suffix}`,
        hostname: 'test-host',
        pid: 12345,
        status: WorkerHealthStatus.STALE,
        registeredQueues: [queueAName],
        organisationIds: [orgAId],
        lastHeartbeatAt: new Date(Date.now() - 120_000),
      },
    });

    metricsService.invalidateOrganisation(orgAId);
    await alertEvaluatorService.evaluateAll();

    const dlqAlerts = await prisma.alert.findMany({ where: { ruleId: dlqRuleId } });
    expect(dlqAlerts).toHaveLength(1);
    expect(dlqAlerts[0].status).toBe(AlertStatus.FIRING);

    // Alert stats endpoint returns accurate counts
    const statsRes = await request(app)
      .get(`/api/v1/organisations/${orgAId}/alerts/stats`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.data.stats.firing).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.data.stats.total).toBeGreaterThanOrEqual(2);

    publishSpy.mockRestore();
  });
});

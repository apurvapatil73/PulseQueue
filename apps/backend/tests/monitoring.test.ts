import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  DeadLetterStatus,
  JobStatus,
  OutboxStatus,
  PlatformEventType,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
  WorkerHealthStatus,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService, buildBullMQQueueName } from '../src/services/bullmq.service.js';
import { jobService } from '../src/services/job.service.js';
import { workerHealthService } from '../src/services/workerHealth.service.js';
import { MetricsService, MIN_PERCENTILE_SAMPLES } from '../src/services/metrics.service.js';
import { EventRetentionService } from '../src/services/eventRetention.service.js';

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

describe('Step 7.2 — Backend Monitoring Metrics, Tenant Isolation & Event Retention', () => {
  const suffix = `mon72_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;
  let ownerEmpty: TestUser;

  let orgAId = '';
  let orgBId = '';
  let orgEmptyId = '';

  let queueAId = '';
  let queueBId = '';
  const queueAName = `mon-alpha-${Date.now()}`;
  const queueBName = `mon-beta-${Date.now()}`;

  const sharedWorkerId = `worker-shared-${suffix}`;
  const staleWorkerId = `worker-stale-${suffix}`;

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdWorkerIds: string[] = [sharedWorkerId, staleWorkerId];

  beforeAll(async () => {
    ownerA = await createAndLoginUser('mon_owner_a', suffix);
    adminA = await createAndLoginUser('mon_admin_a', suffix);
    memberA = await createAndLoginUser('mon_member_a', suffix);
    ownerB = await createAndLoginUser('mon_owner_b', suffix);
    ownerEmpty = await createAndLoginUser('mon_owner_empty', suffix);
    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id, ownerEmpty.id);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Monitoring Org Alpha' });
    orgAId = orgARes.body.data.organisation.id;

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Monitoring Org Beta' });
    orgBId = orgBRes.body.data.organisation.id;

    const orgEmptyRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerEmpty.accessToken}`)
      .send({ name: 'Monitoring Org Empty' });
    orgEmptyId = orgEmptyRes.body.data.organisation.id;

    createdOrgIds.push(orgAId, orgBId, orgEmptyId);

    // Invite adminA (ADMIN) and memberA (MEMBER) into Org A
    for (const [invitee, role] of [
      [adminA, 'ADMIN'],
      [memberA, 'MEMBER'],
    ] as const) {
      const inv = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: invitee.email, role });
      await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: inv.body.data.token });
    }

    const qARes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: queueAName, concurrency: 4, maxRetries: 3, backoffMs: 100 });
    queueAId = qARes.body.data.queue.id;

    const qBRes = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: queueBName, concurrency: 2 });
    queueBId = qBRes.body.data.queue.id;
  }, 60_000);

  afterAll(async () => {
    for (const [orgId, qName] of [
      [orgAId, queueAName],
      [orgBId, queueBName],
    ]) {
      try {
        const reg = bullMQService.getRegisteredQueue(orgId, qName);
        if (reg) await reg.queue.obliterate({ force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    await bullMQService.closeAll();

    await prisma.workerHeartbeat.deleteMany({
      where: { workerInstanceId: { in: createdWorkerIds } },
    });
    await prisma.platformEvent.deleteMany({
      where: {
        OR: [{ organisationId: { in: createdOrgIds } }, { workerId: { in: createdWorkerIds } }],
      },
    });
    await prisma.organisation.deleteMany({
      where: { id: { in: createdOrgIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  }, 30_000);

  // ─── 1. Empty Dataset & Zero-Denominator Safety ───────────────────────────

  describe('Empty Dataset & Zero-Denominator Safety', () => {
    it('returns null rates and percentiles (never NaN or misleading 0%) for an empty organisation', async () => {
      const [metricsRes, tsRes] = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgEmptyId}/monitoring/metrics?windowMinutes=60`)
          .set('Authorization', `Bearer ${ownerEmpty.accessToken}`),
        request(app)
          .get(
            `/api/v1/organisations/${orgEmptyId}/monitoring/metrics/timeseries?windowMinutes=30&bucketMinutes=5`,
          )
          .set('Authorization', `Bearer ${ownerEmpty.accessToken}`),
      ]);

      expect(metricsRes.status).toBe(200);
      const m = metricsRes.body.data.metrics;
      expect(m.organisationId).toBe(orgEmptyId);
      expect(m.summary.totalSubmitted).toBe(0);
      expect(m.summary.totalProcessed).toBe(0);
      expect(m.summary.queueDepth).toBe(0);
      expect(m.summary.successRate).toBeNull();
      expect(m.summary.failureRate).toBeNull();
      expect(m.summary.windowSuccessRate).toBeNull();
      expect(m.summary.windowFailureRate).toBeNull();
      expect(m.summary.averageDurationMs).toBeNull();
      expect(m.summary.windowAverageDurationMs).toBeNull();
      expect(m.latency.minPercentileSamples).toBe(MIN_PERCENTILE_SAMPLES);
      expect(m.latency.executionDuration).toEqual({
        sampleCount: 0,
        avgMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      });
      expect(m.latency.queueWait.sampleCount).toBe(0);
      expect(m.latency.retryOverhead.sampleCount).toBe(0);
      expect(m.latency.endToEnd.sampleCount).toBe(0);
      expect(m.reliability.scheduleMisfiresInWindow).toBe(0);
      expect(m.reliability.dlqNetGrowthInWindow).toBe(0);
      expect(m.reliability.outboxPending).toBe(0);
      expect(m.workerSummary).toEqual({
        total: 0,
        online: 0,
        degraded: 0,
        stale: 0,
        stopped: 0,
        activeJobs: 0,
      });

      expect(tsRes.status).toBe(200);
      const ts = tsRes.body.data.timeseries;
      expect(ts.buckets).toHaveLength(6);
      for (const b of ts.buckets) {
        expect(b.submitted).toBe(0);
        expect(b.completed).toBe(0);
        expect(b.failed).toBe(0);
        expect(b.processed).toBe(0);
        expect(b.successRate).toBeNull();
        expect(b.failureRate).toBeNull();
        expect(b.avgDurationMs).toBeNull();
        expect(b.p95DurationMs).toBeNull();
      }
    });
  });

  // ─── 2. Cross-Tenant Worker Metrics, Error Isolation & Read-Only GETs ─────

  describe('Cross-Tenant Worker & Error-Message Isolation + Read-Only GETs', () => {
    it('isolates per-organisation worker job counts, activeJobs, and lastError on a shared multi-tenant worker', async () => {
      // Register shared worker serving BOTH Org A and Org B
      await workerHealthService.registerWorkerStart({
        workerInstanceId: sharedWorkerId,
        hostname: 'shared-host-1',
        pid: 9001,
        registeredQueues: [
          buildBullMQQueueName(orgAId, queueAName),
          buildBullMQQueueName(orgBId, queueBName),
        ],
        organisationIds: [orgAId, orgBId],
      });

      // Even if legacy global worker_heartbeats.lastError or global counters have data,
      // org-scoped views MUST NOT expose them!
      await prisma.workerHeartbeat.update({
        where: { workerInstanceId: sharedWorkerId },
        data: {
          jobsProcessed: 999,
          jobsSucceeded: 888,
          jobsFailed: 111,
          lastError: 'GLOBAL_INTERNAL_ERROR_MUST_NEVER_LEAK',
        },
      });

      const now = new Date();
      // Org A: 2 completed, 1 failed (with sensitive Org A error), 1 active on sharedWorkerId
      await prisma.job.createMany({
        data: [
          {
            queueId: queueAId,
            name: 'echo',
            status: JobStatus.COMPLETED,
            lastWorkerId: sharedWorkerId,
            durationMs: 25,
            attemptsMade: 1,
            createdAt: new Date(now.getTime() - 20_000),
            firstStartedAt: new Date(now.getTime() - 19_000),
            startedAt: new Date(now.getTime() - 19_000),
            completedAt: new Date(now.getTime() - 18_000),
          },
          {
            queueId: queueAId,
            name: 'echo',
            status: JobStatus.COMPLETED,
            lastWorkerId: sharedWorkerId,
            durationMs: 35,
            attemptsMade: 1,
            createdAt: new Date(now.getTime() - 15_000),
            firstStartedAt: new Date(now.getTime() - 14_000),
            startedAt: new Date(now.getTime() - 14_000),
            completedAt: new Date(now.getTime() - 13_000),
          },
          {
            queueId: queueAId,
            name: 'echo',
            status: JobStatus.FAILED,
            lastWorkerId: sharedWorkerId,
            durationMs: 40,
            attemptsMade: 2,
            errorMessage: 'ORG_A_CONFIDENTIAL_PAYMENT_GATEWAY_FAILURE',
            createdAt: new Date(now.getTime() - 10_000),
            firstStartedAt: new Date(now.getTime() - 9_000),
            startedAt: new Date(now.getTime() - 8_000),
            failedAt: new Date(now.getTime() - 7_000),
          },
          {
            queueId: queueAId,
            name: 'echo',
            status: JobStatus.ACTIVE,
            lastWorkerId: sharedWorkerId,
            attemptsMade: 1,
            createdAt: new Date(now.getTime() - 5_000),
            firstStartedAt: new Date(now.getTime() - 4_000),
            startedAt: new Date(now.getTime() - 4_000),
          },
        ],
      });

      // Org B: 1 completed, 0 failed, 0 active on the EXACT SAME sharedWorkerId
      await prisma.job.create({
        data: {
          queueId: queueBId,
          name: 'echo',
          status: JobStatus.COMPLETED,
          lastWorkerId: sharedWorkerId,
          durationMs: 15,
          attemptsMade: 1,
          createdAt: new Date(now.getTime() - 12_000),
          firstStartedAt: new Date(now.getTime() - 11_000),
          startedAt: new Date(now.getTime() - 11_000),
          completedAt: new Date(now.getTime() - 10_000),
        },
      });

      const [workersA, workersB] = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/workers`)
          .set('Authorization', `Bearer ${memberA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/monitoring/workers`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
      ]);

      expect(workersA.status).toBe(200);
      expect(workersB.status).toBe(200);

      const wA = workersA.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === sharedWorkerId,
      );
      const wB = workersB.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === sharedWorkerId,
      );

      expect(wA).toMatchObject({
        workerInstanceId: sharedWorkerId,
        status: WorkerHealthStatus.ONLINE,
        registeredQueues: [queueAName],
        jobsProcessed: 3,
        jobsSucceeded: 2,
        jobsFailed: 1,
        activeJobs: 1,
        lastError: 'ORG_A_CONFIDENTIAL_PAYMENT_GATEWAY_FAILURE',
      });

      // Org B sees ONLY Org B's job count (1), 0 failed, 0 active, null lastError, and only queueBName!
      expect(wB).toMatchObject({
        workerInstanceId: sharedWorkerId,
        status: WorkerHealthStatus.ONLINE,
        registeredQueues: [queueBName],
        jobsProcessed: 1,
        jobsSucceeded: 1,
        jobsFailed: 0,
        activeJobs: 0,
        lastError: null,
      });
      expect(JSON.stringify(workersB.body)).not.toContain('ORG_A_CONFIDENTIAL');
      expect(JSON.stringify(workersB.body)).not.toContain('GLOBAL_INTERNAL_ERROR');
      expect(JSON.stringify(workersB.body)).not.toContain(queueAName);
    });

    it('keeps GET /monitoring/workers and /metrics strictly read-only (zero DB writes on stale workers)', async () => {
      await workerHealthService.registerWorkerStart({
        workerInstanceId: staleWorkerId,
        hostname: 'stale-host',
        pid: 9002,
        registeredQueues: [buildBullMQQueueName(orgAId, queueAName)],
        organisationIds: [orgAId],
      });
      await prisma.workerHeartbeat.update({
        where: { workerInstanceId: staleWorkerId },
        data: {
          status: WorkerHealthStatus.ONLINE,
          lastHeartbeatAt: new Date(Date.now() - 120_000),
        },
      });

      const res = await request(app)
        .get(`/api/v1/organisations/${orgAId}/monitoring/workers`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);

      expect(res.status).toBe(200);
      const staleView = res.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === staleWorkerId,
      );
      expect(staleView?.status).toBe(WorkerHealthStatus.STALE);
      expect(staleView?.heartbeatAgeMs).toBeGreaterThanOrEqual(115_000);

      // Verify PostgreSQL row was NOT mutated by the GET request
      const dbRowBeforeSweep = await prisma.workerHeartbeat.findUnique({
        where: { workerInstanceId: staleWorkerId },
      });
      expect(dbRowBeforeSweep?.status).toBe(WorkerHealthStatus.ONLINE);

      // Explicit background sweep DOES persist STALE & record event
      const sweep = await workerHealthService.detectStaleWorkers();
      expect(sweep.markedStale).toBeGreaterThanOrEqual(1);

      const dbRowAfterSweep = await prisma.workerHeartbeat.findUnique({
        where: { workerInstanceId: staleWorkerId },
      });
      expect(dbRowAfterSweep?.status).toBe(WorkerHealthStatus.STALE);
    });

    it('enforces OWNER, ADMIN, MEMBER RBAC and blocks cross-tenant timeseries/events/metrics probes', async () => {
      // OWNER, ADMIN, MEMBER all allowed on GET monitoring endpoints
      for (const user of [ownerA, adminA, memberA]) {
        const [mRes, tsRes, wRes, eRes] = await Promise.all([
          request(app)
            .get(`/api/v1/organisations/${orgAId}/monitoring/metrics`)
            .set('Authorization', `Bearer ${user.accessToken}`),
          request(app)
            .get(`/api/v1/organisations/${orgAId}/monitoring/metrics/timeseries`)
            .set('Authorization', `Bearer ${user.accessToken}`),
          request(app)
            .get(`/api/v1/organisations/${orgAId}/monitoring/workers`)
            .set('Authorization', `Bearer ${user.accessToken}`),
          request(app)
            .get(`/api/v1/organisations/${orgAId}/monitoring/events`)
            .set('Authorization', `Bearer ${user.accessToken}`),
        ]);
        expect(mRes.status).toBe(200);
        expect(tsRes.status).toBe(200);
        expect(wRes.status).toBe(200);
        expect(eRes.status).toBe(200);
      }

      // MEMBER forbidden on POST recover-stalled; ADMIN allowed
      const [memberRec, adminRec] = await Promise.all([
        request(app)
          .post(`/api/v1/organisations/${orgAId}/monitoring/recover-stalled`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
          .send({}),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/monitoring/recover-stalled`)
          .set('Authorization', `Bearer ${adminA.accessToken}`)
          .send({}),
      ]);
      expect(memberRec.status).toBe(403);
      expect(adminRec.status).toBe(200);

      // Cross-tenant probes: Org B cannot access Org A's timeseries or pass Org A's queueId under Org B
      const [crossOrgTs, spoofedQueueTs, crossEvents] = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/metrics/timeseries`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/monitoring/metrics/timeseries?queueId=${queueAId}`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/monitoring/events?queueId=${queueAId}`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
      ]);
      expect(crossOrgTs.status).toBe(404);
      expect(spoofedQueueTs.status).toBe(404);
      expect(crossEvents.status).toBe(200);
      expect(crossEvents.body.data.events).toHaveLength(0);
    });
  });

  // ─── 3. Percentiles, Retry-Aware Timing, DLQ Growth & Schedule Misfires ───

  describe('Percentiles, Retry-Aware Timing, Queue/DLQ/Schedule Metrics', () => {
    let orgCalcId = '';
    let queueCalcId = '';

    beforeAll(async () => {
      const orgRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Monitoring Calc Org' });
      orgCalcId = orgRes.body.data.organisation.id;
      createdOrgIds.push(orgCalcId);

      const qRes = await request(app)
        .post(`/api/v1/organisations/${orgCalcId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: `calc-q-${Date.now()}`, concurrency: 4 });
      queueCalcId = qRes.body.data.queue.id;
    });

    it('returns null percentiles below MIN_PERCENTILE_SAMPLES and exact percentiles once sample threshold is met', async () => {
      const now = Date.now();
      // Seed 3 completed jobs (< MIN_PERCENTILE_SAMPLES = 5)
      await prisma.job.createMany({
        data: [10, 20, 30].map((d, i) => ({
          queueId: queueCalcId,
          name: 'echo',
          status: JobStatus.COMPLETED,
          durationMs: d,
          attemptsMade: 1,
          createdAt: new Date(now - (100_000 - i * 1000)),
          firstStartedAt: new Date(now - (99_500 - i * 1000)),
          startedAt: new Date(now - (99_500 - i * 1000)),
          completedAt: new Date(now - (99_000 - i * 1000)),
        })),
      });

      const belowRes = await request(app)
        .get(`/api/v1/organisations/${orgCalcId}/monitoring/metrics?windowMinutes=60`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(belowRes.status).toBe(200);
      const belowLat = belowRes.body.data.metrics.latency.executionDuration;
      expect(belowLat.sampleCount).toBe(3);
      expect(belowLat.avgMs).toBe(20);
      expect(belowLat.p50Ms).toBeNull();
      expect(belowLat.p95Ms).toBeNull();
      expect(belowLat.p99Ms).toBeNull();

      // Add 7 more completed jobs so durations are [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      await prisma.job.createMany({
        data: [40, 50, 60, 70, 80, 90, 100].map((d, i) => ({
          queueId: queueCalcId,
          name: 'echo',
          status: JobStatus.COMPLETED,
          durationMs: d,
          attemptsMade: 1,
          createdAt: new Date(now - (60_000 - i * 1000)),
          firstStartedAt: new Date(now - (59_500 - i * 1000)),
          startedAt: new Date(now - (59_500 - i * 1000)),
          completedAt: new Date(now - (59_000 - i * 1000)),
        })),
      });

      // Also add 1 pending job (depth = 1), 1 outbox pending, 1 schedule with 2 misfires & 1 skip, and 1 open DLQ
      const pendingJob = await prisma.job.create({
        data: {
          queueId: queueCalcId,
          name: 'echo',
          status: JobStatus.PENDING,
          createdAt: new Date(now - 30_000),
        },
      });
      await prisma.jobDispatchOutbox.create({
        data: {
          jobId: pendingJob.id,
          queueId: queueCalcId,
          organisationId: orgCalcId,
          status: OutboxStatus.PENDING,
        },
      });

      const failedForDlq = await prisma.job.create({
        data: {
          queueId: queueCalcId,
          name: 'echo',
          status: JobStatus.FAILED,
          attemptsMade: 2,
          stalledCount: 1,
          failedAt: new Date(now - 20_000),
        },
      });
      await prisma.deadLetterJob.create({
        data: {
          originalJobId: failedForDlq.id,
          organisationId: orgCalcId,
          queueId: queueCalcId,
          queueName: 'calc-q',
          jobName: 'echo',
          failureReason: 'test dlq',
          attemptsMade: 2,
          maxRetries: 2,
          status: DeadLetterStatus.OPEN,
          failedAt: new Date(now - 20_000),
        },
      });

      const sched = await prisma.schedule.create({
        data: {
          organisationId: orgCalcId,
          queueId: queueCalcId,
          name: `calc-sched-${Date.now()}`,
          type: ScheduleType.RECURRING,
          status: ScheduleStatus.ACTIVE,
          jobName: 'echo',
          cronExpression: '*/5 * * * *',
          timezone: 'UTC',
        },
      });
      await prisma.scheduleExecution.createMany({
        data: [
          {
            scheduleId: sched.id,
            scheduledFor: new Date(now - 15 * 60_000),
            status: ScheduleExecutionStatus.MISSED,
            createdAt: new Date(now - 15 * 60_000),
          },
          {
            scheduleId: sched.id,
            scheduledFor: new Date(now - 10 * 60_000),
            status: ScheduleExecutionStatus.MISSED,
            createdAt: new Date(now - 10 * 60_000),
          },
          {
            scheduleId: sched.id,
            scheduledFor: new Date(now - 5 * 60_000),
            status: ScheduleExecutionStatus.SKIPPED_OVERLAP,
            createdAt: new Date(now - 5 * 60_000),
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/organisations/${orgCalcId}/monitoring/metrics?windowMinutes=60`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);

      expect(res.status).toBe(200);
      const m = res.body.data.metrics;
      expect(m.summary.succeeded).toBe(10);
      expect(m.summary.failed).toBe(1);
      expect(m.summary.totalProcessed).toBe(11);
      expect(m.summary.queueDepth).toBe(1);
      expect(m.summary.successRate).toBe(0.9091);
      expect(m.summary.failureRate).toBe(0.0909);

      // Exact PostgreSQL PERCENTILE_CONT over [10,20,30,40,50,60,70,80,90,100]
      expect(m.latency.executionDuration).toEqual({
        sampleCount: 10,
        avgMs: 55,
        p50Ms: 55,
        p95Ms: 95.5,
        p99Ms: 99.1,
      });

      // Queue-level metrics
      expect(m.queues).toHaveLength(1);
      expect(m.queues[0].queueDepth).toBe(1);
      expect(m.queues[0].p95DurationMs).toBe(95.5);
      expect(m.queues[0].retriedJobs).toBe(1);
      expect(m.queues[0].stalledRecoveries).toBe(1);
      expect(m.queues[0].oldestPendingAgeMs).toBeGreaterThanOrEqual(29_000);
      expect(m.queues[0].openDeadLetters).toBe(1);

      // Reliability metrics
      expect(m.reliability.dlqCreatedInWindow).toBe(1);
      expect(m.reliability.dlqReplayedInWindow).toBe(0);
      expect(m.reliability.dlqNetGrowthInWindow).toBe(1);
      expect(m.reliability.scheduleMisfiresInWindow).toBe(2);
      expect(m.reliability.scheduleSkipsInWindow).toBe(1);
      expect(m.reliability.scheduleMisfiresTotal).toBe(2);
      expect(m.reliability.outboxPending).toBe(1);
    });

    it('preserves firstStartedAt across retries and computes retry-aware queue wait and retry overhead', async () => {
      const orgTimingRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Monitoring Timing Org' });
      const orgTimingId = orgTimingRes.body.data.organisation.id;
      createdOrgIds.push(orgTimingId);

      const qRes = await request(app)
        .post(`/api/v1/organisations/${orgTimingId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: `timing-q-${Date.now()}` });
      const qId = qRes.body.data.queue.id;

      // Submit via real jobService, run attempt 1 -> retry -> attempt 2 -> complete
      const created = await jobService.create(orgTimingId, qId, ownerA.id, {
        name: 'echo',
        payload: { message: 'retry-timing' },
        maxRetries: 3,
        backoffMs: 100,
        delayMs: 0,
      });
      const jobId = created.job.id;

      await jobService.markJobActive(orgTimingId, jobId, 1, 'worker-timing');
      const afterAttempt1 = await prisma.job.findUnique({ where: { id: jobId } });
      expect(afterAttempt1?.firstStartedAt).not.toBeNull();
      const firstStartedAt = afterAttempt1!.firstStartedAt!;

      await jobService.markJobRetryScheduled(orgTimingId, jobId, 'transient error', 1, {
        workerId: 'worker-timing',
      });
      await new Promise((r) => setTimeout(r, 60));
      await jobService.markJobActive(orgTimingId, jobId, 2, 'worker-timing');
      await jobService.markJobCompleted(orgTimingId, jobId, { ok: true }, 2, {
        durationMs: 120,
        workerId: 'worker-timing',
      });

      const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
      // firstStartedAt MUST remain equal to attempt 1 while startedAt advanced to attempt 2
      expect(finalJob?.firstStartedAt?.getTime()).toBe(firstStartedAt.getTime());
      expect(finalJob!.startedAt!.getTime()).toBeGreaterThan(firstStartedAt.getTime());

      // Set deterministic timestamps to verify exact SQL timing calculations
      const base = Date.now() - 10_000;
      await prisma.job.update({
        where: { id: jobId },
        data: {
          createdAt: new Date(base),
          firstStartedAt: new Date(base + 250), // 250ms initial queue wait
          startedAt: new Date(base + 1250), // 1000ms retry overhead
          completedAt: new Date(base + 1400), // 1400ms end-to-end
          durationMs: 150,
          attemptsMade: 2,
        },
      });

      // Also insert a historical job with NULL firstStartedAt and a JOB_STARTED event to verify event-history fallback
      const histJob = await prisma.job.create({
        data: {
          queueId: qId,
          name: 'echo',
          status: JobStatus.COMPLETED,
          createdAt: new Date(base),
          firstStartedAt: null,
          startedAt: new Date(base + 2000),
          completedAt: new Date(base + 2200),
          durationMs: 200,
          attemptsMade: 2,
        },
      });
      await prisma.platformEvent.create({
        data: {
          type: PlatformEventType.JOB_STARTED,
          organisationId: orgTimingId,
          queueId: qId,
          jobId: histJob.id,
          message: 'Attempt 1 started',
          createdAt: new Date(base + 350), // 350ms initial queue wait; 1650ms retry overhead
        },
      });

      const metricsRes = await request(app)
        .get(`/api/v1/organisations/${orgTimingId}/monitoring/metrics?windowMinutes=60`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(metricsRes.status).toBe(200);

      const lat = metricsRes.body.data.metrics.latency;
      expect(lat.executionDuration.sampleCount).toBe(2);
      expect(lat.executionDuration.avgMs).toBe(175); // avg(150, 200)
      expect(lat.queueWait.sampleCount).toBe(2);
      expect(lat.queueWait.avgMs).toBe(300); // avg(250, 350)
      expect(lat.retryOverhead.sampleCount).toBe(2);
      expect(lat.retryOverhead.avgMs).toBe(1325); // avg(1000, 1650)
      expect(lat.endToEnd.sampleCount).toBe(2);
      expect(lat.endToEnd.avgMs).toBe(1800); // avg(1400, 2200)
    });
  });

  // ─── 4. Historical Time-Bucket Ordering, Boundaries & Validation ──────────

  describe('Historical Time-Bucket Aggregation & Validation', () => {
    it('returns chronological UTC buckets with accurate per-bucket counts and rejects invalid ranges', async () => {
      const orgTsRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Monitoring Timeseries Org' });
      const orgTsId = orgTsRes.body.data.organisation.id;
      createdOrgIds.push(orgTsId);

      const qRes = await request(app)
        .post(`/api/v1/organisations/${orgTsId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: `ts-q-${Date.now()}` });
      const qId = qRes.body.data.queue.id;

      // Seed jobs at t-12m (bucket A) and t-2m (bucket B) inside a 30m window with 5m buckets
      const nowMs = Date.now();
      const tOld = new Date(nowMs - 12 * 60_000);
      const tRecent = new Date(nowMs - 2 * 60_000);

      await prisma.job.createMany({
        data: [
          {
            queueId: qId,
            name: 'echo',
            status: JobStatus.COMPLETED,
            durationMs: 100,
            createdAt: tOld,
            completedAt: tOld,
          },
          {
            queueId: qId,
            name: 'echo',
            status: JobStatus.FAILED,
            durationMs: 200,
            createdAt: tRecent,
            failedAt: tRecent,
          },
        ],
      });

      const tsRes = await request(app)
        .get(
          `/api/v1/organisations/${orgTsId}/monitoring/metrics/timeseries?windowMinutes=30&bucketMinutes=5&queueId=${qId}`,
        )
        .set('Authorization', `Bearer ${ownerA.accessToken}`);

      expect(tsRes.status).toBe(200);
      const ts = tsRes.body.data.timeseries;
      expect(ts.windowMinutes).toBe(30);
      expect(ts.bucketMinutes).toBe(5);
      expect(ts.buckets).toHaveLength(6);

      // Verify strict chronological UTC ordering and 5-minute spans
      for (let i = 0; i < ts.buckets.length; i += 1) {
        const b = ts.buckets[i];
        expect(b.bucketStart.endsWith('Z')).toBe(true);
        expect(b.bucketEnd.endsWith('Z')).toBe(true);
        expect(new Date(b.bucketEnd).getTime() - new Date(b.bucketStart).getTime()).toBe(
          5 * 60_000,
        );
        if (i > 0) {
          expect(new Date(b.bucketStart).getTime()).toBe(
            new Date(ts.buckets[i - 1].bucketEnd).getTime(),
          );
        }
      }

      const totalCompleted = ts.buckets.reduce(
        (acc: number, b: { completed: number }) => acc + b.completed,
        0,
      );
      const totalFailed = ts.buckets.reduce(
        (acc: number, b: { failed: number }) => acc + b.failed,
        0,
      );
      expect(totalCompleted).toBe(1);
      expect(totalFailed).toBe(1);

      // Validation tests: invalid windowMinutes, invalid bucketMinutes, too many buckets, bucket > window
      const badRequests = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgTsId}/monitoring/metrics?windowMinutes=0`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgTsId}/monitoring/metrics?windowMinutes=20000`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(
            `/api/v1/organisations/${orgTsId}/monitoring/metrics/timeseries?windowMinutes=60&bucketMinutes=7`,
          )
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(
            `/api/v1/organisations/${orgTsId}/monitoring/metrics/timeseries?windowMinutes=10080&bucketMinutes=1`,
          )
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(
            `/api/v1/organisations/${orgTsId}/monitoring/metrics/timeseries?windowMinutes=10&bucketMinutes=15`,
          )
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
      ]);

      for (const bad of badRequests) {
        expect(bad.status).toBe(400);
        expect(bad.body.success).toBe(false);
      }
    });
  });

  // ─── 5. Event Retention (30-Day Boundary & Bounded Batches) ───────────────

  describe('Platform Event Retention (30-Day Policy & Bounded Cleanup)', () => {
    it('deletes expired events in bounded batches while preserving boundary and recent events', async () => {
      const orgRetRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Monitoring Retention Org' });
      const orgRetId = orgRetRes.body.data.organisation.id;
      createdOrgIds.push(orgRetId);

      const now = new Date();
      const dayMs = 86_400_000;

      // 12 expired events (31 to 42 days old)
      const expiredRows = Array.from({ length: 12 }, (_, idx) => ({
        type: PlatformEventType.JOB_COMPLETED,
        organisationId: orgRetId,
        message: `Expired event ${idx + 1}`,
        createdAt: new Date(now.getTime() - (31 + idx) * dayMs),
      }));

      // 1 boundary event (29 days 23 hours old — MUST be retained)
      // + 3 recent events (1 hour old — MUST be retained)
      const keptRows = [
        {
          type: PlatformEventType.JOB_SUBMITTED,
          organisationId: orgRetId,
          message: 'Boundary event (29d 23h)',
          createdAt: new Date(now.getTime() - (30 * dayMs - 3_600_000)),
        },
        ...Array.from({ length: 3 }, (_, idx) => ({
          type: PlatformEventType.JOB_STARTED,
          organisationId: orgRetId,
          message: `Recent event ${idx + 1}`,
          createdAt: new Date(now.getTime() - (idx + 1) * 60_000),
        })),
      ];

      await prisma.platformEvent.createMany({ data: [...expiredRows, ...keptRows] });

      const retention = new EventRetentionService({
        retentionDays: 30,
        batchSize: 5,
        maxBatches: 2,
      });

      // Safety floor: retentionDays < 1 must throw
      await expect(
        retention.purgeExpiredEvents({ organisationId: orgRetId, retentionDays: 0 }),
      ).rejects.toThrow(/at least 1/);

      // Pass 1: bounded to maxBatches=2 * batchSize=5 => deletes exactly 10 rows, hasMore=true
      const pass1 = await retention.purgeExpiredEvents({
        organisationId: orgRetId,
        retentionDays: 30,
        batchSize: 5,
        maxBatches: 2,
        now,
      });
      expect(pass1.batchesExecuted).toBe(2);
      expect(pass1.deletedCount).toBe(10);
      expect(pass1.hasMore).toBe(true);
      expect(pass1.skippedOverlap).toBe(false);

      // Pass 2: deletes remaining 2 expired rows, hasMore=false
      const pass2 = await retention.purgeExpiredEvents({
        organisationId: orgRetId,
        retentionDays: 30,
        batchSize: 5,
        maxBatches: 2,
        now,
      });
      expect(pass2.batchesExecuted).toBe(1);
      expect(pass2.deletedCount).toBe(2);
      expect(pass2.hasMore).toBe(false);

      // Verify exactly the 4 non-expired events remain (boundary + 3 recent)
      const remaining = await prisma.platformEvent.findMany({
        where: { organisationId: orgRetId },
        orderBy: { createdAt: 'asc' },
      });
      expect(remaining).toHaveLength(4);
      expect(remaining[0].message).toBe('Boundary event (29d 23h)');
    });
  });

  // ─── 6. Step 7.5 — Worker Telemetry, Queue Analytics & Metrics Cache ──────

  describe('Step 7.5 — Worker Telemetry, Queue Analytics & Metrics Cache', () => {
    it('persists worker process telemetry, isolates orgConfiguredConcurrency & lastActivityAt, and distinguishes null from zero', async () => {
      const telWorkerId = `worker-tel-${suffix}`;
      const bareWorkerId = `worker-bare-${suffix}`;
      createdWorkerIds.push(telWorkerId, bareWorkerId);

      // Register worker with real telemetry serving both Org A (concurrency 4) and Org B (concurrency 2)
      await workerHealthService.registerWorkerStart({
        workerInstanceId: telWorkerId,
        hostname: 'tel-host',
        pid: 7777,
        registeredQueues: [
          buildBullMQQueueName(orgAId, queueAName),
          buildBullMQQueueName(orgBId, queueBName),
        ],
        organisationIds: [orgAId, orgBId],
        configuredConcurrency: 6,
        cpuUsagePercent: 12.34,
        memoryRssBytes: BigInt(128 * 1024 * 1024),
        uptimeSeconds: 3600,
      });

      // Register worker without telemetry fields -> MUST return null (not 0)
      await workerHealthService.registerWorkerStart({
        workerInstanceId: bareWorkerId,
        hostname: 'bare-host',
        pid: 7778,
        registeredQueues: [buildBullMQQueueName(orgAId, queueAName)],
        organisationIds: [orgAId],
      });

      const [resA, resB] = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/workers`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/monitoring/workers`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
      ]);

      const telA = resA.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === telWorkerId,
      );
      const telB = resB.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === telWorkerId,
      );
      const bareA = resA.body.data.workers.find(
        (w: { workerInstanceId: string }) => w.workerInstanceId === bareWorkerId,
      );

      // Org-scoped configured concurrency (4 for Org A, 2 for Org B — never leaks total 6!)
      expect(telA.orgConfiguredConcurrency).toBe(4);
      expect(telB.orgConfiguredConcurrency).toBe(2);
      expect(telA.cpuUsagePercent).toBe(12.34);
      expect(telA.memoryRssMb).toBe(128);
      expect(telA.uptimeSeconds).toBe(3600);
      expect(telA.lastActivityAt).toBeNull();

      // Unavailable telemetry is strictly null (not fabricated 0)
      expect(bareA.cpuUsagePercent).toBeNull();
      expect(bareA.memoryRssMb).toBeNull();
      expect(bareA.uptimeSeconds).toBeNull();
    });

    it('computes queue p50/p95/p99 execution latency, queue wait time, distinct retryRate vs failureRate, and enforces bounded cache invalidation', async () => {
      const orgQRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Monitoring Step 7.5 Queue Org' });
      const orgQId = orgQRes.body.data.organisation.id;
      createdOrgIds.push(orgQId);

      const qRes = await request(app)
        .post(`/api/v1/organisations/${orgQId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: `q75-${Date.now()}`, concurrency: 3 });
      const qId = qRes.body.data.queue.id;

      const base = Date.now() - 20_000;
      // 10 COMPLETED jobs (0 failed!), 2 of which retried (attemptsMade = 2) -> failureRate = 0, retryRate = 0.2
      await prisma.job.createMany({
        data: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d, idx) => ({
          queueId: qId,
          name: 'echo',
          status: JobStatus.COMPLETED,
          attemptsMade: idx < 2 ? 2 : 1,
          durationMs: d,
          delayMs: 0,
          createdAt: new Date(base + idx * 100),
          firstStartedAt: new Date(base + idx * 100 + 200), // exact 200ms queue wait
          startedAt: new Date(base + idx * 100 + (idx < 2 ? 500 : 200)),
          completedAt: new Date(base + idx * 100 + 600),
        })),
      });

      const cachedService = new MetricsService({ cacheTtlMs: 5_000, maxCacheEntries: 10 });
      const first = await cachedService.getOrganisationMetrics(orgQId, 60);
      expect(first.queues).toHaveLength(1);
      const qm = first.queues[0];
      expect(qm.failureRate).toBe(0);
      expect(qm.retryRate).toBe(0.2); // 2 retried / 10 processed — distinct from failureRate!
      expect(qm.p50DurationMs).toBe(55);
      expect(qm.p95DurationMs).toBe(95.5);
      expect(qm.p99DurationMs).toBe(99.1);
      expect(qm.avgQueueWaitMs).toBe(200);
      expect(qm.p95QueueWaitMs).toBe(200);
      expect(cachedService.getCacheSize()).toBe(1);

      // Second call hits cache (identical generatedAt)
      const second = await cachedService.getOrganisationMetrics(orgQId, 60);
      expect(second.generatedAt).toBe(first.generatedAt);

      // Invalidation forces fresh computation
      cachedService.invalidateOrganisation(orgQId);
      expect(cachedService.getCacheSize()).toBe(0);
      await new Promise((r) => setTimeout(r, 15));
      const third = await cachedService.getOrganisationMetrics(orgQId, 60);
      expect(third.generatedAt).not.toBe(first.generatedAt);
    });
  });
});

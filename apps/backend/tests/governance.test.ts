import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  JobStatus,
  OutboxStatus,
  PlatformEventType,
  Role,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import {
  classifyPoisonJob,
  computeFailureSignature,
  governanceService,
} from '../src/services/governance.service.js';
import { jobService } from '../src/services/job.service.js';
import { outboxReconciler } from '../src/services/outboxReconciler.service.js';
import { scheduleDispatcherService } from '../src/services/scheduleDispatcher.service.js';

interface TestUser {
  id: string;
  accessToken: string;
}

async function createAndLogin(prefix: string, suffix: string): Promise<TestUser> {
  const email = `${prefix}_${suffix}@pulsequeue.dev`;
  const password = 'SecurePassword123!';
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `${prefix} User`, email, password });
  expect(reg.status).toBe(201);
  const login = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { id: reg.body.data.user.id, accessToken: login.body.data.accessToken };
}

describe('Phase 8.2 — Tenant Quotas, Backpressure, Retry Budgets & Poison-Job Quarantine', () => {
  const suffix = `p82_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let ownerA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;
  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';

  beforeAll(async () => {
    ownerA = await createAndLogin('ownera', suffix);
    memberA = await createAndLogin('membera', suffix);
    ownerB = await createAndLogin('ownerb', suffix);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: `Gov Org A ${suffix}` });
    expect(orgARes.status).toBe(201);
    orgAId = orgARes.body.data.organisation.id;

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: `Gov Org B ${suffix}` });
    expect(orgBRes.status).toBe(201);
    orgBId = orgBRes.body.data.organisation.id;

    await prisma.membership.create({
      data: { userId: memberA.id, organisationId: orgAId, role: Role.MEMBER },
    });

    const qARes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: `gov-q-a-${suffix}` });
    expect(qARes.status).toBe(201);
    queueAId = qARes.body.data.queue.id;

    const qBRes = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: `gov-q-b-${suffix}` });
    expect(qBRes.status).toBe(201);
    queueBId = qBRes.body.data.queue.id;
  }, 30_000);

  afterAll(async () => {
    const orgIds = [orgAId, orgBId].filter(Boolean);
    const userIds = [ownerA?.id, memberA?.id, ownerB?.id].filter(Boolean);

    if (orgIds.length > 0) {
      await prisma.platformEvent.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.deadLetterJob.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.jobDispatchOutbox.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.job.deleteMany({ where: { queue: { organisationId: { in: orgIds } } } });
      await prisma.queue.deleteMany({ where: { organisationId: { in: orgIds } } });
      await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
    }
    if (userIds.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await bullMQService.closeAll().catch(() => {});
  }, 30_000);

  it('enforces RBAC on governance config, concurrent tenant quotas on final slots, payload quota, and tenant isolation', async () => {
    // MEMBER can read governance, cannot update quotas
    expect(
      (
        await request(app)
          .get(`/api/v1/organisations/${orgAId}/governance`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
          .send({ maxOutstandingJobs: 5 })
      ).status,
    ).toBe(403);

    // Cross-org denied
    expect(
      (
        await request(app)
          .get(`/api/v1/organisations/${orgAId}/governance`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`)
      ).status,
    ).toBe(404);

    // Set maxOutstandingJobs = 3 and maxPayloadBytes = 256 on Org A
    const cfgRes = await request(app)
      .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ maxOutstandingJobs: 3, maxPayloadBytes: 256 });
    expect(cfgRes.status).toBe(200);
    expect(cfgRes.body.data.governance.quotas.maxOutstandingJobs).toBe(3);

    // Payload exceeding org maxPayloadBytes rejected with 429
    const bigPayloadRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'x'.repeat(300) } });
    expect(bigPayloadRes.status).toBe(429);
    expect(bigPayloadRes.body.error.details.reason).toBe('ORG_MAX_PAYLOAD_BYTES');

    // Submit 1 job normally (usage 1/3)
    const j1 = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'slot-1' } });
    expect(j1.status).toBe(201);

    // 6 concurrent submissions compete for the last 2 available quota slots -> strictly 2 succeed (201) and 4 reject (429)
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: 'echo', payload: { message: `race-${i}` } }),
      ),
    );
    const createdCount = burst.filter((r) => r.status === 201).length;
    const rejectedCount = burst.filter((r) => r.status === 429).length;
    expect(createdCount).toBe(2);
    expect(rejectedCount).toBe(4);
    expect(burst.find((r) => r.status === 429)?.headers['retry-after']).toBe('5');

    // Tenant isolation: Org A at 100% quota MUST NOT block Org B
    const orgBSubmit = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues/${queueBId}/jobs`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'echo', payload: { message: 'org-b-isolated' } });
    expect(orgBSubmit.status).toBe(201);

    // Complete Org A jobs -> quota recovers and new submission succeeds
    await prisma.job.updateMany({
      where: { queueId: queueAId },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
    const afterRecovery = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'recovered' } });
    expect(afterRecovery.status).toBe(201);

    // Reset Org A quotas to null for subsequent queue backpressure test
    await request(app)
      .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ maxOutstandingJobs: null, maxPayloadBytes: null });
    await prisma.job.updateMany({
      where: { queueId: queueAId },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
  });

  it('enforces queue-specific backpressure (depth and oldest pending age) and recovers when drained', async () => {
    const qCfg = await request(app)
      .patch(`/api/v1/organisations/${orgAId}/queues/${queueAId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ maxQueueDepth: 2, backpressureMaxAgeMs: 60_000 });
    expect(qCfg.status).toBe(200);
    expect(qCfg.body.data.queue.maxQueueDepth).toBe(2);

    // Fill queue depth to 2
    for (let i = 0; i < 2; i += 1) {
      const r = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'echo', payload: { message: `bp-${i}` } });
      expect(r.status).toBe(201);
    }

    // 3rd job rejected by queue backpressure
    const rejected = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'bp-overflow' } });
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.details.reason).toBe('QUEUE_BACKPRESSURE_DEPTH');

    // Governance view reflects REJECTING status
    const gov = await request(app)
      .get(`/api/v1/organisations/${orgAId}/governance`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(gov.status).toBe(200);
    expect(gov.body.data.governance.backpressure.queues[0].status).toBe('REJECTING');

    // Drain jobs -> backpressure recovers to NORMAL
    await prisma.job.updateMany({
      where: { queueId: queueAId },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
    const recovered = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'bp-recovered' } });
    expect(recovered.status).toBe(201);

    // Reset queue backpressure
    await request(app)
      .patch(`/api/v1/organisations/${orgAId}/queues/${queueAId}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ maxQueueDepth: null, backpressureMaxAgeMs: null });
    await prisma.job.updateMany({
      where: { queueId: queueAId },
      data: { status: JobStatus.COMPLETED, completedAt: new Date() },
    });
  });

  it('enforces rolling-window retry budgets and exposes budget exhaustion metrics', async () => {
    // Configure org retry budget = 2 retries per 300s
    await request(app)
      .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ retryBudgetMaxRetries: 2, retryBudgetWindowSeconds: 300 });

    // Before retries, budget allows
    const check0 = await governanceService.evaluateRetryBudget(orgAId, queueAId);
    expect(check0.allowed).toBe(true);

    // Record 2 JOB_RETRIED events
    await prisma.platformEvent.createMany({
      data: [
        {
          type: PlatformEventType.JOB_RETRIED,
          organisationId: orgAId,
          queueId: queueAId,
          message: 'retry 1',
        },
        {
          type: PlatformEventType.JOB_RETRIED,
          organisationId: orgAId,
          queueId: queueAId,
          message: 'retry 2',
        },
      ],
    });

    // Now budget is exhausted (2/2)
    const checkExhausted = await governanceService.evaluateRetryBudget(orgAId, queueAId);
    expect(checkExhausted.allowed).toBe(false);
    expect(checkExhausted.scope).toBe('organisation');
    expect(checkExhausted.used).toBe(2);
    expect(checkExhausted.limit).toBe(2);

    // Reset org budget
    await request(app)
      .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ retryBudgetMaxRetries: null });
  });

  it('classifies poison jobs deterministically, quarantines into DLQ, enforces RBAC on manual release, and reports monitoring metrics', async () => {
    // Normalized signature ignores volatile UUIDs & timestamps
    const sig1 = computeFailureSignature(
      'billing.charge',
      'Timeout for order 123e4567-e89b-12d3-a456-426614174000 at 2026-11-23T10:00:00Z code 504',
    );
    const sig2 = computeFailureSignature(
      'billing.charge',
      'Timeout for order 999e4567-e89b-12d3-a456-426614174999 at 2026-11-23T12:34:56Z code 502',
    );
    expect(sig1).toBe(sig2);

    // Single transient failure is NOT poison
    const transient1 = classifyPoisonJob({
      jobName: 'billing.charge',
      errorMessage: 'Transient network reset 1',
      isNonRetryable: false,
      previousSignature: null,
      previousConsecutiveSameFailures: 0,
      poisonFailureThreshold: 3,
      stalledCount: 0,
    });
    expect(transient1.isPoison).toBe(false);
    expect(transient1.consecutiveSameFailures).toBe(1);

    // 3rd consecutive identical failure signature triggers poison quarantine
    const poison3 = classifyPoisonJob({
      jobName: 'billing.charge',
      errorMessage: 'Transient network reset 99',
      isNonRetryable: false,
      previousSignature: transient1.failureSignature,
      previousConsecutiveSameFailures: 2,
      poisonFailureThreshold: 3,
      stalledCount: 0,
    });
    expect(poison3.isPoison).toBe(true);
    expect(poison3.quarantineReason).toContain('Repeated identical failure signature');

    // Persist a quarantined job via jobService.markJobFailed
    const job = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'echo',
        payload: { message: 'poison-test' },
        status: JobStatus.PENDING,
      },
    });
    const act = await jobService.markJobActive(orgAId, job.id, 3, 'worker-gov');
    expect(act.outcome).toBe('activated');
    if (act.outcome !== 'activated') return;

    await jobService.markJobFailed(orgAId, job.id, 'Deterministic crash', 3, {
      workerId: 'worker-gov',
      fencingToken: act.fencingToken,
      routeToDlq: true,
      quarantine: {
        isQuarantined: true,
        quarantineReason: poison3.quarantineReason,
        failureSignature: poison3.failureSignature,
        consecutiveSameFailures: 3,
      },
    });

    const dlqRecord = await prisma.deadLetterJob.findUnique({ where: { originalJobId: job.id } });
    expect(dlqRecord).not.toBeNull();
    expect(dlqRecord?.isQuarantined).toBe(true);
    expect(dlqRecord?.failureSignature).toBe(poison3.failureSignature);

    // Monitoring metrics reflect admission rejections + quarantinedOpen
    const metricsRes = await request(app)
      .get(`/api/v1/organisations/${orgAId}/monitoring/metrics?windowMinutes=60`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(metricsRes.status).toBe(200);
    expect(
      metricsRes.body.data.metrics.reliability.admissionRejectionsInWindow,
    ).toBeGreaterThanOrEqual(1);
    expect(metricsRes.body.data.metrics.reliability.quarantinedOpen).toBeGreaterThanOrEqual(1);

    // MEMBER cannot manually release/replay a quarantined job (403)
    const memberReplay = await request(app)
      .post(`/api/v1/organisations/${orgAId}/dlq/${dlqRecord!.id}/replay`)
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({});
    expect(memberReplay.status).toBe(403);

    // OWNER can release/replay quarantined job -> emits JOB_QUARANTINE_RELEASED
    const ownerReplay = await request(app)
      .post(`/api/v1/organisations/${orgAId}/dlq/${dlqRecord!.id}/replay`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({});
    expect(ownerReplay.status).toBe(201);

    const releaseEvt = await prisma.platformEvent.findFirst({
      where: {
        organisationId: orgAId,
        type: PlatformEventType.JOB_QUARANTINE_RELEASED,
        jobId: ownerReplay.body.data.replayedJob.id,
      },
    });
    expect(releaseEvt).not.toBeNull();
  });

  it('does not treat maxActiveJobs as an admission-time rejection on valid queued submissions', async () => {
    // Configure maxActiveJobs = 1 with no other admission caps
    await prisma.organisation.update({
      where: { id: orgAId },
      data: {
        maxOutstandingJobs: null,
        maxActiveJobs: 1,
        maxQueuedJobs: null,
        maxDelayedJobs: null,
        maxPayloadBytes: null,
      },
    });
    await prisma.queue.update({
      where: { id: queueAId },
      data: { maxQueueDepth: null, backpressureMaxAgeMs: null },
    });

    // Seed 1 ACTIVE job and 2 PENDING jobs (so active >= maxActiveJobs and queued >= maxActiveJobs)
    const activeJob = await prisma.job.create({
      data: { queueId: queueAId, name: 'echo', payload: { m: 'a' }, status: JobStatus.ACTIVE },
    });
    const pending1 = await prisma.job.create({
      data: { queueId: queueAId, name: 'echo', payload: { m: 'p1' }, status: JobStatus.PENDING },
    });
    const pending2 = await prisma.job.create({
      data: { queueId: queueAId, name: 'echo', payload: { m: 'p2' }, status: JobStatus.PENDING },
    });

    // Valid queued submission must STILL be accepted (201), not blocked by maxActiveJobs
    const submitRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'echo', payload: { message: 'queued-allowed' } });
    expect(submitRes.status).toBe(201);

    // Governance overview still exposes maxActiveJobs limit and current active count
    const overviewRes = await request(app)
      .get(`/api/v1/organisations/${orgAId}/governance`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.data.governance.quotas.maxActiveJobs).toBe(1);
    expect(overviewRes.body.data.governance.usage.activeJobs).toBeGreaterThanOrEqual(1);

    // Clean up seeded jobs
    await prisma.job.deleteMany({
      where: { id: { in: [activeJob.id, pending1.id, pending2.id, submitRes.body.data.job.id] } },
    });
    await prisma.organisation.update({
      where: { id: orgAId },
      data: { maxActiveJobs: null },
    });
  });

  it('enforces tenant quotas on DLQ replay and scheduled job materialization (no bypass)', async () => {
    // Clear existing outstanding jobs in Org A and set maxOutstandingJobs = 1
    await prisma.job.updateMany({
      where: {
        queue: { organisationId: orgAId },
        status: { in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED, JobStatus.PAUSED] },
      },
      data: { status: JobStatus.COMPLETED },
    });
    await prisma.organisation.update({
      where: { id: orgAId },
      data: {
        maxOutstandingJobs: 1,
        maxQueuedJobs: null,
        maxDelayedJobs: null,
        maxPayloadBytes: null,
      },
    });

    // Occupy the single quota slot
    const blocker = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'echo',
        payload: { blocker: true },
        status: JobStatus.PENDING,
      },
    });

    // 1. DLQ replay must be rejected with 429
    const failedJob = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'echo',
        payload: { from: 'dlq' },
        status: JobStatus.PENDING,
      },
    });
    const failedAct = await jobService.markJobActive(orgAId, failedJob.id, 1, 'worker-dlq-quota');
    expect(failedAct.outcome).toBe('activated');
    if (failedAct.outcome !== 'activated') return;
    await jobService.markJobFailed(orgAId, failedJob.id, 'Failed previously', 1, {
      workerId: 'worker-dlq-quota',
      fencingToken: failedAct.fencingToken,
      routeToDlq: true,
    });
    const dlqEntry = await prisma.deadLetterJob.findUnique({
      where: { originalJobId: failedJob.id },
    });
    expect(dlqEntry).not.toBeNull();
    const replayRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/dlq/${dlqEntry!.id}/replay`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({});
    expect(replayRes.status).toBe(429);

    // 2. Near-term ONE_TIME schedule creation must be rejected with 429
    const nearRunAt = new Date(Date.now() + 60_000).toISOString();
    const schedRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/schedules`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        queueId: queueAId,
        name: `quota-onetime-${suffix}`,
        type: 'ONE_TIME',
        jobName: 'echo',
        payload: { message: 'scheduled' },
        runAt: nearRunAt,
      });
    expect(schedRes.status).toBe(429);

    // 3. Due RECURRING schedule tick must enforce quota (skip materialization, create no job)
    const pastSlot = new Date(Date.now() - 10_000);
    const recurring = await prisma.schedule.create({
      data: {
        organisationId: orgAId,
        queueId: queueAId,
        name: `quota-recurring-${suffix}`,
        type: ScheduleType.RECURRING,
        status: ScheduleStatus.ACTIVE,
        jobName: 'echo',
        payload: { message: 'recurring' },
        cronExpression: '* * * * *',
        timezone: 'UTC',
        nextRunAt: pastSlot,
        createdById: ownerA.id,
      },
    });

    const beforeCount = await prisma.job.count({ where: { queueId: queueAId } });
    const tickSummary = await scheduleDispatcherService.tick(new Date(), {
      organisationId: orgAId,
    });
    const afterCount = await prisma.job.count({ where: { queueId: queueAId } });

    expect(afterCount).toBe(beforeCount);
    expect(tickSummary.dispatched).toBe(0);
    expect(tickSummary.skippedConcurrency).toBeGreaterThanOrEqual(1);

    const skippedExec = await prisma.scheduleExecution.findFirst({
      where: { scheduleId: recurring.id, status: ScheduleExecutionStatus.SKIPPED_CONCURRENCY },
    });
    expect(skippedExec).not.toBeNull();
    expect(skippedExec?.reason).toContain('Admission rejected');

    // Clean up
    await prisma.schedule.delete({ where: { id: recurring.id } });
    await prisma.job.delete({ where: { id: blocker.id } });
    await prisma.organisation.update({
      where: { id: orgAId },
      data: { maxOutstandingJobs: null },
    });
  });

  it('enforces retry budgets atomically under concurrent retry transitions', async () => {
    // Clear prior JOB_RETRIED events in Org A and configure retryBudgetMaxRetries = 1
    await prisma.platformEvent.deleteMany({
      where: { organisationId: orgAId, type: PlatformEventType.JOB_RETRIED },
    });
    await prisma.organisation.update({
      where: { id: orgAId },
      data: { retryBudgetMaxRetries: 1, retryBudgetWindowSeconds: 300 },
    });
    await prisma.queue.update({
      where: { id: queueAId },
      data: { retryBudgetMaxRetries: null },
    });

    const job1 = await prisma.job.create({
      data: { queueId: queueAId, name: 'echo', payload: { c: 1 }, status: JobStatus.PENDING },
    });
    const job2 = await prisma.job.create({
      data: { queueId: queueAId, name: 'echo', payload: { c: 2 }, status: JobStatus.PENDING },
    });

    const act1 = await jobService.markJobActive(orgAId, job1.id, 1, 'worker-c1');
    const act2 = await jobService.markJobActive(orgAId, job2.id, 1, 'worker-c2');
    expect(act1.outcome).toBe('activated');
    expect(act2.outcome).toBe('activated');
    if (act1.outcome !== 'activated' || act2.outcome !== 'activated') return;

    // Fire both retry transitions concurrently against budget = 1
    const [res1, res2] = await Promise.all([
      jobService.markJobRetryScheduled(orgAId, job1.id, 'Transient error 1', 1, {
        workerId: 'worker-c1',
        fencingToken: act1.fencingToken,
        enforceRetryBudget: true,
      }),
      jobService.markJobRetryScheduled(orgAId, job2.id, 'Transient error 2', 1, {
        workerId: 'worker-c2',
        fencingToken: act2.fencingToken,
        enforceRetryBudget: true,
      }),
    ]);

    const outcomes = [res1.outcome, res2.outcome].sort();
    expect(outcomes).toEqual(['retry_budget_exhausted', 'updated']);

    const retryEventsCount = await prisma.platformEvent.count({
      where: { organisationId: orgAId, type: PlatformEventType.JOB_RETRIED },
    });
    expect(retryEventsCount).toBe(1);

    // Clean up
    await prisma.organisation.update({
      where: { id: orgAId },
      data: { retryBudgetMaxRetries: null },
    });
  });

  it('never auto-redispatches quarantined jobs via outbox reconciliation', async () => {
    const quarantinedJob = await prisma.job.create({
      data: {
        queueId: queueAId,
        name: 'echo',
        payload: { poisoned: true },
        status: JobStatus.PENDING,
        isQuarantined: true,
        quarantinedAt: new Date(),
        quarantineReason: 'Poison job quarantined',
      },
    });
    const outbox = await prisma.jobDispatchOutbox.create({
      data: {
        jobId: quarantinedJob.id,
        queueId: queueAId,
        organisationId: orgAId,
        status: OutboxStatus.PENDING,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });

    await outboxReconciler.reconcileOnce();

    const updatedOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { id: outbox.id } });
    expect(updatedOutbox?.status).toBe(OutboxStatus.CANCELLED);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  JobDispatchState,
  JobStatus,
  OutboxStatus,
  ScheduleStatus,
  ScheduleType,
  SchedulingPolicy,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { jobService } from '../src/services/job.service.js';
import { outboxReconciler } from '../src/services/outboxReconciler.service.js';
import {
  computeVirtualRankAt,
  createBullMQDispatchAdapter,
  prioritySchedulerService,
} from '../src/services/priorityScheduler.service.js';
import { scheduleDispatcherService } from '../src/services/scheduleDispatcher.service.js';

describe('Phase 8.3.2 — Production Scheduler Integration (PostgreSQL + Redis/BullMQ)', () => {
  const suffix = `p832_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let ownerToken = '';
  let orgId = '';
  let legacyQueueId = '';
  let fifoQueueId = '';
  let strictQueueId = '';
  let agingQueueId = '';
  let quotaOrgId = '';
  let quotaQueue1Id = '';
  let quotaQueue2Id = '';

  beforeAll(async () => {
    const email = `p832_owner_${suffix}@pulsequeue.dev`;
    const password = 'SecurePassword123!';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'P832 Owner', email, password });
    expect(reg.status).toBe(201);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    ownerToken = login.body.data.accessToken;

    const orgRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: `P832 Org ${suffix}` });
    expect(orgRes.status).toBe(201);
    orgId = orgRes.body.data.organisation.id;

    const mkQueue = async (body: Record<string, unknown>) => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body);
      expect(res.status).toBe(201);
      return res.body.data.queue.id as string;
    };

    legacyQueueId = await mkQueue({ name: `legacy-${suffix}`, concurrency: 2 });
    fifoQueueId = await mkQueue({
      name: `fifo-${suffix}`,
      concurrency: 2,
      schedulingPolicy: SchedulingPolicy.FIFO,
    });
    strictQueueId = await mkQueue({
      name: `strict-${suffix}`,
      concurrency: 2,
      schedulingPolicy: SchedulingPolicy.STRICT_PRIORITY,
    });
    agingQueueId = await mkQueue({
      name: `aging-${suffix}`,
      concurrency: 2,
      schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      agingRatePerSec: 0.05,
      maxEffectivePriority: 25.0,
      starvationThresholdSec: 300,
    });

    // Dedicated org with maxActiveJobs = 2 across two queues
    const qOrg = await prisma.organisation.create({
      data: { name: `P832 Quota Org ${suffix}`, maxActiveJobs: 2 },
    });
    quotaOrgId = qOrg.id;
    const qq1 = await prisma.queue.create({
      data: {
        organisationId: quotaOrgId,
        name: `q1-${suffix}`,
        concurrency: 5,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      },
    });
    const qq2 = await prisma.queue.create({
      data: {
        organisationId: quotaOrgId,
        name: `q2-${suffix}`,
        concurrency: 5,
        schedulingPolicy: SchedulingPolicy.STRICT_PRIORITY,
      },
    });
    quotaQueue1Id = qq1.id;
    quotaQueue2Id = qq2.id;
  });

  afterAll(async () => {
    prioritySchedulerService.stop();
    await prisma.organisation.deleteMany({ where: { id: { in: [orgId, quotaOrgId] } } });
    await bullMQService.closeAll();
  });

  it('preserves direct BullMQ dispatch for LEGACY_BULLMQ queues', async () => {
    const res = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${legacyQueueId}/jobs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'echo', payload: { message: 'legacy-direct' }, priority: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data.dispatch.enqueued).toBe(true);

    const jobId = res.body.data.job.id as string;
    const [jobRow, outboxRow] = await Promise.all([
      prisma.job.findUnique({ where: { id: jobId } }),
      prisma.jobDispatchOutbox.findUnique({ where: { jobId } }),
    ]);
    expect(jobRow?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(outboxRow?.status).toBe(OutboxStatus.DISPATCHED);
  });

  it('keeps custom-policy submissions QUEUED, enforces bounded concurrency, and dispatches in FIFO / STRICT_PRIORITY / PRIORITY_AGING order', async () => {
    // Submit 3 jobs to STRICT_PRIORITY queue (concurrency = 2): P=2, P=18, P=10
    const sLow = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${strictQueueId}/jobs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'echo', payload: { message: 'low' }, priority: 2 });
    const sHigh = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${strictQueueId}/jobs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'echo', payload: { message: 'high' }, priority: 18 });
    const sMid = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${strictQueueId}/jobs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'echo', payload: { message: 'mid' }, priority: 10 });

    expect(sLow.status).toBe(201);
    expect(sHigh.status).toBe(201);
    expect(sMid.status).toBe(201);
    // Custom policy must NOT enqueue directly on HTTP submit
    expect(sLow.body.data.dispatch.enqueued).toBe(false);

    const lowId = sLow.body.data.job.id as string;
    const highId = sHigh.body.data.job.id as string;
    const midId = sMid.body.data.job.id as string;

    // Outbox reconciliation must NOT bypass custom scheduling
    await outboxReconciler.reconcileOnce();
    const stillQueued = await prisma.job.count({
      where: { queueId: strictQueueId, dispatchState: JobDispatchState.QUEUED },
    });
    expect(stillQueued).toBe(3);

    // Tick scheduler -> queue concurrency is 2, so ONLY top 2 (highId, midId) dispatch to BullMQ
    const tick1 = await prioritySchedulerService.tickAllQueues({
      queueId: strictQueueId,
      claimerId: 'sched-strict-1',
    });
    expect(tick1.dispatched).toBe(2);

    const [rHigh, rMid, rLow] = await Promise.all([
      prisma.job.findUnique({ where: { id: highId } }),
      prisma.job.findUnique({ where: { id: midId } }),
      prisma.job.findUnique({ where: { id: lowId } }),
    ]);
    expect(rHigh?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(rMid?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(rLow?.dispatchState).toBe(JobDispatchState.QUEUED);

    // Second tick while 2 jobs remain PENDING+DISPATCHED must NOT exceed queue concurrency (2)
    const tick2 = await prioritySchedulerService.tickAllQueues({
      queueId: strictQueueId,
      claimerId: 'sched-strict-2',
    });
    expect(tick2.dispatched).toBe(0);

    // Complete highId -> frees 1 slot -> lowId now dispatches
    await prisma.job.update({ where: { id: highId }, data: { status: JobStatus.COMPLETED } });
    const tick3 = await prioritySchedulerService.tickAllQueues({
      queueId: strictQueueId,
      claimerId: 'sched-strict-3',
    });
    expect(tick3.dispatched).toBe(1);
    const rLowAfter = await prisma.job.findUnique({ where: { id: lowId } });
    expect(rLowAfter?.dispatchState).toBe(JobDispatchState.DISPATCHED);

    // Clean up
    await prisma.job.deleteMany({ where: { queueId: strictQueueId } });
  });

  it('never dispatches delayed custom-policy jobs early and promotes them once readyAt <= now', async () => {
    const delayedRes = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${fifoQueueId}/jobs`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'echo', payload: { message: 'delayed' }, delayMs: 60_000 });
    expect(delayedRes.status).toBe(201);
    const delayedId = delayedRes.body.data.job.id as string;

    const earlyTick = await prioritySchedulerService.tickAllQueues({
      queueId: fifoQueueId,
      claimerId: 'sched-delay-early',
    });
    expect(earlyTick.dispatched).toBe(0);
    const beforeDue = await prisma.job.findUnique({ where: { id: delayedId } });
    expect(beforeDue?.status).toBe(JobStatus.DELAYED);
    expect(beforeDue?.dispatchState).toBe(JobDispatchState.QUEUED);

    // Advance virtual clock past readyAt -> scheduler promotes DELAYED -> PENDING and dispatches
    const futureNow = new Date(Date.now() + 120_000);
    const dueTick = await prioritySchedulerService.tickAllQueues({
      queueId: fifoQueueId,
      claimerId: 'sched-delay-due',
      now: futureNow,
    });
    expect(dueTick.dispatched).toBe(1);

    const afterDue = await prisma.job.findUnique({ where: { id: delayedId } });
    expect(afterDue?.status).toBe(JobStatus.PENDING);
    expect(afterDue?.dispatchState).toBe(JobDispatchState.DISPATCHED);

    await prisma.job.deleteMany({ where: { queueId: fifoQueueId } });
  });

  it('routes DLQ replay and one-time / recurring scheduled jobs through custom scheduling without bypass', async () => {
    // 1. DLQ replay on custom agingQueueId
    const origJob = await prisma.job.create({
      data: {
        queueId: agingQueueId,
        name: 'echo',
        payload: { message: 'dlq-custom' },
        status: JobStatus.PENDING,
        dispatchState: JobDispatchState.DISPATCHED,
      },
    });
    const act = await jobService.markJobActive(orgId, origJob.id, 1, 'w-dlq');
    expect(act.outcome).toBe('activated');
    if (act.outcome !== 'activated') return;
    await jobService.markJobFailed(orgId, origJob.id, 'Boom', 1, {
      workerId: 'w-dlq',
      fencingToken: act.fencingToken,
      routeToDlq: true,
    });
    const dlq = await prisma.deadLetterJob.findUniqueOrThrow({
      where: { originalJobId: origJob.id },
    });

    const replayRes = await request(app)
      .post(`/api/v1/organisations/${orgId}/dlq/${dlq.id}/replay`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(replayRes.status).toBe(201);
    expect(replayRes.body.data.dispatch.enqueued).toBe(false);

    const replayedId = replayRes.body.data.replayedJob.id as string;
    const replayedRow = await prisma.job.findUnique({ where: { id: replayedId } });
    expect(replayedRow?.dispatchState).toBe(JobDispatchState.QUEUED);

    // 2. Near-term ONE_TIME schedule on custom agingQueueId
    const futureRunAt = new Date(Date.now() + 60_000).toISOString();
    const oneTimeRes = await request(app)
      .post(`/api/v1/organisations/${orgId}/schedules`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        queueId: agingQueueId,
        name: `custom-onetime-${suffix}`,
        type: 'ONE_TIME',
        jobName: 'echo',
        payload: { message: 'sched-onetime' },
        runAt: futureRunAt,
      });
    expect(oneTimeRes.status).toBe(201);
    const oneTimeJobId = oneTimeRes.body.data.initialJobId as string;
    const oneTimeJob = await prisma.job.findUnique({ where: { id: oneTimeJobId } });
    expect(oneTimeJob?.status).toBe(JobStatus.DELAYED);
    expect(oneTimeJob?.dispatchState).toBe(JobDispatchState.QUEUED);

    // 3. Due RECURRING schedule on custom agingQueueId
    // Anchor nextRunAt to the start of the current UTC minute so it is always <= now
    // while the next `* * * * *` occurrence is strictly > now (immune to minute-boundary SKIP_MISSED).
    const currentMinuteStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const recurring = await prisma.schedule.create({
      data: {
        organisationId: orgId,
        queueId: agingQueueId,
        name: `custom-recurring-${suffix}`,
        type: ScheduleType.RECURRING,
        status: ScheduleStatus.ACTIVE,
        jobName: 'echo',
        payload: { message: 'sched-recurring' },
        cronExpression: '* * * * *',
        timezone: 'UTC',
        nextRunAt: currentMinuteStart,
      },
    });
    await scheduleDispatcherService.tick(new Date(), { organisationId: orgId });
    const recExec = await prisma.scheduleExecution.findFirst({
      where: { scheduleId: recurring.id },
      include: { job: true },
    });
    expect(recExec?.job?.dispatchState).toBe(JobDispatchState.QUEUED);

    // Now scheduler tick dispatches replayed + recurring (2 slots = concurrency 2),
    // while future one-time job stays DELAYED + QUEUED!
    const tick = await prioritySchedulerService.tickAllQueues({
      queueId: agingQueueId,
      claimerId: 'sched-dlq-sched',
    });
    expect(tick.dispatched).toBe(2);
    const oneTimeAfter = await prisma.job.findUnique({ where: { id: oneTimeJobId } });
    expect(oneTimeAfter?.dispatchState).toBe(JobDispatchState.QUEUED);

    await prisma.schedule.deleteMany({ where: { queueId: agingQueueId } });
    await prisma.job.deleteMany({ where: { queueId: agingQueueId } });
  });

  it('enforces Organisation.maxActiveJobs across two queues including dispatched-but-not-yet-active jobs and concurrent schedulers', async () => {
    const now = new Date();
    for (const qId of [quotaQueue1Id, quotaQueue2Id]) {
      for (let i = 0; i < 4; i += 1) {
        const readyAt = new Date(now.getTime() - (i + 1) * 1000);
        await prisma.job.create({
          data: {
            queueId: qId,
            name: 'echo',
            payload: { message: `q-${i}` },
            status: JobStatus.PENDING,
            priority: 10,
            dispatchState: JobDispatchState.QUEUED,
            readyAt,
            virtualRankAt: computeVirtualRankAt(readyAt, 10, 0.05),
          },
        });
      }
    }

    // 3 concurrent scheduler processes ticking the same organisation (maxActiveJobs = 2)
    const ticks = await Promise.all([
      prioritySchedulerService.tickAllQueues({
        organisationId: quotaOrgId,
        claimerId: 'proc-a',
        now,
      }),
      prioritySchedulerService.tickAllQueues({
        organisationId: quotaOrgId,
        claimerId: 'proc-b',
        now,
      }),
      prioritySchedulerService.tickAllQueues({
        organisationId: quotaOrgId,
        claimerId: 'proc-c',
        now,
      }),
    ]);

    const totalDispatched = ticks.reduce((sum, t) => sum + t.dispatched, 0);
    expect(totalDispatched).toBe(2);

    // Another tick while those 2 jobs are PENDING+DISPATCHED (not yet ACTIVE) MUST dispatch 0!
    const followUp = await prioritySchedulerService.tickAllQueues({
      organisationId: quotaOrgId,
      claimerId: 'proc-d',
      now,
    });
    expect(followUp.dispatched).toBe(0);
    expect(followUp.orgCapacityDenials).toBeGreaterThanOrEqual(1);

    const obs = prioritySchedulerService.getObservabilitySnapshot();
    expect(obs.orgCapacityDenialsTotal).toBeGreaterThanOrEqual(1);
    expect(obs.dispatchesTotal).toBeGreaterThanOrEqual(2);
  });

  it('handles crash-after-claim, crash-after-enqueue-before-DB-update, and protects live claims during recovery', async () => {
    const now = new Date();
    const queueRow = await prisma.queue.findUniqueOrThrow({ where: { id: fifoQueueId } });
    const adapter = createBullMQDispatchAdapter(bullMQService);

    // 1. Live claim must NOT be stolen by stale recovery
    const liveJob = await prisma.job.create({
      data: {
        queueId: fifoQueueId,
        name: 'echo',
        payload: { message: 'live-claim' },
        status: JobStatus.PENDING,
        dispatchState: JobDispatchState.DISPATCHING,
        dispatchClaimedAt: new Date(now.getTime() - 1_000), // 1s old (< 15s threshold)
        dispatchClaimedBy: 'live-scheduler',
        readyAt: now,
        virtualRankAt: now,
      },
    });
    const stolen = await prioritySchedulerService.recoverStaleReservations(
      15_000,
      now,
      fifoQueueId,
    );
    expect(stolen).toBe(0);
    const liveCheck = await prisma.job.findUnique({ where: { id: liveJob.id } });
    expect(liveCheck?.dispatchState).toBe(JobDispatchState.DISPATCHING);
    expect(liveCheck?.dispatchClaimedBy).toBe('live-scheduler');
    await prisma.job.delete({ where: { id: liveJob.id } });

    // 2. Crash AFTER BullMQ enqueue but BEFORE DB markDispatched
    const crashJob = await prisma.job.create({
      data: {
        queueId: fifoQueueId,
        name: 'echo',
        payload: { message: 'crash-after-enqueue' },
        status: JobStatus.PENDING,
        dispatchState: JobDispatchState.QUEUED,
        readyAt: new Date(now.getTime() - 5_000),
        virtualRankAt: new Date(now.getTime() - 5_000),
      },
    });
    const claimed = await prioritySchedulerService.claimCandidatesForQueue({
      queueId: fifoQueueId,
      claimerId: 'crashed-proc',
      limit: 1,
      now,
    });
    expect(claimed.claimed).toHaveLength(1);

    // Enqueue succeeds in BullMQ, then process crashes before markDispatched()!
    const enq1 = await adapter.dispatchClaimedJob(queueRow, claimed.claimed[0], 5);
    expect(enq1.enqueued).toBe(true);

    // Backdate claim to simulate stale reservation after crash
    await prisma.job.update({
      where: { id: crashJob.id },
      data: { dispatchClaimedAt: new Date(now.getTime() - 30_000) },
    });

    // Healthy scheduler tick recovers stale claim, re-claims, BullMQ deduplicates on stable jobId,
    // and DB transitions cleanly to DISPATCHED!
    const recoveryTick = await prioritySchedulerService.tickAllQueues({
      queueId: fifoQueueId,
      claimerId: 'healthy-proc',
      now,
    });
    expect(recoveryTick.staleRecovered).toBe(1);
    expect(recoveryTick.dispatched).toBe(1);

    const recoveredRow = await prisma.job.findUnique({ where: { id: crashJob.id } });
    expect(recoveredRow?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(recoveredRow?.dispatchClaimedBy).toBeNull();

    await prisma.job.deleteMany({ where: { queueId: fifoQueueId } });
  });
});

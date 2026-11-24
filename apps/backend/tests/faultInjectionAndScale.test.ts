import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobDispatchState,
  JobStatus,
  OutboxStatus,
  PrismaClient,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
  SchedulingPolicy,
} from '@prisma/client';
import { prisma } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { connectRedis } from '../src/config/redis.js';
import { jobService } from '../src/services/job.service.js';
import { OutboxReconciler } from '../src/services/outboxReconciler.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';
import { StalledJobRecoveryService } from '../src/services/stalledJobRecovery.service.js';
import type { BullMQService } from '../src/services/bullmq.service.js';

describe('Phase 10.3 — Fault Injection, Recovery & Performance Regression Gates', () => {
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
  });

  it('recovers multi-tenant outbox backlog idempotently after simulated Redis outage while preserving tenant isolation', async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organisation.create({ data: { name: `P103 Fault Org A ${Date.now()}` } }),
      prisma.organisation.create({ data: { name: `P103 Fault Org B ${Date.now()}` } }),
    ]);
    createdOrgIds.push(orgA.id, orgB.id);

    const [qA, qB] = await Promise.all([
      prisma.queue.create({
        data: {
          organisationId: orgA.id,
          name: `p103-redis-a-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
        },
      }),
      prisma.queue.create({
        data: {
          organisationId: orgB.id,
          name: `p103-redis-b-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
        },
      }),
    ]);

    const past = new Date(Date.now() - 5000);
    const createdIds: string[] = [];
    for (const [org, q] of [
      [orgA, qA],
      [orgB, qB],
    ] as const) {
      for (let i = 0; i < 4; i++) {
        const job = await prisma.job.create({
          data: {
            queueId: q.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 5,
            payload: { message: `${org.id}-${i}` },
            dispatchState: JobDispatchState.DISPATCHED,
            readyAt: past,
            virtualRankAt: past,
          },
        });
        createdIds.push(job.id);
        await prisma.jobDispatchOutbox.create({
          data: {
            jobId: job.id,
            queueId: q.id,
            organisationId: org.id,
            status: OutboxStatus.PENDING,
            nextAttemptAt: past,
          },
        });
      }
    }

    // 1. Simulated Redis outage: enqueueJob fails -> outbox stays PENDING with backoff
    let redisOnline = false;
    const enqueuedByOrg = new Map<string, Set<string>>();
    const faultBullMQ = {
      enqueueJob: async (q: { organisationId: string }, job: { id: string }) => {
        if (!redisOnline) {
          return { enqueued: false, deduplicated: false, error: 'ECONNREFUSED Redis down' };
        }
        const set = enqueuedByOrg.get(q.organisationId) ?? new Set<string>();
        const dedup = set.has(job.id);
        set.add(job.id);
        enqueuedByOrg.set(q.organisationId, set);
        return { enqueued: true, deduplicated: dedup };
      },
    } as unknown as BullMQService;

    const reconciler = new OutboxReconciler({
      bullMQ: faultBullMQ,
      batchSize: 50,
      baseBackoffMs: 10,
      maxBackoffMs: 50,
    });
    const duringOutage = await reconciler.reconcileOnce(50);
    expect(duringOutage.failed).toBeGreaterThanOrEqual(8);

    const stillPending = await prisma.jobDispatchOutbox.count({
      where: { jobId: { in: createdIds }, status: OutboxStatus.PENDING },
    });
    expect(stillPending).toBe(8);

    // 2. Redis recovers -> reset nextAttemptAt due now and reconcile cleanly
    redisOnline = true;
    await prisma.jobDispatchOutbox.updateMany({
      where: { jobId: { in: createdIds } },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await reconciler.reconcileOnce(50);
    const dispatchedRows = await prisma.jobDispatchOutbox.findMany({
      where: { jobId: { in: createdIds } },
    });
    expect(dispatchedRows.every((r) => r.status === OutboxStatus.DISPATCHED)).toBe(true);
    expect(enqueuedByOrg.get(orgA.id)?.size).toBe(4);
    expect(enqueuedByOrg.get(orgB.id)?.size).toBe(4);
  });

  it('recovers stalled ACTIVE job after simulated worker crash, enforces fencing tokens, and preserves poison-job quarantine', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P103 Worker Crash Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p103-crash-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 5,
      },
    });

    const past = new Date(Date.now() - 5000);
    const fields = buildInitialSchedulingFields(queue, 5, 0, past);

    const [normalJob, poisonJob] = await Promise.all([
      prisma.job.create({
        data: {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: 'crash-recover' },
          dispatchState: JobDispatchState.DISPATCHED,
          readyAt: past,
          virtualRankAt: fields.virtualRankAt,
        },
      }),
      prisma.job.create({
        data: {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.FAILED,
          priority: 5,
          payload: {},
          isQuarantined: true,
          quarantineReason: 'Poison payload',
          dispatchState: JobDispatchState.QUEUED,
          readyAt: past,
          virtualRankAt: fields.virtualRankAt,
        },
      }),
    ]);

    // Worker A activates normalJob with a short lease, then crashes
    const actA = await jobService.markJobActive(org.id, normalJob.id, 1, 'worker-crashed-A', {
      leaseDurationMs: 1_000,
    });
    expect(actA.outcome).toBe('activated');
    if (actA.outcome !== 'activated') throw new Error('expected activated');
    expect(actA.fencingToken).toBe(1);

    // Force lease expiry to simulate worker crash without arbitrary sleep
    await prisma.job.update({
      where: { id: normalJob.id },
      data: { leaseExpiresAt: new Date(Date.now() - 5_000) },
    });

    const mockBullMQ = {
      getBullJobState: async () => 'unknown',
      enqueueJob: async () => ({ enqueued: true, deduplicated: false }),
      removeJobFromBullMQ: async () => {},
    } as unknown as BullMQService;

    const recovery = new StalledJobRecoveryService({
      bullMQ: mockBullMQ,
      staleActiveThresholdMs: 1_000,
      maxStalledRecoveries: 3,
    });
    const recSummary = await recovery.recoverStalledJobs({ organisationId: org.id });
    expect(recSummary.recovered).toBe(1);

    const afterRec = await prisma.job.findUnique({ where: { id: normalJob.id } });
    expect(afterRec?.status).toBe(JobStatus.PENDING);
    expect(afterRec?.dispatchState).toBe(JobDispatchState.QUEUED);
    expect(afterRec?.fencingToken).toBe(2);

    // Worker B activates and completes the recovered job (fencingToken = 3)
    const actB = await jobService.markJobActive(org.id, normalJob.id, 2, 'worker-healthy-B');
    expect(actB.outcome).toBe('activated');
    if (actB.outcome !== 'activated') throw new Error('expected activated');
    expect(actB.fencingToken).toBe(3);

    // Stale Worker A wakes up and attempts completion with old fencingToken=1 -> REJECTED
    const staleRes = await jobService.markJobCompleted(org.id, normalJob.id, { stale: true }, 1, {
      workerId: 'worker-crashed-A',
      fencingToken: actA.fencingToken,
    });
    expect(staleRes.outcome).toBe('stale_fencing_token');

    // Healthy Worker B completes cleanly
    const validRes = await jobService.markJobCompleted(org.id, normalJob.id, { ok: true }, 2, {
      workerId: 'worker-healthy-B',
      fencingToken: actB.fencingToken,
    });
    expect(validRes.outcome).toBe('updated');

    // Verify quarantined poisonJob is NEVER claimed by PrioritySchedulerService
    const scheduler = new PrioritySchedulerService();
    const claimRes = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 5,
      claimerId: 'p103-poison-check',
    });
    expect(claimRes.claimed.map((c) => c.id)).not.toContain(poisonJob.id);
  });

  it('survives repeated scheduler start/stopAndDrain cycles and enforces structural performance regression gates', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P103 Perf Gate Org ${Date.now()}`, maxActiveJobs: 50 },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p103-gate-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        concurrency: 25,
      },
    });

    const past = new Date(Date.now() - 2000);
    await prisma.job.createMany({
      data: Array.from({ length: 120 }, (_, i) => {
        const fields = buildInitialSchedulingFields(queue, (i % 10) + 1, 0, past);
        return {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: (i % 10) + 1,
          payload: { message: `gate-${i}` },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: past,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });

    // 1. Repeated start / stopAndDrain cycles without leaked timers or stranded state
    const lifecycleSched = new PrioritySchedulerService();
    for (let cycle = 0; cycle < 3; cycle++) {
      lifecycleSched.start({ intervalMs: 200, claimerId: `cycle-${cycle}` });
      expect(lifecycleSched.isRunning()).toBe(true);
      const drain = await lifecycleSched.stopAndDrain(2000);
      expect(drain.drained).toBe(true);
      expect(lifecycleSched.isRunning()).toBe(false);
    }

    // 2. Structural performance regression gate: 4 competing schedulers, zero duplicates,
    //    bounded tick latency, zero leaked reservations, bounded heap growth
    const heapBeforeMb = process.memoryUsage().heapUsed / 1024 ** 2;
    const schedulers = [0, 1, 2, 3].map(() => new PrioritySchedulerService());
    const seenIds = new Set<string>();
    let maxTickMs = 0;

    for (let round = 0; round < 3; round++) {
      const t0 = performance.now();
      const batches = await Promise.all(
        schedulers.map((s, idx) =>
          s.dispatchBatchWithAdapter(
            queue,
            {
              claimerId: `gate-s-${idx}`,
              limit: 15,
              maxInFlightForQueue: 120,
              enforceOrgActiveLimit: true,
            },
            {
              dispatchClaimedJob: async (_q, job) => {
                // Fail every 5th job to verify zero leaked DISPATCHING reservations
                const shouldFail = job.priority === 1;
                return { enqueued: !shouldFail, deduplicated: false };
              },
            },
          ),
        ),
      );
      const elapsed = performance.now() - t0;
      if (elapsed > maxTickMs) maxTickMs = elapsed;

      // Verify zero leaked DISPATCHING reservations after every round
      const stuckDispatching = await prisma.job.count({
        where: { queueId: queue.id, dispatchState: JobDispatchState.DISPATCHING },
      });
      expect(stuckDispatching).toBe(0);

      // Verify org active/dispatched invariant never exceeds maxActiveJobs=50
      const activeOrDispatched = await prisma.job.count({
        where: {
          queue: { organisationId: org.id },
          status: JobStatus.PENDING,
          dispatchState: JobDispatchState.DISPATCHED,
        },
      });
      expect(activeOrDispatched).toBeLessThanOrEqual(50);

      // Complete dispatched jobs for next round and verify no duplicates
      const dispatchedRows = await prisma.job.findMany({
        where: {
          queueId: queue.id,
          status: JobStatus.PENDING,
          dispatchState: JobDispatchState.DISPATCHED,
        },
        select: { id: true },
      });
      for (const r of dispatchedRows) {
        expect(seenIds.has(r.id)).toBe(false);
        seenIds.add(r.id);
      }
      if (dispatchedRows.length > 0) {
        await prisma.job.updateMany({
          where: { id: { in: dispatchedRows.map((r) => r.id) } },
          data: { status: JobStatus.COMPLETED, completedAt: new Date() },
        });
      }
      void batches;
    }

    const heapDeltaMb = process.memoryUsage().heapUsed / 1024 ** 2 - heapBeforeMb;
    // Generous non-brittle CI bounds
    expect(maxTickMs).toBeLessThan(5_000);
    expect(heapDeltaMb).toBeLessThan(64);
    expect(seenIds.size).toBeGreaterThan(0);
  });

  it('recovers cleanly from a controlled PostgreSQL backend connection termination (pg_terminate_backend)', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P103 PG Interrupt Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p103-pg-int-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
      },
    });

    const past = new Date(Date.now() - 2000);
    const fields = buildInitialSchedulingFields(queue, 5, 0, past);
    const job = await prisma.job.create({
      data: {
        queueId: queue.id,
        name: 'echo',
        status: JobStatus.PENDING,
        priority: 5,
        payload: { message: 'survive-pg-interrupt' },
        dispatchState: JobDispatchState.QUEUED,
        readyAt: past,
        virtualRankAt: fields.virtualRankAt,
      },
    });

    // Open a dedicated PrismaClient with a unique application_name and connection_limit=1
    const appName = `pq_fault_pg_${Date.now()}`;
    const dedicatedUrl = new URL(env.DATABASE_URL);
    dedicatedUrl.searchParams.set('application_name', appName);
    dedicatedUrl.searchParams.set('connection_limit', '1');
    const dedicatedClient = new PrismaClient({
      datasources: { db: { url: dedicatedUrl.toString() } },
    });

    try {
      const pidRows = await dedicatedClient.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      const targetPid = pidRows[0]!.pid;
      expect(targetPid).toBeGreaterThan(0);

      // Terminate ONLY this dedicated PostgreSQL backend connection via the admin client
      const termRows = await prisma.$queryRaw<Array<{ terminated: boolean }>>`
        SELECT pg_terminate_backend(${targetPid}::int4) AS terminated
      `;
      expect(termRows[0]?.terminated).toBe(true);

      // First query after pg_terminate_backend must observe the real PG connection closure
      let caughtError: unknown = null;
      try {
        await dedicatedClient.$queryRaw`SELECT 1`;
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).not.toBeNull();

      // Reconnect cleanly and verify a fresh PostgreSQL backend PID is assigned
      await dedicatedClient.$disconnect();
      await dedicatedClient.$connect();
      const newPidRows = await dedicatedClient.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid
      `;
      expect(newPidRows[0]!.pid).not.toBe(targetPid);

      // Verify the durable job can now be claimed, activated, and completed cleanly
      const scheduler = new PrioritySchedulerService();
      const claim = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 5,
        claimerId: 'pg-recovery-sched',
      });
      expect(claim.claimed.map((c) => c.id)).toContain(job.id);
      const act = await jobService.markJobActive(org.id, job.id, 1, 'pg-recovery-worker');
      expect(act.outcome).toBe('activated');
      if (act.outcome !== 'activated') throw new Error('expected activated');
      const done = await jobService.markJobCompleted(org.id, job.id, { recovered: true }, 1, {
        workerId: 'pg-recovery-worker',
        fencingToken: act.fencingToken,
      });
      expect(done.outcome).toBe('updated');
    } finally {
      await dedicatedClient.$disconnect();
    }
  });

  it('drains a significant multi-tenant outbox backlog (120 jobs) across multiple bounded batches without duplicates', async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organisation.create({ data: { name: `P103 Backlog A ${Date.now()}` } }),
      prisma.organisation.create({ data: { name: `P103 Backlog B ${Date.now()}` } }),
    ]);
    createdOrgIds.push(orgA.id, orgB.id);

    const [qA, qB] = await Promise.all([
      prisma.queue.create({
        data: {
          organisationId: orgA.id,
          name: `p103-bl-a-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
        },
      }),
      prisma.queue.create({
        data: {
          organisationId: orgB.id,
          name: `p103-bl-b-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
        },
      }),
    ]);

    const past = new Date(Date.now() - 5000);
    const allJobIds: string[] = [];
    for (const [org, q] of [
      [orgA, qA],
      [orgB, qB],
    ] as const) {
      await prisma.job.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          queueId: q.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: `bl-${i}` },
          dispatchState: JobDispatchState.DISPATCHED,
          readyAt: past,
          virtualRankAt: past,
        })),
      });
      const rows = await prisma.job.findMany({ where: { queueId: q.id }, select: { id: true } });
      allJobIds.push(...rows.map((r) => r.id));
      await prisma.jobDispatchOutbox.createMany({
        data: rows.map((r) => ({
          jobId: r.id,
          queueId: q.id,
          organisationId: org.id,
          status: OutboxStatus.PENDING,
          nextAttemptAt: past,
        })),
      });
    }

    const seenByOrg = new Map<string, Set<string>>();
    const mockBullMQ = {
      enqueueJob: async (q: { organisationId: string }, job: { id: string }) => {
        const set = seenByOrg.get(q.organisationId) ?? new Set<string>();
        const dedup = set.has(job.id);
        set.add(job.id);
        seenByOrg.set(q.organisationId, set);
        return { enqueued: true, deduplicated: dedup };
      },
    } as unknown as BullMQService;

    const reconciler = new OutboxReconciler({ bullMQ: mockBullMQ, batchSize: 40 });
    for (let pass = 0; pass < 5; pass++) {
      const remaining = await prisma.jobDispatchOutbox.count({
        where: { jobId: { in: allJobIds }, status: OutboxStatus.PENDING },
      });
      if (remaining === 0) break;
      await reconciler.reconcileOnce(40);
    }

    const pendingAfter = await prisma.jobDispatchOutbox.count({
      where: { jobId: { in: allJobIds }, status: OutboxStatus.PENDING },
    });
    expect(pendingAfter).toBe(0);
    expect(seenByOrg.get(orgA.id)?.size).toBe(60);
    expect(seenByOrg.get(orgB.id)?.size).toBe(60);
  });

  it('enforces delayed delivery timing, verifies markJobActive PENDING outbox sync, and preserves scheduled telemetry on markJobCompleted', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P103 Delay & HotPath Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p103-delay-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
      },
    });

    const now = new Date();
    const futureReadyAt = new Date(now.getTime() + 250);
    const delayFields = buildInitialSchedulingFields(queue, 5, 250, now);
    const delayedJob = await prisma.job.create({
      data: {
        queueId: queue.id,
        name: 'echo',
        status: JobStatus.DELAYED,
        priority: 5,
        payload: { message: 'delayed-job' },
        delayMs: 250,
        dispatchState: JobDispatchState.QUEUED,
        readyAt: futureReadyAt,
        virtualRankAt: delayFields.virtualRankAt,
      },
    });
    await prisma.jobDispatchOutbox.create({
      data: {
        jobId: delayedJob.id,
        queueId: queue.id,
        organisationId: org.id,
        status: OutboxStatus.PENDING,
        nextAttemptAt: now,
      },
    });

    // Attach a Schedule + ScheduleExecution to verify scheduled telemetry is updated before completion returns
    const schedule = await prisma.schedule.create({
      data: {
        organisationId: org.id,
        queueId: queue.id,
        name: `p103-sched-${Date.now()}`,
        type: ScheduleType.ONE_TIME,
        status: ScheduleStatus.ACTIVE,
        jobName: 'echo',
        payload: { message: 'delayed-job' },
        runAt: futureReadyAt,
        nextRunAt: futureReadyAt,
      },
    });
    const schedExec = await prisma.scheduleExecution.create({
      data: {
        scheduleId: schedule.id,
        jobId: delayedJob.id,
        status: ScheduleExecutionStatus.DISPATCHED,
        scheduledFor: futureReadyAt,
      },
    });

    const scheduler = new PrioritySchedulerService();

    // Before readyAt: must NOT be claimed
    const beforeClaim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 5,
      claimerId: 'delay-sched',
      now,
    });
    expect(beforeClaim.claimed).toHaveLength(0);

    // After readyAt: promotes DELAYED -> PENDING and claims cleanly
    const afterClaim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 5,
      claimerId: 'delay-sched',
      now: new Date(futureReadyAt.getTime() + 100),
    });
    expect(afterClaim.claimed.map((c) => c.id)).toEqual([delayedJob.id]);

    // Simulate worker activating BEFORE markDispatched (outbox is still PENDING) -> markJobActive MUST sync outbox to DISPATCHED
    const act = await jobService.markJobActive(org.id, delayedJob.id, 1, 'delay-worker');
    expect(act.outcome).toBe('activated');
    if (act.outcome !== 'activated') throw new Error('expected activated');

    const outboxAfterAct = await prisma.jobDispatchOutbox.findUnique({
      where: { jobId: delayedJob.id },
    });
    expect(outboxAfterAct?.status).toBe(OutboxStatus.DISPATCHED);

    // Complete job -> ScheduleExecution telemetry MUST be updated to COMPLETED
    const comp = await jobService.markJobCompleted(org.id, delayedJob.id, { ok: true }, 1, {
      workerId: 'delay-worker',
      fencingToken: act.fencingToken,
      durationMs: 42,
    });
    expect(comp.outcome).toBe('updated');

    const execAfterComp = await prisma.scheduleExecution.findUnique({
      where: { id: schedExec.id },
    });
    expect(execAfterComp?.finalJobStatus).toBe(JobStatus.COMPLETED);
    expect(execAfterComp?.completedAt).not.toBeNull();
    expect(execAfterComp?.durationMs).toBe(42);
  });
});

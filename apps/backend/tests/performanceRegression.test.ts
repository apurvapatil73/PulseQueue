import express from 'express';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { JobDispatchState, JobStatus, OutboxStatus, SchedulingPolicy } from '@prisma/client';
import { prisma } from '../src/config/database.js';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { jobService } from '../src/services/job.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';

describe('Phase 10.1 — Bounded Performance & Scalability Regression Suite', () => {
  const createdOrgIds: string[] = [];
  const scheduler = new PrioritySchedulerService();
  const testRedisPrefix = `pq:rl:perf10:${Date.now()}`;

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    const redis = getRedisClient();
    try {
      const keys = await redis.keys(`${testRedisPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // Ignore cleanup errors
    }
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
  });

  it('claims a 50-job batch via single batched PostgreSQL UPDATE preserving schedulingDecision and deadlineMissedAt', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf10 Batch ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-dl-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.DEADLINE_AWARE,
        concurrency: 50,
      },
    });

    const now = new Date();
    await prisma.job.createMany({
      data: Array.from({ length: 50 }, (_, i) => {
        const fields = buildInitialSchedulingFields(queue, (i % 10) + 1, 0, now);
        return {
          queueId: queue.id,
          name: `batch-job-${i}`,
          status: JobStatus.PENDING,
          priority: (i % 10) + 1,
          payload: { i },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
          deadlineAt: new Date(now.getTime() + (i < 5 ? -5000 : (i + 1) * 1000)),
        };
      }),
    });

    const t0 = performance.now();
    const res = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 50,
      claimerId: 'perf10-batch',
      now,
    });
    const elapsedMs = performance.now() - t0;

    expect(res.claimed).toHaveLength(50);
    // Generous regression bound (batched UPDATE typically completes in < 30ms locally)
    expect(elapsedMs).toBeLessThan(2000);

    // Verify batched UPDATE persisted both schedulingDecision and deadlineMissedAt accurately
    const persisted = await prisma.job.findMany({
      where: { queueId: queue.id, dispatchState: JobDispatchState.DISPATCHING },
      select: { schedulingDecision: true, deadlineMissedAt: true },
    });
    expect(persisted).toHaveLength(50);
    expect(persisted.every((j) => j.schedulingDecision !== null)).toBe(true);
    expect(persisted.filter((j) => j.deadlineMissedAt !== null)).toHaveLength(5);
  });

  it('executes Redis EVALSHA distributed rate limiting with exact accounting and bounded latency', async () => {
    const redis = getRedisClient();
    const rlApp = express();
    rlApp.use(
      createRateLimiter({
        name: `perf-evalsha-${Date.now()}`,
        windowMs: 10_000,
        maxRequests: 40,
        failurePolicy: 'fail-closed',
        redisClient: redis,
        alwaysEnforce: true,
        keyPrefix: testRedisPrefix,
      }),
    );
    rlApp.get('/ok', (_req, res) => res.json({ ok: true }));
    rlApp.use(errorHandler);

    const t0 = performance.now();
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const res = await request(rlApp).get('/ok');
      if (res.status === 200) ok++;
      if (res.status === 429) limited++;
    }
    const elapsedMs = performance.now() - t0;

    expect(ok).toBe(40);
    expect(limited).toBe(5);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('maintains bounded heap growth across sustained multi-round claim and dispatch cycles', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf10 Sustained ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-sus-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        concurrency: 20,
      },
    });

    const heapBeforeMb = process.memoryUsage().heapUsed / 1024 ** 2;
    const now = new Date();
    for (let r = 0; r < 5; r++) {
      await prisma.job.createMany({
        data: Array.from({ length: 20 }, (_, i) => {
          const fields = buildInitialSchedulingFields(queue, (i % 20) + 1, 0, now);
          return {
            queueId: queue.id,
            name: `sus-${r}-${i}`,
            status: JobStatus.PENDING,
            priority: (i % 20) + 1,
            payload: { r, i },
            dispatchState: JobDispatchState.QUEUED,
            readyAt: now,
            virtualRankAt: fields.virtualRankAt,
          };
        }),
      });
      const claimed = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 20,
        claimerId: 'perf10-sus',
        now,
      });
      expect(claimed.claimed).toHaveLength(20);
      await scheduler.markDispatched(
        claimed.claimed.map((c) => c.id),
        'perf10-sus',
      );
    }

    const heapDeltaMb = process.memoryUsage().heapUsed / 1024 ** 2 - heapBeforeMb;
    expect(heapDeltaMb).toBeLessThan(50);
  });

  it('handles mixed success/failure parallel dispatch batches cleanly without losing jobs or leaking reservations', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf10 MixedBatch ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-mixed-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 20,
      },
    });

    const now = new Date();
    const createdJobs = [];
    for (let i = 0; i < 12; i++) {
      const fields = buildInitialSchedulingFields(queue, 5, 0, now);
      const job = await prisma.job.create({
        data: {
          queueId: queue.id,
          name: `mix-${i}`,
          status: JobStatus.PENDING,
          priority: 5,
          payload: { idx: i },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
        },
      });
      createdJobs.push(job);
    }

    const mixedAdapter = {
      dispatchClaimedJob: async (_q: unknown, job: { payload: unknown }) => {
        const idx = (job.payload as { idx: number }).idx;
        if (idx % 2 === 0) {
          return {
            enqueued: true,
            deduplicated: false,
            bullmqJobId: `b-${idx}`,
            bullmqQueueName: 'mock-q',
          };
        }
        if (idx % 4 === 1) {
          return {
            enqueued: false,
            deduplicated: false,
            bullmqJobId: null,
            bullmqQueueName: 'mock-q',
            error: 'Simulated enqueue rejection',
          };
        }
        throw new Error('Simulated transient Redis transport error');
      },
    };

    const summary = await scheduler.dispatchBatchWithAdapter(
      queue,
      { claimerId: 'mixed-claimer', limit: 12, now },
      mixedAdapter,
    );

    expect(summary.claimed).toBe(12);
    expect(summary.dispatched).toBe(6);
    expect(summary.released).toBe(6);

    const dbJobs = await prisma.job.findMany({
      where: { queueId: queue.id },
      select: { dispatchState: true, dispatchClaimedBy: true },
    });
    expect(dbJobs.filter((j) => j.dispatchState === JobDispatchState.DISPATCHED)).toHaveLength(6);
    expect(
      dbJobs.filter(
        (j) => j.dispatchState === JobDispatchState.QUEUED && j.dispatchClaimedBy === null,
      ),
    ).toHaveLength(6);
  });

  it('prevents duplicate claims across concurrent schedulers under batched SQL UPDATE and updates updatedAt', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf10 ConcBatch ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-conc-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        concurrency: 40,
      },
    });

    const past = new Date(Date.now() - 5000);
    await prisma.job.createMany({
      data: Array.from({ length: 40 }, (_, i) => {
        const fields = buildInitialSchedulingFields(queue, (i % 10) + 1, 0, past);
        return {
          queueId: queue.id,
          name: `conc-b-${i}`,
          status: JobStatus.PENDING,
          priority: (i % 10) + 1,
          payload: { i },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: past,
          virtualRankAt: fields.virtualRankAt,
          updatedAt: past,
        };
      }),
    });

    const now = new Date();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        scheduler.claimCandidatesForQueue({
          queueId: queue.id,
          limit: 15,
          claimerId: `conc-sched-${n}`,
          now,
        }),
      ),
    );

    const claimedIds = results.flatMap((r) => r.claimed.map((c) => c.id));
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBe(40);

    const dbUpdated = await prisma.job.findMany({
      where: { queueId: queue.id },
      select: { updatedAt: true, dispatchState: true },
    });
    expect(
      dbUpdated.every(
        (j) =>
          j.dispatchState === JobDispatchState.DISPATCHING &&
          j.updatedAt.getTime() >= now.getTime() - 1000,
      ),
    ).toBe(true);
  });

  it('recovers cleanly from Redis SCRIPT FLUSH (NOSCRIPT) under concurrent EVALSHA rate-limit requests', async () => {
    const redis = getRedisClient();
    // Evict all cached Lua scripts from Redis to force NOSCRIPT fallback under concurrency
    await redis.script('FLUSH');

    const noscriptApp = express();
    noscriptApp.use(
      createRateLimiter({
        name: `perf-noscript-${Date.now()}`,
        windowMs: 10_000,
        maxRequests: 4,
        failurePolicy: 'fail-closed',
        redisClient: redis,
        alwaysEnforce: true,
        keyPrefix: testRedisPrefix,
      }),
    );
    noscriptApp.get('/ping', (_req, res) => res.json({ ok: true }));
    noscriptApp.use(errorHandler);

    // 6 concurrent requests immediately after SCRIPT FLUSH
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(noscriptApp).get('/ping')),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(4);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
  });

  it('handles worker activation racing ahead of scheduler markDispatched without reverting ACTIVE state or fencing token', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf Race Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-race-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 4,
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
        payload: { message: 'race' },
        dispatchState: JobDispatchState.QUEUED,
        readyAt: past,
        virtualRankAt: fields.virtualRankAt,
      },
    });
    await prisma.jobDispatchOutbox.create({
      data: {
        jobId: job.id,
        queueId: queue.id,
        organisationId: org.id,
        status: OutboxStatus.PENDING,
        nextAttemptAt: past,
      },
    });

    // Scheduler claims job -> DISPATCHING
    const claim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 4,
      claimerId: 'sched-race-1',
    });
    expect(claim.claimed).toHaveLength(1);

    // Worker receives BullMQ job and activates it BEFORE scheduler calls markDispatched
    const activation = await jobService.markJobActive(org.id, job.id, 1, 'worker-race-1');
    expect(activation.outcome).toBe('activated');
    if (activation.outcome !== 'activated') throw new Error('expected activated');
    expect(activation.fencingToken).toBe(1);

    // Scheduler now runs markDispatched and (defensively) releaseReservations
    const finalized = await scheduler.markDispatched([job.id], 'sched-race-1');
    const released = await scheduler.releaseReservations([job.id], 'sched-race-1');
    expect(finalized).toBe(0);
    expect(released).toBe(0);

    // Job must remain ACTIVE + DISPATCHED with intact fencingToken=1 and outbox=DISPATCHED
    const afterJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect(afterJob?.status).toBe(JobStatus.ACTIVE);
    expect(afterJob?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(afterJob?.fencingToken).toBe(1);
    expect(afterJob?.dispatchClaimedBy).toBeNull();

    const afterOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId: job.id } });
    expect(afterOutbox?.status).toBe(OutboxStatus.DISPATCHED);
  });

  it('prevents a stale scheduler from releasing, finalizing, or mutating outbox of a job owned by another claimer', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf Stale Claimer Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-stale-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 4,
      },
    });

    const staleTime = new Date(Date.now() - 60_000);
    const fields = buildInitialSchedulingFields(queue, 5, 0, staleTime);
    const job = await prisma.job.create({
      data: {
        queueId: queue.id,
        name: 'echo',
        status: JobStatus.PENDING,
        priority: 5,
        payload: { message: 'stale' },
        dispatchState: JobDispatchState.QUEUED,
        readyAt: staleTime,
        virtualRankAt: fields.virtualRankAt,
      },
    });
    await prisma.jobDispatchOutbox.create({
      data: {
        jobId: job.id,
        queueId: queue.id,
        organisationId: org.id,
        status: OutboxStatus.PENDING,
        nextAttemptAt: staleTime,
      },
    });

    // Stale scheduler claims job at staleTime
    const firstClaim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 4,
      claimerId: 'sched-stale',
      now: staleTime,
    });
    expect(firstClaim.claimed).toHaveLength(1);

    // Reservation expires and is recovered back to QUEUED, then claimed by sched-fresh
    const recovered = await scheduler.recoverStaleReservations(10_000, new Date(), queue.id);
    expect(recovered).toBe(1);

    const secondClaim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 4,
      claimerId: 'sched-fresh',
    });
    expect(secondClaim.claimed).toHaveLength(1);

    // Stale scheduler wakes up and tries both releaseReservations and markDispatched
    expect(await scheduler.releaseReservations([job.id], 'sched-stale')).toBe(0);
    expect(await scheduler.markDispatched([job.id], 'sched-stale')).toBe(0);

    // Job must still be DISPATCHING owned by sched-fresh, and outbox must stay PENDING
    const row = await prisma.job.findUnique({ where: { id: job.id } });
    expect(row?.dispatchState).toBe(JobDispatchState.DISPATCHING);
    expect(row?.dispatchClaimedBy).toBe('sched-fresh');

    const outbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId: job.id } });
    expect(outbox?.status).toBe(OutboxStatus.PENDING);
  });

  it('recovers safely from crash between enqueue and markDispatched and rejects stale fencing tokens', async () => {
    const org = await prisma.organisation.create({
      data: { name: `Perf Crash Recovery Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `perf-crash-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 4,
      },
    });

    const staleTime = new Date(Date.now() - 60_000);
    const fields = buildInitialSchedulingFields(queue, 5, 0, staleTime);
    const [jobActivated, jobStranded] = await Promise.all([
      prisma.job.create({
        data: {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: 'activated-before-crash' },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: staleTime,
          virtualRankAt: fields.virtualRankAt,
        },
      }),
      prisma.job.create({
        data: {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: 'stranded-after-crash' },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: staleTime,
          virtualRankAt: fields.virtualRankAt,
        },
      }),
    ]);

    // Claim both at staleTime, simulating crash before markDispatched
    const claim = await scheduler.claimCandidatesForQueue({
      queueId: queue.id,
      limit: 4,
      claimerId: 'sched-crashed',
      now: staleTime,
    });
    expect(claim.claimed).toHaveLength(2);

    // Job 1 was already enqueued and picked up by Worker A
    const actA = await jobService.markJobActive(org.id, jobActivated.id, 1, 'worker-A');
    expect(actA.outcome).toBe('activated');
    if (actA.outcome !== 'activated') throw new Error('expected activated');

    // Stale reservation recovery reclaims ONLY Job 2 (PENDING+DISPATCHING), leaving Job 1 (ACTIVE) intact
    const recovered = await scheduler.recoverStaleReservations(10_000, new Date(), queue.id);
    expect(recovered).toBe(1);

    const [row1, row2] = await Promise.all([
      prisma.job.findUnique({ where: { id: jobActivated.id } }),
      prisma.job.findUnique({ where: { id: jobStranded.id } }),
    ]);
    expect(row1?.status).toBe(JobStatus.ACTIVE);
    expect(row1?.dispatchState).toBe(JobDispatchState.DISPATCHED);
    expect(row2?.status).toBe(JobStatus.PENDING);
    expect(row2?.dispatchState).toBe(JobDispatchState.QUEUED);

    // Verify stale fencing token rejection: simulate newer fencing token issued, old worker rejected
    await prisma.job.update({
      where: { id: jobActivated.id },
      data: { fencingToken: actA.fencingToken + 1 },
    });
    const staleComplete = await jobService.markJobCompleted(
      org.id,
      jobActivated.id,
      { ok: true },
      1,
      { workerId: 'worker-A', fencingToken: actA.fencingToken },
    );
    expect(staleComplete.outcome).toBe('stale_fencing_token');
  });
});

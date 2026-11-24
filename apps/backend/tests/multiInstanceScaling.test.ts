import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  JobDispatchState,
  JobStatus,
  OutboxStatus,
  PlatformEventType,
  SchedulingPolicy,
  WorkerHealthStatus,
} from '@prisma/client';
import { prisma, buildPooledDatabaseUrl } from '../src/config/database.js';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { createApp } from '../src/app.js';
import { HealthService } from '../src/services/health.service.js';
import { getHealth, getLiveness, getReadiness } from '../src/controllers/health.controller.js';
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { OutboxReconciler } from '../src/services/outboxReconciler.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';
import { WorkerHealthService } from '../src/services/workerHealth.service.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { getInstanceIdentity } from '../src/utils/logger.js';

describe('Phase 10.2 — Multi-Instance Horizontal Scaling Correctness', () => {
  const createdOrgIds: string[] = [];
  const createdWorkerIds: string[] = [];
  const testPrefix = `pq:rl:p102:${Date.now()}`;

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    const redis = getRedisClient();
    try {
      const keys = await redis.keys(`${testPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // Ignore cleanup errors
    }
    if (createdWorkerIds.length > 0) {
      await prisma.platformEvent.deleteMany({ where: { workerId: { in: createdWorkerIds } } });
      await prisma.workerHeartbeat.deleteMany({
        where: { workerInstanceId: { in: createdWorkerIds } },
      });
    }
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
  });

  it('distinguishes liveness, readiness, and shutting-down state across independent API replicas', async () => {
    const identity = getInstanceIdentity();
    expect(identity.instanceId).toBeTruthy();
    expect(identity.pid).toBe(process.pid);

    const replica1Health = new HealthService(
      async () => 'connected',
      async () => 'connected',
    );
    const replica2Health = new HealthService(
      async () => 'connected',
      async () => 'connected',
    );

    expect(replica1Health.getLiveness().statusCode).toBe(200);
    expect((await replica1Health.getReadiness()).statusCode).toBe(200);
    expect((await replica1Health.getReadiness()).report.ready).toBe(true);

    // Replica 1 enters graceful shutdown while Replica 2 stays healthy
    replica1Health.markShuttingDown();
    expect(replica1Health.getLiveness().statusCode).toBe(503);
    expect(replica1Health.getLiveness().report.status).toBe('shutting_down');
    expect((await replica1Health.getReadiness()).statusCode).toBe(503);
    expect((await replica1Health.getReadiness()).report.ready).toBe(false);

    expect(replica2Health.getLiveness().statusCode).toBe(200);
    expect((await replica2Health.getReadiness()).statusCode).toBe(200);

    // Verify mounted Express /health/live and /health/ready routes on main app
    const appInstance = createApp();
    const [liveRes, readyRes] = await Promise.all([
      request(appInstance).get('/health/live'),
      request(appInstance).get('/health/ready'),
    ]);
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.status).toBe('alive');
    expect(liveRes.body.instanceId).toBe(identity.instanceId);
    expect([200, 503]).toContain(readyRes.status);
    expect(readyRes.body).toHaveProperty('ready');
    expect(readyRes.body).toHaveProperty('pool');
    void getHealth;
    void getLiveness;
    void getReadiness;
  });

  it('enforces explicit Prisma connection_limit and pool_timeout without overriding explicit URL params', () => {
    const prodDefault = buildPooledDatabaseUrl(
      'postgresql://user:pass@localhost:5432/pulsequeue',
      undefined,
      undefined,
      'production',
    );
    expect(prodDefault.config.connectionLimit).toBe(10);
    expect(prodDefault.config.source).toBe('production_default');
    expect(prodDefault.url).toContain('connection_limit=10');

    const envOverride = buildPooledDatabaseUrl(
      'postgresql://user:pass@localhost:5432/pulsequeue',
      6,
      15,
      'production',
    );
    expect(envOverride.config.connectionLimit).toBe(6);
    expect(envOverride.config.poolTimeoutSec).toBe(15);
    expect(envOverride.config.source).toBe('env');

    const explicitUrl = buildPooledDatabaseUrl(
      'postgresql://user:pass@localhost:5432/pulsequeue?connection_limit=4&pool_timeout=8',
      12,
      30,
      'production',
    );
    expect(explicitUrl.config.connectionLimit).toBe(4);
    expect(explicitUrl.config.poolTimeoutSec).toBe(8);
    expect(explicitUrl.config.source).toBe('url');
  });

  it('shares distributed Redis rate-limit state across two independent API replicas', async () => {
    const redis = getRedisClient();
    const limiterName = `p102-replica-rl-${Date.now()}`;

    const mkReplica = () => {
      const app = express();
      app.use(
        createRateLimiter({
          name: limiterName,
          windowMs: 10_000,
          maxRequests: 5,
          failurePolicy: 'fail-closed',
          redisClient: redis,
          alwaysEnforce: true,
          keyPrefix: testPrefix,
        }),
      );
      app.get('/probe', (_req, res) => res.json({ ok: true }));
      app.use(errorHandler);
      return app;
    };

    const replicaA = mkReplica();
    const replicaB = mkReplica();

    // Send 8 concurrent requests split evenly across Replica A and Replica B
    const responses = await Promise.all([
      ...Array.from({ length: 4 }, () => request(replicaA).get('/probe')),
      ...Array.from({ length: 4 }, () => request(replicaB).get('/probe')),
    ]);

    expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
  });

  it('prevents duplicate claims and preserves tenant isolation when multiple scheduler instances compete', async () => {
    const [orgA, orgB] = await Promise.all([
      prisma.organisation.create({
        data: { name: `P102 Sched Org A ${Date.now()}`, maxActiveJobs: 15 },
      }),
      prisma.organisation.create({
        data: { name: `P102 Sched Org B ${Date.now()}`, maxActiveJobs: 15 },
      }),
    ]);
    createdOrgIds.push(orgA.id, orgB.id);

    const [queueA, queueB] = await Promise.all([
      prisma.queue.create({
        data: {
          organisationId: orgA.id,
          name: `p102-q-a-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.WEIGHTED_FAIR,
          concurrency: 10,
        },
      }),
      prisma.queue.create({
        data: {
          organisationId: orgB.id,
          name: `p102-q-b-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.DEADLINE_AWARE,
          concurrency: 10,
        },
      }),
    ]);

    const past = new Date(Date.now() - 5000);
    for (const q of [queueA, queueB]) {
      await prisma.job.createMany({
        data: Array.from({ length: 20 }, (_, i) => {
          const fields = buildInitialSchedulingFields(q, (i % 10) + 1, 0, past);
          return {
            queueId: q.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: (i % 10) + 1,
            payload: { message: `job-${i}` },
            dispatchState: JobDispatchState.QUEUED,
            readyAt: past,
            virtualRankAt: fields.virtualRankAt,
            deadlineAt: new Date(Date.now() + (i + 1) * 1000),
          };
        }),
      });
    }

    const sched1 = new PrioritySchedulerService();
    const sched2 = new PrioritySchedulerService();
    const sched3 = new PrioritySchedulerService();

    const dispatchedByJob = new Map<string, string>();
    const mkTrackingAdapter = (instanceId: string) => ({
      dispatchClaimedJob: async (
        _q: unknown,
        job: { id: string; queueId: string },
      ): Promise<{ enqueued: boolean; deduplicated: boolean }> => {
        if (dispatchedByJob.has(job.id)) {
          throw new Error(`Duplicate dispatch of job ${job.id} by ${instanceId}`);
        }
        dispatchedByJob.set(job.id, instanceId);
        return { enqueued: true, deduplicated: false };
      },
    });

    // Run 3 schedulers concurrently across Org A and Org B
    await Promise.all([
      sched1.tickAllQueues({
        claimerId: 'sched-inst-1',
        queueId: queueA.id,
        adapter: mkTrackingAdapter('sched-inst-1') as never,
      }),
      sched2.tickAllQueues({
        claimerId: 'sched-inst-2',
        queueId: queueA.id,
        adapter: mkTrackingAdapter('sched-inst-2') as never,
      }),
      sched3.tickAllQueues({
        claimerId: 'sched-inst-3',
        queueId: queueB.id,
        adapter: mkTrackingAdapter('sched-inst-3') as never,
      }),
    ]);

    // Verify Org A & Org B jobs remain strictly isolated and no job was duplicated
    const [orgAJobs, orgBJobs] = await Promise.all([
      prisma.job.findMany({ where: { queueId: queueA.id } }),
      prisma.job.findMany({ where: { queueId: queueB.id } }),
    ]);

    const dispatchedA = orgAJobs.filter((j) => j.dispatchState === JobDispatchState.DISPATCHED);
    const dispatchedB = orgBJobs.filter((j) => j.dispatchState === JobDispatchState.DISPATCHED);
    expect(dispatchedA.length).toBeGreaterThan(0);
    expect(dispatchedA.length).toBeLessThanOrEqual(15); // respects Org A maxActiveJobs=15
    expect(dispatchedB.length).toBe(10); // bounded by queueB concurrency=10
    expect(dispatchedByJob.size).toBe(dispatchedA.length + dispatchedB.length);
  });

  it('reconciles legacy outbox concurrently across two OutboxReconciler instances without duplicate terminal state', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P102 Outbox Org ${Date.now()}` },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p102-outbox-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
        concurrency: 5,
      },
    });

    const past = new Date(Date.now() - 2000);
    const jobs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        prisma.job.create({
          data: {
            queueId: queue.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 5,
            payload: { message: `outbox-${i}` },
            dispatchState: JobDispatchState.DISPATCHED,
            readyAt: past,
            virtualRankAt: past,
          },
        }),
      ),
    );
    await prisma.jobDispatchOutbox.createMany({
      data: jobs.map((j) => ({
        jobId: j.id,
        queueId: queue.id,
        organisationId: org.id,
        status: OutboxStatus.PENDING,
        nextAttemptAt: past,
      })),
    });

    const reconcilerA = new OutboxReconciler({ bullMQ: bullMQService, batchSize: 50 });
    const reconcilerB = new OutboxReconciler({ bullMQ: bullMQService, batchSize: 50 });

    await Promise.all([reconcilerA.reconcileOnce(50), reconcilerB.reconcileOnce(50)]);

    const outboxRows = await prisma.jobDispatchOutbox.findMany({
      where: { jobId: { in: jobs.map((j) => j.id) } },
    });
    expect(outboxRows).toHaveLength(6);
    expect(outboxRows.every((r) => r.status === OutboxStatus.DISPATCHED)).toBe(true);
  });

  it('detects stale workers atomically across two concurrent WorkerHealthService instances', async () => {
    const workerId = `worker-p102-stale-${Date.now()}`;
    createdWorkerIds.push(workerId);

    const staleTime = new Date(Date.now() - 120_000);
    await prisma.workerHeartbeat.create({
      data: {
        workerInstanceId: workerId,
        hostname: 'test-host',
        pid: 12345,
        status: WorkerHealthStatus.ONLINE,
        registeredQueues: [],
        organisationIds: [],
        lastHeartbeatAt: staleTime,
        startedAt: staleTime,
      },
    });

    const healthA = new WorkerHealthService();
    const healthB = new WorkerHealthService();

    const [resA, resB] = await Promise.all([
      healthA.detectStaleWorkers(),
      healthB.detectStaleWorkers(),
    ]);

    // Exactly one instance wins the atomic ONLINE -> STALE transition and records the event
    const events = await prisma.platformEvent.findMany({
      where: { workerId, type: PlatformEventType.WORKER_HEARTBEAT_STALE },
    });
    expect(events).toHaveLength(1);
    expect(resA.markedStale + resB.markedStale).toBeGreaterThanOrEqual(1);
  });

  it('stopAndDrain awaits in-flight ticks, blocks new ticks, handles timeouts/errors, and is idempotent', async () => {
    const svc = new PrioritySchedulerService();

    // 1. In-flight tick awaited cleanly and repeated calls are safe
    let tickCalls = 0;
    let releaseTick!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const origTick = svc.tickAllQueues.bind(svc);
    svc.tickAllQueues = async () => {
      tickCalls += 1;
      await gate;
      return {
        queuesScanned: 0,
        delayedPromoted: 0,
        staleRecovered: 0,
        claimed: 0,
        dispatched: 0,
        released: 0,
        orgCapacityDenials: 0,
        durationMs: 1,
      };
    };

    svc.start({ intervalMs: 50, claimerId: 'drain-test' });
    // Wait until the first tick enters the gate
    const deadline = Date.now() + 2000;
    while (tickCalls === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(tickCalls).toBe(1);

    // Timeout case: returns drained=false while tick is still blocked
    const timedOut = await svc.stopAndDrain(60);
    expect(timedOut).toEqual({ drained: false });

    // No new ticks start after stopAndDrain begins (even if nudgeQueue is called)
    svc.nudgeQueue('00000000-0000-0000-0000-000000000000', 0);
    await new Promise((r) => setTimeout(r, 80));
    expect(tickCalls).toBe(1);

    // Release the blocked tick and verify repeated stopAndDrain calls settle with drained=true
    releaseTick();
    const [r1, r2] = await Promise.all([svc.stopAndDrain(500), svc.stopAndDrain(500)]);
    expect(r1).toEqual({ drained: true });
    expect(r2).toEqual({ drained: true });

    // 2. Errors in an in-flight tick never block or reject stopAndDrain
    let errEntered = false;
    let releaseErr!: () => void;
    const errGate = new Promise<void>((resolve) => {
      releaseErr = resolve;
    });
    svc.tickAllQueues = async () => {
      errEntered = true;
      await errGate;
      throw new Error('Simulated tick crash');
    };
    svc.start({ intervalMs: 50, claimerId: 'drain-err-test' });
    const errDeadline = Date.now() + 2000;
    while (!errEntered && Date.now() < errDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const drainErrPromise = svc.stopAndDrain(1000);
    releaseErr();
    expect(await drainErrPromise).toEqual({ drained: true });

    svc.tickAllQueues = origTick;
  });
});

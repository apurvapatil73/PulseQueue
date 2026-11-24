import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import {
  bullMQService,
  computeVirtualRankAt,
  jobService,
  prioritySchedulerService,
  prisma,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import { WorkerManager } from '../src/runtime/workerManager.js';
import { createDefaultProcessorRegistry } from '../src/processors/builtin.processors.js';

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number = 10_000,
  intervalMs: number = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Phase 8.3.2 — Live Worker Execution with Custom Priority Scheduling', () => {
  const suffix = `w832_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let orgId = '';
  let strictQueue: PersistedQueueDescriptor;
  let retryQueue: PersistedQueueDescriptor;
  let manager: WorkerManager;
  const executionOrder: string[] = [];
  let retryAttempts = 0;

  beforeAll(async () => {
    const org = await prisma.organisation.create({
      data: { name: `Worker Sched Org ${suffix}` },
    });
    orgId = org.id;

    const sq = await prisma.queue.create({
      data: {
        organisationId: orgId,
        name: `strict-exec-${suffix}`,
        concurrency: 1,
        schedulingPolicy: SchedulingPolicy.STRICT_PRIORITY,
      },
    });
    strictQueue = sq;

    const rq = await prisma.queue.create({
      data: {
        organisationId: orgId,
        name: `retry-exec-${suffix}`,
        concurrency: 1,
        maxRetries: 2,
        backoffMs: 100,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      },
    });
    retryQueue = rq;

    const registry = createDefaultProcessorRegistry();
    registry.register({
      name: 'test.ordered',
      execute: async (ctx) => {
        const label = String((ctx.payload as Record<string, unknown>).label ?? '');
        executionOrder.push(label);
        await new Promise((r) => setTimeout(r, 40));
        return { label };
      },
    });
    registry.register({
      name: 'test.flakyOnce',
      execute: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) {
          throw new Error('Transient custom-scheduler failure');
        }
        return { recoveredOnAttempt: retryAttempts };
      },
    });

    manager = new WorkerManager({
      workerInstanceId: `worker-sched-${suffix}`,
      registry,
    });
    manager.registerWorker(strictQueue);
    manager.registerWorker(retryQueue);
    await manager.waitUntilReady();

    prioritySchedulerService.start({
      intervalMs: 80,
      claimerId: `worker-sched-${suffix}`,
    });
  });

  afterAll(async () => {
    prioritySchedulerService.stop();
    await manager.closeAll();
    await prisma.organisation.deleteMany({ where: { id: orgId } });
    await bullMQService.closeAll();
  });

  it('executes mixed-priority jobs in actual STRICT_PRIORITY order with concurrency=1', async () => {
    // Pause scheduler briefly so all 3 jobs are queued before first claim
    prioritySchedulerService.stop();
    const now = new Date();
    const specs = [
      { label: 'low-2', priority: 2 },
      { label: 'high-19', priority: 19 },
      { label: 'mid-10', priority: 10 },
    ];
    for (const s of specs) {
      await prisma.job.create({
        data: {
          queueId: strictQueue.id,
          name: 'test.ordered',
          payload: { label: s.label },
          status: JobStatus.PENDING,
          priority: s.priority,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: computeVirtualRankAt(now, s.priority, 0.05),
        },
      });
    }

    prioritySchedulerService.start({
      intervalMs: 60,
      claimerId: `worker-sched-${suffix}`,
    });

    await waitForCondition(async () => {
      const done = await prisma.job.count({
        where: { queueId: strictQueue.id, status: JobStatus.COMPLETED },
      });
      return done === 3;
    });

    expect(executionOrder).toEqual(['high-19', 'mid-10', 'low-2']);
  });

  it('routes transient retries on custom-policy queues back through DELAYED+QUEUED and completes on retry', async () => {
    const submitted = await jobService.create(orgId, retryQueue.id, null, {
      name: 'test.flakyOnce',
      payload: {},
      maxRetries: 2,
      backoffMs: 100,
      delayMs: 0,
    });
    expect(submitted.dispatch.enqueued).toBe(false);

    await waitForCondition(async () => {
      const row = await prisma.job.findUnique({ where: { id: submitted.job.id } });
      return row?.status === JobStatus.COMPLETED;
    });

    const finalJob = await prisma.job.findUnique({ where: { id: submitted.job.id } });
    expect(finalJob?.status).toBe(JobStatus.COMPLETED);
    expect(finalJob?.attemptsMade).toBe(2);
    expect(retryAttempts).toBe(2);
  });

  it('recovers pending custom-scheduled jobs cleanly across worker shutdown and restart', async () => {
    // Stop scheduler & worker
    prioritySchedulerService.stop();
    await manager.closeAll();

    const pendingJob = await prisma.job.create({
      data: {
        queueId: strictQueue.id,
        name: 'test.ordered',
        payload: { label: 'after-restart' },
        status: JobStatus.PENDING,
        priority: 15,
        dispatchState: JobDispatchState.QUEUED,
        readyAt: new Date(),
        virtualRankAt: computeVirtualRankAt(new Date(), 15, 0.05),
      },
    });

    // Restart fresh WorkerManager + scheduler
    const registry2 = createDefaultProcessorRegistry();
    registry2.register({
      name: 'test.ordered',
      execute: async (ctx) => ({
        label: String((ctx.payload as Record<string, unknown>).label ?? ''),
      }),
    });
    manager = new WorkerManager({
      workerInstanceId: `worker-sched-restarted-${suffix}`,
      registry: registry2,
    });
    manager.registerWorker(strictQueue);
    await manager.waitUntilReady();

    prioritySchedulerService.start({
      intervalMs: 60,
      claimerId: `worker-sched-restarted-${suffix}`,
    });

    await waitForCondition(async () => {
      const row = await prisma.job.findUnique({ where: { id: pendingJob.id } });
      return row?.status === JobStatus.COMPLETED;
    });

    const recovered = await prisma.job.findUnique({ where: { id: pendingJob.id } });
    expect(recovered?.status).toBe(JobStatus.COMPLETED);
  });
});

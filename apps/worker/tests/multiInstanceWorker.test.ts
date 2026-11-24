import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
  bullMQService,
  connectRedis,
  jobService,
  prisma,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import { WorkerManager } from '../src/runtime/workerManager.js';

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Phase 10.2 — Multi-Instance Worker & Scheduler Correctness', () => {
  const createdOrgIds: string[] = [];
  const queuesToObliterate: PersistedQueueDescriptor[] = [];

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    await bullMQService.closeAll().catch(() => {});
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
  });

  it('processes jobs concurrently across two WorkerManager + two PrioritySchedulerService instances with zero duplicates and survives graceful shutdown of one worker', async () => {
    const org = await prisma.organisation.create({
      data: { name: `P102 Worker Org ${Date.now()}`, maxActiveJobs: 20 },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `p102-mw-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 6,
      },
    });
    queuesToObliterate.push(queue);

    const worker1 = new WorkerManager({ workerInstanceId: `w1-${Date.now()}` });
    const worker2 = new WorkerManager({ workerInstanceId: `w2-${Date.now()}` });

    worker1.registerWorker(queue);
    worker2.registerWorker(queue);

    // Seed first batch of 12 jobs using built-in 'echo' processor
    const past = new Date(Date.now() - 2000);
    await prisma.job.createMany({
      data: Array.from({ length: 12 }, (_, i) => {
        const fields = buildInitialSchedulingFields(queue, 5, 0, past);
        return {
          queueId: queue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: `mw-job-${i}` },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: past,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });

    const sched1 = new PrioritySchedulerService();
    const sched2 = new PrioritySchedulerService();

    try {
      // Compete two scheduler instances to dispatch the initial batch, then tick until all 12 drain
      await Promise.all([
        sched1.tickAllQueues({ queueId: queue.id, claimerId: 'w-sched-1' }),
        sched2.tickAllQueues({ queueId: queue.id, claimerId: 'w-sched-2' }),
      ]);

      await waitForCondition(async () => {
        await sched1.tickAllQueues({ queueId: queue.id, claimerId: 'w-sched-1' });
        const done = await prisma.job.count({
          where: { queueId: queue.id, status: JobStatus.COMPLETED },
        });
        return done === 12;
      });

      // Gracefully shut down Worker 1 while Worker 2 stays online
      await worker1.closeAll();

      // Seed 6 more jobs and dispatch them; Worker 2 alone must complete all of them
      await prisma.job.createMany({
        data: Array.from({ length: 6 }, (_, i) => {
          const fields = buildInitialSchedulingFields(queue, 5, 0, past);
          return {
            queueId: queue.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 5,
            payload: { message: `mw-job-after-${i}` },
            dispatchState: JobDispatchState.QUEUED,
            readyAt: past,
            virtualRankAt: fields.virtualRankAt,
          };
        }),
      });

      await sched2.tickAllQueues({ queueId: queue.id, claimerId: 'w-sched-2' });

      await waitForCondition(async () => {
        const done = await prisma.job.count({
          where: { queueId: queue.id, status: JobStatus.COMPLETED },
        });
        return done === 18;
      });

      const allJobs = await prisma.job.findMany({ where: { queueId: queue.id } });
      expect(allJobs).toHaveLength(18);
      for (const j of allJobs) {
        expect(j.status).toBe(JobStatus.COMPLETED);
        expect(j.attemptsMade).toBe(1);
        expect(j.fencingToken).toBe(1);
      }

      // Verify fencing-token protection across instances on one of the completed jobs
      const sampleJob = allJobs[0];
      const staleAttempt = await jobService.markJobCompleted(
        org.id,
        sampleJob.id,
        { stale: true },
        1,
        { workerId: 'stale-worker', fencingToken: Math.max(0, sampleJob.fencingToken - 1) },
      );
      expect(staleAttempt.outcome).toBe('stale_fencing_token');
    } finally {
      await worker1.closeAll().catch(() => {});
      await worker2.closeAll().catch(() => {});
    }
  }, 20_000);
});

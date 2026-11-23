import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStatus, ScheduleStatus, ScheduleType } from '@prisma/client';
import {
  bullMQService,
  deadLetterService,
  jobService,
  organisationService,
  prisma,
  queueService,
  scheduleDispatcherService,
  scheduleService,
  workerHealthService,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import {
  createDefaultProcessorRegistry,
  InvalidJobPayloadError,
  ProcessorRegistry,
  UnregisteredProcessorError,
  WorkerManager,
} from '../src/index.js';

async function waitForJobStatus(
  jobId: string,
  expectedStatuses: JobStatus[],
  timeoutMs: number = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job && expectedStatuses.includes(job.status)) {
      return job;
    }
    await delay(100);
  }
  const latest = await prisma.job.findUnique({ where: { id: jobId } });
  throw new Error(
    `Timed out waiting for job ${jobId} to reach [${expectedStatuses.join(', ')}]; latest status=${latest?.status ?? 'missing'}`,
  );
}

describe('Distributed Worker Runtime, Processors & Lifecycle Sync (Step 4.2)', () => {
  // ─── 1. Extensible Processor Registry & Safe Built-in Processors ──────────

  describe('ProcessorRegistry & Built-in Deterministic Processors', () => {
    it('executes echo, math.sum, and transform.json deterministically with structured output', async () => {
      const registry = createDefaultProcessorRegistry();

      expect(registry.list()).toEqual(
        expect.arrayContaining(['echo', 'math.sum', 'transform.json', 'test.fail']),
      );

      const echoRes = await registry.execute({
        jobId: 'j1',
        organisationId: 'o1',
        queueId: 'q1',
        queueName: 'default',
        jobName: 'echo',
        payload: { message: 'PulseQueue', metadata: { env: 'test' } },
        attemptNumber: 1,
        maxAttempts: 3,
      });
      expect(echoRes.processor).toBe('echo');
      expect(echoRes.output).toMatchObject({
        echoed: 'PulseQueue',
        length: 10,
        attemptNumber: 1,
        metadata: { env: 'test' },
      });

      const sumRes = await registry.execute({
        jobId: 'j2',
        organisationId: 'o1',
        queueId: 'q1',
        queueName: 'default',
        jobName: 'math.sum',
        payload: { numbers: [10, 20, 30, 40] },
        attemptNumber: 1,
        maxAttempts: 1,
      });
      expect(sumRes.output).toEqual({
        sum: 100,
        count: 4,
        min: 10,
        max: 40,
        average: 25,
      });

      const transformRes = await registry.execute({
        jobId: 'j3',
        organisationId: 'o1',
        queueId: 'q1',
        queueName: 'default',
        jobName: 'transform.json',
        payload: { records: { beta: 2, alpha: 'one' }, uppercaseKeys: true },
        attemptNumber: 1,
        maxAttempts: 1,
      });
      expect(transformRes.output).toEqual({
        keyCount: 2,
        transformed: { ALPHA: 'one', BETA: 2 },
      });
    });

    it('rejects invalid payloads and unregistered processors with typed non-retryable errors', async () => {
      const registry = createDefaultProcessorRegistry();

      await expect(
        registry.execute({
          jobId: 'j4',
          organisationId: 'o1',
          queueId: 'q1',
          queueName: 'default',
          jobName: 'echo',
          payload: { message: '' },
          attemptNumber: 1,
          maxAttempts: 3,
        }),
      ).rejects.toBeInstanceOf(InvalidJobPayloadError);

      await expect(
        registry.execute({
          jobId: 'j5',
          organisationId: 'o1',
          queueId: 'q1',
          queueName: 'default',
          jobName: 'does.not.exist',
          payload: {},
          attemptNumber: 1,
          maxAttempts: 3,
        }),
      ).rejects.toBeInstanceOf(UnregisteredProcessorError);

      // Duplicate registration protection
      const custom = new ProcessorRegistry();
      custom.register({
        name: 'custom.op',
        description: 'test',
        execute: async () => ({ ok: true }),
      });
      expect(() =>
        custom.register({
          name: 'custom.op',
          description: 'dup',
          execute: async () => ({ ok: false }),
        }),
      ).toThrow('already registered');
    });
  });

  // ─── 2. Real BullMQ Worker Execution Against Live PostgreSQL & Docker Redis

  describe('Live Worker Execution, Retries, Concurrency & Idempotency', () => {
    const suffix = `w_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const workerManager = new WorkerManager();

    let userId = '';
    let orgAId = '';
    let orgBId = '';
    let queueA!: PersistedQueueDescriptor;
    let queueB!: PersistedQueueDescriptor;

    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: {
          name: 'Worker Test User',
          email: `worker_test_${suffix}@pulsequeue.dev`,
          passwordHash: 'not-used-in-worker-tests',
        },
      });
      userId = user.id;

      const orgA = await organisationService.create(userId, 'Worker Org Alpha');
      const orgB = await organisationService.create(userId, 'Worker Org Beta');
      orgAId = orgA.id;
      orgBId = orgB.id;
      createdOrgIds.push(orgAId, orgBId);

      const qA = await queueService.create(orgAId, userId, {
        name: `worker-alpha-${Date.now()}`,
        concurrency: 3,
        defaultPriority: 10,
        maxRetries: 2,
        backoffMs: 120,
      });
      const qB = await queueService.create(orgBId, userId, {
        name: `worker-beta-${Date.now()}`,
        concurrency: 2,
        defaultPriority: 5,
        maxRetries: 1,
        backoffMs: 100,
      });

      queueA = qA;
      queueB = qB;

      // Register two distinct org-scoped queue workers + verify duplicate registration prevention
      const firstReg = workerManager.registerWorker(queueA);
      const dupReg = workerManager.registerWorker({ ...queueA, concurrency: 4 });
      const secondQueueReg = workerManager.registerWorker(queueB);

      expect(firstReg).toBe(dupReg);
      expect(firstReg.concurrency).toBe(4);
      expect(secondQueueReg.concurrency).toBe(2);
      expect(workerManager.listRegisteredWorkers()).toHaveLength(2);

      await workerManager.waitUntilReady();
    }, 30_000);

    afterAll(async () => {
      await workerManager.closeAll();
      expect(workerManager.listRegisteredWorkers()).toHaveLength(0);

      for (const q of [queueA, queueB]) {
        if (!q) continue;
        try {
          const entry = bullMQService.getRegisteredQueue(q.organisationId, q.name);
          if (entry) {
            await entry.queue.obliterate({ force: true });
          }
        } catch {
          // ignore cleanup errors
        }
      }

      await bullMQService.closeAll();

      if (createdOrgIds.length > 0) {
        await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
      }
      if (userId) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }, 30_000);

    it('processes jobs across multiple organisation queues from PENDING -> ACTIVE -> COMPLETED and persists structured results', async () => {
      const subA = await jobService.create(orgAId, queueA.id, userId, {
        name: 'echo',
        payload: { message: 'hello from org A' },
        delayMs: 0,
      });
      const subB = await jobService.create(orgBId, queueB.id, userId, {
        name: 'math.sum',
        payload: { numbers: [5, 15, 25] },
        delayMs: 0,
      });

      expect(subA.dispatch.enqueued).toBe(true);
      expect(subB.dispatch.enqueued).toBe(true);

      const doneA = await waitForJobStatus(subA.job.id, [JobStatus.COMPLETED]);
      const doneB = await waitForJobStatus(subB.job.id, [JobStatus.COMPLETED]);

      expect(doneA.status).toBe(JobStatus.COMPLETED);
      expect(doneA.attemptsMade).toBe(1);
      expect(doneA.startedAt).not.toBeNull();
      expect(doneA.completedAt).not.toBeNull();
      expect(doneA.errorMessage).toBeNull();
      expect(doneA.result).toMatchObject({
        processor: 'echo',
        output: { echoed: 'hello from org A', length: 16 },
      });

      expect(doneB.status).toBe(JobStatus.COMPLETED);
      expect(doneB.attemptsMade).toBe(1);
      expect(doneB.result).toMatchObject({
        processor: 'math.sum',
        output: { sum: 45, count: 3, min: 5, max: 25, average: 15 },
      });
    }, 15_000);

    it('retries transient failures with BullMQ exponential backoff (not marking FAILED early) and recovers on subsequent attempt', async () => {
      const sub = await jobService.create(orgAId, queueA.id, userId, {
        name: 'test.fail',
        payload: { reason: 'Transient upstream 503', failUntilAttempt: 1 },
        maxRetries: 2,
        backoffMs: 120,
        delayMs: 0,
      });

      const finished = await waitForJobStatus(sub.job.id, [JobStatus.COMPLETED, JobStatus.FAILED]);

      expect(finished.status).toBe(JobStatus.COMPLETED);
      expect(finished.attemptsMade).toBe(2);
      expect(finished.failedAt).toBeNull();
      expect(finished.errorMessage).toBeNull();
      expect(finished.result).toMatchObject({
        processor: 'test.fail',
        output: { recovered: true, recoveredOnAttempt: 2, maxAttempts: 3 },
      });
    }, 15_000);

    it('exhausts retries and marks job permanently FAILED with errorMessage and failedAt timestamp', async () => {
      const sub = await jobService.create(orgBId, queueB.id, userId, {
        name: 'test.fail',
        payload: { reason: 'Permanent payment gateway error' },
        maxRetries: 1, // 2 total attempts
        backoffMs: 100,
        delayMs: 0,
      });

      const failed = await waitForJobStatus(sub.job.id, [JobStatus.FAILED]);

      expect(failed.status).toBe(JobStatus.FAILED);
      expect(failed.attemptsMade).toBe(2);
      expect(failed.failedAt).not.toBeNull();
      expect(failed.completedAt).toBeNull();
      expect(failed.errorMessage).toContain('Permanent payment gateway error');
    }, 15_000);

    it('marks invalid-payload jobs permanently FAILED on attempt 1 without wasting retries', async () => {
      const sub = await jobService.create(orgAId, queueA.id, userId, {
        name: 'math.sum',
        payload: { numbers: [] }, // invalid: must have >= 1 finite number
        maxRetries: 3,
        backoffMs: 100,
        delayMs: 0,
      });

      const failed = await waitForJobStatus(sub.job.id, [JobStatus.FAILED]);

      expect(failed.status).toBe(JobStatus.FAILED);
      expect(failed.attemptsMade).toBe(1);
      expect(failed.errorMessage).toContain('Invalid payload for "math.sum"');
    }, 15_000);

    it('safely skips missing PostgreSQL jobs and never overwrites already-COMPLETED jobs on duplicate delivery', async () => {
      // 1. Enqueue a job directly to BullMQ whose PG row does not exist
      const ghostId = crypto.randomUUID();
      await bullMQService.enqueueJob(queueA, {
        id: ghostId,
        queueId: queueA.id,
        name: 'echo',
        priority: 5,
        payload: { message: 'ghost' },
        maxRetries: 0,
        backoffMs: 0,
        delayMs: 0,
      });
      await delay(400);
      expect(await prisma.job.findUnique({ where: { id: ghostId } })).toBeNull();

      // 2. Create a job that is ALREADY COMPLETED in PostgreSQL, then deliver it to BullMQ
      const preCompleted = await prisma.job.create({
        data: {
          queueId: queueA.id,
          name: 'test.fail', // would fail if wrongly re-executed
          status: JobStatus.COMPLETED,
          priority: 5,
          payload: { reason: 'must never run' },
          result: { preserved: true },
          completedAt: new Date(),
          attemptsMade: 1,
        },
      });

      await bullMQService.enqueueJob(queueA, {
        id: preCompleted.id,
        queueId: queueA.id,
        name: preCompleted.name,
        priority: preCompleted.priority,
        payload: preCompleted.payload,
        maxRetries: 0,
        backoffMs: 0,
        delayMs: 0,
      });

      await delay(500);
      const after = await prisma.job.findUnique({ where: { id: preCompleted.id } });
      expect(after?.status).toBe(JobStatus.COMPLETED);
      expect(after?.result).toEqual({ preserved: true });
      expect(after?.errorMessage).toBeNull();
    }, 15_000);

    it('routes exhausted failed jobs to DLQ and processes replayed DLQ jobs to COMPLETED while tracking worker heartbeats', async () => {
      const identity = workerManager.getWorkerIdentity();
      await workerHealthService.registerWorkerStart({
        ...identity,
        registeredQueues: workerManager.listRegisteredWorkers(),
        organisationIds: workerManager.listRegisteredOrganisationIds(),
      });

      // 1. Submit invalid-payload job -> fails -> enters DLQ automatically
      const failingSub = await jobService.create(orgAId, queueA.id, userId, {
        name: 'echo',
        payload: { message: '' }, // invalid
        maxRetries: 1,
        backoffMs: 50,
        delayMs: 0,
      });

      const failed = await waitForJobStatus(failingSub.job.id, [JobStatus.FAILED]);
      expect(failed.status).toBe(JobStatus.FAILED);
      expect(failed.lastWorkerId).toBe(identity.workerInstanceId);

      // Confirm DLQ record created
      const dlqRecord = await prisma.deadLetterJob.findUnique({
        where: { originalJobId: failingSub.job.id },
      });
      expect(dlqRecord).not.toBeNull();
      expect(dlqRecord?.status).toBe('OPEN');

      // 2. Replay DLQ job with valid payload -> worker automatically executes it to COMPLETED
      const replay = await deadLetterService.replay(orgAId, dlqRecord!.id, userId, {
        payload: { message: 'replayed-and-succeeded' },
      });
      expect(replay.deadLetterJob.status).toBe('REPLAYED');

      const replayedDone = await waitForJobStatus(replay.replayedJob.id, [JobStatus.COMPLETED]);
      expect(replayedDone.status).toBe(JobStatus.COMPLETED);
      expect(replayedDone.replayedFromDlqId).toBe(dlqRecord!.id);
      expect(replayedDone.durationMs).not.toBeNull();
      expect(replayedDone.result).toMatchObject({
        processor: 'echo',
        output: { echoed: 'replayed-and-succeeded' },
      });

      // Verify worker heartbeat tracked real processing counters
      const hb = await prisma.workerHeartbeat.findUnique({
        where: { workerInstanceId: identity.workerInstanceId },
      });
      expect(hb).not.toBeNull();
      expect(hb!.jobsProcessed).toBeGreaterThanOrEqual(2);
      expect(hb!.jobsSucceeded).toBeGreaterThanOrEqual(1);
      expect(hb!.jobsFailed).toBeGreaterThanOrEqual(1);

      // Clean up test worker heartbeat row
      await prisma.workerHeartbeat.deleteMany({
        where: { workerInstanceId: identity.workerInstanceId },
      });
    }, 20_000);

    it('executes a one-time scheduled job at its future timestamp and runs multiple recurring cron occurrences without duplicates', async () => {
      // 1. One-time scheduled job ~800ms in the future
      const runAtIso = new Date(Date.now() + 800).toISOString();
      const oneTime = await scheduleService.create(orgAId, userId, {
        queueId: queueA.id,
        name: `one-time-worker-${Date.now()}`,
        type: ScheduleType.ONE_TIME,
        jobName: 'echo',
        payload: { message: 'scheduled-once' },
        timezone: 'UTC',
        runAt: runAtIso,
        preventOverlap: true,
      });

      expect(oneTime.initialJobId).toBeDefined();
      const oneTimeDone = await waitForJobStatus(oneTime.initialJobId!, [JobStatus.COMPLETED]);
      expect(oneTimeDone.status).toBe(JobStatus.COMPLETED);
      expect(oneTimeDone.result).toMatchObject({
        processor: 'echo',
        output: { echoed: 'scheduled-once' },
      });

      // Dispatcher reconciles one-time schedule to COMPLETED
      await scheduleDispatcherService.tick();
      const completedSched = await prisma.schedule.findUnique({
        where: { id: oneTime.schedule.id },
      });
      expect(completedSched?.status).toBe(ScheduleStatus.COMPLETED);

      // 2. Recurring schedule (every 1 second) producing 2 distinct completed executions
      const recurring = await scheduleService.create(orgAId, userId, {
        queueId: queueA.id,
        name: `recurring-worker-${Date.now()}`,
        type: ScheduleType.RECURRING,
        jobName: 'echo',
        payload: { message: 'recurring-tick' },
        cronExpression: '*/1 * * * * *',
        timezone: 'UTC',
        preventOverlap: true,
      });

      // Wait precisely until each of the next 2 scheduled occurrences is due and tick on-time
      for (let i = 0; i < 2; i++) {
        const current = await prisma.schedule.findUnique({ where: { id: recurring.schedule.id } });
        const waitMs = Math.max(
          50,
          (current?.nextRunAt?.getTime() ?? Date.now()) - Date.now() + 80,
        );
        await delay(waitMs);
        await scheduleDispatcherService.tick(new Date(), { organisationId: orgAId });
      }

      const execs = await prisma.scheduleExecution.findMany({
        where: { scheduleId: recurring.schedule.id, jobId: { not: null } },
        orderBy: { scheduledFor: 'asc' },
      });
      expect(execs.length).toBeGreaterThanOrEqual(2);

      const distinctJobIds = new Set(execs.map((e) => e.jobId));
      expect(distinctJobIds.size).toBe(execs.length);

      for (const exec of execs) {
        const done = await waitForJobStatus(exec.jobId!, [JobStatus.COMPLETED]);
        expect(done.status).toBe(JobStatus.COMPLETED);
      }

      // Cancel recurring schedule cleanly
      await scheduleService.cancel(orgAId, recurring.schedule.id, userId);
    }, 20_000);

    it('persists full ScheduleExecution telemetry (dispatchedAt, startedAt, completedAt, durationMs, retryCount) and enforces schedule maxDurationMs timeout', async () => {
      // Register a slow processor for testing maxDurationMs timeout enforcement
      workerManager.getProcessorRegistry().register({
        name: 'test.slow',
        description: 'Sleeps for requested delayMs to test maxDurationMs timeouts',
        async execute(context) {
          const payload = context.payload as { sleepMs?: number };
          await delay(payload.sleepMs ?? 400);
          return { finished: true };
        },
      });

      // 1. Scheduled job with transient failure on attempt 1 -> recovers on attempt 2 and tracks retryCount
      const retrySched = await scheduleService.create(orgAId, userId, {
        queueId: queueA.id,
        name: `retry-telemetry-${Date.now()}`,
        type: ScheduleType.ONE_TIME,
        jobName: 'test.fail',
        payload: { reason: 'Transient scheduled blip', failUntilAttempt: 1 },
        maxRetries: 2,
        backoffMs: 50,
        timezone: 'UTC',
        runAt: new Date(Date.now() + 250).toISOString(),
      });

      expect(retrySched.initialJobId).toBeDefined();
      const retryJob = await waitForJobStatus(retrySched.initialJobId!, [JobStatus.COMPLETED]);
      expect(retryJob.status).toBe(JobStatus.COMPLETED);
      expect(retryJob.attemptsMade).toBe(2);

      const retryExec = await prisma.scheduleExecution.findUnique({
        where: { jobId: retrySched.initialJobId! },
      });
      expect(retryExec).not.toBeNull();
      expect(retryExec!.dispatchedAt).not.toBeNull();
      expect(retryExec!.startedAt).not.toBeNull();
      expect(retryExec!.completedAt).not.toBeNull();
      expect(retryExec!.finalJobStatus).toBe(JobStatus.COMPLETED);
      expect(retryExec!.retryCount).toBeGreaterThanOrEqual(1);
      expect(retryExec!.durationMs).toBeGreaterThanOrEqual(0);

      // 2. Scheduled job exceeding maxDurationMs (120ms limit vs 450ms sleep) -> FAILED + telemetry synced
      const timeoutSched = await scheduleService.create(orgAId, userId, {
        queueId: queueA.id,
        name: `timeout-limit-${Date.now()}`,
        type: ScheduleType.ONE_TIME,
        jobName: 'test.slow',
        payload: { sleepMs: 450 },
        maxRetries: 0,
        maxDurationMs: 120,
        timezone: 'UTC',
        runAt: new Date(Date.now() + 250).toISOString(),
      });

      expect(timeoutSched.initialJobId).toBeDefined();
      const timedOutJob = await waitForJobStatus(timeoutSched.initialJobId!, [JobStatus.FAILED]);
      expect(timedOutJob.status).toBe(JobStatus.FAILED);
      expect(timedOutJob.errorMessage).toContain('maxDurationMs');

      const timeoutExec = await prisma.scheduleExecution.findUnique({
        where: { jobId: timeoutSched.initialJobId! },
      });
      expect(timeoutExec?.finalJobStatus).toBe(JobStatus.FAILED);
      expect(timeoutExec?.completedAt).not.toBeNull();
      expect(timeoutExec?.durationMs).toBeGreaterThanOrEqual(100);
    }, 20_000);
  });
});

import crypto from 'node:crypto';
import os from 'node:os';
import { Worker, UnrecoverableError, type ConnectionOptions, type Job as BullJob } from 'bullmq';
import { PlatformEventType } from '@prisma/client';
import {
  buildBullMQQueueName,
  buildBullMQRedisOptions,
  env,
  eventService,
  jobService,
  logger,
  sanitizeRedisUrl,
  workerHealthService,
  type BullMQJobPayload,
  type JobService,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import {
  InvalidJobPayloadError,
  UnregisteredProcessorError,
  type ProcessorResult,
} from '../processors/processor.types.js';
import type { ProcessorRegistry } from '../processors/processor.registry.js';
import { createDefaultProcessorRegistry } from '../processors/builtin.processors.js';

export interface RegisteredWorkerEntry {
  bullmqQueueName: string;
  organisationId: string;
  queueId: string;
  logicalName: string;
  concurrency: number;
  worker: Worker<BullMQJobPayload, ProcessorResult | null>;
}

export interface WorkerManagerOptions {
  workerInstanceId?: string;
  registry?: ProcessorRegistry;
  jobService?: JobService;
  redisUrl?: string;
}

/**
 * Manages BullMQ Worker instances for organisation-scoped queues within a worker process.
 */
export class WorkerManager {
  private readonly workers = new Map<string, RegisteredWorkerEntry>();
  private readonly workerInstanceId: string;
  private readonly hostname: string;
  private readonly pid: number;
  private readonly registry: ProcessorRegistry;
  private readonly jobs: JobService;
  private readonly redisUrl: string;
  private isClosing = false;

  constructor(options: WorkerManagerOptions = {}) {
    this.hostname = os.hostname();
    this.pid = process.pid;
    this.workerInstanceId =
      options.workerInstanceId ??
      `worker-${this.hostname}-${this.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.registry = options.registry ?? createDefaultProcessorRegistry();
    this.jobs = options.jobService ?? jobService;
    this.redisUrl = options.redisUrl ?? env.REDIS_URL;
  }

  getWorkerInstanceId(): string {
    return this.workerInstanceId;
  }

  getWorkerIdentity(): { workerInstanceId: string; hostname: string; pid: number } {
    return {
      workerInstanceId: this.workerInstanceId,
      hostname: this.hostname,
      pid: this.pid,
    };
  }

  getProcessorRegistry(): ProcessorRegistry {
    return this.registry;
  }

  listRegisteredWorkers(): string[] {
    return Array.from(this.workers.keys());
  }

  listRegisteredOrganisationIds(): string[] {
    const orgIds = new Set<string>();
    for (const entry of this.workers.values()) {
      orgIds.add(entry.organisationId);
    }
    return Array.from(orgIds);
  }

  getWorker(organisationId: string, queueName: string): RegisteredWorkerEntry | undefined {
    const key = buildBullMQQueueName(organisationId, queueName);
    return this.workers.get(key);
  }

  /**
   * Registers a BullMQ Worker for a persisted organisation-scoped queue.
   * Deduplicates by BullMQ queue name to prevent duplicate workers in the same process.
   */
  registerWorker(persistedQueue: PersistedQueueDescriptor): RegisteredWorkerEntry {
    if (this.isClosing) {
      throw new Error('Cannot register new workers while WorkerManager is shutting down');
    }

    const bullmqQueueName = buildBullMQQueueName(
      persistedQueue.organisationId,
      persistedQueue.name,
    );

    const existing = this.workers.get(bullmqQueueName);
    if (existing) {
      if (existing.concurrency !== persistedQueue.concurrency) {
        existing.worker.concurrency = persistedQueue.concurrency;
        existing.concurrency = persistedQueue.concurrency;
        logger.info('Updated worker concurrency', {
          workerInstanceId: this.workerInstanceId,
          bullmqQueueName,
          organisationId: persistedQueue.organisationId,
          concurrency: persistedQueue.concurrency,
        });
      }
      return existing;
    }

    const connectionOptions = buildBullMQRedisOptions(this.redisUrl);
    connectionOptions.lazyConnect = false;

    const worker = new Worker<BullMQJobPayload, ProcessorResult | null>(
      bullmqQueueName,
      async (bullJob) => this.processBullJob(persistedQueue, bullJob),
      {
        connection: connectionOptions as ConnectionOptions,
        concurrency: Math.max(1, persistedQueue.concurrency),
      },
    );

    worker.on('error', (err) => {
      logger.error('BullMQ Worker connection/runtime error', {
        workerInstanceId: this.workerInstanceId,
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        target: sanitizeRedisUrl(this.redisUrl),
        error: err.message,
      });
    });

    worker.on('stalled', (stalledJobId) => {
      logger.warn('BullMQ detected stalled job', {
        workerInstanceId: this.workerInstanceId,
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        queueId: persistedQueue.id,
        jobId: stalledJobId,
      });

      void eventService.record({
        type: PlatformEventType.JOB_STALLED,
        organisationId: persistedQueue.organisationId,
        queueId: persistedQueue.id,
        jobId: stalledJobId,
        workerId: this.workerInstanceId,
        message: `BullMQ detected stalled job ${stalledJobId} on queue "${persistedQueue.name}"`,
        metadata: { bullmqQueueName, source: 'bullmq_stalled_event' },
      });
    });

    worker.on('failed', (bullJob, err) => {
      logger.warn('BullMQ Worker reported failed attempt', {
        workerInstanceId: this.workerInstanceId,
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        jobId: bullJob?.data?.jobId ?? bullJob?.id,
        attemptsMade: bullJob?.attemptsMade,
        maxAttempts: bullJob?.opts?.attempts ?? 1,
        error: err.message,
      });
    });

    const entry: RegisteredWorkerEntry = {
      bullmqQueueName,
      organisationId: persistedQueue.organisationId,
      queueId: persistedQueue.id,
      logicalName: persistedQueue.name,
      concurrency: persistedQueue.concurrency,
      worker,
    };

    this.workers.set(bullmqQueueName, entry);

    logger.info('Worker registered for organisation queue', {
      workerInstanceId: this.workerInstanceId,
      bullmqQueueName,
      organisationId: persistedQueue.organisationId,
      queueId: persistedQueue.id,
      logicalName: persistedQueue.name,
      concurrency: persistedQueue.concurrency,
    });

    return entry;
  }

  /**
   * Core job execution handler invoked by BullMQ.
   */
  private async processBullJob(
    persistedQueue: PersistedQueueDescriptor,
    bullJob: BullJob<BullMQJobPayload, ProcessorResult | null>,
  ): Promise<ProcessorResult | null> {
    const jobData = bullJob.data;
    const jobId = jobData?.jobId ?? bullJob.id;
    const organisationId = jobData?.organisationId ?? persistedQueue.organisationId;
    const attemptNumber = bullJob.attemptsMade + 1;
    const maxAttempts = bullJob.opts?.attempts ?? 1;

    if (!jobId) {
      logger.warn('Received BullMQ job without stable jobId; skipping', {
        workerInstanceId: this.workerInstanceId,
        organisationId,
        queueId: persistedQueue.id,
      });
      return null;
    }

    if (organisationId !== persistedQueue.organisationId) {
      logger.error('Tenant mismatch between BullMQ worker queue and job payload; aborting', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        expectedOrganisationId: persistedQueue.organisationId,
        payloadOrganisationId: organisationId,
      });
      throw new UnrecoverableError('Cross-tenant job payload rejected');
    }

    // 1. Atomically claim job as ACTIVE in PostgreSQL
    const activation = await this.jobs.markJobActive(
      organisationId,
      jobId,
      attemptNumber,
      this.workerInstanceId,
    );

    if (activation.outcome === 'missing') {
      logger.warn('PostgreSQL job missing or cancelled before execution; skipping', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        organisationId,
        queueId: persistedQueue.id,
      });
      return null;
    }

    if (activation.outcome === 'already_terminal') {
      logger.warn('Ignoring duplicate delivery for job already in terminal state', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        organisationId,
        terminalStatus: activation.status,
      });
      return null;
    }

    if (activation.outcome === 'already_active') {
      logger.warn('Job is already ACTIVE in PostgreSQL; skipping concurrent duplicate delivery', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        organisationId,
      });
      return null;
    }

    logger.info('Job processing started', {
      workerInstanceId: this.workerInstanceId,
      jobId,
      organisationId,
      queueId: persistedQueue.id,
      queueName: persistedQueue.name,
      jobName: activation.job.name,
      attemptNumber,
      maxAttempts,
    });

    const execStartedAt = Date.now();

    // 2. Execute decoupled processor with optional schedule maxDurationMs timeout guard
    try {
      const execPromise = this.registry.execute({
        jobId,
        organisationId,
        queueId: persistedQueue.id,
        queueName: persistedQueue.name,
        jobName: activation.job.name,
        payload: activation.job.payload,
        attemptNumber,
        maxAttempts,
      });

      let procResult: ProcessorResult;
      const maxDurationMs = activation.maxDurationMs;

      if (maxDurationMs && maxDurationMs > 0) {
        let timeoutHandle: NodeJS.Timeout | undefined;
        try {
          procResult = await Promise.race([
            execPromise,
            new Promise<never>((_resolve, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(
                  new Error(
                    `Job execution exceeded schedule maxDurationMs limit (${maxDurationMs}ms)`,
                  ),
                );
              }, maxDurationMs);
              timeoutHandle.unref();
            }),
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      } else {
        procResult = await execPromise;
      }

      const sync = await this.jobs.markJobCompleted(
        organisationId,
        jobId,
        {
          processor: procResult.processor,
          output: procResult.output,
          durationMs: procResult.durationMs,
        },
        attemptNumber,
        {
          durationMs: procResult.durationMs,
          workerId: this.workerInstanceId,
        },
      );

      await workerHealthService.recordJobOutcome(this.workerInstanceId, 'succeeded');

      logger.info('Job completed', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        organisationId,
        queueId: persistedQueue.id,
        jobName: activation.job.name,
        processor: procResult.processor,
        attemptNumber,
        durationMs: procResult.durationMs,
        syncOutcome: sync.outcome,
      });

      return procResult;
    } catch (err) {
      const durationMs = Math.max(0, Date.now() - execStartedAt);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isNonRetryable =
        err instanceof InvalidJobPayloadError || err instanceof UnregisteredProcessorError;
      const hasRemainingAttempts = !isNonRetryable && attemptNumber < maxAttempts;

      if (hasRemainingAttempts) {
        await this.jobs.markJobRetryScheduled(organisationId, jobId, errorMessage, attemptNumber, {
          workerId: this.workerInstanceId,
        });

        logger.warn('Job attempt failed; BullMQ retry scheduled', {
          workerInstanceId: this.workerInstanceId,
          jobId,
          organisationId,
          queueId: persistedQueue.id,
          jobName: activation.job.name,
          attemptNumber,
          maxAttempts,
          error: errorMessage,
        });

        throw err;
      }

      // Exhausted retries or non-retryable error -> mark FAILED + idempotently route to DLQ
      await this.jobs.markJobFailed(organisationId, jobId, errorMessage, attemptNumber, {
        durationMs,
        workerId: this.workerInstanceId,
        routeToDlq: true,
      });

      await workerHealthService.recordJobOutcome(this.workerInstanceId, 'failed', errorMessage);

      logger.error('Job permanently failed', {
        workerInstanceId: this.workerInstanceId,
        jobId,
        organisationId,
        queueId: persistedQueue.id,
        jobName: activation.job.name,
        attemptNumber,
        maxAttempts,
        nonRetryable: isNonRetryable,
        error: errorMessage,
      });

      if (isNonRetryable) {
        throw new UnrecoverableError(errorMessage);
      }

      throw err;
    }
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all(
      Array.from(this.workers.values()).map((entry) => entry.worker.waitUntilReady()),
    );
  }

  async unregisterWorker(organisationId: string, queueName: string): Promise<void> {
    const key = buildBullMQQueueName(organisationId, queueName);
    const entry = this.workers.get(key);
    if (!entry) {
      return;
    }

    this.workers.delete(key);
    try {
      await entry.worker.close();
      logger.info('Worker unregistered and closed', {
        workerInstanceId: this.workerInstanceId,
        bullmqQueueName: key,
        organisationId,
      });
    } catch (err) {
      logger.warn('Error closing worker during unregister', {
        workerInstanceId: this.workerInstanceId,
        bullmqQueueName: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async closeAll(): Promise<void> {
    this.isClosing = true;
    const entries = Array.from(this.workers.values());
    this.workers.clear();

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await entry.worker.close();
        } catch (err) {
          logger.warn('Error closing BullMQ worker during shutdown', {
            workerInstanceId: this.workerInstanceId,
            bullmqQueueName: entry.bullmqQueueName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    logger.info('All BullMQ workers closed cleanly', {
      workerInstanceId: this.workerInstanceId,
      closedWorkers: entries.length,
    });
    this.isClosing = false;
  }
}

import { Worker, UnrecoverableError, type ConnectionOptions, type Job as BullJob } from 'bullmq';
import {
  buildBullMQQueueName,
  buildBullMQRedisOptions,
  env,
  jobService,
  logger,
  sanitizeRedisUrl,
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
  registry?: ProcessorRegistry;
  jobService?: JobService;
  redisUrl?: string;
}

/**
 * Manages BullMQ Worker instances for organisation-scoped queues within a worker process.
 *
 * Guarantees:
 * - Prevents duplicate worker registration for the same org + queue in a process.
 * - Maps persisted queue `concurrency` into BullMQ Worker options.
 * - Each Worker receives its own blocking Redis connection built from REDIS_URL
 *   with `maxRetriesPerRequest: null` (as required by BullMQ).
 * - Synchronizes PostgreSQL job status atomically via `jobService` without ever
 *   overwriting terminal states (`COMPLETED` / `FAILED`) or crashing on deleted jobs.
 * - Keeps PostgreSQL accurate across retries: marks retrying jobs `DELAYED` and only
 *   marks permanently `FAILED` once all BullMQ attempts are exhausted or unrecoverable.
 */
export class WorkerManager {
  private readonly workers = new Map<string, RegisteredWorkerEntry>();
  private readonly registry: ProcessorRegistry;
  private readonly jobs: JobService;
  private readonly redisUrl: string;
  private isClosing = false;

  constructor(options: WorkerManagerOptions = {}) {
    this.registry = options.registry ?? createDefaultProcessorRegistry();
    this.jobs = options.jobService ?? jobService;
    this.redisUrl = options.redisUrl ?? env.REDIS_URL;
  }

  getProcessorRegistry(): ProcessorRegistry {
    return this.registry;
  }

  listRegisteredWorkers(): string[] {
    return Array.from(this.workers.keys());
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
      // Update runtime concurrency if changed in PostgreSQL
      if (existing.concurrency !== persistedQueue.concurrency) {
        existing.worker.concurrency = persistedQueue.concurrency;
        existing.concurrency = persistedQueue.concurrency;
        logger.info('Updated worker concurrency', {
          bullmqQueueName,
          organisationId: persistedQueue.organisationId,
          concurrency: persistedQueue.concurrency,
        });
      }
      return existing;
    }

    // BullMQ Workers require blocking commands; pass parsed RedisOptions so BullMQ
    // owns a dedicated connection per worker and closes it cleanly on worker.close()
    const connectionOptions = buildBullMQRedisOptions(this.redisUrl);
    // Workers connect immediately on startup
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
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        target: sanitizeRedisUrl(this.redisUrl),
        error: err.message,
      });
    });

    worker.on('failed', (bullJob, err) => {
      logger.warn('BullMQ Worker reported failed attempt', {
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
   * Handles atomic PostgreSQL activation, processor execution, retry vs terminal failure
   * synchronisation, and safe handling of missing/deleted/already-terminal jobs.
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
        organisationId,
        queueId: persistedQueue.id,
      });
      return null;
    }

    // Enforce tenant isolation: reject mismatched organisation payload
    if (organisationId !== persistedQueue.organisationId) {
      logger.error('Tenant mismatch between BullMQ worker queue and job payload; aborting', {
        jobId,
        expectedOrganisationId: persistedQueue.organisationId,
        payloadOrganisationId: organisationId,
      });
      throw new UnrecoverableError('Cross-tenant job payload rejected');
    }

    // 1. Atomically claim job as ACTIVE in PostgreSQL
    const activation = await this.jobs.markJobActive(organisationId, jobId, attemptNumber);

    if (activation.outcome === 'missing') {
      logger.warn('PostgreSQL job missing or cancelled before execution; skipping', {
        jobId,
        organisationId,
        queueId: persistedQueue.id,
      });
      return null;
    }

    if (activation.outcome === 'already_terminal') {
      logger.warn('Ignoring duplicate delivery for job already in terminal state', {
        jobId,
        organisationId,
        terminalStatus: activation.status,
      });
      return null;
    }

    if (activation.outcome === 'already_active') {
      logger.warn('Job is already ACTIVE in PostgreSQL; skipping concurrent duplicate delivery', {
        jobId,
        organisationId,
      });
      return null;
    }

    logger.info('Job processing started', {
      jobId,
      organisationId,
      queueId: persistedQueue.id,
      queueName: persistedQueue.name,
      jobName: activation.job.name,
      attemptNumber,
      maxAttempts,
    });

    // 2. Execute decoupled processor (never log raw user payload contents)
    try {
      const procResult = await this.registry.execute({
        jobId,
        organisationId,
        queueId: persistedQueue.id,
        queueName: persistedQueue.name,
        jobName: activation.job.name,
        payload: activation.job.payload,
        attemptNumber,
        maxAttempts,
      });

      // 3a. Persist COMPLETED state + structured result atomically
      const sync = await this.jobs.markJobCompleted(
        organisationId,
        jobId,
        {
          processor: procResult.processor,
          output: procResult.output,
          durationMs: procResult.durationMs,
        },
        attemptNumber,
      );

      logger.info('Job completed', {
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isNonRetryable =
        err instanceof InvalidJobPayloadError || err instanceof UnregisteredProcessorError;
      const hasRemainingAttempts = !isNonRetryable && attemptNumber < maxAttempts;

      if (hasRemainingAttempts) {
        // 3b. Retry will be scheduled by BullMQ — mark PG as DELAYED (NOT FAILED!)
        await this.jobs.markJobRetryScheduled(organisationId, jobId, errorMessage, attemptNumber);

        logger.warn('Job attempt failed; BullMQ retry scheduled', {
          jobId,
          organisationId,
          queueId: persistedQueue.id,
          jobName: activation.job.name,
          attemptNumber,
          maxAttempts,
          error: errorMessage,
        });

        // Rethrow so BullMQ applies configured exponential backoff & schedules next attempt
        throw err;
      }

      // 3c. Attempts exhausted or non-retryable error — mark permanently FAILED in PostgreSQL
      await this.jobs.markJobFailed(organisationId, jobId, errorMessage, attemptNumber);

      logger.error('Job permanently failed', {
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

  /**
   * Waits until all registered workers have established their Redis connections.
   */
  async waitUntilReady(): Promise<void> {
    await Promise.all(
      Array.from(this.workers.values()).map((entry) => entry.worker.waitUntilReady()),
    );
  }

  /**
   * Unregisters and gracefully closes a single worker.
   */
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
        bullmqQueueName: key,
        organisationId,
      });
    } catch (err) {
      logger.warn('Error closing worker during unregister', {
        bullmqQueueName: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Gracefully closes all active BullMQ workers, allowing in-flight jobs to finish.
   */
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
            bullmqQueueName: entry.bullmqQueueName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    logger.info('All BullMQ workers closed cleanly', { closedWorkers: entries.length });
    this.isClosing = false;
  }
}

import { Queue as BullMQQueue, type JobsOptions, type DefaultJobOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import {
  getBullMQConnection,
  ensureBullMQConnectionReady,
  disconnectBullMQConnection,
} from '../config/redis.js';
import { QUEUE_LIMITS } from '../validators/queue.validator.js';
import { logger } from '../utils/logger.js';

export interface PersistedQueueDescriptor {
  id: string;
  organisationId: string;
  name: string;
  isPaused: boolean;
  concurrency: number;
  defaultPriority: number;
  maxRetries: number;
  backoffMs: number;
}

export interface PersistedJobDescriptor {
  id: string;
  queueId: string;
  name: string;
  priority: number;
  payload: Prisma.JsonValue;
  maxRetries: number;
  backoffMs: number;
  delayMs: number;
}

export interface BullMQJobPayload {
  jobId: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  name: string;
  payload: Prisma.JsonValue;
}

export interface MappedBullMQQueueConfig {
  bullmqQueueName: string;
  workerOptions: {
    concurrency: number;
  };
  defaultJobOptions: DefaultJobOptions;
}

export interface RegisteredBullMQQueue {
  bullmqQueueName: string;
  organisationId: string;
  queueId: string;
  logicalName: string;
  config: MappedBullMQQueueConfig;
  queue: BullMQQueue<BullMQJobPayload>;
}

export interface EnqueueResult {
  broker: 'bullmq';
  enqueued: boolean;
  deduplicated: boolean;
  bullmqQueueName: string;
  bullmqJobId: string | null;
  error?: string;
}

export interface PauseSyncResult {
  synced: boolean;
  bullmqQueueName: string;
  isPaused: boolean;
  error?: string;
}

export interface BullMQServiceDeps {
  getConnection?: () => Redis;
  ensureReady?: (connection: Redis, timeoutMs?: number) => Promise<void>;
  disconnectConnection?: () => Promise<void>;
  createQueue?: (
    bullmqQueueName: string,
    connection: Redis,
    defaultJobOptions: DefaultJobOptions,
  ) => BullMQQueue<BullMQJobPayload>;
}

/**
 * Builds a deterministic, organisation-scoped, colon-free BullMQ queue name.
 * BullMQ forbids ':' in queue names because Redis keys use `bull:<name>:*`.
 */
export function buildBullMQQueueName(organisationId: string, queueName: string): string {
  if (organisationId.includes(':') || queueName.includes(':')) {
    throw new Error('BullMQ queue identifier segments must not contain ":"');
  }
  return `org_${organisationId}__${queueName}`;
}

/**
 * Maps PulseQueue priority (1 = lowest .. 20 = critical/highest) to BullMQ priority
 * (1 = highest .. 20 = lowest).
 */
export function mapPriorityToBullMQ(pulsePriority: number): number {
  const clamped = Math.max(
    QUEUE_LIMITS.MIN_PRIORITY,
    Math.min(QUEUE_LIMITS.MAX_PRIORITY, Math.round(pulsePriority)),
  );
  return QUEUE_LIMITS.MAX_PRIORITY + QUEUE_LIMITS.MIN_PRIORITY - clamped;
}

/**
 * Maps persisted PostgreSQL queue configuration into BullMQ queue & future-worker options.
 */
export function mapQueueConfigToBullMQ(queue: PersistedQueueDescriptor): MappedBullMQQueueConfig {
  const bullmqQueueName = buildBullMQQueueName(queue.organisationId, queue.name);

  const defaultJobOptions: DefaultJobOptions = {
    priority: mapPriorityToBullMQ(queue.defaultPriority),
    attempts: Math.max(1, queue.maxRetries + 1),
    ...(queue.backoffMs > 0
      ? {
          backoff: {
            type: 'exponential',
            delay: queue.backoffMs,
          },
        }
      : {}),
  };

  return {
    bullmqQueueName,
    workerOptions: {
      concurrency: queue.concurrency,
    },
    defaultJobOptions,
  };
}

/**
 * Maps a persisted PostgreSQL job into BullMQ per-job options using a stable jobId.
 */
export function mapJobOptionsToBullMQ(job: PersistedJobDescriptor): JobsOptions {
  const options: JobsOptions = {
    // Stable identifier prevents duplicate BullMQ jobs on retry/re-enqueue
    jobId: job.id,
    priority: mapPriorityToBullMQ(job.priority),
    attempts: Math.max(1, job.maxRetries + 1),
    ...(job.backoffMs > 0
      ? {
          backoff: {
            type: 'exponential',
            delay: job.backoffMs,
          },
        }
      : {}),
    ...(job.delayMs > 0 ? { delay: job.delayMs } : {}),
  };

  return options;
}

/**
 * Central BullMQ queue-management and reliable enqueue service.
 *
 * PostgreSQL remains the authoritative source of truth for organisation, queue,
 * and job metadata. This service manages deduplicated BullMQ Queue producers
 * sharing a single Redis connection and handles Redis failures safely without
 * silently losing persisted PostgreSQL jobs.
 */
export class BullMQService {
  private readonly registry = new Map<string, RegisteredBullMQQueue>();
  private readonly getConnectionFn: () => Redis;
  private readonly ensureReadyFn: (connection: Redis, timeoutMs?: number) => Promise<void>;
  private readonly disconnectConnectionFn: () => Promise<void>;
  private readonly createQueueFn: (
    bullmqQueueName: string,
    connection: Redis,
    defaultJobOptions: DefaultJobOptions,
  ) => BullMQQueue<BullMQJobPayload>;

  constructor(deps: BullMQServiceDeps = {}) {
    this.getConnectionFn = deps.getConnection ?? getBullMQConnection;
    this.ensureReadyFn = deps.ensureReady ?? ensureBullMQConnectionReady;
    this.disconnectConnectionFn = deps.disconnectConnection ?? disconnectBullMQConnection;
    this.createQueueFn =
      deps.createQueue ??
      ((bullmqQueueName, connection, defaultJobOptions) =>
        new BullMQQueue<BullMQJobPayload>(bullmqQueueName, {
          connection,
          defaultJobOptions,
        }));
  }

  /**
   * Registers or retrieves the BullMQ Queue corresponding to a persisted PostgreSQL queue.
   * Deduplicates by organisation-scoped BullMQ queue name to avoid duplicate registrations.
   */
  getOrRegisterQueue(persistedQueue: PersistedQueueDescriptor): RegisteredBullMQQueue {
    const mappedConfig = mapQueueConfigToBullMQ(persistedQueue);
    const existing = this.registry.get(mappedConfig.bullmqQueueName);

    if (existing) {
      // Refresh cached config metadata if queue settings were updated in PostgreSQL
      existing.config = mappedConfig;
      existing.queueId = persistedQueue.id;
      return existing;
    }

    const connection = this.getConnectionFn();
    const queue = this.createQueueFn(
      mappedConfig.bullmqQueueName,
      connection,
      mappedConfig.defaultJobOptions,
    );

    queue.on('error', (err) => {
      logger.error('BullMQ Queue error', {
        bullmqQueueName: mappedConfig.bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        error: err.message,
      });
    });

    const entry: RegisteredBullMQQueue = {
      bullmqQueueName: mappedConfig.bullmqQueueName,
      organisationId: persistedQueue.organisationId,
      queueId: persistedQueue.id,
      logicalName: persistedQueue.name,
      config: mappedConfig,
      queue,
    };

    this.registry.set(mappedConfig.bullmqQueueName, entry);

    logger.info('BullMQ queue registered', {
      bullmqQueueName: mappedConfig.bullmqQueueName,
      organisationId: persistedQueue.organisationId,
      queueId: persistedQueue.id,
      concurrency: mappedConfig.workerOptions.concurrency,
    });

    return entry;
  }

  /**
   * Returns an already-registered BullMQ queue entry, if present.
   */
  getRegisteredQueue(organisationId: string, queueName: string): RegisteredBullMQQueue | undefined {
    const key = buildBullMQQueueName(organisationId, queueName);
    return this.registry.get(key);
  }

  /**
   * Lists all currently registered BullMQ queue names (useful for diagnostics/shutdown).
   */
  listRegisteredQueueNames(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Closes and removes a BullMQ queue from the registry (e.g. after delete or rename).
   */
  async unregisterQueue(organisationId: string, queueName: string): Promise<void> {
    const key = buildBullMQQueueName(organisationId, queueName);
    const entry = this.registry.get(key);
    if (!entry) {
      return;
    }

    this.registry.delete(key);
    try {
      await entry.queue.close();
      logger.info('BullMQ queue unregistered', {
        bullmqQueueName: key,
        organisationId,
      });
    } catch (err) {
      logger.warn('Error closing BullMQ queue during unregister', {
        bullmqQueueName: key,
        organisationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Synchronizes a queue's persisted pause/resume state with BullMQ.
   * Failures are caught and logged without corrupting PostgreSQL state.
   */
  async syncQueuePauseState(persistedQueue: PersistedQueueDescriptor): Promise<PauseSyncResult> {
    const bullmqQueueName = buildBullMQQueueName(
      persistedQueue.organisationId,
      persistedQueue.name,
    );

    try {
      const connection = this.getConnectionFn();
      await this.ensureReadyFn(connection);
      const { queue } = this.getOrRegisterQueue(persistedQueue);

      if (persistedQueue.isPaused) {
        await queue.pause();
      } else {
        await queue.resume();
      }

      logger.info('Synchronized queue pause state with BullMQ', {
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        isPaused: persistedQueue.isPaused,
      });

      return {
        synced: true,
        bullmqQueueName,
        isPaused: persistedQueue.isPaused,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to synchronize queue pause state with BullMQ', {
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        isPaused: persistedQueue.isPaused,
        error: message,
      });

      return {
        synced: false,
        bullmqQueueName,
        isPaused: persistedQueue.isPaused,
        error: message,
      };
    }
  }

  /**
   * Reliable enqueue adapter: adds a persisted PostgreSQL job into BullMQ using
   * the job's UUID as a stable jobId so duplicate enqueue attempts are idempotent.
   *
   * Never mutates PostgreSQL job status. On Redis outage, returns `enqueued: false`
   * so callers know the durable PostgreSQL job requires later reconciliation.
   */
  async enqueueJob(
    persistedQueue: PersistedQueueDescriptor,
    persistedJob: PersistedJobDescriptor,
  ): Promise<EnqueueResult> {
    const bullmqQueueName = buildBullMQQueueName(
      persistedQueue.organisationId,
      persistedQueue.name,
    );

    try {
      const connection = this.getConnectionFn();
      await this.ensureReadyFn(connection);

      const { queue } = this.getOrRegisterQueue(persistedQueue);

      // Keep BullMQ pause state aligned if queue was created paused
      if (persistedQueue.isPaused) {
        await queue.pause();
      }

      // Check for existing job with the same stable jobId for explicit duplicate reporting
      const existingBullJob = await queue.getJob(persistedJob.id);
      if (existingBullJob) {
        logger.info('Duplicate BullMQ enqueue prevented via stable jobId', {
          jobId: persistedJob.id,
          bullmqQueueName,
          organisationId: persistedQueue.organisationId,
        });

        return {
          broker: 'bullmq',
          enqueued: true,
          deduplicated: true,
          bullmqQueueName,
          bullmqJobId: existingBullJob.id ?? persistedJob.id,
        };
      }

      const payload: BullMQJobPayload = {
        jobId: persistedJob.id,
        organisationId: persistedQueue.organisationId,
        queueId: persistedQueue.id,
        queueName: persistedQueue.name,
        name: persistedJob.name,
        payload: persistedJob.payload,
      };

      const jobOptions = mapJobOptionsToBullMQ(persistedJob);
      const bullJob = await queue.add(persistedJob.name, payload, jobOptions);

      logger.info('Job enqueued to BullMQ', {
        jobId: persistedJob.id,
        bullmqJobId: bullJob.id,
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
      });

      return {
        broker: 'bullmq',
        enqueued: true,
        deduplicated: false,
        bullmqQueueName,
        bullmqJobId: bullJob.id ?? persistedJob.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        'Failed to enqueue persisted job to BullMQ; job remains durable in PostgreSQL for reconciliation',
        {
          jobId: persistedJob.id,
          queueId: persistedQueue.id,
          organisationId: persistedQueue.organisationId,
          bullmqQueueName,
          error: message,
        },
      );

      return {
        broker: 'bullmq',
        enqueued: false,
        deduplicated: false,
        bullmqQueueName,
        bullmqJobId: null,
        error: message,
      };
    }
  }

  /**
   * Best-effort removal of a cancelled pre-execution job from BullMQ.
   */
  async removeJobFromBullMQ(
    persistedQueue: PersistedQueueDescriptor,
    jobId: string,
  ): Promise<boolean> {
    const bullmqQueueName = buildBullMQQueueName(
      persistedQueue.organisationId,
      persistedQueue.name,
    );

    try {
      const connection = this.getConnectionFn();
      await this.ensureReadyFn(connection);
      const { queue } = this.getOrRegisterQueue(persistedQueue);

      const bullJob = await queue.getJob(jobId);
      if (bullJob) {
        await bullJob.remove();
        logger.info('Removed cancelled job from BullMQ', {
          jobId,
          bullmqQueueName,
          organisationId: persistedQueue.organisationId,
        });
        return true;
      }

      return false;
    } catch (err) {
      logger.warn('Failed to remove cancelled job from BullMQ', {
        jobId,
        bullmqQueueName,
        organisationId: persistedQueue.organisationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Gracefully closes all registered BullMQ Queue instances and the shared BullMQ Redis connection.
   */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.registry.values());
    this.registry.clear();

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await entry.queue.close();
        } catch (err) {
          logger.warn('Error closing BullMQ queue during shutdown', {
            bullmqQueueName: entry.bullmqQueueName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await this.disconnectConnectionFn();

    logger.info('All BullMQ queues and shared Redis connection closed', {
      closedQueues: entries.length,
    });
  }
}

export const bullMQService = new BullMQService();

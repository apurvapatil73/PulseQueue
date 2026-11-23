import path from 'node:path';
import {
  bullMQService,
  connectDatabase,
  disconnectDatabase,
  disconnectRedis,
  env,
  logger,
  outboxReconciler,
  prisma,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import { WorkerManager } from './workerManager.js';

export interface WorkerRuntimeOptions {
  queueSyncIntervalMs?: number;
  outboxIntervalMs?: number;
  workerManager?: WorkerManager;
}

/**
 * Standalone worker process runtime.
 * Discovers persisted organisation queues from PostgreSQL, registers deduplicated
 * BullMQ workers, runs controlled outbox reconciliation, and supports graceful shutdown.
 */
export class WorkerRuntime {
  private readonly manager: WorkerManager;
  private readonly queueSyncIntervalMs: number;
  private readonly outboxIntervalMs: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  private isShuttingDown = false;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.manager = options.workerManager ?? new WorkerManager();
    this.queueSyncIntervalMs = options.queueSyncIntervalMs ?? 10_000;
    this.outboxIntervalMs = options.outboxIntervalMs ?? 5_000;
  }

  getWorkerManager(): WorkerManager {
    return this.manager;
  }

  /**
   * Discovers persisted queues in PostgreSQL and registers BullMQ workers for each.
   */
  async syncQueuesFromDatabase(): Promise<number> {
    if (this.syncInFlight) {
      return 0;
    }

    this.syncInFlight = true;
    try {
      const queues: PersistedQueueDescriptor[] = await prisma.queue.findMany({
        select: {
          id: true,
          organisationId: true,
          name: true,
          isPaused: true,
          concurrency: true,
          defaultPriority: true,
          maxRetries: true,
          backoffMs: true,
        },
      });

      for (const q of queues) {
        this.manager.registerWorker(q);
      }

      return queues.length;
    } catch (err) {
      logger.error('Failed to synchronize persisted queues for worker runtime', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.syncInFlight = false;
    }
  }

  async start(): Promise<void> {
    logger.info(`Starting PulseQueue Worker Runtime in [${env.NODE_ENV}] mode...`, {
      processors: this.manager.getProcessorRegistry().list(),
    });

    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      throw new Error('Worker runtime could not connect to PostgreSQL');
    }

    const discovered = await this.syncQueuesFromDatabase();
    await this.manager.waitUntilReady();

    // Run one immediate reconciliation pass and start controlled interval reconciliation
    await outboxReconciler.reconcileOnce();
    outboxReconciler.start(this.outboxIntervalMs);

    this.syncTimer = setInterval(() => {
      void this.syncQueuesFromDatabase();
    }, this.queueSyncIntervalMs);
    this.syncTimer.unref();

    logger.info('PulseQueue Worker Runtime started', {
      registeredWorkers: this.manager.listRegisteredWorkers().length,
      discoveredQueues: discovered,
      queueSyncIntervalMs: this.queueSyncIntervalMs,
      outboxIntervalMs: this.outboxIntervalMs,
    });
  }

  async stop(signal: string = 'SIGTERM'): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    logger.info(`Worker runtime received ${signal}. Initiating graceful shutdown...`);

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    outboxReconciler.stop();
    await this.manager.closeAll();
    await bullMQService.closeAll();
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('PulseQueue Worker Runtime shutdown complete.');
  }
}

const entryArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRunner =
  entryArg.endsWith(`${path.sep}workerRunner.js`) ||
  entryArg.endsWith(`${path.sep}workerRunner.ts`);

if (process.env.NODE_ENV !== 'test' && isDirectRunner) {
  const runtime = new WorkerRuntime();

  const handleSignal = (sig: string) => {
    runtime
      .stop(sig)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('uncaughtException', (err: Error) => {
    logger.error(`Worker Uncaught Exception: ${err.message}`, { stack: err.stack });
    runtime
      .stop('UNCAUGHT_EXCEPTION')
      .then(() => process.exit(1))
      .catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Worker Unhandled Promise Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  runtime.start().catch((err) => {
    logger.error('Fatal worker startup error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

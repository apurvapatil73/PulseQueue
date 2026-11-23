import path from 'node:path';
import {
  bullMQService,
  connectDatabase,
  disconnectDatabase,
  disconnectRedis,
  env,
  eventRetentionService,
  logger,
  outboxReconciler,
  prisma,
  scheduleDispatcherService,
  stalledJobRecoveryService,
  workerHealthService,
  type PersistedQueueDescriptor,
} from '@pulsequeue/backend';
import { WorkerManager } from './workerManager.js';

export interface WorkerRuntimeOptions {
  queueSyncIntervalMs?: number;
  outboxIntervalMs?: number;
  heartbeatIntervalMs?: number;
  stalledRecoveryIntervalMs?: number;
  workerManager?: WorkerManager;
}

/**
 * Standalone worker process runtime.
 * Discovers persisted organisation queues from PostgreSQL, registers deduplicated
 * BullMQ workers, publishes periodic heartbeats, runs outbox reconciliation &
 * stalled-job recovery, and shuts down gracefully.
 */
export class WorkerRuntime {
  private readonly manager: WorkerManager;
  private readonly queueSyncIntervalMs: number;
  private readonly outboxIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly stalledRecoveryIntervalMs: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  private heartbeatInFlight = false;
  private isShuttingDown = false;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.manager = options.workerManager ?? new WorkerManager();
    this.queueSyncIntervalMs = options.queueSyncIntervalMs ?? 10_000;
    this.outboxIntervalMs = options.outboxIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.stalledRecoveryIntervalMs = options.stalledRecoveryIntervalMs ?? 15_000;
  }

  getWorkerManager(): WorkerManager {
    return this.manager;
  }

  /**
   * Publishes a heartbeat for this worker instance with its registered queues & orgs.
   */
  async publishHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight || this.isShuttingDown) {
      return;
    }

    this.heartbeatInFlight = true;
    try {
      const identity = this.manager.getWorkerIdentity();
      await workerHealthService.recordHeartbeat({
        ...identity,
        registeredQueues: this.manager.listRegisteredWorkers(),
        organisationIds: this.manager.listRegisteredOrganisationIds(),
      });
    } catch (err) {
      logger.warn('Failed to publish worker heartbeat', {
        workerInstanceId: this.manager.getWorkerInstanceId(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.heartbeatInFlight = false;
    }
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
        workerInstanceId: this.manager.getWorkerInstanceId(),
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.syncInFlight = false;
    }
  }

  async start(): Promise<void> {
    const identity = this.manager.getWorkerIdentity();

    logger.info(`Starting PulseQueue Worker Runtime in [${env.NODE_ENV}] mode...`, {
      workerInstanceId: identity.workerInstanceId,
      pid: identity.pid,
      processors: this.manager.getProcessorRegistry().list(),
    });

    const dbConnected = await connectDatabase();
    if (!dbConnected) {
      throw new Error('Worker runtime could not connect to PostgreSQL');
    }

    const discovered = await this.syncQueuesFromDatabase();
    await this.manager.waitUntilReady();

    // Register initial ONLINE worker heartbeat + WORKER_STARTED event
    await workerHealthService.registerWorkerStart({
      ...identity,
      registeredQueues: this.manager.listRegisteredWorkers(),
      organisationIds: this.manager.listRegisteredOrganisationIds(),
    });

    // Run one immediate outbox + BullMQ schedule reconcile + schedule tick and start intervals
    await outboxReconciler.reconcileOnce();
    await scheduleDispatcherService.reconcileWithBullMQ();
    await scheduleDispatcherService.tick();
    outboxReconciler.start(this.outboxIntervalMs);
    stalledJobRecoveryService.start(this.stalledRecoveryIntervalMs);
    scheduleDispatcherService.start(1000, 30_000);
    workerHealthService.startStaleSweep(15_000);
    eventRetentionService.start();

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();

    this.syncTimer = setInterval(() => {
      void this.syncQueuesFromDatabase();
    }, this.queueSyncIntervalMs);
    this.syncTimer.unref();

    logger.info('PulseQueue Worker Runtime started', {
      workerInstanceId: identity.workerInstanceId,
      registeredWorkers: this.manager.listRegisteredWorkers().length,
      discoveredQueues: discovered,
      queueSyncIntervalMs: this.queueSyncIntervalMs,
      outboxIntervalMs: this.outboxIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
  }

  async stop(signal: string = 'SIGTERM'): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    const workerId = this.manager.getWorkerInstanceId();
    logger.info(`Worker runtime received ${signal}. Initiating graceful shutdown...`, {
      workerInstanceId: workerId,
    });

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    outboxReconciler.stop();
    stalledJobRecoveryService.stop();
    scheduleDispatcherService.stop();
    workerHealthService.stopStaleSweep();
    eventRetentionService.stop();
    await this.manager.closeAll();

    // Record graceful STOPPED state before closing PostgreSQL
    try {
      await workerHealthService.markWorkerStopped(workerId, `Graceful shutdown (${signal})`);
    } catch (err) {
      logger.warn('Failed to mark worker stopped in database', {
        workerInstanceId: workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await bullMQService.closeAll();
    await disconnectDatabase();
    await disconnectRedis();

    logger.info('PulseQueue Worker Runtime shutdown complete.', { workerInstanceId: workerId });
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

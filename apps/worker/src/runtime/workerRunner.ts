import path from 'node:path';
import {
  alertEvaluatorService,
  bullMQService,
  connectDatabase,
  disconnectDatabase,
  disconnectRedis,
  env,
  eventRetentionService,
  logger,
  outboxReconciler,
  prioritySchedulerService,
  prisma,
  realtimeEventBus,
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
  alertEvalIntervalMs?: number;
  schedulerIntervalMs?: number;
  shutdownDrainTimeoutMs?: number;
  shutdownEscalationGraceMs?: number;
  workerManager?: WorkerManager;
  schedulerService?: typeof prioritySchedulerService;
  disconnectDeps?: () => Promise<void>;
}

export interface WorkerStopResult {
  clean: boolean;
  schedulerDrained: boolean;
  escalated: boolean;
  timedOut: boolean;
  dependenciesClosed: boolean;
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
  private readonly alertEvalIntervalMs: number;
  private readonly schedulerIntervalMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly shutdownEscalationGraceMs: number;
  private readonly scheduler: typeof prioritySchedulerService;
  private readonly disconnectDeps: () => Promise<void>;
  private syncTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncInFlight = false;
  private heartbeatInFlight = false;
  private isShuttingDown = false;
  private shutdownPromise: Promise<WorkerStopResult> | null = null;
  private depsClosed = false;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuHrTimeNs: bigint | null = null;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.manager = options.workerManager ?? new WorkerManager();
    this.queueSyncIntervalMs = options.queueSyncIntervalMs ?? 10_000;
    this.outboxIntervalMs = options.outboxIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.stalledRecoveryIntervalMs = options.stalledRecoveryIntervalMs ?? 15_000;
    this.alertEvalIntervalMs = options.alertEvalIntervalMs ?? 30_000;
    this.schedulerIntervalMs = options.schedulerIntervalMs ?? 250;
    this.shutdownDrainTimeoutMs = Math.max(50, options.shutdownDrainTimeoutMs ?? 5_000);
    this.shutdownEscalationGraceMs = Math.max(50, options.shutdownEscalationGraceMs ?? 5_000);
    this.scheduler = options.schedulerService ?? prioritySchedulerService;
    this.disconnectDeps =
      options.disconnectDeps ??
      (async () => {
        await bullMQService.closeAll();
        await disconnectDatabase();
        await disconnectRedis();
      });
  }

  getWorkerManager(): WorkerManager {
    return this.manager;
  }

  /**
   * Collects non-blocking process-level telemetry (CPU %, RSS bytes, uptime, concurrency).
   * Never throws so telemetry issues cannot interrupt job processing or crash the worker.
   */
  collectProcessTelemetry(): {
    configuredConcurrency: number;
    cpuUsagePercent: number | null;
    memoryRssBytes: bigint | null;
    uptimeSeconds: number | null;
  } {
    let cpuUsagePercent: number | null = null;
    let memoryRssBytes: bigint | null = null;
    let uptimeSeconds: number | null = null;

    try {
      const nowHr = process.hrtime.bigint();
      const curCpu = process.cpuUsage();
      if (this.lastCpuUsage && this.lastCpuHrTimeNs !== null) {
        const elapsedUs = Number(nowHr - this.lastCpuHrTimeNs) / 1000;
        const cpuDeltaUs =
          curCpu.user - this.lastCpuUsage.user + (curCpu.system - this.lastCpuUsage.system);
        if (elapsedUs > 0 && cpuDeltaUs >= 0) {
          cpuUsagePercent = Math.round((cpuDeltaUs / elapsedUs) * 100 * 100) / 100;
        }
      }
      this.lastCpuUsage = curCpu;
      this.lastCpuHrTimeNs = nowHr;
    } catch {
      cpuUsagePercent = null;
    }

    try {
      memoryRssBytes = BigInt(process.memoryUsage().rss);
    } catch {
      memoryRssBytes = null;
    }

    try {
      uptimeSeconds = Math.max(0, Math.floor(process.uptime()));
    } catch {
      uptimeSeconds = null;
    }

    return {
      configuredConcurrency: this.manager.getConfiguredConcurrency(),
      cpuUsagePercent,
      memoryRssBytes,
      uptimeSeconds,
    };
  }

  /**
   * Publishes a heartbeat for this worker instance with its registered queues, orgs & telemetry.
   */
  async publishHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight || this.isShuttingDown) {
      return;
    }

    this.heartbeatInFlight = true;
    try {
      const identity = this.manager.getWorkerIdentity();
      const telemetry = this.collectProcessTelemetry();
      await workerHealthService.recordHeartbeat({
        ...identity,
        ...telemetry,
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
          poisonFailureThreshold: true,
          schedulingPolicy: true,
          agingRatePerSec: true,
        },
      });

      for (const q of queues) {
        this.manager.registerWorker(q);
      }

      await this.manager.reconcileDeletedQueues(queues);

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

    // Register initial ONLINE worker heartbeat + WORKER_STARTED event with initial telemetry
    const initialTelemetry = this.collectProcessTelemetry();
    await workerHealthService.registerWorkerStart({
      ...identity,
      ...initialTelemetry,
      registeredQueues: this.manager.listRegisteredWorkers(),
      organisationIds: this.manager.listRegisteredOrganisationIds(),
    });

    // Run one immediate outbox + BullMQ schedule reconcile + schedule tick + custom scheduler tick
    await outboxReconciler.reconcileOnce();
    await scheduleDispatcherService.reconcileWithBullMQ();
    await scheduleDispatcherService.tick();
    await prioritySchedulerService.tickAllQueues({ claimerId: identity.workerInstanceId });
    outboxReconciler.start(this.outboxIntervalMs);
    prioritySchedulerService.start({
      intervalMs: this.schedulerIntervalMs,
      claimerId: identity.workerInstanceId,
    });
    stalledJobRecoveryService.start(this.stalledRecoveryIntervalMs);
    scheduleDispatcherService.start(1000, 30_000);
    workerHealthService.startStaleSweep(15_000);
    eventRetentionService.start();
    alertEvaluatorService.start(this.alertEvalIntervalMs);

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

  private async closeDependenciesOnce(): Promise<void> {
    if (this.depsClosed) {
      return;
    }
    this.depsClosed = true;
    await this.disconnectDeps();
  }

  async stop(signal: string = 'SIGTERM'): Promise<WorkerStopResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.isShuttingDown = true;

    this.shutdownPromise = this.performStop(signal);
    return this.shutdownPromise;
  }

  private async performStop(signal: string): Promise<WorkerStopResult> {
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
    alertEvaluatorService.stop();

    // Phase 1: Stop scheduler loop and wait up to shutdownDrainTimeoutMs for in-flight ticks
    let { drained: schedulerDrained } = await this.scheduler.stopAndDrain(
      this.shutdownDrainTimeoutMs,
    );
    let escalated = false;

    await this.manager.closeAll();

    // Record graceful STOPPED state while PostgreSQL is still connected
    try {
      await workerHealthService.markWorkerStopped(workerId, `Graceful shutdown (${signal})`);
    } catch (err) {
      logger.warn('Failed to mark worker stopped in database', {
        workerInstanceId: workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await realtimeEventBus.closeAll();

    // Phase 2: Bounded escalation retry if scheduler tick was still active after Phase 1
    if (!schedulerDrained) {
      escalated = true;
      logger.warn(
        'Priority scheduler tick still in flight after initial drain timeout; entering bounded grace retry',
        {
          workerInstanceId: workerId,
          escalationGraceMs: this.shutdownEscalationGraceMs,
        },
      );
      const retryRes = await this.scheduler.stopAndDrain(this.shutdownEscalationGraceMs);
      schedulerDrained = retryRes.drained;
    }

    // Phase 3: Never disconnect BullMQ/Prisma/Redis underneath an active tick.
    // If still active after bounded escalation, attach deferred cleanup to whenDrained()
    // and return timedOut=true so the CLI signal handler exits non-zero in bounded time.
    if (!schedulerDrained) {
      logger.error(
        'Priority scheduler tick did not finish within bounded shutdown window; deferring dependency disconnect until tick settles',
        { workerInstanceId: workerId },
      );
      void this.scheduler
        .whenDrained()
        .then(() => this.closeDependenciesOnce())
        .catch((err) => {
          logger.warn('Deferred worker dependency cleanup failed', {
            workerInstanceId: workerId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      return {
        clean: false,
        schedulerDrained: false,
        escalated,
        timedOut: true,
        dependenciesClosed: false,
      };
    }

    await this.closeDependenciesOnce();

    logger.info('PulseQueue Worker Runtime shutdown complete.', { workerInstanceId: workerId });
    return {
      clean: true,
      schedulerDrained: true,
      escalated,
      timedOut: false,
      dependenciesClosed: true,
    };
  }
}

const entryArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRunner =
  entryArg.endsWith(`${path.sep}workerRunner.js`) ||
  entryArg.endsWith(`${path.sep}workerRunner.ts`);

if (process.env.NODE_ENV !== 'test' && isDirectRunner) {
  const runtime = new WorkerRuntime();
  let forceExitTimer: NodeJS.Timeout | null = null;

  const handleSignal = (sig: string) => {
    if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => {
        logger.error('Worker graceful shutdown exceeded hard bound; forcing exit(1)');
        process.exit(1);
      }, 15_000);
      forceExitTimer.unref();
    }

    runtime
      .stop(sig)
      .then((res) => process.exit(res.clean ? 0 : 1))
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

import { JobStatus, PlatformEventType, WorkerHealthStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { eventService } from './event.service.js';

export interface WorkerHeartbeatInput {
  workerInstanceId: string;
  hostname: string;
  pid: number;
  registeredQueues: string[];
  organisationIds: string[];
  lastError?: string | null;
}

export interface WorkerHealthThresholds {
  /** Heartbeat older than this (but <= staleMs) is classified DEGRADED (delayed, not presumed dead). */
  degradedThresholdMs: number;
  /** Heartbeat older than this is classified STALE. */
  staleThresholdMs: number;
}

export const DEFAULT_WORKER_HEALTH_THRESHOLDS: WorkerHealthThresholds = {
  degradedThresholdMs: 15_000,
  staleThresholdMs: 45_000,
};

export interface OrgSafeWorkerView {
  workerInstanceId: string;
  hostname: string;
  pid: number;
  status: WorkerHealthStatus;
  /** Filtered strictly to BullMQ queue names belonging to the caller's organisation. */
  registeredQueues: string[];
  /** Strictly organisation-scoped count of terminal (COMPLETED + FAILED) jobs executed by this worker. */
  jobsProcessed: number;
  /** Strictly organisation-scoped count of COMPLETED jobs executed by this worker. */
  jobsSucceeded: number;
  /** Strictly organisation-scoped count of FAILED jobs executed by this worker. */
  jobsFailed: number;
  /** Strictly organisation-scoped count of currently ACTIVE jobs on this worker. */
  activeJobs: number;
  /** Latest FAILED job error message belonging strictly to the caller's organisation (never global). */
  lastError: string | null;
  lastHeartbeatAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  heartbeatAgeMs: number;
}

/**
 * Computes effective worker health status without prematurely declaring a temporarily
 * delayed heartbeat dead: ONLINE -> DEGRADED -> STALE (and STOPPED when cleanly shut down).
 */
export function classifyWorkerHealth(
  persistedStatus: WorkerHealthStatus,
  lastHeartbeatAt: Date,
  nowMs: number = Date.now(),
  thresholds: WorkerHealthThresholds = DEFAULT_WORKER_HEALTH_THRESHOLDS,
): WorkerHealthStatus {
  if (persistedStatus === WorkerHealthStatus.STOPPED) {
    return WorkerHealthStatus.STOPPED;
  }

  const ageMs = Math.max(0, nowMs - lastHeartbeatAt.getTime());
  if (ageMs > thresholds.staleThresholdMs) {
    return WorkerHealthStatus.STALE;
  }
  if (ageMs > thresholds.degradedThresholdMs) {
    return WorkerHealthStatus.DEGRADED;
  }
  return WorkerHealthStatus.ONLINE;
}

/**
 * Worker health and heartbeat monitoring service.
 * Tracks multiple worker instances, distinguishes delayed (DEGRADED) vs STALE workers,
 * records audit events on start/stop/staleness, and serves organisation-safe views.
 */
export class WorkerHealthService {
  private staleSweepTimer: NodeJS.Timeout | null = null;
  private staleSweepInFlight = false;

  /**
   * Registers a worker startup heartbeat and persists a WORKER_STARTED event.
   */
  async registerWorkerStart(input: WorkerHeartbeatInput): Promise<void> {
    const now = new Date();
    await db.workerHeartbeat.upsert({
      where: { workerInstanceId: input.workerInstanceId },
      create: {
        workerInstanceId: input.workerInstanceId,
        hostname: input.hostname,
        pid: input.pid,
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        lastHeartbeatAt: now,
        startedAt: now,
        stoppedAt: null,
        lastError: null,
      },
      update: {
        hostname: input.hostname,
        pid: input.pid,
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        lastHeartbeatAt: now,
        startedAt: now,
        stoppedAt: null,
        lastError: null,
      },
    });

    logger.info('Worker heartbeat registered (started)', {
      workerInstanceId: input.workerInstanceId,
      pid: input.pid,
      queueCount: input.registeredQueues.length,
    });

    await eventService.record({
      type: PlatformEventType.WORKER_STARTED,
      workerId: input.workerInstanceId,
      message: `Worker ${input.workerInstanceId} started`,
      metadata: {
        hostname: input.hostname,
        pid: input.pid,
        queueCount: input.registeredQueues.length,
      },
    });
  }

  /**
   * Publishes a periodic worker heartbeat.
   */
  async recordHeartbeat(input: WorkerHeartbeatInput): Promise<void> {
    const now = new Date();
    await db.workerHeartbeat.upsert({
      where: { workerInstanceId: input.workerInstanceId },
      create: {
        workerInstanceId: input.workerInstanceId,
        hostname: input.hostname,
        pid: input.pid,
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        lastHeartbeatAt: now,
        startedAt: now,
        lastError: input.lastError ?? null,
      },
      update: {
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        lastHeartbeatAt: now,
        stoppedAt: null,
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      },
    });
  }

  /**
   * Increments internal per-worker processing counters atomically in PostgreSQL.
   * Tenant-specific job error messages are intentionally NOT stored on the global
   * worker_heartbeats row to prevent cross-tenant error leakage; organisation-scoped
   * views derive lastError strictly from that organisation's own failed jobs.
   */
  async recordJobOutcome(
    workerInstanceId: string,
    outcome: 'succeeded' | 'failed',
    _errorMessage?: string,
  ): Promise<void> {
    try {
      await db.workerHeartbeat.updateMany({
        where: { workerInstanceId },
        data: {
          jobsProcessed: { increment: 1 },
          ...(outcome === 'succeeded'
            ? { jobsSucceeded: { increment: 1 } }
            : { jobsFailed: { increment: 1 } }),
          lastHeartbeatAt: new Date(),
        },
      });
    } catch (err) {
      logger.warn('Failed to update worker processing counters', {
        workerInstanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Marks a worker gracefully STOPPED and records a WORKER_STOPPED event.
   */
  async markWorkerStopped(workerInstanceId: string, reason?: string): Promise<void> {
    const now = new Date();
    await db.workerHeartbeat.updateMany({
      where: { workerInstanceId },
      data: {
        status: WorkerHealthStatus.STOPPED,
        stoppedAt: now,
        lastHeartbeatAt: now,
        ...(reason ? { lastError: reason.slice(0, 1000) } : {}),
      },
    });

    logger.info('Worker marked STOPPED', { workerInstanceId, reason });

    await eventService.record({
      type: PlatformEventType.WORKER_STOPPED,
      workerId: workerInstanceId,
      message: `Worker ${workerInstanceId} stopped gracefully`,
      metadata: reason ? { reason } : {},
    });
  }

  /**
   * Evaluates non-stopped workers against health thresholds, transitioning delayed
   * workers to DEGRADED and stale workers to STALE (recording WORKER_HEARTBEAT_STALE once).
   */
  async detectStaleWorkers(
    thresholds: WorkerHealthThresholds = DEFAULT_WORKER_HEALTH_THRESHOLDS,
  ): Promise<{ markedDegraded: number; markedStale: number }> {
    const now = new Date();
    const activeWorkers = await db.workerHeartbeat.findMany({
      where: {
        status: { in: [WorkerHealthStatus.ONLINE, WorkerHealthStatus.DEGRADED] },
      },
    });

    let markedDegraded = 0;
    let markedStale = 0;

    for (const worker of activeWorkers) {
      const nextStatus = classifyWorkerHealth(
        worker.status,
        worker.lastHeartbeatAt,
        now.getTime(),
        thresholds,
      );

      if (nextStatus === worker.status) {
        continue;
      }

      const updated = await db.workerHeartbeat.updateMany({
        where: {
          id: worker.id,
          status: worker.status,
          lastHeartbeatAt: worker.lastHeartbeatAt,
        },
        data: { status: nextStatus },
      });

      if (updated.count !== 1) {
        continue;
      }

      if (nextStatus === WorkerHealthStatus.DEGRADED) {
        markedDegraded += 1;
        logger.warn('Worker heartbeat delayed; marked DEGRADED', {
          workerInstanceId: worker.workerInstanceId,
          lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
        });
      } else if (nextStatus === WorkerHealthStatus.STALE) {
        markedStale += 1;
        logger.error('Worker heartbeat exceeded stale threshold; marked STALE', {
          workerInstanceId: worker.workerInstanceId,
          lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
        });

        await eventService.record({
          type: PlatformEventType.WORKER_HEARTBEAT_STALE,
          workerId: worker.workerInstanceId,
          message: `Worker ${worker.workerInstanceId} heartbeat became stale`,
          metadata: {
            lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
            staleThresholdMs: thresholds.staleThresholdMs,
          },
        });
      }
    }

    return { markedDegraded, markedStale };
  }

  /**
   * Starts a periodic background sweep that persists DEGRADED/STALE worker transitions
   * without requiring GET monitoring endpoints to perform database writes.
   */
  startStaleSweep(
    intervalMs: number = 15_000,
    thresholds: WorkerHealthThresholds = DEFAULT_WORKER_HEALTH_THRESHOLDS,
  ): void {
    if (this.staleSweepTimer) return;
    const safeInterval = Math.max(2000, intervalMs);
    this.staleSweepTimer = setInterval(() => {
      if (this.staleSweepInFlight) return;
      this.staleSweepInFlight = true;
      void this.detectStaleWorkers(thresholds)
        .catch((err) => {
          logger.warn('Background stale worker sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.staleSweepInFlight = false;
        });
    }, safeInterval);
    this.staleSweepTimer.unref();
    logger.info('Worker stale-heartbeat sweep started', { intervalMs: safeInterval });
  }

  stopStaleSweep(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
      logger.info('Worker stale-heartbeat sweep stopped');
    }
  }

  /**
   * Returns strictly organisation-safe worker monitoring views (read-only: performs zero DB writes).
   * - Only includes workers serving the caller's organisation.
   * - Strips foreign organisations' queue identifiers from `registeredQueues`.
   * - Computes `jobsProcessed`, `jobsSucceeded`, `jobsFailed`, `activeJobs`, and `lastError`
   *   exclusively from the caller's own persisted jobs (never leaking global worker counters
   *   or another organisation's error messages).
   */
  async listWorkersForOrganisation(
    orgId: string,
    thresholds: WorkerHealthThresholds = DEFAULT_WORKER_HEALTH_THRESHOLDS,
  ): Promise<OrgSafeWorkerView[]> {
    const nowMs = Date.now();
    const orgPrefix = `org_${orgId}__`;

    const workers = await db.workerHeartbeat.findMany({
      where: {
        organisationIds: { has: orgId },
      },
      orderBy: [{ lastHeartbeatAt: 'desc' }],
    });

    if (workers.length === 0) {
      return [];
    }

    const workerIds = workers.map((w) => w.workerInstanceId);

    const [orgJobCounts, orgLatestErrors] = await Promise.all([
      db.job.groupBy({
        by: ['lastWorkerId', 'status'],
        where: {
          queue: { organisationId: orgId },
          lastWorkerId: { in: workerIds },
          status: { in: [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.ACTIVE] },
        },
        _count: { _all: true },
      }),
      db.job.findMany({
        where: {
          queue: { organisationId: orgId },
          lastWorkerId: { in: workerIds },
          status: JobStatus.FAILED,
          errorMessage: { not: null },
        },
        orderBy: [{ failedAt: 'desc' }, { updatedAt: 'desc' }],
        distinct: ['lastWorkerId'],
        select: {
          lastWorkerId: true,
          errorMessage: true,
        },
      }),
    ]);

    const countsByWorker = new Map<string, { succeeded: number; failed: number; active: number }>();
    for (const row of orgJobCounts) {
      if (!row.lastWorkerId) continue;
      let entry = countsByWorker.get(row.lastWorkerId);
      if (!entry) {
        entry = { succeeded: 0, failed: 0, active: 0 };
        countsByWorker.set(row.lastWorkerId, entry);
      }
      if (row.status === JobStatus.COMPLETED) entry.succeeded = row._count._all;
      if (row.status === JobStatus.FAILED) entry.failed = row._count._all;
      if (row.status === JobStatus.ACTIVE) entry.active = row._count._all;
    }

    const lastErrorByWorker = new Map<string, string>();
    for (const row of orgLatestErrors) {
      if (row.lastWorkerId && row.errorMessage) {
        lastErrorByWorker.set(row.lastWorkerId, row.errorMessage);
      }
    }

    return workers.map((w) => {
      const effectiveStatus = classifyWorkerHealth(w.status, w.lastHeartbeatAt, nowMs, thresholds);
      // Strictly filter queue names so no foreign organisation IDs or queue names leak
      const orgScopedQueues = w.registeredQueues
        .filter((q) => q.startsWith(orgPrefix))
        .map((q) => q.slice(orgPrefix.length));

      const stats = countsByWorker.get(w.workerInstanceId) ?? {
        succeeded: 0,
        failed: 0,
        active: 0,
      };

      return {
        workerInstanceId: w.workerInstanceId,
        hostname: w.hostname,
        pid: w.pid,
        status: effectiveStatus,
        registeredQueues: orgScopedQueues,
        jobsProcessed: stats.succeeded + stats.failed,
        jobsSucceeded: stats.succeeded,
        jobsFailed: stats.failed,
        activeJobs: stats.active,
        lastError: lastErrorByWorker.get(w.workerInstanceId) ?? null,
        lastHeartbeatAt: w.lastHeartbeatAt,
        startedAt: w.startedAt,
        stoppedAt: w.stoppedAt,
        heartbeatAgeMs: Math.max(0, nowMs - w.lastHeartbeatAt.getTime()),
      };
    });
  }
}

export const workerHealthService = new WorkerHealthService();

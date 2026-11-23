import { PlatformEventType, WorkerHealthStatus } from '@prisma/client';
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
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
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
   * Increments real per-worker processing counters atomically in PostgreSQL.
   */
  async recordJobOutcome(
    workerInstanceId: string,
    outcome: 'succeeded' | 'failed',
    errorMessage?: string,
  ): Promise<void> {
    try {
      await db.workerHeartbeat.updateMany({
        where: { workerInstanceId },
        data: {
          jobsProcessed: { increment: 1 },
          ...(outcome === 'succeeded'
            ? { jobsSucceeded: { increment: 1 } }
            : {
                jobsFailed: { increment: 1 },
                lastError: errorMessage ? errorMessage.slice(0, 1000) : null,
              }),
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
   * Returns organisation-safe worker monitoring views.
   * Only includes workers serving the caller's organisation and strips foreign
   * organisations' queue identifiers from `registeredQueues`.
   */
  async listWorkersForOrganisation(
    orgId: string,
    thresholds: WorkerHealthThresholds = DEFAULT_WORKER_HEALTH_THRESHOLDS,
  ): Promise<OrgSafeWorkerView[]> {
    // Re-evaluate freshness before returning
    await this.detectStaleWorkers(thresholds);

    const nowMs = Date.now();
    const orgPrefix = `org_${orgId}__`;

    const workers = await db.workerHeartbeat.findMany({
      where: {
        organisationIds: { has: orgId },
      },
      orderBy: [{ lastHeartbeatAt: 'desc' }],
    });

    return workers.map((w) => {
      const effectiveStatus = classifyWorkerHealth(w.status, w.lastHeartbeatAt, nowMs, thresholds);
      // Strictly filter queue names so no foreign organisation IDs or queue names leak
      const orgScopedQueues = w.registeredQueues
        .filter((q) => q.startsWith(orgPrefix))
        .map((q) => q.slice(orgPrefix.length));

      return {
        workerInstanceId: w.workerInstanceId,
        hostname: w.hostname,
        pid: w.pid,
        status: effectiveStatus,
        registeredQueues: orgScopedQueues,
        jobsProcessed: w.jobsProcessed,
        jobsSucceeded: w.jobsSucceeded,
        jobsFailed: w.jobsFailed,
        lastError: w.lastError,
        lastHeartbeatAt: w.lastHeartbeatAt,
        startedAt: w.startedAt,
        stoppedAt: w.stoppedAt,
        heartbeatAgeMs: Math.max(0, nowMs - w.lastHeartbeatAt.getTime()),
      };
    });
  }
}

export const workerHealthService = new WorkerHealthService();

import { PlatformEventType, Prisma, WorkerHealthStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { eventService } from './event.service.js';
import { realtimeEventBus } from './realtime.service.js';

export interface WorkerHeartbeatInput {
  workerInstanceId: string;
  hostname: string;
  pid: number;
  registeredQueues: string[];
  organisationIds: string[];
  configuredConcurrency?: number | null;
  cpuUsagePercent?: number | null;
  memoryRssBytes?: bigint | number | null;
  uptimeSeconds?: number | null;
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
  /** Sum of configured concurrency across this organisation's queues registered on this worker. */
  orgConfiguredConcurrency: number;
  /** Process-level worker CPU usage percentage over the last heartbeat interval, or null if unavailable. */
  cpuUsagePercent: number | null;
  /** Process-level worker resident set size (RSS) in MB, or null if unavailable. */
  memoryRssMb: number | null;
  /** Worker process uptime in seconds, or null if unavailable. */
  uptimeSeconds: number | null;
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
  /** Strictly organisation-scoped timestamp of the last job activity on this worker, or null if none. */
  lastActivityAt: Date | null;
  lastHeartbeatAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  heartbeatAgeMs: number;
}

interface WorkerOrgStatsRow {
  workerId: string;
  succeeded: number | bigint | string;
  failed: number | bigint | string;
  active: number | bigint | string;
  lastActivityAt: Date | null;
  lastError: string | null;
}

function toSafeBigInt(value?: bigint | number | null): bigint | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (!Number.isFinite(value) || value < 0) return null;
  return BigInt(Math.trunc(value));
}

function toSafeCpu(value?: number | null): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

function toSafeInt(value?: number | null): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
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
    const configuredConcurrency = toSafeInt(input.configuredConcurrency) ?? null;
    const cpuUsagePercent = toSafeCpu(input.cpuUsagePercent) ?? null;
    const memoryRssBytes = toSafeBigInt(input.memoryRssBytes) ?? null;
    const uptimeSeconds = toSafeInt(input.uptimeSeconds) ?? null;

    await db.workerHeartbeat.upsert({
      where: { workerInstanceId: input.workerInstanceId },
      create: {
        workerInstanceId: input.workerInstanceId,
        hostname: input.hostname,
        pid: input.pid,
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        configuredConcurrency,
        cpuUsagePercent,
        memoryRssBytes,
        uptimeSeconds,
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
        configuredConcurrency,
        cpuUsagePercent,
        memoryRssBytes,
        uptimeSeconds,
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

    const startedEvent = await eventService.record({
      type: PlatformEventType.WORKER_STARTED,
      workerId: input.workerInstanceId,
      message: `Worker ${input.workerInstanceId} started`,
      metadata: {
        hostname: input.hostname,
        pid: input.pid,
        queueCount: input.registeredQueues.length,
      },
    });

    if (startedEvent) {
      const uniqueOrgIds = Array.from(new Set(input.organisationIds));
      await Promise.all(
        uniqueOrgIds.map((orgId) =>
          realtimeEventBus.publish({
            id: startedEvent.id,
            type: PlatformEventType.WORKER_STARTED,
            organisationId: orgId,
            queueId: null,
            jobId: null,
            workerId: input.workerInstanceId,
            message: startedEvent.message,
            metadata: { status: WorkerHealthStatus.ONLINE },
            createdAt: startedEvent.createdAt.toISOString(),
          }),
        ),
      );
    }
  }

  /**
   * Publishes a periodic worker heartbeat.
   */
  async recordHeartbeat(input: WorkerHeartbeatInput): Promise<void> {
    const now = new Date();
    const configuredConcurrency = toSafeInt(input.configuredConcurrency);
    const cpuUsagePercent = toSafeCpu(input.cpuUsagePercent);
    const memoryRssBytes = toSafeBigInt(input.memoryRssBytes);
    const uptimeSeconds = toSafeInt(input.uptimeSeconds);

    await db.workerHeartbeat.upsert({
      where: { workerInstanceId: input.workerInstanceId },
      create: {
        workerInstanceId: input.workerInstanceId,
        hostname: input.hostname,
        pid: input.pid,
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        configuredConcurrency: configuredConcurrency ?? null,
        cpuUsagePercent: cpuUsagePercent ?? null,
        memoryRssBytes: memoryRssBytes ?? null,
        uptimeSeconds: uptimeSeconds ?? null,
        lastHeartbeatAt: now,
        startedAt: now,
        lastError: input.lastError ?? null,
      },
      update: {
        registeredQueues: input.registeredQueues,
        organisationIds: Array.from(new Set(input.organisationIds)),
        status: WorkerHealthStatus.ONLINE,
        ...(configuredConcurrency !== undefined ? { configuredConcurrency } : {}),
        ...(cpuUsagePercent !== undefined ? { cpuUsagePercent } : {}),
        ...(memoryRssBytes !== undefined ? { memoryRssBytes } : {}),
        ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
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
    const existing = await db.workerHeartbeat.findUnique({
      where: { workerInstanceId },
      select: { organisationIds: true },
    });

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

    const stoppedEvent = await eventService.record({
      type: PlatformEventType.WORKER_STOPPED,
      workerId: workerInstanceId,
      message: `Worker ${workerInstanceId} stopped gracefully`,
      metadata: reason ? { reason } : {},
    });

    if (stoppedEvent && existing?.organisationIds.length) {
      await Promise.all(
        Array.from(new Set(existing.organisationIds)).map((orgId) =>
          realtimeEventBus.publish({
            id: stoppedEvent.id,
            type: PlatformEventType.WORKER_STOPPED,
            organisationId: orgId,
            queueId: null,
            jobId: null,
            workerId: workerInstanceId,
            message: stoppedEvent.message,
            metadata: { status: WorkerHealthStatus.STOPPED },
            createdAt: stoppedEvent.createdAt.toISOString(),
          }),
        ),
      );
    }
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

        const staleEvent = await eventService.record({
          type: PlatformEventType.WORKER_HEARTBEAT_STALE,
          workerId: worker.workerInstanceId,
          message: `Worker ${worker.workerInstanceId} heartbeat became stale`,
          metadata: {
            lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
            staleThresholdMs: thresholds.staleThresholdMs,
          },
        });

        if (staleEvent && worker.organisationIds.length > 0) {
          await Promise.all(
            Array.from(new Set(worker.organisationIds)).map((orgId) =>
              realtimeEventBus.publish({
                id: staleEvent.id,
                type: PlatformEventType.WORKER_HEARTBEAT_STALE,
                organisationId: orgId,
                queueId: null,
                jobId: null,
                workerId: worker.workerInstanceId,
                message: staleEvent.message,
                metadata: {
                  status: WorkerHealthStatus.STALE,
                  lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
                },
                createdAt: staleEvent.createdAt.toISOString(),
              }),
            ),
          );
        }
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
    orgQueuesHint?: Array<{ name: string; concurrency: number }>,
  ): Promise<OrgSafeWorkerView[]> {
    const nowMs = Date.now();
    const orgPrefix = `org_${orgId}__`;

    const [workers, orgQueues] = await Promise.all([
      db.workerHeartbeat.findMany({
        where: {
          organisationIds: { has: orgId },
        },
        orderBy: [{ lastHeartbeatAt: 'desc' }],
      }),
      orgQueuesHint
        ? Promise.resolve(orgQueuesHint)
        : db.queue.findMany({
            where: { organisationId: orgId },
            select: { name: true, concurrency: true },
          }),
    ]);

    if (workers.length === 0) {
      return [];
    }

    const queueConcurrencyByName = new Map<string, number>();
    for (const q of orgQueues) {
      queueConcurrencyByName.set(q.name, q.concurrency);
    }

    const workerIds = workers.map((w) => w.workerInstanceId);

    // Single combined SQL query for org-scoped counts, lastActivityAt, and latest org-scoped error
    const statsRows = await db.$queryRaw<WorkerOrgStatsRow[]>`
      SELECT
        j.last_worker_id AS "workerId",
        COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::int AS succeeded,
        COUNT(*) FILTER (WHERE j.status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE j.status = 'ACTIVE')::int AS active,
        MAX(COALESCE(j.completed_at, j.failed_at, j.started_at)) AS "lastActivityAt",
        (
          ARRAY_AGG(j.error_message ORDER BY j.failed_at DESC NULLS LAST, j.updated_at DESC)
          FILTER (WHERE j.status = 'FAILED' AND j.error_message IS NOT NULL)
        )[1] AS "lastError"
      FROM jobs j
      INNER JOIN queues q ON q.id = j.queue_id
      WHERE q.organisation_id = ${orgId}::uuid
        AND j.last_worker_id IN (${Prisma.join(workerIds)})
        AND j.status IN ('COMPLETED', 'FAILED', 'ACTIVE')
      GROUP BY j.last_worker_id
    `;

    const statsByWorker = new Map<
      string,
      {
        succeeded: number;
        failed: number;
        active: number;
        lastActivityAt: Date | null;
        lastError: string | null;
      }
    >();
    for (const row of statsRows) {
      statsByWorker.set(row.workerId, {
        succeeded: Number(row.succeeded) || 0,
        failed: Number(row.failed) || 0,
        active: Number(row.active) || 0,
        lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null,
        lastError: row.lastError ?? null,
      });
    }

    return workers.map((w) => {
      const effectiveStatus = classifyWorkerHealth(w.status, w.lastHeartbeatAt, nowMs, thresholds);
      // Strictly filter queue names so no foreign organisation IDs or queue names leak
      const orgScopedQueues = w.registeredQueues
        .filter((q) => q.startsWith(orgPrefix))
        .map((q) => q.slice(orgPrefix.length));

      const orgConfiguredConcurrency = orgScopedQueues.reduce(
        (acc, qName) => acc + (queueConcurrencyByName.get(qName) ?? 0),
        0,
      );

      const stats = statsByWorker.get(w.workerInstanceId) ?? {
        succeeded: 0,
        failed: 0,
        active: 0,
        lastActivityAt: null,
        lastError: null,
      };

      const memoryRssMb =
        w.memoryRssBytes !== null && w.memoryRssBytes !== undefined
          ? Math.round((Number(w.memoryRssBytes) / (1024 * 1024)) * 100) / 100
          : null;

      return {
        workerInstanceId: w.workerInstanceId,
        hostname: w.hostname,
        pid: w.pid,
        status: effectiveStatus,
        registeredQueues: orgScopedQueues,
        orgConfiguredConcurrency,
        cpuUsagePercent: w.cpuUsagePercent ?? null,
        memoryRssMb,
        uptimeSeconds: w.uptimeSeconds ?? null,
        jobsProcessed: stats.succeeded + stats.failed,
        jobsSucceeded: stats.succeeded,
        jobsFailed: stats.failed,
        activeJobs: stats.active,
        lastError: stats.lastError,
        lastActivityAt: stats.lastActivityAt,
        lastHeartbeatAt: w.lastHeartbeatAt,
        startedAt: w.startedAt,
        stoppedAt: w.stoppedAt,
        heartbeatAgeMs: Math.max(0, nowMs - w.lastHeartbeatAt.getTime()),
      };
    });
  }
}

export const workerHealthService = new WorkerHealthService();

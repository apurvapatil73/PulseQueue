import {
  DeadLetterStatus,
  JobStatus,
  OutboxStatus,
  PlatformEventType,
  Prisma,
  ScheduleExecutionStatus,
  WorkerHealthStatus,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { workerHealthService, type OrgSafeWorkerView } from './workerHealth.service.js';

/**
 * Minimum number of timing samples required before p50/p95/p99 percentiles are reported.
 * Below this threshold percentiles return `null` to avoid statistically misleading estimates.
 */
export const MIN_PERCENTILE_SAMPLES = 5;

export interface LatencyDistribution {
  sampleCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface QueueMetricsItem {
  queueId: string;
  name: string;
  isPaused: boolean;
  concurrency: number;
  totalJobs: number;
  /** Non-active queued backlog (PENDING + DELAYED + PAUSED). */
  queueDepth: number;
  byStatus: Record<JobStatus, number>;
  /** All-time success rate: COMPLETED / (COMPLETED + FAILED), or null if 0 processed. */
  successRate: number | null;
  /** All-time failure rate: FAILED / (COMPLETED + FAILED), or null if 0 processed. */
  failureRate: number | null;
  /** All-time average last-attempt execution duration in ms. */
  averageDurationMs: number | null;
  /** Windowed p95 execution duration in ms, or null if fewer than MIN_PERCENTILE_SAMPLES. */
  p95DurationMs: number | null;
  /** Count of jobs in this queue with attemptsMade > 1. */
  retriedJobs: number;
  /** Cumulative stalled-job recoveries across jobs in this queue. */
  stalledRecoveries: number;
  /** Jobs completed or failed within the requested window. */
  processedInWindow: number;
  /** Windowed processing throughput (processedInWindow / windowMinutes). */
  jobsPerMinute: number;
  /** Age in ms of the oldest PENDING job in this queue, or null if no pending jobs. */
  oldestPendingAgeMs: number | null;
  openDeadLetters: number;
}

export interface OrganisationMetricsView {
  organisationId: string;
  summary: {
    totalSubmitted: number;
    totalProcessed: number;
    succeeded: number;
    failed: number;
    active: number;
    pending: number;
    delayed: number;
    paused: number;
    /** Total non-active queued backlog (pending + delayed + paused). */
    queueDepth: number;
    /** All-time success rate: succeeded / totalProcessed, or null if totalProcessed === 0. */
    successRate: number | null;
    /** All-time failure rate: failed / totalProcessed, or null if totalProcessed === 0. */
    failureRate: number | null;
    /** Windowed success rate: completedInWindow / processedInWindow, or null if 0 processed. */
    windowSuccessRate: number | null;
    /** Windowed failure rate: failedInWindow / processedInWindow, or null if 0 processed. */
    windowFailureRate: number | null;
    retriedJobs: number;
    totalRetryEvents: number;
    stalledRecoveries: number;
    deadLetterOpen: number;
    deadLetterReplayed: number;
    /** All-time average last-attempt processor execution duration in ms. */
    averageDurationMs: number | null;
    /** Windowed average last-attempt processor execution duration in ms. */
    windowAverageDurationMs: number | null;
  };
  throughput: {
    windowMinutes: number;
    completedInWindow: number;
    failedInWindow: number;
    processedInWindow: number;
    jobsPerMinute: number;
  };
  /**
   * Windowed latency distributions computed in PostgreSQL.
   * Percentiles (p50/p95/p99) are `null` when sampleCount < minPercentileSamples.
   */
  latency: {
    windowMinutes: number;
    minPercentileSamples: number;
    /** Last-attempt processor execution duration (`jobs.duration_ms`). */
    executionDuration: LatencyDistribution;
    /** Initial queue wait before first attempt (`first_started_at - created_at - delay_ms`). */
    queueWait: LatencyDistribution;
    /** Retry overhead between initial start and final attempt start (`started_at - first_started_at` for retried jobs). */
    retryOverhead: LatencyDistribution;
    /** Full lifecycle completion time (`completed_at - created_at` for COMPLETED jobs). */
    endToEnd: LatencyDistribution;
  };
  /**
   * Windowed and current reliability indicators scoped to this organisation.
   */
  reliability: {
    windowMinutes: number;
    retriesInWindow: number;
    stalledEventsInWindow: number;
    recoveredEventsInWindow: number;
    dlqCreatedInWindow: number;
    dlqReplayedInWindow: number;
    dlqNetGrowthInWindow: number;
    scheduleMisfiresInWindow: number;
    scheduleSkipsInWindow: number;
    scheduleMisfiresTotal: number;
    outboxPending: number;
  };
  /** Aggregated counts of workers serving this organisation. */
  workerSummary: {
    total: number;
    online: number;
    degraded: number;
    stale: number;
    stopped: number;
    activeJobs: number;
  };
  queues: QueueMetricsItem[];
  workers: OrgSafeWorkerView[];
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
}

export interface TimeseriesBucketItem {
  bucketStart: string;
  bucketEnd: string;
  submitted: number;
  completed: number;
  failed: number;
  processed: number;
  successRate: number | null;
  failureRate: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  retries: number;
  stalled: number;
  dlqAdded: number;
  scheduleMisfires: number;
}

export interface OrganisationTimeseriesView {
  organisationId: string;
  queueId: string | null;
  windowMinutes: number;
  bucketMinutes: number;
  minPercentileSamples: number;
  windowStart: string;
  windowEnd: string;
  buckets: TimeseriesBucketItem[];
  generatedAt: string;
}

interface LatencySqlRow {
  exec_count: number | bigint | string;
  exec_avg: number | string | null;
  exec_p50: number | string | null;
  exec_p95: number | string | null;
  exec_p99: number | string | null;
  wait_count: number | bigint | string;
  wait_avg: number | string | null;
  wait_p50: number | string | null;
  wait_p95: number | string | null;
  wait_p99: number | string | null;
  retry_count: number | bigint | string;
  retry_avg: number | string | null;
  retry_p50: number | string | null;
  retry_p95: number | string | null;
  retry_p99: number | string | null;
  e2e_count: number | bigint | string;
  e2e_avg: number | string | null;
  e2e_p50: number | string | null;
  e2e_p95: number | string | null;
  e2e_p99: number | string | null;
}

interface QueueWindowSqlRow {
  queueId: string;
  completedInWindow: number | bigint | string;
  failedInWindow: number | bigint | string;
  retriedJobs: number | bigint | string;
  stalledRecoveries: number | bigint | string;
  durationSampleCount: number | bigint | string;
  p95DurationMs: number | string | null;
  oldestPendingAt: Date | null;
}

interface TimeseriesSqlRow {
  bucket_start: Date;
  submitted: number | bigint | string;
  completed: number | bigint | string;
  failed: number | bigint | string;
  duration_samples: number | bigint | string;
  avg_duration_ms: number | string | null;
  p95_duration_ms: number | string | null;
  retries: number | bigint | string;
  stalled: number | bigint | string;
  dlq_added: number | bigint | string;
  schedule_misfires: number | bigint | string;
}

function toInt(val: number | bigint | string | null | undefined): number {
  if (val === null || val === undefined) return 0;
  const num = Number(val);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

function roundMs(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function roundRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function buildDistribution(
  countRaw: number | bigint | string | undefined,
  avgRaw: number | string | null | undefined,
  p50Raw: number | string | null | undefined,
  p95Raw: number | string | null | undefined,
  p99Raw: number | string | null | undefined,
): LatencyDistribution {
  const sampleCount = toInt(countRaw);
  if (sampleCount === 0) {
    return { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  }
  const hasPercentiles = sampleCount >= MIN_PERCENTILE_SAMPLES;
  return {
    sampleCount,
    avgMs: roundMs(avgRaw),
    p50Ms: hasPercentiles ? roundMs(p50Raw) : null,
    p95Ms: hasPercentiles ? roundMs(p95Raw) : null,
    p99Ms: hasPercentiles ? roundMs(p99Raw) : null,
  };
}

export function resolveBucketMinutes(windowMinutes: number, requested?: number): number {
  if (requested !== undefined) return requested;
  if (windowMinutes <= 60) return 1;
  if (windowMinutes <= 360) return 5;
  if (windowMinutes <= 1440) return 15;
  return 60;
}

/**
 * Genuine persisted execution metrics service.
 * Aggregates exclusively from live PostgreSQL records — strictly scoped by organisationId,
 * read-only (zero DB writes on GET), and never returns synthetic or hardcoded values.
 */
export class MetricsService {
  async getOrganisationMetrics(
    orgId: string,
    windowMinutes: number = 60,
  ): Promise<OrganisationMetricsView> {
    const now = new Date();
    const nowMs = now.getTime();
    const windowStart = new Date(nowMs - windowMinutes * 60_000);

    const [
      queues,
      jobsByQueueAndStatus,
      durationAgg,
      durationByQueue,
      retriedJobsCount,
      retryEventsCount,
      stalledSumAgg,
      dlqByStatus,
      dlqOpenByQueue,
      completedInWindow,
      failedInWindow,
      workers,
      latencyRows,
      queueWindowRows,
      windowEventsByType,
      dlqCreatedInWindow,
      dlqReplayedInWindow,
      scheduleWindowGroups,
      scheduleMisfiresTotal,
      outboxPending,
    ] = await Promise.all([
      db.queue.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true, isPaused: true, concurrency: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.job.groupBy({
        by: ['queueId', 'status'],
        where: { queue: { organisationId: orgId } },
        _count: { _all: true },
      }),
      db.job.aggregate({
        where: {
          queue: { organisationId: orgId },
          durationMs: { not: null },
        },
        _avg: { durationMs: true },
      }),
      db.job.groupBy({
        by: ['queueId'],
        where: {
          queue: { organisationId: orgId },
          durationMs: { not: null },
        },
        _avg: { durationMs: true },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          attemptsMade: { gt: 1 },
        },
      }),
      db.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_RETRIED,
        },
      }),
      db.job.aggregate({
        where: { queue: { organisationId: orgId } },
        _sum: { stalledCount: true },
      }),
      db.deadLetterJob.groupBy({
        by: ['status'],
        where: { organisationId: orgId },
        _count: { _all: true },
      }),
      db.deadLetterJob.groupBy({
        by: ['queueId'],
        where: {
          organisationId: orgId,
          status: DeadLetterStatus.OPEN,
        },
        _count: { _all: true },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          status: JobStatus.COMPLETED,
          completedAt: { gte: windowStart },
        },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          status: JobStatus.FAILED,
          failedAt: { gte: windowStart },
        },
      }),
      workerHealthService.listWorkersForOrganisation(orgId),
      db.$queryRaw<LatencySqlRow[]>`
        WITH org_window_jobs AS (
          SELECT
            j.id,
            j.status,
            j.attempts_made,
            j.duration_ms,
            j.delay_ms,
            j.created_at,
            j.started_at,
            j.completed_at,
            COALESCE(
              j.first_started_at,
              (
                SELECT MIN(pe.created_at)
                FROM platform_events pe
                WHERE pe.job_id = j.id
                  AND pe.type = 'JOB_STARTED'
              ),
              j.started_at
            ) AS effective_first_started_at
          FROM jobs j
          INNER JOIN queues q ON q.id = j.queue_id
          WHERE q.organisation_id = ${orgId}::uuid
            AND (
              (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
              OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart})
            )
        ),
        computed AS (
          SELECT
            duration_ms,
            CASE
              WHEN effective_first_started_at IS NOT NULL THEN
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (effective_first_started_at - created_at)) * 1000.0 - delay_ms
                )
              ELSE NULL
            END AS queue_wait_ms,
            CASE
              WHEN attempts_made > 1
                AND effective_first_started_at IS NOT NULL
                AND started_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (started_at - effective_first_started_at)) * 1000.0)
              ELSE NULL
            END AS retry_overhead_ms,
            CASE
              WHEN status = 'COMPLETED' AND completed_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000.0)
              ELSE NULL
            END AS e2e_ms
          FROM org_window_jobs
        )
        SELECT
          COUNT(duration_ms)::int AS exec_count,
          AVG(duration_ms) AS exec_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS exec_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS exec_p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS exec_p99,

          COUNT(queue_wait_ms)::int AS wait_count,
          AVG(queue_wait_ms) AS wait_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY queue_wait_ms) FILTER (WHERE queue_wait_ms IS NOT NULL) AS wait_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY queue_wait_ms) FILTER (WHERE queue_wait_ms IS NOT NULL) AS wait_p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY queue_wait_ms) FILTER (WHERE queue_wait_ms IS NOT NULL) AS wait_p99,

          COUNT(retry_overhead_ms)::int AS retry_count,
          AVG(retry_overhead_ms) AS retry_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY retry_overhead_ms) FILTER (WHERE retry_overhead_ms IS NOT NULL) AS retry_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY retry_overhead_ms) FILTER (WHERE retry_overhead_ms IS NOT NULL) AS retry_p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY retry_overhead_ms) FILTER (WHERE retry_overhead_ms IS NOT NULL) AS retry_p99,

          COUNT(e2e_ms)::int AS e2e_count,
          AVG(e2e_ms) AS e2e_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e2e_ms) FILTER (WHERE e2e_ms IS NOT NULL) AS e2e_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e2e_ms) FILTER (WHERE e2e_ms IS NOT NULL) AS e2e_p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY e2e_ms) FILTER (WHERE e2e_ms IS NOT NULL) AS e2e_p99
        FROM computed
      `,
      db.$queryRaw<QueueWindowSqlRow[]>`
        SELECT
          j.queue_id AS "queueId",
          COUNT(*) FILTER (WHERE j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})::int AS "completedInWindow",
          COUNT(*) FILTER (WHERE j.status = 'FAILED' AND j.failed_at >= ${windowStart})::int AS "failedInWindow",
          COUNT(*) FILTER (WHERE j.attempts_made > 1)::int AS "retriedJobs",
          COALESCE(SUM(j.stalled_count), 0)::int AS "stalledRecoveries",
          COUNT(j.duration_ms) FILTER (
            WHERE (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
               OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart})
          )::int AS "durationSampleCount",
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY j.duration_ms) FILTER (
            WHERE j.duration_ms IS NOT NULL
              AND (
                (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
                OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart})
              )
          ) AS "p95DurationMs",
          MIN(j.created_at) FILTER (WHERE j.status = 'PENDING') AS "oldestPendingAt"
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
        GROUP BY j.queue_id
      `,
      db.platformEvent.groupBy({
        by: ['type'],
        where: {
          organisationId: orgId,
          createdAt: { gte: windowStart },
          type: {
            in: [
              PlatformEventType.JOB_RETRIED,
              PlatformEventType.JOB_STALLED,
              PlatformEventType.JOB_RECOVERED,
            ],
          },
        },
        _count: { _all: true },
      }),
      db.deadLetterJob.count({
        where: {
          organisationId: orgId,
          createdAt: { gte: windowStart },
        },
      }),
      db.deadLetterJob.count({
        where: {
          organisationId: orgId,
          replayedAt: { gte: windowStart },
        },
      }),
      db.scheduleExecution.groupBy({
        by: ['status'],
        where: {
          schedule: { organisationId: orgId },
          createdAt: { gte: windowStart },
          status: {
            in: [
              ScheduleExecutionStatus.MISSED,
              ScheduleExecutionStatus.SKIPPED_OVERLAP,
              ScheduleExecutionStatus.SKIPPED_CONCURRENCY,
              ScheduleExecutionStatus.SKIPPED_MIN_INTERVAL,
              ScheduleExecutionStatus.SKIPPED_MAX_RUNS,
            ],
          },
        },
        _count: { _all: true },
      }),
      db.scheduleExecution.count({
        where: {
          schedule: { organisationId: orgId },
          status: ScheduleExecutionStatus.MISSED,
        },
      }),
      db.jobDispatchOutbox.count({
        where: {
          organisationId: orgId,
          status: OutboxStatus.PENDING,
        },
      }),
    ]);

    const statusTotals: Record<JobStatus, number> = {
      [JobStatus.PENDING]: 0,
      [JobStatus.ACTIVE]: 0,
      [JobStatus.COMPLETED]: 0,
      [JobStatus.FAILED]: 0,
      [JobStatus.DELAYED]: 0,
      [JobStatus.PAUSED]: 0,
    };

    const queueStatusMap = new Map<string, Record<JobStatus, number>>();
    for (const row of jobsByQueueAndStatus) {
      statusTotals[row.status] += row._count._all;

      let qMap = queueStatusMap.get(row.queueId);
      if (!qMap) {
        qMap = {
          [JobStatus.PENDING]: 0,
          [JobStatus.ACTIVE]: 0,
          [JobStatus.COMPLETED]: 0,
          [JobStatus.FAILED]: 0,
          [JobStatus.DELAYED]: 0,
          [JobStatus.PAUSED]: 0,
        };
        queueStatusMap.set(row.queueId, qMap);
      }
      qMap[row.status] = row._count._all;
    }

    const durationMap = new Map<string, number | null>();
    for (const row of durationByQueue) {
      durationMap.set(row.queueId, roundMs(row._avg.durationMs));
    }

    const dlqQueueMap = new Map<string, number>();
    for (const row of dlqOpenByQueue) {
      dlqQueueMap.set(row.queueId, row._count._all);
    }

    const queueWindowMap = new Map<string, QueueWindowSqlRow>();
    for (const row of queueWindowRows) {
      queueWindowMap.set(row.queueId, row);
    }

    let deadLetterOpen = 0;
    let deadLetterReplayed = 0;
    for (const row of dlqByStatus) {
      if (row.status === DeadLetterStatus.OPEN) deadLetterOpen = row._count._all;
      if (row.status === DeadLetterStatus.REPLAYED) deadLetterReplayed = row._count._all;
    }

    const eventWindowMap = new Map<PlatformEventType, number>();
    for (const row of windowEventsByType) {
      eventWindowMap.set(row.type, row._count._all);
    }

    let scheduleMisfiresInWindow = 0;
    let scheduleSkipsInWindow = 0;
    for (const row of scheduleWindowGroups) {
      if (row.status === ScheduleExecutionStatus.MISSED) {
        scheduleMisfiresInWindow = row._count._all;
      } else {
        scheduleSkipsInWindow += row._count._all;
      }
    }

    const totalSubmitted = Object.values(statusTotals).reduce((acc, v) => acc + v, 0);
    const totalProcessed = statusTotals[JobStatus.COMPLETED] + statusTotals[JobStatus.FAILED];
    const queueDepth =
      statusTotals[JobStatus.PENDING] +
      statusTotals[JobStatus.DELAYED] +
      statusTotals[JobStatus.PAUSED];
    const processedInWindow = completedInWindow + failedInWindow;
    const jobsPerMinute =
      windowMinutes > 0 ? Math.round((processedInWindow / windowMinutes) * 1000) / 1000 : 0;

    const latencyRow = latencyRows[0];
    const executionDuration = buildDistribution(
      latencyRow?.exec_count,
      latencyRow?.exec_avg,
      latencyRow?.exec_p50,
      latencyRow?.exec_p95,
      latencyRow?.exec_p99,
    );
    const queueWait = buildDistribution(
      latencyRow?.wait_count,
      latencyRow?.wait_avg,
      latencyRow?.wait_p50,
      latencyRow?.wait_p95,
      latencyRow?.wait_p99,
    );
    const retryOverhead = buildDistribution(
      latencyRow?.retry_count,
      latencyRow?.retry_avg,
      latencyRow?.retry_p50,
      latencyRow?.retry_p95,
      latencyRow?.retry_p99,
    );
    const endToEnd = buildDistribution(
      latencyRow?.e2e_count,
      latencyRow?.e2e_avg,
      latencyRow?.e2e_p50,
      latencyRow?.e2e_p95,
      latencyRow?.e2e_p99,
    );

    const workerSummary = {
      total: workers.length,
      online: 0,
      degraded: 0,
      stale: 0,
      stopped: 0,
      activeJobs: 0,
    };
    for (const w of workers) {
      if (w.status === WorkerHealthStatus.ONLINE) workerSummary.online += 1;
      else if (w.status === WorkerHealthStatus.DEGRADED) workerSummary.degraded += 1;
      else if (w.status === WorkerHealthStatus.STALE) workerSummary.stale += 1;
      else if (w.status === WorkerHealthStatus.STOPPED) workerSummary.stopped += 1;
      workerSummary.activeJobs += w.activeJobs;
    }

    const queueMetrics: QueueMetricsItem[] = queues.map((q) => {
      const byStatus = queueStatusMap.get(q.id) ?? {
        [JobStatus.PENDING]: 0,
        [JobStatus.ACTIVE]: 0,
        [JobStatus.COMPLETED]: 0,
        [JobStatus.FAILED]: 0,
        [JobStatus.DELAYED]: 0,
        [JobStatus.PAUSED]: 0,
      };
      const totalJobs = Object.values(byStatus).reduce((acc, v) => acc + v, 0);
      const qProcessed = byStatus[JobStatus.COMPLETED] + byStatus[JobStatus.FAILED];
      const qDepth =
        byStatus[JobStatus.PENDING] + byStatus[JobStatus.DELAYED] + byStatus[JobStatus.PAUSED];
      const qWin = queueWindowMap.get(q.id);
      const qProcessedWin = qWin ? toInt(qWin.completedInWindow) + toInt(qWin.failedInWindow) : 0;
      const qSamples = qWin ? toInt(qWin.durationSampleCount) : 0;
      const oldestPendingAgeMs =
        qWin?.oldestPendingAt != null
          ? Math.max(0, nowMs - new Date(qWin.oldestPendingAt).getTime())
          : null;

      return {
        queueId: q.id,
        name: q.name,
        isPaused: q.isPaused,
        concurrency: q.concurrency,
        totalJobs,
        queueDepth: qDepth,
        byStatus,
        successRate: roundRate(byStatus[JobStatus.COMPLETED], qProcessed),
        failureRate: roundRate(byStatus[JobStatus.FAILED], qProcessed),
        averageDurationMs: durationMap.get(q.id) ?? null,
        p95DurationMs: qSamples >= MIN_PERCENTILE_SAMPLES ? roundMs(qWin?.p95DurationMs) : null,
        retriedJobs: qWin ? toInt(qWin.retriedJobs) : 0,
        stalledRecoveries: qWin ? toInt(qWin.stalledRecoveries) : 0,
        processedInWindow: qProcessedWin,
        jobsPerMinute:
          windowMinutes > 0 ? Math.round((qProcessedWin / windowMinutes) * 1000) / 1000 : 0,
        oldestPendingAgeMs,
        openDeadLetters: dlqQueueMap.get(q.id) ?? 0,
      };
    });

    const generatedAt = now.toISOString();

    return {
      organisationId: orgId,
      summary: {
        totalSubmitted,
        totalProcessed,
        succeeded: statusTotals[JobStatus.COMPLETED],
        failed: statusTotals[JobStatus.FAILED],
        active: statusTotals[JobStatus.ACTIVE],
        pending: statusTotals[JobStatus.PENDING],
        delayed: statusTotals[JobStatus.DELAYED],
        paused: statusTotals[JobStatus.PAUSED],
        queueDepth,
        successRate: roundRate(statusTotals[JobStatus.COMPLETED], totalProcessed),
        failureRate: roundRate(statusTotals[JobStatus.FAILED], totalProcessed),
        windowSuccessRate: roundRate(completedInWindow, processedInWindow),
        windowFailureRate: roundRate(failedInWindow, processedInWindow),
        retriedJobs: retriedJobsCount,
        totalRetryEvents: retryEventsCount,
        stalledRecoveries: stalledSumAgg._sum.stalledCount ?? 0,
        deadLetterOpen,
        deadLetterReplayed,
        averageDurationMs: roundMs(durationAgg._avg.durationMs),
        windowAverageDurationMs: executionDuration.avgMs,
      },
      throughput: {
        windowMinutes,
        completedInWindow,
        failedInWindow,
        processedInWindow,
        jobsPerMinute,
      },
      latency: {
        windowMinutes,
        minPercentileSamples: MIN_PERCENTILE_SAMPLES,
        executionDuration,
        queueWait,
        retryOverhead,
        endToEnd,
      },
      reliability: {
        windowMinutes,
        retriesInWindow: eventWindowMap.get(PlatformEventType.JOB_RETRIED) ?? 0,
        stalledEventsInWindow: eventWindowMap.get(PlatformEventType.JOB_STALLED) ?? 0,
        recoveredEventsInWindow: eventWindowMap.get(PlatformEventType.JOB_RECOVERED) ?? 0,
        dlqCreatedInWindow,
        dlqReplayedInWindow,
        dlqNetGrowthInWindow: dlqCreatedInWindow - dlqReplayedInWindow,
        scheduleMisfiresInWindow,
        scheduleSkipsInWindow,
        scheduleMisfiresTotal,
        outboxPending,
      },
      workerSummary,
      queues: queueMetrics,
      workers,
      windowStart: windowStart.toISOString(),
      windowEnd: generatedAt,
      generatedAt,
    };
  }

  /**
   * Computes chronological UTC time-bucketed metrics directly in PostgreSQL via `date_bin`
   * and `generate_series`, avoiding loading historical rows into Node.js memory.
   */
  async getOrganisationTimeseries(
    orgId: string,
    params: { windowMinutes: number; bucketMinutes?: number; queueId?: string; now?: Date },
  ): Promise<OrganisationTimeseriesView> {
    if (params.queueId) {
      const queue = await db.queue.findFirst({
        where: { id: params.queueId, organisationId: orgId },
        select: { id: true },
      });
      if (!queue) {
        throw new NotFoundError('Queue not found');
      }
    }

    const bucketMinutes = resolveBucketMinutes(params.windowMinutes, params.bucketMinutes);
    const bucketMs = bucketMinutes * 60_000;
    const now = params.now ?? new Date();
    const nowMs = now.getTime();

    // Align to exact UTC bucket boundaries so the current in-progress bucket is included
    const alignedEndMs = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
    const bucketCount = Math.ceil(params.windowMinutes / bucketMinutes);
    const alignedStartMs = alignedEndMs - bucketCount * bucketMs;
    const lastBucketStartMs = alignedEndMs - bucketMs;

    const alignedStart = new Date(alignedStartMs);
    const alignedEnd = new Date(alignedEndMs);
    const lastBucketStart = new Date(lastBucketStartMs);
    const stride = `${bucketMinutes} minutes`;

    const queueFilterJob = params.queueId
      ? Prisma.sql`AND j.queue_id = ${params.queueId}::uuid`
      : Prisma.empty;
    const queueFilterEvent = params.queueId
      ? Prisma.sql`AND pe.queue_id = ${params.queueId}::uuid`
      : Prisma.empty;
    const queueFilterDlq = params.queueId
      ? Prisma.sql`AND d.queue_id = ${params.queueId}::uuid`
      : Prisma.empty;
    const queueFilterSchedule = params.queueId
      ? Prisma.sql`AND s.queue_id = ${params.queueId}::uuid`
      : Prisma.empty;

    const rows = await db.$queryRaw<TimeseriesSqlRow[]>`
      WITH series AS (
        SELECT gs AS bucket_start
        FROM generate_series(
          ${alignedStart}::timestamp,
          ${lastBucketStart}::timestamp,
          ${stride}::interval
        ) AS gs
      ),
      submitted_buckets AS (
        SELECT
          date_bin(${stride}::interval, j.created_at, TIMESTAMP '1970-01-01 00:00:00') AS b,
          COUNT(*)::int AS submitted
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          ${queueFilterJob}
          AND j.created_at >= ${alignedStart}::timestamp
          AND j.created_at < ${alignedEnd}::timestamp
        GROUP BY b
      ),
      terminal_buckets AS (
        SELECT
          date_bin(
            ${stride}::interval,
            CASE WHEN j.status = 'COMPLETED' THEN j.completed_at ELSE j.failed_at END,
            TIMESTAMP '1970-01-01 00:00:00'
          ) AS b,
          COUNT(*) FILTER (WHERE j.status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE j.status = 'FAILED')::int AS failed,
          COUNT(j.duration_ms)::int AS duration_samples,
          AVG(j.duration_ms) AS avg_duration_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY j.duration_ms) FILTER (WHERE j.duration_ms IS NOT NULL) AS p95_duration_ms
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          ${queueFilterJob}
          AND (
            (j.status = 'COMPLETED' AND j.completed_at >= ${alignedStart}::timestamp AND j.completed_at < ${alignedEnd}::timestamp)
            OR (j.status = 'FAILED' AND j.failed_at >= ${alignedStart}::timestamp AND j.failed_at < ${alignedEnd}::timestamp)
          )
        GROUP BY b
      ),
      event_buckets AS (
        SELECT
          date_bin(${stride}::interval, pe.created_at, TIMESTAMP '1970-01-01 00:00:00') AS b,
          COUNT(*) FILTER (WHERE pe.type = 'JOB_RETRIED')::int AS retries,
          COUNT(*) FILTER (WHERE pe.type = 'JOB_STALLED')::int AS stalled
        FROM platform_events pe
        WHERE pe.organisation_id = ${orgId}::uuid
          ${queueFilterEvent}
          AND pe.type IN ('JOB_RETRIED', 'JOB_STALLED')
          AND pe.created_at >= ${alignedStart}::timestamp
          AND pe.created_at < ${alignedEnd}::timestamp
        GROUP BY b
      ),
      dlq_buckets AS (
        SELECT
          date_bin(${stride}::interval, d.created_at, TIMESTAMP '1970-01-01 00:00:00') AS b,
          COUNT(*)::int AS dlq_added
        FROM dead_letter_jobs d
        WHERE d.organisation_id = ${orgId}::uuid
          ${queueFilterDlq}
          AND d.created_at >= ${alignedStart}::timestamp
          AND d.created_at < ${alignedEnd}::timestamp
        GROUP BY b
      ),
      misfire_buckets AS (
        SELECT
          date_bin(${stride}::interval, se.created_at, TIMESTAMP '1970-01-01 00:00:00') AS b,
          COUNT(*)::int AS schedule_misfires
        FROM schedule_executions se
        INNER JOIN schedules s ON s.id = se.schedule_id
        WHERE s.organisation_id = ${orgId}::uuid
          ${queueFilterSchedule}
          AND se.status = 'MISSED'
          AND se.created_at >= ${alignedStart}::timestamp
          AND se.created_at < ${alignedEnd}::timestamp
        GROUP BY b
      )
      SELECT
        s.bucket_start,
        COALESCE(sb.submitted, 0)::int AS submitted,
        COALESCE(tb.completed, 0)::int AS completed,
        COALESCE(tb.failed, 0)::int AS failed,
        COALESCE(tb.duration_samples, 0)::int AS duration_samples,
        tb.avg_duration_ms,
        tb.p95_duration_ms,
        COALESCE(eb.retries, 0)::int AS retries,
        COALESCE(eb.stalled, 0)::int AS stalled,
        COALESCE(dbq.dlq_added, 0)::int AS dlq_added,
        COALESCE(mb.schedule_misfires, 0)::int AS schedule_misfires
      FROM series s
      LEFT JOIN submitted_buckets sb ON sb.b = s.bucket_start
      LEFT JOIN terminal_buckets tb ON tb.b = s.bucket_start
      LEFT JOIN event_buckets eb ON eb.b = s.bucket_start
      LEFT JOIN dlq_buckets dbq ON dbq.b = s.bucket_start
      LEFT JOIN misfire_buckets mb ON mb.b = s.bucket_start
      ORDER BY s.bucket_start ASC
    `;

    const buckets: TimeseriesBucketItem[] = rows.map((row) => {
      const startDate = new Date(row.bucket_start);
      const endDate = new Date(startDate.getTime() + bucketMs);
      const completed = toInt(row.completed);
      const failed = toInt(row.failed);
      const processed = completed + failed;
      const samples = toInt(row.duration_samples);

      return {
        bucketStart: startDate.toISOString(),
        bucketEnd: endDate.toISOString(),
        submitted: toInt(row.submitted),
        completed,
        failed,
        processed,
        successRate: roundRate(completed, processed),
        failureRate: roundRate(failed, processed),
        avgDurationMs: roundMs(row.avg_duration_ms),
        p95DurationMs: samples >= MIN_PERCENTILE_SAMPLES ? roundMs(row.p95_duration_ms) : null,
        retries: toInt(row.retries),
        stalled: toInt(row.stalled),
        dlqAdded: toInt(row.dlq_added),
        scheduleMisfires: toInt(row.schedule_misfires),
      };
    });

    return {
      organisationId: orgId,
      queueId: params.queueId ?? null,
      windowMinutes: params.windowMinutes,
      bucketMinutes,
      minPercentileSamples: MIN_PERCENTILE_SAMPLES,
      windowStart: alignedStart.toISOString(),
      windowEnd: alignedEnd.toISOString(),
      buckets,
      generatedAt: now.toISOString(),
    };
  }
}

export const metricsService = new MetricsService();

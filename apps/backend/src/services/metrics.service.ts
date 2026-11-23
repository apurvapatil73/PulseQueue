import { JobStatus, Prisma, WorkerHealthStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { workerHealthService, type OrgSafeWorkerView } from './workerHealth.service.js';

/**
 * Minimum number of timing samples required before p50/p95/p99 percentiles are reported.
 * Below this threshold percentiles return `null` to avoid statistically misleading estimates.
 */
export const MIN_PERCENTILE_SAMPLES = 5;

export const DEFAULT_METRICS_CACHE_TTL_MS = 2_000;
export const DEFAULT_METRICS_CACHE_MAX_ENTRIES = 200;

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
  /** All-time retry rate: retriedJobs / (COMPLETED + FAILED), or null if 0 processed. */
  retryRate: number | null;
  /** All-time average last-attempt execution duration in ms. */
  averageDurationMs: number | null;
  /** Windowed p50 execution duration in ms, or null if fewer than MIN_PERCENTILE_SAMPLES. */
  p50DurationMs: number | null;
  /** Windowed p95 execution duration in ms, or null if fewer than MIN_PERCENTILE_SAMPLES. */
  p95DurationMs: number | null;
  /** Windowed p99 execution duration in ms, or null if fewer than MIN_PERCENTILE_SAMPLES. */
  p99DurationMs: number | null;
  /** Windowed average initial queue wait time (submission -> first start) in ms. */
  avgQueueWaitMs: number | null;
  /** Windowed p95 initial queue wait time in ms, or null if fewer than MIN_PERCENTILE_SAMPLES. */
  p95QueueWaitMs: number | null;
  /** Count of jobs in this queue with attemptsMade > 1 (distinct from failed jobs). */
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

interface OrgJobAnalyticsRow {
  pending: number | bigint | string;
  active: number | bigint | string;
  completed: number | bigint | string;
  failed: number | bigint | string;
  delayed: number | bigint | string;
  paused: number | bigint | string;
  retried_jobs: number | bigint | string;
  stalled_recoveries: number | bigint | string;
  all_time_avg_duration_ms: number | string | null;
  completed_in_window: number | bigint | string;
  failed_in_window: number | bigint | string;
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

interface QueueAnalyticsRow {
  queueId: string;
  pending: number | bigint | string;
  active: number | bigint | string;
  completed: number | bigint | string;
  failed: number | bigint | string;
  delayed: number | bigint | string;
  paused: number | bigint | string;
  retriedJobs: number | bigint | string;
  stalledRecoveries: number | bigint | string;
  allTimeAvgDurationMs: number | string | null;
  completedInWindow: number | bigint | string;
  failedInWindow: number | bigint | string;
  durationSampleCount: number | bigint | string;
  p50DurationMs: number | string | null;
  p95DurationMs: number | string | null;
  p99DurationMs: number | string | null;
  waitSampleCount: number | bigint | string;
  avgQueueWaitMs: number | string | null;
  p95QueueWaitMs: number | string | null;
  oldestPendingAt: Date | null;
}

interface OrgReliabilitySqlRow {
  total_retry_events: number | bigint | string;
  retries_in_window: number | bigint | string;
  stalled_events_in_window: number | bigint | string;
  recovered_events_in_window: number | bigint | string;
  dlq_open: number | bigint | string;
  dlq_replayed: number | bigint | string;
  dlq_created_in_window: number | bigint | string;
  dlq_replayed_in_window: number | bigint | string;
  schedule_misfires_total: number | bigint | string;
  schedule_misfires_in_window: number | bigint | string;
  schedule_skips_in_window: number | bigint | string;
  outbox_pending: number | bigint | string;
  dlq_open_by_queue: Record<string, number> | null;
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

interface MetricsCacheEntry {
  organisationId: string;
  expiresAtMs: number;
  value: OrganisationMetricsView;
}

export interface MetricsServiceOptions {
  cacheTtlMs?: number;
  maxCacheEntries?: number;
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
 * read-only (zero DB writes on GET), optimized via consolidated SQL CTEs and a bounded
 * short-TTL cache with event-driven invalidation.
 */
export class MetricsService {
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, MetricsCacheEntry>();

  constructor(options: MetricsServiceOptions = {}) {
    this.cacheTtlMs =
      options.cacheTtlMs ?? (process.env.NODE_ENV === 'test' ? 0 : DEFAULT_METRICS_CACHE_TTL_MS);
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_METRICS_CACHE_MAX_ENTRIES;
  }

  /**
   * Invalidates all cached metrics entries for a specific organisation.
   */
  invalidateOrganisation(orgId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.organisationId === orgId) {
        this.cache.delete(key);
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  async getOrganisationMetrics(
    orgId: string,
    windowMinutes: number = 60,
    options?: { bypassCache?: boolean },
  ): Promise<OrganisationMetricsView> {
    const cacheKey = `${orgId}:${windowMinutes}`;
    const now = new Date();
    const nowMs = now.getTime();

    if (this.cacheTtlMs > 0 && !options?.bypassCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAtMs > nowMs) {
        return cached.value;
      }
      if (cached) {
        this.cache.delete(cacheKey);
      }
    }

    const windowStart = new Date(nowMs - windowMinutes * 60_000);

    // Consolidated into 4 compact queries (plus 2 inside listWorkersForOrganisation = 6 max, down from 23)
    const queues = await db.queue.findMany({
      where: { organisationId: orgId },
      select: { id: true, name: true, isPaused: true, concurrency: true },
      orderBy: { createdAt: 'asc' },
    });

    const [orgJobRows, queueJobRows, reliabilityRows, workers] = await Promise.all([
      db.$queryRaw<OrgJobAnalyticsRow[]>`
        WITH org_jobs AS (
          SELECT
            j.id,
            j.status,
            j.attempts_made,
            j.stalled_count,
            j.duration_ms,
            j.delay_ms,
            j.created_at,
            j.started_at,
            j.completed_at,
            j.failed_at,
            (
              (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
              OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart})
            ) AS in_window,
            CASE
              WHEN (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
                OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart}) THEN
                COALESCE(
                  j.first_started_at,
                  (
                    SELECT MIN(pe.created_at)
                    FROM platform_events pe
                    WHERE pe.job_id = j.id AND pe.type = 'JOB_STARTED'
                  ),
                  j.started_at
                )
              ELSE NULL
            END AS effective_first_started_at
          FROM jobs j
          INNER JOIN queues q ON q.id = j.queue_id
          WHERE q.organisation_id = ${orgId}::uuid
        ),
        computed AS (
          SELECT
            *,
            CASE
              WHEN in_window AND effective_first_started_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (effective_first_started_at - created_at)) * 1000.0 - delay_ms)
              ELSE NULL
            END AS queue_wait_ms,
            CASE
              WHEN in_window AND attempts_made > 1 AND effective_first_started_at IS NOT NULL AND started_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (started_at - effective_first_started_at)) * 1000.0)
              ELSE NULL
            END AS retry_overhead_ms,
            CASE
              WHEN in_window AND status = 'COMPLETED' AND completed_at IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000.0)
              ELSE NULL
            END AS e2e_ms
          FROM org_jobs
        )
        SELECT
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'DELAYED')::int AS delayed,
          COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
          COUNT(*) FILTER (WHERE attempts_made > 1)::int AS retried_jobs,
          COALESCE(SUM(stalled_count), 0)::int AS stalled_recoveries,
          AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS all_time_avg_duration_ms,
          COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= ${windowStart})::int AS completed_in_window,
          COUNT(*) FILTER (WHERE status = 'FAILED' AND failed_at >= ${windowStart})::int AS failed_in_window,

          COUNT(duration_ms) FILTER (WHERE in_window)::int AS exec_count,
          AVG(duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS exec_avg,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS exec_p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS exec_p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS exec_p99,

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
      db.$queryRaw<QueueAnalyticsRow[]>`
        WITH q_jobs AS (
          SELECT
            j.queue_id,
            j.status,
            j.attempts_made,
            j.stalled_count,
            j.duration_ms,
            j.delay_ms,
            j.created_at,
            j.completed_at,
            j.failed_at,
            (
              (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
              OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart})
            ) AS in_window,
            CASE
              WHEN (j.status = 'COMPLETED' AND j.completed_at >= ${windowStart})
                OR (j.status = 'FAILED' AND j.failed_at >= ${windowStart}) THEN
                COALESCE(j.first_started_at, j.started_at)
              ELSE NULL
            END AS eff_first_started
          FROM jobs j
          INNER JOIN queues q ON q.id = j.queue_id
          WHERE q.organisation_id = ${orgId}::uuid
        ),
        q_computed AS (
          SELECT
            *,
            CASE
              WHEN in_window AND eff_first_started IS NOT NULL THEN
                GREATEST(0, EXTRACT(EPOCH FROM (eff_first_started - created_at)) * 1000.0 - delay_ms)
              ELSE NULL
            END AS queue_wait_ms
          FROM q_jobs
        )
        SELECT
          queue_id AS "queueId",
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE status = 'DELAYED')::int AS delayed,
          COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
          COUNT(*) FILTER (WHERE attempts_made > 1)::int AS "retriedJobs",
          COALESCE(SUM(stalled_count), 0)::int AS "stalledRecoveries",
          AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS "allTimeAvgDurationMs",
          COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= ${windowStart})::int AS "completedInWindow",
          COUNT(*) FILTER (WHERE status = 'FAILED' AND failed_at >= ${windowStart})::int AS "failedInWindow",
          COUNT(duration_ms) FILTER (WHERE in_window)::int AS "durationSampleCount",
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS "p50DurationMs",
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS "p95DurationMs",
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE in_window AND duration_ms IS NOT NULL) AS "p99DurationMs",
          COUNT(queue_wait_ms)::int AS "waitSampleCount",
          AVG(queue_wait_ms) AS "avgQueueWaitMs",
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY queue_wait_ms) FILTER (WHERE queue_wait_ms IS NOT NULL) AS "p95QueueWaitMs",
          MIN(created_at) FILTER (WHERE status = 'PENDING') AS "oldestPendingAt"
        FROM q_computed
        GROUP BY queue_id
      `,
      db.$queryRaw<OrgReliabilitySqlRow[]>`
        SELECT
          (SELECT COUNT(*)::int FROM platform_events WHERE organisation_id = ${orgId}::uuid AND type = 'JOB_RETRIED') AS total_retry_events,
          (SELECT COUNT(*)::int FROM platform_events WHERE organisation_id = ${orgId}::uuid AND type = 'JOB_RETRIED' AND created_at >= ${windowStart}) AS retries_in_window,
          (SELECT COUNT(*)::int FROM platform_events WHERE organisation_id = ${orgId}::uuid AND type = 'JOB_STALLED' AND created_at >= ${windowStart}) AS stalled_events_in_window,
          (SELECT COUNT(*)::int FROM platform_events WHERE organisation_id = ${orgId}::uuid AND type = 'JOB_RECOVERED' AND created_at >= ${windowStart}) AS recovered_events_in_window,
          (SELECT COUNT(*)::int FROM dead_letter_jobs WHERE organisation_id = ${orgId}::uuid AND status = 'OPEN') AS dlq_open,
          (SELECT COUNT(*)::int FROM dead_letter_jobs WHERE organisation_id = ${orgId}::uuid AND status = 'REPLAYED') AS dlq_replayed,
          (SELECT COUNT(*)::int FROM dead_letter_jobs WHERE organisation_id = ${orgId}::uuid AND created_at >= ${windowStart}) AS dlq_created_in_window,
          (SELECT COUNT(*)::int FROM dead_letter_jobs WHERE organisation_id = ${orgId}::uuid AND replayed_at >= ${windowStart}) AS dlq_replayed_in_window,
          (SELECT COUNT(*)::int FROM schedule_executions se INNER JOIN schedules s ON s.id = se.schedule_id WHERE s.organisation_id = ${orgId}::uuid AND se.status = 'MISSED') AS schedule_misfires_total,
          (SELECT COUNT(*)::int FROM schedule_executions se INNER JOIN schedules s ON s.id = se.schedule_id WHERE s.organisation_id = ${orgId}::uuid AND se.status = 'MISSED' AND se.created_at >= ${windowStart}) AS schedule_misfires_in_window,
          (SELECT COUNT(*)::int FROM schedule_executions se INNER JOIN schedules s ON s.id = se.schedule_id WHERE s.organisation_id = ${orgId}::uuid AND se.status IN ('SKIPPED_OVERLAP', 'SKIPPED_CONCURRENCY', 'SKIPPED_MIN_INTERVAL', 'SKIPPED_MAX_RUNS') AND se.created_at >= ${windowStart}) AS schedule_skips_in_window,
          (SELECT COUNT(*)::int FROM job_dispatch_outbox WHERE organisation_id = ${orgId}::uuid AND status = 'PENDING') AS outbox_pending,
          (
            SELECT json_object_agg(queue_id::text, cnt)
            FROM (
              SELECT queue_id, COUNT(*)::int AS cnt
              FROM dead_letter_jobs
              WHERE organisation_id = ${orgId}::uuid AND status = 'OPEN'
              GROUP BY queue_id
            ) d
          ) AS dlq_open_by_queue
      `,
      workerHealthService.listWorkersForOrganisation(orgId, undefined, queues),
    ]);

    const orgJob = orgJobRows[0];
    const rel = reliabilityRows[0];

    const pending = toInt(orgJob?.pending);
    const active = toInt(orgJob?.active);
    const succeeded = toInt(orgJob?.completed);
    const failed = toInt(orgJob?.failed);
    const delayed = toInt(orgJob?.delayed);
    const paused = toInt(orgJob?.paused);

    const totalSubmitted = pending + active + succeeded + failed + delayed + paused;
    const totalProcessed = succeeded + failed;
    const queueDepth = pending + delayed + paused;

    const completedInWindow = toInt(orgJob?.completed_in_window);
    const failedInWindow = toInt(orgJob?.failed_in_window);
    const processedInWindow = completedInWindow + failedInWindow;
    const jobsPerMinute =
      windowMinutes > 0 ? Math.round((processedInWindow / windowMinutes) * 1000) / 1000 : 0;

    const executionDuration = buildDistribution(
      orgJob?.exec_count,
      orgJob?.exec_avg,
      orgJob?.exec_p50,
      orgJob?.exec_p95,
      orgJob?.exec_p99,
    );
    const queueWait = buildDistribution(
      orgJob?.wait_count,
      orgJob?.wait_avg,
      orgJob?.wait_p50,
      orgJob?.wait_p95,
      orgJob?.wait_p99,
    );
    const retryOverhead = buildDistribution(
      orgJob?.retry_count,
      orgJob?.retry_avg,
      orgJob?.retry_p50,
      orgJob?.retry_p95,
      orgJob?.retry_p99,
    );
    const endToEnd = buildDistribution(
      orgJob?.e2e_count,
      orgJob?.e2e_avg,
      orgJob?.e2e_p50,
      orgJob?.e2e_p95,
      orgJob?.e2e_p99,
    );

    const dlqOpenByQueue = rel?.dlq_open_by_queue ?? {};
    const queueRowMap = new Map<string, QueueAnalyticsRow>();
    for (const row of queueJobRows) {
      queueRowMap.set(row.queueId, row);
    }

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
      const qr = queueRowMap.get(q.id);
      const byStatus: Record<JobStatus, number> = {
        [JobStatus.PENDING]: toInt(qr?.pending),
        [JobStatus.ACTIVE]: toInt(qr?.active),
        [JobStatus.COMPLETED]: toInt(qr?.completed),
        [JobStatus.FAILED]: toInt(qr?.failed),
        [JobStatus.DELAYED]: toInt(qr?.delayed),
        [JobStatus.PAUSED]: toInt(qr?.paused),
      };
      const totalJobs =
        byStatus.PENDING +
        byStatus.ACTIVE +
        byStatus.COMPLETED +
        byStatus.FAILED +
        byStatus.DELAYED +
        byStatus.PAUSED;
      const qProcessed = byStatus.COMPLETED + byStatus.FAILED;
      const qDepth = byStatus.PENDING + byStatus.DELAYED + byStatus.PAUSED;
      const qRetried = toInt(qr?.retriedJobs);
      const qProcessedWin = toInt(qr?.completedInWindow) + toInt(qr?.failedInWindow);
      const durSamples = toInt(qr?.durationSampleCount);
      const waitSamples = toInt(qr?.waitSampleCount);
      const oldestPendingAgeMs =
        qr?.oldestPendingAt != null
          ? Math.max(0, nowMs - new Date(qr.oldestPendingAt).getTime())
          : null;

      return {
        queueId: q.id,
        name: q.name,
        isPaused: q.isPaused,
        concurrency: q.concurrency,
        totalJobs,
        queueDepth: qDepth,
        byStatus,
        successRate: roundRate(byStatus.COMPLETED, qProcessed),
        failureRate: roundRate(byStatus.FAILED, qProcessed),
        retryRate: roundRate(qRetried, qProcessed),
        averageDurationMs: roundMs(qr?.allTimeAvgDurationMs),
        p50DurationMs: durSamples >= MIN_PERCENTILE_SAMPLES ? roundMs(qr?.p50DurationMs) : null,
        p95DurationMs: durSamples >= MIN_PERCENTILE_SAMPLES ? roundMs(qr?.p95DurationMs) : null,
        p99DurationMs: durSamples >= MIN_PERCENTILE_SAMPLES ? roundMs(qr?.p99DurationMs) : null,
        avgQueueWaitMs: waitSamples > 0 ? roundMs(qr?.avgQueueWaitMs) : null,
        p95QueueWaitMs: waitSamples >= MIN_PERCENTILE_SAMPLES ? roundMs(qr?.p95QueueWaitMs) : null,
        retriedJobs: qRetried,
        stalledRecoveries: toInt(qr?.stalledRecoveries),
        processedInWindow: qProcessedWin,
        jobsPerMinute:
          windowMinutes > 0 ? Math.round((qProcessedWin / windowMinutes) * 1000) / 1000 : 0,
        oldestPendingAgeMs,
        openDeadLetters: toInt(dlqOpenByQueue[q.id]),
      };
    });

    const dlqCreatedInWindow = toInt(rel?.dlq_created_in_window);
    const dlqReplayedInWindow = toInt(rel?.dlq_replayed_in_window);
    const generatedAt = now.toISOString();

    const result: OrganisationMetricsView = {
      organisationId: orgId,
      summary: {
        totalSubmitted,
        totalProcessed,
        succeeded,
        failed,
        active,
        pending,
        delayed,
        paused,
        queueDepth,
        successRate: roundRate(succeeded, totalProcessed),
        failureRate: roundRate(failed, totalProcessed),
        windowSuccessRate: roundRate(completedInWindow, processedInWindow),
        windowFailureRate: roundRate(failedInWindow, processedInWindow),
        retriedJobs: toInt(orgJob?.retried_jobs),
        totalRetryEvents: toInt(rel?.total_retry_events),
        stalledRecoveries: toInt(orgJob?.stalled_recoveries),
        deadLetterOpen: toInt(rel?.dlq_open),
        deadLetterReplayed: toInt(rel?.dlq_replayed),
        averageDurationMs: roundMs(orgJob?.all_time_avg_duration_ms),
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
        retriesInWindow: toInt(rel?.retries_in_window),
        stalledEventsInWindow: toInt(rel?.stalled_events_in_window),
        recoveredEventsInWindow: toInt(rel?.recovered_events_in_window),
        dlqCreatedInWindow,
        dlqReplayedInWindow,
        dlqNetGrowthInWindow: dlqCreatedInWindow - dlqReplayedInWindow,
        scheduleMisfiresInWindow: toInt(rel?.schedule_misfires_in_window),
        scheduleSkipsInWindow: toInt(rel?.schedule_skips_in_window),
        scheduleMisfiresTotal: toInt(rel?.schedule_misfires_total),
        outboxPending: toInt(rel?.outbox_pending),
      },
      workerSummary,
      queues: queueMetrics,
      workers,
      windowStart: windowStart.toISOString(),
      windowEnd: generatedAt,
      generatedAt,
    };

    if (this.cacheTtlMs > 0) {
      if (this.cache.size >= this.maxCacheEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, {
        organisationId: orgId,
        expiresAtMs: Date.now() + this.cacheTtlMs,
        value: result,
      });
    }

    return result;
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

import { SchedulingPolicy } from '@prisma/client';

/**
 * Priority tier mapping (strictly bounded 4-value cardinality).
 * Higher numbers represent higher urgency on PulseQueue's [1..20] priority scale:
 * - critical: 16..20
 * - high:     11..15
 * - medium:    6..10
 * - low:       1..5
 */
export type PriorityTier = 'critical' | 'high' | 'medium' | 'low';

export const PRIORITY_TIERS: readonly PriorityTier[] = ['critical', 'high', 'medium', 'low'];

export const SCHEDULING_POLICIES: readonly SchedulingPolicy[] = [
  SchedulingPolicy.LEGACY_BULLMQ,
  SchedulingPolicy.FIFO,
  SchedulingPolicy.STRICT_PRIORITY,
  SchedulingPolicy.PRIORITY_AGING,
  SchedulingPolicy.WEIGHTED_FAIR,
  SchedulingPolicy.DEADLINE_AWARE,
  SchedulingPolicy.HYBRID_FAIR_DEADLINE,
];

export function mapPriorityToTier(priority: number): PriorityTier {
  if (priority >= 16) return 'critical';
  if (priority >= 11) return 'high';
  if (priority >= 6) return 'medium';
  return 'low';
}

/**
 * Documented histogram bucket upper bounds (inclusive) for scheduler metrics.
 * Units are explicitly suffixed (`Ms` = milliseconds, `Count` = integer jobs per batch).
 */
export const SCHEDULER_HISTOGRAM_BUCKETS = {
  claimLatencyMs: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000] as const,
  dispatchLatencyMs: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000] as const,
  tickDurationMs: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const,
  batchSizeCount: [1, 2, 4, 8, 16, 32, 64, 128] as const,
  deadlineLatenessMs: [10, 50, 100, 250, 500, 1000, 5000, 30000, 60000] as const,
} as const;

export interface HistogramBucketEntry {
  /** Upper bound (inclusive) or '+Inf' for overflow bucket. */
  le: number | '+Inf';
  /** Cumulative count of observations <= le. */
  cumulativeCount: number;
}

export interface HistogramSnapshot {
  unit: 'ms' | 'jobs';
  count: number;
  sum: number;
  avg: number | null;
  max: number | null;
  p50Estimate: number | null;
  p95Estimate: number | null;
  p99Estimate: number | null;
  buckets: HistogramBucketEntry[];
}

class BoundedHistogram {
  private readonly bounds: readonly number[];
  private readonly unit: 'ms' | 'jobs';
  private readonly bucketCounts: number[];
  private overflowCount = 0;
  private count = 0;
  private sum = 0;
  private maxVal: number | null = null;

  constructor(bounds: readonly number[], unit: 'ms' | 'jobs') {
    this.bounds = bounds;
    this.unit = unit;
    this.bucketCounts = new Array<number>(bounds.length).fill(0);
  }

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.sum += value;
    if (this.maxVal === null || value > this.maxVal) {
      this.maxVal = value;
    }
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= this.bounds[i]) {
        this.bucketCounts[i] += 1;
        return;
      }
    }
    this.overflowCount += 1;
  }

  private estimateQuantile(q: number): number | null {
    if (this.count === 0) return null;
    const target = Math.ceil(this.count * q);
    let cumulative = 0;
    for (let i = 0; i < this.bounds.length; i += 1) {
      cumulative += this.bucketCounts[i];
      if (cumulative >= target) {
        return this.bounds[i];
      }
    }
    return this.maxVal ?? this.bounds[this.bounds.length - 1];
  }

  snapshot(): HistogramSnapshot {
    const buckets: HistogramBucketEntry[] = [];
    let cumulative = 0;
    for (let i = 0; i < this.bounds.length; i += 1) {
      cumulative += this.bucketCounts[i];
      buckets.push({ le: this.bounds[i], cumulativeCount: cumulative });
    }
    cumulative += this.overflowCount;
    buckets.push({ le: '+Inf', cumulativeCount: cumulative });

    return {
      unit: this.unit,
      count: this.count,
      sum: Math.round(this.sum * 100) / 100,
      avg: this.count > 0 ? Math.round((this.sum / this.count) * 100) / 100 : null,
      max: this.maxVal !== null ? Math.round(this.maxVal * 100) / 100 : null,
      p50Estimate: this.estimateQuantile(0.5),
      p95Estimate: this.estimateQuantile(0.95),
      p99Estimate: this.estimateQuantile(0.99),
      buckets,
    };
  }

  reset(): void {
    this.bucketCounts.fill(0);
    this.overflowCount = 0;
    this.count = 0;
    this.sum = 0;
    this.maxVal = null;
  }
}

export interface GlobalSchedulerMetricsSnapshot {
  /** Privacy-safe global aggregate metrics. Contains zero organisation, queue, or job identifiers. */
  scope: 'global_aggregate';
  collectedAt: string;
  counters: {
    claimsTotal: number;
    dispatchesTotal: number;
    dispatchFailuresTotal: number;
    dispatchRetriesTotal: number;
    delayedPromotedTotal: number;
    starvationPromotionsTotal: number;
    priorityInversionsTotal: number;
    tenantCapacityDenialsTotal: number;
    reservationRecoveriesTotal: number;
    drrRoundsTotal: number;
    drrDeficitUpdatesTotal: number;
    drrDeficitConsumedTotal: number;
    drrFairnessDenialsTotal: number;
    deadlineAwareDispatchesTotal: number;
    deadlineMissesTotal: number;
    byPolicy: Record<
      SchedulingPolicy,
      {
        claims: number;
        dispatches: number;
        failures: number;
      }
    >;
  };
  gauges: {
    lastTickDurationMs: number | null;
    lastBatchSize: number | null;
    isLoopRunning: boolean;
  };
  histograms: {
    claimLatencyMs: HistogramSnapshot;
    dispatchLatencyMs: HistogramSnapshot;
    tickDurationMs: HistogramSnapshot;
    batchSize: HistogramSnapshot;
    deadlineLatenessMs: HistogramSnapshot;
  };
}

function createZeroPolicyRecord(): Record<
  SchedulingPolicy,
  { claims: number; dispatches: number; failures: number }
> {
  return {
    [SchedulingPolicy.LEGACY_BULLMQ]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.FIFO]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.STRICT_PRIORITY]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.PRIORITY_AGING]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.WEIGHTED_FAIR]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.DEADLINE_AWARE]: { claims: 0, dispatches: 0, failures: 0 },
    [SchedulingPolicy.HYBRID_FAIR_DEADLINE]: { claims: 0, dispatches: 0, failures: 0 },
  };
}

/**
 * Non-blocking, bounded-cardinality in-process scheduler metrics registry.
 *
 * Strictly forbids high-cardinality labels (no organisationId, jobId, or queueName).
 * Only bounded enums (`SchedulingPolicy`, `PriorityTier`) are used as label dimensions.
 */
export class SchedulerMetricsRegistry {
  private claimsTotal = 0;
  private dispatchesTotal = 0;
  private dispatchFailuresTotal = 0;
  private dispatchRetriesTotal = 0;
  private delayedPromotedTotal = 0;
  private starvationPromotionsTotal = 0;
  private priorityInversionsTotal = 0;
  private tenantCapacityDenialsTotal = 0;
  private reservationRecoveriesTotal = 0;
  private drrRoundsTotal = 0;
  private drrDeficitUpdatesTotal = 0;
  private drrDeficitConsumedTotal = 0;
  private drrFairnessDenialsTotal = 0;
  private deadlineAwareDispatchesTotal = 0;
  private deadlineMissesTotal = 0;
  private byPolicy = createZeroPolicyRecord();

  private lastTickDurationMs: number | null = null;
  private lastBatchSize: number | null = null;
  private isLoopRunning = false;

  private readonly claimLatencyMs = new BoundedHistogram(
    SCHEDULER_HISTOGRAM_BUCKETS.claimLatencyMs,
    'ms',
  );
  private readonly dispatchLatencyMs = new BoundedHistogram(
    SCHEDULER_HISTOGRAM_BUCKETS.dispatchLatencyMs,
    'ms',
  );
  private readonly tickDurationMs = new BoundedHistogram(
    SCHEDULER_HISTOGRAM_BUCKETS.tickDurationMs,
    'ms',
  );
  private readonly batchSize = new BoundedHistogram(
    SCHEDULER_HISTOGRAM_BUCKETS.batchSizeCount,
    'jobs',
  );
  private readonly deadlineLatenessMs = new BoundedHistogram(
    SCHEDULER_HISTOGRAM_BUCKETS.deadlineLatenessMs,
    'ms',
  );

  recordClaim(policy: SchedulingPolicy, count: number, latencyMs: number): void {
    if (count > 0) {
      this.claimsTotal += count;
      this.byPolicy[policy].claims += count;
      this.lastBatchSize = count;
      this.batchSize.observe(count);
    }
    this.claimLatencyMs.observe(latencyMs);
  }

  recordDispatchSuccess(policy: SchedulingPolicy, latencyMs: number, isRetry = false): void {
    this.dispatchesTotal += 1;
    this.byPolicy[policy].dispatches += 1;
    if (isRetry) {
      this.dispatchRetriesTotal += 1;
    }
    this.dispatchLatencyMs.observe(latencyMs);
  }

  recordDispatchFailure(policy: SchedulingPolicy): void {
    this.dispatchFailuresTotal += 1;
    this.byPolicy[policy].failures += 1;
  }

  recordDelayedPromoted(count: number): void {
    if (count > 0) this.delayedPromotedTotal += count;
  }

  recordStarvationPromotions(count: number): void {
    if (count > 0) this.starvationPromotionsTotal += count;
  }

  recordPriorityInversion(count: number = 1): void {
    if (count > 0) this.priorityInversionsTotal += count;
  }

  recordTenantCapacityDenial(): void {
    this.tenantCapacityDenialsTotal += 1;
  }

  recordReservationRecovery(count: number): void {
    if (count > 0) this.reservationRecoveriesTotal += count;
  }

  recordDrrRound(): void {
    this.drrRoundsTotal += 1;
    this.drrDeficitUpdatesTotal += 1;
  }

  recordDrrDeficitConsumed(cost: number): void {
    if (cost > 0) {
      this.drrDeficitConsumedTotal += cost;
      this.drrDeficitUpdatesTotal += 1;
    }
  }

  recordDrrFairnessDenial(): void {
    this.drrFairnessDenialsTotal += 1;
  }

  recordDeadlineDispatch(): void {
    this.deadlineAwareDispatchesTotal += 1;
  }

  recordDeadlineMiss(latenessMs: number): void {
    this.deadlineMissesTotal += 1;
    if (Number.isFinite(latenessMs) && latenessMs >= 0) {
      this.deadlineLatenessMs.observe(latenessMs);
    }
  }

  recordTickDuration(durationMs: number): void {
    this.lastTickDurationMs = Math.round(durationMs * 100) / 100;
    this.tickDurationMs.observe(durationMs);
  }

  setLoopRunning(running: boolean): void {
    this.isLoopRunning = running;
  }

  getGlobalSnapshot(): GlobalSchedulerMetricsSnapshot {
    return {
      scope: 'global_aggregate',
      collectedAt: new Date().toISOString(),
      counters: {
        claimsTotal: this.claimsTotal,
        dispatchesTotal: this.dispatchesTotal,
        dispatchFailuresTotal: this.dispatchFailuresTotal,
        dispatchRetriesTotal: this.dispatchRetriesTotal,
        delayedPromotedTotal: this.delayedPromotedTotal,
        starvationPromotionsTotal: this.starvationPromotionsTotal,
        priorityInversionsTotal: this.priorityInversionsTotal,
        tenantCapacityDenialsTotal: this.tenantCapacityDenialsTotal,
        reservationRecoveriesTotal: this.reservationRecoveriesTotal,
        drrRoundsTotal: this.drrRoundsTotal,
        drrDeficitUpdatesTotal: this.drrDeficitUpdatesTotal,
        drrDeficitConsumedTotal: Math.round(this.drrDeficitConsumedTotal * 100) / 100,
        drrFairnessDenialsTotal: this.drrFairnessDenialsTotal,
        deadlineAwareDispatchesTotal: this.deadlineAwareDispatchesTotal,
        deadlineMissesTotal: this.deadlineMissesTotal,
        byPolicy: {
          [SchedulingPolicy.LEGACY_BULLMQ]: { ...this.byPolicy[SchedulingPolicy.LEGACY_BULLMQ] },
          [SchedulingPolicy.FIFO]: { ...this.byPolicy[SchedulingPolicy.FIFO] },
          [SchedulingPolicy.STRICT_PRIORITY]: {
            ...this.byPolicy[SchedulingPolicy.STRICT_PRIORITY],
          },
          [SchedulingPolicy.PRIORITY_AGING]: { ...this.byPolicy[SchedulingPolicy.PRIORITY_AGING] },
          [SchedulingPolicy.WEIGHTED_FAIR]: { ...this.byPolicy[SchedulingPolicy.WEIGHTED_FAIR] },
          [SchedulingPolicy.DEADLINE_AWARE]: { ...this.byPolicy[SchedulingPolicy.DEADLINE_AWARE] },
          [SchedulingPolicy.HYBRID_FAIR_DEADLINE]: {
            ...this.byPolicy[SchedulingPolicy.HYBRID_FAIR_DEADLINE],
          },
        },
      },
      gauges: {
        lastTickDurationMs: this.lastTickDurationMs,
        lastBatchSize: this.lastBatchSize,
        isLoopRunning: this.isLoopRunning,
      },
      histograms: {
        claimLatencyMs: this.claimLatencyMs.snapshot(),
        dispatchLatencyMs: this.dispatchLatencyMs.snapshot(),
        tickDurationMs: this.tickDurationMs.snapshot(),
        batchSize: this.batchSize.snapshot(),
        deadlineLatenessMs: this.deadlineLatenessMs.snapshot(),
      },
    };
  }

  reset(): void {
    this.claimsTotal = 0;
    this.dispatchesTotal = 0;
    this.dispatchFailuresTotal = 0;
    this.dispatchRetriesTotal = 0;
    this.delayedPromotedTotal = 0;
    this.starvationPromotionsTotal = 0;
    this.priorityInversionsTotal = 0;
    this.tenantCapacityDenialsTotal = 0;
    this.reservationRecoveriesTotal = 0;
    this.drrRoundsTotal = 0;
    this.drrDeficitUpdatesTotal = 0;
    this.drrDeficitConsumedTotal = 0;
    this.drrFairnessDenialsTotal = 0;
    this.deadlineAwareDispatchesTotal = 0;
    this.deadlineMissesTotal = 0;
    this.byPolicy = createZeroPolicyRecord();
    this.lastTickDurationMs = null;
    this.lastBatchSize = null;
    this.isLoopRunning = false;
    this.claimLatencyMs.reset();
    this.dispatchLatencyMs.reset();
    this.tickDurationMs.reset();
    this.batchSize.reset();
    this.deadlineLatenessMs.reset();
  }
}

export const schedulerMetricsRegistry = new SchedulerMetricsRegistry();

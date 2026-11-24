import type { SchedulingPolicy } from '@prisma/client';

export interface LatencyDistributionStats {
  sampleCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface PriorityInversionSample {
  id: string;
  priority: number;
  readyAtMs: number;
  startedAtMs: number;
}

export interface TenantFairnessInput {
  tenantLabel: string;
  quotaWeight: number;
  completedJobs: number;
}

export interface TenantFairnessResult {
  /** Definition of x_i used in Jain's Fairness Index: completedJobs / quotaWeight. */
  metricDefinition: 'completed_jobs_per_quota_weight';
  jainsFairnessIndex: number | null;
  tenants: Array<{
    tenantLabel: string;
    quotaWeight: number;
    completedJobs: number;
    normalizedService: number;
  }>;
}

export interface BenchmarkConfig {
  scenario: 'A' | 'B' | 'C' | 'D' | 'E';
  label: string;
  policy: SchedulingPolicy | 'MIXED';
  totalJobs: number;
  queueCount: number;
  organisationCount: number;
  workerCount: number;
  workerConcurrency: number;
  jobExecutionMs: number;
  priorityDistribution: string;
  submissionRatePerSec: number | null;
  tenantQuotas: number[];
  maxDurationMs: number;
  seed: number;
}

export interface ScenarioBenchmarkResult {
  config: BenchmarkConfig;
  environment: {
    nodeVersion: string;
    platform: string;
    cpuCount: number;
    executedAt: string;
  };
  metrics: {
    elapsedMs: number;
    totalSubmitted: number;
    totalCompleted: number;
    jobsPerSecond: number;
    queueWaitMs: LatencyDistributionStats;
    lowPriorityWaitMs: LatencyDistributionStats;
    highPriorityWaitMs: LatencyDistributionStats;
    dispatchLatencyMs: LatencyDistributionStats;
    executionDurationMs: LatencyDistributionStats;
    maxWaitingMs: number | null;
    starvationCount: number;
    priorityInversionCount: number;
    workerUtilizationPercent: number;
    schedulerOverheadMs: {
      avgTickDurationMs: number | null;
      p95ClaimLatencyMs: number | null;
    };
    dbQueryLatencyMs: number;
    redisLatencyMs: number;
    redisRemainingBacklog: number;
    tenantCapacityViolations: number;
    fairness?: TenantFairnessResult;
  };
  notes: string[];
}

/**
 * Deterministic Mulberry32 PRNG for reproducible benchmark workloads.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes exact percentile `p` in [0, 100] from a pre-sorted ascending numeric array
 * using linear interpolation (matching PostgreSQL PERCENTILE_CONT semantics).
 */
export function computePercentile(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const clampedP = Math.max(0, Math.min(100, p));
  if (sortedValues.length === 1) return Math.round(sortedValues[0] * 100) / 100;
  const idx = (clampedP / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const weight = idx - lo;
  const interpolated = sortedValues[lo] * (1 - weight) + sortedValues[hi] * weight;
  return Math.round(interpolated * 100) / 100;
}

export function computeDistribution(values: readonly number[]): LatencyDistributionStats {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return {
      sampleCount: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    };
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  return {
    sampleCount: clean.length,
    avgMs: Math.round((sum / clean.length) * 100) / 100,
    p50Ms: computePercentile(clean, 50),
    p95Ms: computePercentile(clean, 95),
    p99Ms: computePercentile(clean, 99),
    maxMs: Math.round(clean[clean.length - 1] * 100) / 100,
  };
}

/**
 * Computes Jain's Fairness Index:
 *   J(x) = (sum(x_i)^2) / (n * sum(x_i^2))  in [1/n, 1]
 *
 * Where `x_i = completedJobs_i / quotaWeight_i` (normalized service received per unit of
 * configured tenant concurrency weight), ensuring fair comparison across tenants with
 * unequal quotas.
 */
export function computeJainsFairnessIndex(
  inputs: readonly TenantFairnessInput[],
): TenantFairnessResult {
  const valid = inputs.filter((t) => t.quotaWeight > 0);
  const tenants = valid.map((t) => ({
    tenantLabel: t.tenantLabel,
    quotaWeight: t.quotaWeight,
    completedJobs: t.completedJobs,
    normalizedService: Math.round((t.completedJobs / t.quotaWeight) * 10000) / 10000,
  }));

  if (tenants.length === 0) {
    return {
      metricDefinition: 'completed_jobs_per_quota_weight',
      jainsFairnessIndex: null,
      tenants: [],
    };
  }

  const sumX = tenants.reduce((acc, t) => acc + t.normalizedService, 0);
  const sumXSq = tenants.reduce((acc, t) => acc + t.normalizedService * t.normalizedService, 0);
  const j =
    sumXSq > 0 ? Math.round(((sumX * sumX) / (tenants.length * sumXSq)) * 10000) / 10000 : null;

  return {
    metricDefinition: 'completed_jobs_per_quota_weight',
    jainsFairnessIndex: j,
    tenants,
  };
}

/**
 * Counts priority inversions in an observed execution sequence:
 * A priority inversion occurs when a job `a` starts strictly earlier than job `b`
 * (`a.startedAtMs < b.startedAtMs`), yet `b` was already eligible when `a` started
 * (`b.readyAtMs <= a.startedAtMs`) and `b` had strictly higher base priority (`b.priority > a.priority`).
 */
export function countPriorityInversions(samples: readonly PriorityInversionSample[]): number {
  const sorted = [...samples].sort((a, b) => a.startedAtMs - b.startedAtMs);
  let inversions = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const started = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const later = sorted[j];
      if (later.readyAtMs <= started.startedAtMs && later.priority > started.priority) {
        inversions += 1;
        break; // count each inverted start once
      }
    }
  }
  return inversions;
}

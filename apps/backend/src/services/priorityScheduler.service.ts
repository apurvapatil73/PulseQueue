import {
  JobDispatchState,
  JobStatus,
  OutboxStatus,
  Prisma,
  SchedulingPolicy,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { QUEUE_LIMITS } from '../validators/queue.validator.js';
import {
  bullMQService,
  type BullMQService,
  type EnqueueResult,
  type PersistedQueueDescriptor,
} from './bullmq.service.js';
import { schedulerMetricsRegistry } from './schedulerMetrics.service.js';
import {
  DRR_DEFAULTS,
  accumulateDrrDeficit,
  buildSchedulingDecisionAudit,
  consumeDrrDeficit,
  evaluateDeadlineUrgency,
  isDeadlinePolicy,
  isDrrPolicy,
  type SchedulingDecisionAudit,
} from './fairDeadline.utils.js';

/**
 * Advisory lock namespace for tenant-level active/dispatching reservation checks.
 * Distinct from Phase 8.2 admission (82001) and retry-budget (82002) namespaces.
 */
const LOCK_NS_DISPATCH = 83001;

export const SCHEDULING_DEFAULTS = {
  POLICY: SchedulingPolicy.LEGACY_BULLMQ,
  AGING_RATE_PER_SEC: 0.05,
  MAX_EFFECTIVE_PRIORITY: 25.0,
  STARVATION_THRESHOLD_SEC: 300,
  MIN_AGING_RATE_PER_SEC: 0.001,
  MAX_AGING_RATE_PER_SEC: 10.0,
  MIN_MAX_EFFECTIVE_PRIORITY: QUEUE_LIMITS.MAX_PRIORITY,
  MAX_MAX_EFFECTIVE_PRIORITY: 100.0,
  MIN_STARVATION_THRESHOLD_SEC: 10,
  MAX_STARVATION_THRESHOLD_SEC: 86_400,
  DEFAULT_RESERVATION_STALE_MS: 15_000,
} as const;

export interface SchedulingPolicyConfig {
  schedulingPolicy: SchedulingPolicy;
  agingRatePerSec: number;
  maxEffectivePriority: number;
  starvationThresholdSec: number | null;
  deadlineUrgencyWindowSec?: number;
}

export interface SchedulingCandidateInput {
  id: string;
  priority: number;
  readyAt: Date;
  virtualRankAt?: Date;
  pausedDurationMs?: number;
  deadlineAt?: Date | null;
  schedulingCost?: number;
}

export interface EvaluatedCandidate {
  id: string;
  /**
   * Mutually exclusive priority bands:
   * - Band 0: Hard starvation promotion (waitingSec >= starvationThresholdSec)
   * - Band 1: Clamped at maxEffectivePriority (not starved, linear score >= maxEffectivePriority)
   * - Band 2: Linear aging band (unclamped, score strictly below maxEffectivePriority)
   */
  band: 0 | 1 | 2;
  waitingSec: number;
  basePriority: number;
  unclampedPriority: number;
  effectivePriority: number;
  isStarvationPromoted: boolean;
  isClamped: boolean;
  readyAt: Date;
  virtualRankAt: Date;
}

export interface ClaimedScheduledJob {
  id: string;
  queueId: string;
  name: string;
  priority: number;
  payload: Prisma.JsonValue;
  maxRetries: number;
  backoffMs: number;
  delayMs: number;
  readyAt: Date;
  virtualRankAt: Date;
  schedulingCost: number;
  deadlineAt: Date | null;
  deadlineMissedAt: Date | null;
  schedulingDecision: SchedulingDecisionAudit | null;
  dispatchState: JobDispatchState;
  dispatchClaimedAt: Date | null;
  dispatchClaimedBy: string | null;
  evaluation: EvaluatedCandidate;
}

export interface ClaimCandidatesParams {
  queueId: string;
  claimerId: string;
  limit: number;
  now?: Date;
  /**
   * Optional queue-level in-flight buffer ceiling (ACTIVE + DISPATCHING).
   * When provided, the claim count is bounded by `max(0, maxInFlightForQueue - currentInFlight)`.
   */
  maxInFlightForQueue?: number;
  /**
   * When true (default), respects Organisation.maxActiveJobs across all queues of the tenant
   * using a transaction-scoped advisory lock so concurrent schedulers cannot oversubscribe
   * active + dispatching reservations.
   */
  enforceOrgActiveLimit?: boolean;
  /**
   * For DRR policies (`WEIGHTED_FAIR`, `HYBRID_FAIR_DEADLINE`), controls whether this call
   * may add one round's quantum (`baseQuantum * weight`) to the organisation's deficit before
   * claiming. Defaults to `true`.
   */
  accumulateDrrRound?: boolean;
  /**
   * Minimum logical DRR round interval in milliseconds, enforced authoritatively in PostgreSQL
   * via `Organisation.drrLastRoundAt` under the per-org advisory lock.
   * When > 0, multiple independent scheduler processes ticking within the same logical round
   * window will accumulate quantum at most ONCE per organisation per round.
   * Defaults to `0` for direct calls; `tickAllQueues` defaults to `activeIntervalMs`.
   */
  drrMinRoundIntervalMs?: number;
}

export interface ClaimCandidatesResult {
  queueId: string;
  organisationId: string;
  policy: SchedulingPolicy;
  claimed: ClaimedScheduledJob[];
  skippedReason:
    | null
    | 'queue_not_found'
    | 'queue_paused'
    | 'legacy_policy'
    | 'zero_limit'
    | 'queue_buffer_full'
    | 'org_active_limit_reached'
    | 'drr_insufficient_deficit';
}

export interface JobDispatchAdapter {
  dispatchClaimedJob(
    queue: PersistedQueueDescriptor,
    job: ClaimedScheduledJob,
    effectivePriority: number,
  ): Promise<EnqueueResult>;
}

export interface DispatchBatchSummary {
  claimed: number;
  dispatched: number;
  released: number;
  skippedReason: ClaimCandidatesResult['skippedReason'];
}

export interface SchedulerTickSummary {
  queuesScanned: number;
  delayedPromoted: number;
  staleRecovered: number;
  claimed: number;
  dispatched: number;
  released: number;
  orgCapacityDenials: number;
  durationMs: number;
}

export interface SchedulerObservabilitySnapshot {
  claimsTotal: number;
  dispatchesTotal: number;
  dispatchFailuresTotal: number;
  staleRecoveriesTotal: number;
  orgCapacityDenialsTotal: number;
  delayedPromotedTotal: number;
  byPolicyDispatched: Record<SchedulingPolicy, number>;
  avgDispatchLatencyMs: number | null;
  lastTickDurationMs: number | null;
}

/**
 * Returns true when a queue is governed by PulseQueue's custom PostgreSQL scheduler
 * (`FIFO`, `STRICT_PRIORITY`, or `PRIORITY_AGING`) rather than direct `LEGACY_BULLMQ` enqueueing.
 */
export function isCustomSchedulingPolicy(policy: SchedulingPolicy | undefined): boolean {
  return policy !== undefined && policy !== SchedulingPolicy.LEGACY_BULLMQ;
}

/**
 * Computes canonical initial scheduling fields (`dispatchState`, `readyAt`, `virtualRankAt`)
 * for a newly created job based on its queue's scheduling policy and aging rate.
 */
export function buildInitialSchedulingFields(
  queue: { schedulingPolicy: SchedulingPolicy; agingRatePerSec: number },
  priority: number,
  delayMs: number,
  now: Date = new Date(),
): {
  dispatchState: JobDispatchState;
  readyAt: Date;
  virtualRankAt: Date;
} {
  const readyAt = computeReadyAt(now, delayMs);
  const virtualRankAt = computeVirtualRankAt(readyAt, priority, queue.agingRatePerSec);
  const dispatchState = isCustomSchedulingPolicy(queue.schedulingPolicy)
    ? JobDispatchState.QUEUED
    : JobDispatchState.DISPATCHED;
  return { dispatchState, readyAt, virtualRankAt };
}

/**
 * Production BullMQ transport adapter for `PrioritySchedulerService`.
 *
 * Uses stable `jobId = job.id`, maps effective priority into BullMQ's priority scale,
 * cleans up any stale completed/failed Redis transport entry from a prior retry attempt,
 * and sets BullMQ `maxRetries: 0` (1 transport attempt) so retries on custom-policy queues
 * re-enter PostgreSQL `DELAYED + QUEUED` and respect the queue's scheduling policy.
 */
export function createBullMQDispatchAdapter(
  bullMQ: BullMQService = bullMQService,
): JobDispatchAdapter {
  return {
    async dispatchClaimedJob(queue, job, effectivePriority): Promise<EnqueueResult> {
      const existingState = await bullMQ.getBullJobState(queue, job.id);
      if (existingState === 'completed' || existingState === 'failed') {
        await bullMQ.removeJobFromBullMQ(queue, job.id);
      }

      return bullMQ.enqueueJob(queue, {
        id: job.id,
        queueId: job.queueId,
        name: job.name,
        priority: clampBasePriority(effectivePriority),
        payload: job.payload,
        maxRetries: 0,
        backoffMs: 0,
        delayMs: 0,
      });
    },
  };
}

function hashOrgLockKey(orgId: string): number {
  let hash = 0;
  for (let i = 0; i < orgId.length; i += 1) {
    hash = (hash * 31 + orgId.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Clamps a raw priority integer into PulseQueue's canonical [1..20] range
 * where higher numbers represent higher urgency.
 */
export function clampBasePriority(priority: number): number {
  return Math.max(
    QUEUE_LIMITS.MIN_PRIORITY,
    Math.min(QUEUE_LIMITS.MAX_PRIORITY, Math.round(priority)),
  );
}

/**
 * Computes the timestamp at which a job becomes eligible for scheduling.
 * Delayed jobs are excluded from candidate selection and do not accrue aging until `readyAt`.
 */
export function computeReadyAt(createdAt: Date, delayMs: number): Date {
  return new Date(createdAt.getTime() + Math.max(0, Math.round(delayMs)));
}

/**
 * Computes the static Virtual Rank Timestamp:
 *
 *   V(j) = readyAt(j) - (basePriority(j) / agingRatePerSec) * 1000ms
 *
 * Algebraic equivalence on the unclamped linear band:
 *   P_base(j1) + alpha * (t - readyAt(j1)) > P_base(j2) + alpha * (t - readyAt(j2))
 *   <=> readyAt(j1) - P_base(j1) / alpha < readyAt(j2) - P_base(j2) / alpha
 *   <=> V(j1) < V(j2)
 *
 * Smaller `virtualRankAt` strictly corresponds to higher effective priority at every instant `t`,
 * enabling O(log N + K) PostgreSQL B-tree index scans without periodic priority rewrites.
 */
export function computeVirtualRankAt(
  readyAt: Date,
  basePriority: number,
  agingRatePerSec: number = SCHEDULING_DEFAULTS.AGING_RATE_PER_SEC,
): Date {
  if (!Number.isFinite(agingRatePerSec) || agingRatePerSec <= 0) {
    throw new Error('agingRatePerSec must be a positive finite number');
  }
  const p = clampBasePriority(basePriority);
  const offsetMs = Math.round((p / agingRatePerSec) * 1000);
  return new Date(readyAt.getTime() - offsetMs);
}

/**
 * Computes the virtual-rank cutoff timestamp for the maxEffectivePriority clamp at instant `now`:
 *
 *   P_base + alpha * (now - readyAt) >= P_max
 *   <=> readyAt - P_base / alpha <= now - P_max / alpha
 *   <=> V(j) <= clampCutoff(now)
 *
 * Jobs with `virtualRankAt <= clampCutoff(now)` have reached `maxEffectivePriority` and are
 * evaluated in Band 1 with exact FIFO tie-breaking (`readyAt ASC, id ASC`), eliminating any
 * clamping-induced ordering discrepancy between virtual-rank sorting and clamped scores.
 */
export function computeClampCutoffAt(
  now: Date,
  maxEffectivePriority: number = SCHEDULING_DEFAULTS.MAX_EFFECTIVE_PRIORITY,
  agingRatePerSec: number = SCHEDULING_DEFAULTS.AGING_RATE_PER_SEC,
): Date {
  if (!Number.isFinite(agingRatePerSec) || agingRatePerSec <= 0) {
    throw new Error('agingRatePerSec must be a positive finite number');
  }
  const offsetMs = Math.round((maxEffectivePriority / agingRatePerSec) * 1000);
  return new Date(now.getTime() - offsetMs);
}

/**
 * Computes the exact pause overlap duration for a job on a queue paused at `pausedAt` and
 * resumed at `resumedAt`:
 *
 *   delta = max(0, resumedAt - max(pausedAt, readyAt))
 *
 * - Jobs ready before pause shift by the full pause window (preserving pre-pause wait time).
 * - Jobs submitted during pause shift to `resumedAt` (zero wait accumulated while paused).
 * - Delayed jobs whose `readyAt > resumedAt` shift by 0 (delay target preserved).
 */
export function computePausedShiftMs(readyAt: Date, pausedAt: Date, resumedAt: Date): number {
  const effectivePauseStart = Math.max(pausedAt.getTime(), readyAt.getTime());
  return Math.max(0, resumedAt.getTime() - effectivePauseStart);
}

/**
 * Applies pause-duration exclusion to both `readyAt` and `virtualRankAt` by shifting both
 * forward equally so paused time never contributes to aging or starvation thresholds.
 */
export function applyPausedShift(
  readyAt: Date,
  virtualRankAt: Date,
  pausedAt: Date,
  resumedAt: Date,
): { readyAt: Date; virtualRankAt: Date; shiftMs: number } {
  const shiftMs = computePausedShiftMs(readyAt, pausedAt, resumedAt);
  if (shiftMs === 0) {
    return { readyAt, virtualRankAt, shiftMs: 0 };
  }
  return {
    readyAt: new Date(readyAt.getTime() + shiftMs),
    virtualRankAt: new Date(virtualRankAt.getTime() + shiftMs),
    shiftMs,
  };
}

/**
 * Computes non-negative eligible waiting time in seconds.
 */
export function computeWaitingSeconds(
  readyAt: Date,
  now: Date,
  pausedDurationMs: number = 0,
): number {
  const elapsedMs = now.getTime() - readyAt.getTime() - Math.max(0, pausedDurationMs);
  return Math.max(0, elapsedMs / 1000);
}

/**
 * Pure reference evaluator for a single candidate job at instant `now`.
 *
 * Note: Promotion into Band 0 (starvation) or Band 1 (maxEffectivePriority) governs
 * candidate selection priority within the scheduler; actual execution time still depends on
 * available worker capacity, queue concurrency, and tenant active-job limits.
 */
export function evaluateCandidateScore(
  candidate: SchedulingCandidateInput,
  config: SchedulingPolicyConfig,
  now: Date,
): EvaluatedCandidate {
  const basePriority = clampBasePriority(candidate.priority);
  const pausedMs = Math.max(0, candidate.pausedDurationMs ?? 0);
  const effectiveReadyAt = new Date(candidate.readyAt.getTime() + pausedMs);
  const waitingSec = computeWaitingSeconds(candidate.readyAt, now, pausedMs);
  const agingRate = config.agingRatePerSec;
  const maxEff = Math.max(QUEUE_LIMITS.MAX_PRIORITY, config.maxEffectivePriority);

  const virtualRankAt =
    candidate.virtualRankAt && pausedMs === 0
      ? candidate.virtualRankAt
      : computeVirtualRankAt(effectiveReadyAt, basePriority, agingRate);

  const unclampedPriority = basePriority + agingRate * waitingSec;

  const starveCutoffMs =
    config.starvationThresholdSec !== null
      ? now.getTime() - config.starvationThresholdSec * 1000
      : null;
  const isStarvationPromoted =
    starveCutoffMs !== null && effectiveReadyAt.getTime() <= starveCutoffMs;

  if (isStarvationPromoted) {
    return {
      id: candidate.id,
      band: 0,
      waitingSec,
      basePriority,
      unclampedPriority,
      effectivePriority: maxEff + 1 + waitingSec,
      isStarvationPromoted: true,
      isClamped: false,
      readyAt: effectiveReadyAt,
      virtualRankAt,
    };
  }

  const clampCutoff = computeClampCutoffAt(now, maxEff, agingRate);
  const isClamped = virtualRankAt.getTime() <= clampCutoff.getTime();

  if (isClamped) {
    return {
      id: candidate.id,
      band: 1,
      waitingSec,
      basePriority,
      unclampedPriority,
      effectivePriority: maxEff,
      isStarvationPromoted: false,
      isClamped: true,
      readyAt: effectiveReadyAt,
      virtualRankAt,
    };
  }

  return {
    id: candidate.id,
    band: 2,
    waitingSec,
    basePriority,
    unclampedPriority,
    effectivePriority: unclampedPriority,
    isStarvationPromoted: false,
    isClamped: false,
    readyAt: effectiveReadyAt,
    virtualRankAt,
  };
}

/**
 * Deterministic reference comparator matching the SQL candidate selection order for all policies:
 * - FIFO: `readyAt ASC, id ASC`
 * - STRICT_PRIORITY / LEGACY_BULLMQ: `basePriority DESC, readyAt ASC, id ASC`
 * - PRIORITY_AGING:
 *   1. `band ASC` (0 = starvation > 1 = clamped at maxEffectivePriority > 2 = linear aging)
 *   2. Band 0 & Band 1: `readyAt ASC, id ASC` (exact FIFO among starved or clamped jobs)
 *   3. Band 2: `virtualRankAt ASC, readyAt ASC, id ASC` (exact linear aging order)
 */
export function compareCandidatesByPolicy(
  a: SchedulingCandidateInput,
  b: SchedulingCandidateInput,
  config: SchedulingPolicyConfig,
  now: Date,
): number {
  const readyA = a.readyAt.getTime() + Math.max(0, a.pausedDurationMs ?? 0);
  const readyB = b.readyAt.getTime() + Math.max(0, b.pausedDurationMs ?? 0);

  if (config.schedulingPolicy === SchedulingPolicy.FIFO) {
    if (readyA !== readyB) return readyA - readyB;
    return a.id.localeCompare(b.id);
  }

  if (
    config.schedulingPolicy === SchedulingPolicy.STRICT_PRIORITY ||
    config.schedulingPolicy === SchedulingPolicy.LEGACY_BULLMQ
  ) {
    const pA = clampBasePriority(a.priority);
    const pB = clampBasePriority(b.priority);
    if (pA !== pB) return pB - pA;
    if (readyA !== readyB) return readyA - readyB;
    return a.id.localeCompare(b.id);
  }

  // DEADLINE_AWARE (3-band strict EDF: starvation -> all deadlines ordered by absolute deadlineAt ASC -> no-deadline aging)
  if (config.schedulingPolicy === SchedulingPolicy.DEADLINE_AWARE) {
    const evalA = evaluateCandidateScore(a, config, now);
    const evalB = evaluateCandidateScore(b, config, now);
    const dA = evaluateDeadlineUrgency(a.deadlineAt, now, config.deadlineUrgencyWindowSec);
    const dB = evaluateDeadlineUrgency(b.deadlineAt, now, config.deadlineUrgencyWindowSec);

    const edfBand = (ev: EvaluatedCandidate, dl: ReturnType<typeof evaluateDeadlineUrgency>) => {
      if (ev.isStarvationPromoted) return 0;
      if (dl.hasDeadline) return 1;
      return 2;
    };

    const bandA = edfBand(evalA, dA);
    const bandB = edfBand(evalB, dB);
    if (bandA !== bandB) return bandA - bandB;

    if (bandA === 1) {
      const dlDiff = (a.deadlineAt?.getTime() ?? 0) - (b.deadlineAt?.getTime() ?? 0);
      if (dlDiff !== 0) return dlDiff;
      const pDiff = clampBasePriority(b.priority) - clampBasePriority(a.priority);
      if (pDiff !== 0) return pDiff;
      if (readyA !== readyB) return readyA - readyB;
      return a.id.localeCompare(b.id);
    }
    // Band 0 (starvation) or Band 2 (no deadline -> aging)
    if (bandA === 2) {
      if (evalA.band !== evalB.band) return evalA.band - evalB.band;
      if (evalA.band === 2) {
        const vDiff = evalA.virtualRankAt.getTime() - evalB.virtualRankAt.getTime();
        if (vDiff !== 0) return vDiff;
      }
    }
    if (readyA !== readyB) return readyA - readyB;
    return a.id.localeCompare(b.id);
  }

  // HYBRID_FAIR_DEADLINE (Band 0 starvation -> Band 1 approaching or overdue deadline -> Band 2 priority aging)
  if (config.schedulingPolicy === SchedulingPolicy.HYBRID_FAIR_DEADLINE) {
    const urgencySec =
      config.deadlineUrgencyWindowSec ?? DRR_DEFAULTS.DEFAULT_DEADLINE_URGENCY_WINDOW_SEC;
    const evalA = evaluateCandidateScore(a, config, now);
    const evalB = evaluateCandidateScore(b, config, now);
    const dA = evaluateDeadlineUrgency(a.deadlineAt, now, urgencySec);
    const dB = evaluateDeadlineUrgency(b.deadlineAt, now, urgencySec);

    const hybBand = (ev: EvaluatedCandidate, dl: ReturnType<typeof evaluateDeadlineUrgency>) => {
      if (ev.isStarvationPromoted) return 0;
      if (dl.isApproaching || dl.isExpired) return 1;
      return 2;
    };

    const bandA = hybBand(evalA, dA);
    const bandB = hybBand(evalB, dB);
    if (bandA !== bandB) return bandA - bandB;

    if (bandA === 1) {
      const dlDiff = (a.deadlineAt?.getTime() ?? 0) - (b.deadlineAt?.getTime() ?? 0);
      if (dlDiff !== 0) return dlDiff;
      const pDiff = clampBasePriority(b.priority) - clampBasePriority(a.priority);
      if (pDiff !== 0) return pDiff;
      if (readyA !== readyB) return readyA - readyB;
      return a.id.localeCompare(b.id);
    }

    if (bandA === 2) {
      if (evalA.band !== evalB.band) return evalA.band - evalB.band;
      if (evalA.band === 2) {
        const vDiff = evalA.virtualRankAt.getTime() - evalB.virtualRankAt.getTime();
        if (vDiff !== 0) return vDiff;
      }
      // Tie-break equal effective priority by earlier deadline (nulls last)
      const dlA = a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const dlB = b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (dlA !== dlB) return dlA - dlB;
    }

    if (readyA !== readyB) return readyA - readyB;
    return a.id.localeCompare(b.id);
  }

  // PRIORITY_AGING and WEIGHTED_FAIR inner queue ordering (3-band virtual-time comparator)
  const evalA = evaluateCandidateScore(a, config, now);
  const evalB = evaluateCandidateScore(b, config, now);

  if (evalA.band !== evalB.band) {
    return evalA.band - evalB.band;
  }

  if (evalA.band === 2) {
    const vDiff = evalA.virtualRankAt.getTime() - evalB.virtualRankAt.getTime();
    if (vDiff !== 0) return vDiff;
  }

  if (readyA !== readyB) {
    return readyA - readyB;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Pure helper to filter out ineligible (delayed) jobs and sort eligible candidates according
 * to the configured scheduling policy.
 */
export function rankEligibleCandidates<T extends SchedulingCandidateInput>(
  candidates: readonly T[],
  config: SchedulingPolicyConfig,
  now: Date,
): T[] {
  const nowMs = now.getTime();
  return candidates
    .filter((c) => c.readyAt.getTime() + Math.max(0, c.pausedDurationMs ?? 0) <= nowMs)
    .sort((a, b) => compareCandidatesByPolicy(a, b, config, now));
}

interface RawClaimedJobRow {
  id: string;
  queue_id: string;
  name: string;
  priority: number;
  payload: Prisma.JsonValue;
  max_retries: number;
  backoff_ms: number;
  delay_ms: number;
  ready_at: Date;
  virtual_rank_at: Date;
  scheduling_cost: number;
  deadline_at: Date | null;
  deadline_missed_at: Date | null;
  dispatch_state: JobDispatchState;
  dispatch_claimed_at: Date | null;
  dispatch_claimed_by: string | null;
}

/**
 * PostgreSQL-authoritative custom priority scheduling engine.
 *
 * Owns candidate selection, deterministic ordering, atomic multi-process claiming via
 * `FOR UPDATE SKIP LOCKED`, tenant-level active/dispatching reservation safety, and
 * stale-reservation cleanup. Kept decoupled from BullMQ via `JobDispatchAdapter`.
 */
export class PrioritySchedulerService {
  private readonly defaultAdapter: JobDispatchAdapter;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private roundRobinOffset = 0;
  private activeClaimerId = 'scheduler-default';
  private activeIntervalMs = 250;
  private activeStaleAfterMs: number = SCHEDULING_DEFAULTS.DEFAULT_RESERVATION_STALE_MS;
  private readonly nudgeTimers = new Map<string, NodeJS.Timeout>();

  // Aggregate observability counters (no high-cardinality tenant labels)
  private claimsTotal = 0;
  private dispatchesTotal = 0;
  private dispatchFailuresTotal = 0;
  private staleRecoveriesTotal = 0;
  private orgCapacityDenialsTotal = 0;
  private delayedPromotedTotal = 0;
  private dispatchLatencySumMs = 0;
  private dispatchLatencyCount = 0;
  private lastTickDurationMs: number | null = null;
  private readonly byPolicyDispatched: Record<SchedulingPolicy, number> = {
    [SchedulingPolicy.LEGACY_BULLMQ]: 0,
    [SchedulingPolicy.FIFO]: 0,
    [SchedulingPolicy.STRICT_PRIORITY]: 0,
    [SchedulingPolicy.PRIORITY_AGING]: 0,
    [SchedulingPolicy.WEIGHTED_FAIR]: 0,
    [SchedulingPolicy.DEADLINE_AWARE]: 0,
    [SchedulingPolicy.HYBRID_FAIR_DEADLINE]: 0,
  };

  constructor(adapter?: JobDispatchAdapter) {
    this.defaultAdapter = adapter ?? createBullMQDispatchAdapter(bullMQService);
  }

  getObservabilitySnapshot(): SchedulerObservabilitySnapshot {
    return {
      claimsTotal: this.claimsTotal,
      dispatchesTotal: this.dispatchesTotal,
      dispatchFailuresTotal: this.dispatchFailuresTotal,
      staleRecoveriesTotal: this.staleRecoveriesTotal,
      orgCapacityDenialsTotal: this.orgCapacityDenialsTotal,
      delayedPromotedTotal: this.delayedPromotedTotal,
      byPolicyDispatched: { ...this.byPolicyDispatched },
      avgDispatchLatencyMs:
        this.dispatchLatencyCount > 0
          ? Math.round((this.dispatchLatencySumMs / this.dispatchLatencyCount) * 100) / 100
          : null,
      lastTickDurationMs: this.lastTickDurationMs,
    };
  }

  /**
   * Atomically selects and reserves up to `params.limit` eligible `PENDING` + `QUEUED` jobs
   * for a single non-paused, non-legacy queue using PostgreSQL `FOR UPDATE SKIP LOCKED`.
   *
   * State transition performed atomically inside the transaction:
   *   `dispatchState: QUEUED -> DISPATCHING` with `dispatchClaimedAt = now`, `dispatchClaimedBy = claimerId`.
   *
   * Multiple scheduler processes may call this concurrently on the same queue or tenant:
   * - `FOR UPDATE SKIP LOCKED` guarantees zero duplicate claims.
   * - When `enforceOrgActiveLimit` is enabled and `Organisation.maxActiveJobs` is configured,
   *   a transaction-scoped advisory lock serializes tenant-level reservation capacity checks
   *   against `ACTIVE + DISPATCHING` jobs across all queues in the organisation.
   */
  async claimCandidatesForQueue(params: ClaimCandidatesParams): Promise<ClaimCandidatesResult> {
    const now = params.now ?? new Date();
    const requestedLimit = Math.max(0, Math.floor(params.limit));

    if (requestedLimit === 0) {
      return {
        queueId: params.queueId,
        organisationId: '',
        policy: SchedulingPolicy.LEGACY_BULLMQ,
        claimed: [],
        skippedReason: 'zero_limit',
      };
    }

    return db.$transaction(
      async (tx) => {
        const queue = await tx.queue.findUnique({
          where: { id: params.queueId },
          select: {
            id: true,
            organisationId: true,
            isPaused: true,
            concurrency: true,
            schedulingPolicy: true,
            agingRatePerSec: true,
            maxEffectivePriority: true,
            starvationThresholdSec: true,
            schedulingWeight: true,
            deadlineUrgencyWindowSec: true,
            organisation: {
              select: {
                maxActiveJobs: true,
                schedulingWeight: true,
                drrBaseQuantum: true,
                drrMaxDeficit: true,
                schedulingDeficit: true,
                drrVersion: true,
              },
            },
          },
        });

        if (!queue) {
          return {
            queueId: params.queueId,
            organisationId: '',
            policy: SchedulingPolicy.LEGACY_BULLMQ,
            claimed: [],
            skippedReason: 'queue_not_found' as const,
          };
        }

        if (queue.isPaused) {
          return {
            queueId: queue.id,
            organisationId: queue.organisationId,
            policy: queue.schedulingPolicy,
            claimed: [],
            skippedReason: 'queue_paused' as const,
          };
        }

        if (queue.schedulingPolicy === SchedulingPolicy.LEGACY_BULLMQ) {
          return {
            queueId: queue.id,
            organisationId: queue.organisationId,
            policy: queue.schedulingPolicy,
            claimed: [],
            skippedReason: 'legacy_policy' as const,
          };
        }

        // Promote eligible DELAYED custom-policy jobs whose readyAt <= now into PENDING
        // so delayed jobs are never dispatched early and seamlessly enter policy ordering once due
        const promoted = await tx.job.updateMany({
          where: {
            queueId: queue.id,
            status: JobStatus.DELAYED,
            dispatchState: JobDispatchState.QUEUED,
            isQuarantined: false,
            readyAt: { lte: now },
          },
          data: {
            status: JobStatus.PENDING,
          },
        });
        if (promoted.count > 0) {
          this.delayedPromotedTotal += promoted.count;
          schedulerMetricsRegistry.recordDelayedPromoted(promoted.count);
        }

        let effectiveLimit = requestedLimit;

        // Optional queue-level bounded buffer ceiling:
        // counts ACTIVE + DISPATCHING + DISPATCHED (still PENDING in BullMQ) so we never
        // preload the backlog into Redis ahead of PostgreSQL scheduling decisions
        if (params.maxInFlightForQueue !== undefined) {
          const inFlightCount = await tx.job.count({
            where: {
              queueId: queue.id,
              OR: [
                { status: JobStatus.ACTIVE },
                {
                  status: JobStatus.PENDING,
                  dispatchState: {
                    in: [JobDispatchState.DISPATCHING, JobDispatchState.DISPATCHED],
                  },
                },
              ],
            },
          });
          const queueHeadroom = Math.max(0, params.maxInFlightForQueue - inFlightCount);
          if (queueHeadroom === 0) {
            return {
              queueId: queue.id,
              organisationId: queue.organisationId,
              policy: queue.schedulingPolicy,
              claimed: [],
              skippedReason: 'queue_buffer_full' as const,
            };
          }
          effectiveLimit = Math.min(effectiveLimit, queueHeadroom);
        }

        const usesDrr = isDrrPolicy(queue.schedulingPolicy);
        const enforceOrgLimit = params.enforceOrgActiveLimit ?? true;
        const needsOrgLock =
          usesDrr || (enforceOrgLimit && queue.organisation.maxActiveJobs !== null);

        // Acquire transaction-scoped PostgreSQL advisory lock per organisation whenever
        // DRR deficit state or Organisation.maxActiveJobs must be updated atomically across processes.
        if (needsOrgLock) {
          const lockKey = hashOrgLockKey(queue.organisationId);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_DISPATCH}::int4, ${lockKey}::int4)`;
        }

        // Tenant-level active + in-flight dispatch reservation cap (`Organisation.maxActiveJobs`)
        if (enforceOrgLimit && queue.organisation.maxActiveJobs !== null) {
          const orgReserved = await tx.job.count({
            where: {
              queue: { organisationId: queue.organisationId },
              OR: [
                { status: JobStatus.ACTIVE },
                {
                  status: JobStatus.PENDING,
                  dispatchState: {
                    in: [JobDispatchState.DISPATCHING, JobDispatchState.DISPATCHED],
                  },
                  queue: {
                    schedulingPolicy: { not: SchedulingPolicy.LEGACY_BULLMQ },
                  },
                },
              ],
            },
          });

          const orgHeadroom = Math.max(0, queue.organisation.maxActiveJobs - orgReserved);
          if (orgHeadroom === 0) {
            this.orgCapacityDenialsTotal += 1;
            schedulerMetricsRegistry.recordTenantCapacityDenial();
            logger.debug('Scheduler deferred claim: organisation maxActiveJobs reached', {
              policy: queue.schedulingPolicy,
              maxActiveJobs: queue.organisation.maxActiveJobs,
              orgReserved,
            });
            return {
              queueId: queue.id,
              organisationId: queue.organisationId,
              policy: queue.schedulingPolicy,
              claimed: [],
              skippedReason: 'org_active_limit_reached' as const,
            };
          }
          effectiveLimit = Math.min(effectiveLimit, orgHeadroom);
        }

        const policyConfig: SchedulingPolicyConfig = {
          schedulingPolicy: queue.schedulingPolicy,
          agingRatePerSec: queue.agingRatePerSec,
          maxEffectivePriority: queue.maxEffectivePriority,
          starvationThresholdSec: queue.starvationThresholdSec,
          deadlineUrgencyWindowSec: queue.deadlineUrgencyWindowSec,
        };

        // Re-read authoritative DRR state under the advisory lock
        let drrDeficit: number | null = null;
        let drrRoundAccumulated = false;
        if (usesDrr) {
          const freshOrg = await tx.organisation.findUnique({
            where: { id: queue.organisationId },
            select: {
              schedulingWeight: true,
              drrBaseQuantum: true,
              drrMaxDeficit: true,
              schedulingDeficit: true,
              drrLastRoundAt: true,
            },
          });
          if (freshOrg) {
            const hasEligibleInQueue = await tx.job.count({
              where: {
                queueId: queue.id,
                status: JobStatus.PENDING,
                dispatchState: JobDispatchState.QUEUED,
                isQuarantined: false,
                readyAt: { lte: now },
              },
              take: 1,
            });
            if (hasEligibleInQueue === 0) {
              // If the entire organisation has 0 eligible DRR jobs, reset idle deficit to 0
              // so idle tenants cannot hoard unbounded credit across silent periods.
              const orgEligible = await tx.job.count({
                where: {
                  queue: {
                    organisationId: queue.organisationId,
                    isPaused: false,
                    schedulingPolicy: {
                      in: [SchedulingPolicy.WEIGHTED_FAIR, SchedulingPolicy.HYBRID_FAIR_DEADLINE],
                    },
                  },
                  status: JobStatus.PENDING,
                  dispatchState: JobDispatchState.QUEUED,
                  isQuarantined: false,
                  readyAt: { lte: now },
                },
                take: 1,
              });
              if (orgEligible === 0 && freshOrg.schedulingDeficit > 0) {
                await tx.organisation.update({
                  where: { id: queue.organisationId },
                  data: {
                    schedulingDeficit: 0,
                    drrVersion: { increment: 1 },
                    drrLastRoundAt: now,
                  },
                });
              }
              return {
                queueId: queue.id,
                organisationId: queue.organisationId,
                policy: queue.schedulingPolicy,
                claimed: [],
                skippedReason: null,
              };
            }

            const minRoundIntervalMs = Math.max(0, params.drrMinRoundIntervalMs ?? 0);
            const elapsedSinceLastRoundMs =
              freshOrg.drrLastRoundAt !== null
                ? now.getTime() - freshOrg.drrLastRoundAt.getTime()
                : Number.POSITIVE_INFINITY;
            const canAccumulateInRound =
              (params.accumulateDrrRound ?? true) &&
              (minRoundIntervalMs === 0 || elapsedSinceLastRoundMs >= minRoundIntervalMs);

            if (canAccumulateInRound) {
              drrDeficit = accumulateDrrDeficit(
                freshOrg.schedulingDeficit,
                freshOrg.drrBaseQuantum,
                freshOrg.schedulingWeight,
                freshOrg.drrMaxDeficit,
              );
              drrRoundAccumulated = true;
              schedulerMetricsRegistry.recordDrrRound();
            } else {
              drrDeficit = Math.max(0, freshOrg.schedulingDeficit);
            }
          }
        }

        const claimStartedAt = Date.now();
        const lockedRows = await this.selectLockedCandidatesInTransaction(
          tx,
          queue.id,
          policyConfig,
          effectiveLimit,
          now,
        );

        // Apply DRR head-of-line cost gating if this queue uses DRR fairness
        const selectedEntries: Array<{
          row: RawClaimedJobRow;
          audit: SchedulingDecisionAudit;
          deadlineMissedAt: Date | null;
          evaluation: EvaluatedCandidate;
        }> = [];

        let currentDeficit = drrDeficit;
        let totalConsumedCost = 0;

        for (const row of lockedRows) {
          const deficitBefore = currentDeficit;
          if (usesDrr && currentDeficit !== null) {
            const consumed = consumeDrrDeficit(currentDeficit, row.scheduling_cost);
            if (!consumed.allowed) {
              // Standard DRR head-of-line rule: stop this round and retain accumulated deficit
              // so large jobs accumulate credit across rounds and never starve.
              break;
            }
            currentDeficit = consumed.nextDeficit;
            totalConsumedCost += consumed.cost;
          }

          const evaluation = evaluateCandidateScore(
            {
              id: row.id,
              priority: row.priority,
              readyAt: row.ready_at,
              virtualRankAt: row.virtual_rank_at,
              deadlineAt: row.deadline_at,
              schedulingCost: row.scheduling_cost,
            },
            policyConfig,
            now,
          );
          const dlEval = evaluateDeadlineUrgency(
            row.deadline_at,
            now,
            queue.deadlineUrgencyWindowSec,
          );
          const deadlineMissedAt = dlEval.isExpired ? (row.deadline_missed_at ?? now) : null;

          let reason = 'priority_aging';
          if (queue.schedulingPolicy === SchedulingPolicy.FIFO) reason = 'fifo_order';
          else if (queue.schedulingPolicy === SchedulingPolicy.STRICT_PRIORITY)
            reason = 'strict_priority';
          else if (evaluation.isStarvationPromoted) reason = 'starvation_promotion';
          else if (isDeadlinePolicy(queue.schedulingPolicy) && dlEval.isApproaching)
            reason = 'approaching_deadline_edf';
          else if (isDeadlinePolicy(queue.schedulingPolicy) && dlEval.isExpired)
            reason = 'expired_deadline_recovery';
          else if (usesDrr) reason = 'weighted_fair_drr';

          const audit = buildSchedulingDecisionAudit({
            policy: queue.schedulingPolicy,
            band: evaluation.band,
            reason,
            basePriority: row.priority,
            effectivePriority: evaluation.effectivePriority,
            deadlineAt: row.deadline_at,
            now,
            tenantWeight: queue.organisation.schedulingWeight,
            queueWeight: queue.schedulingWeight,
            schedulingCost: row.scheduling_cost,
            deficitBefore,
            deficitAfter: currentDeficit,
          });

          selectedEntries.push({ row, audit, deadlineMissedAt, evaluation });
        }

        // Persist atomic DRR state update only when deficit or round timestamp actually changed
        // (avoids pushing drrLastRoundAt forward when a second scheduler checks mid-round)
        if (usesDrr && currentDeficit !== null) {
          if (drrRoundAccumulated || totalConsumedCost > 0) {
            await tx.organisation.update({
              where: { id: queue.organisationId },
              data: {
                schedulingDeficit: currentDeficit,
                drrVersion: { increment: 1 },
                ...(drrRoundAccumulated ? { drrLastRoundAt: now } : {}),
              },
            });
          }
          if (totalConsumedCost > 0) {
            schedulerMetricsRegistry.recordDrrDeficitConsumed(totalConsumedCost);
          }
          if (lockedRows.length > 0 && selectedEntries.length === 0) {
            schedulerMetricsRegistry.recordDrrFairnessDenial();
            return {
              queueId: queue.id,
              organisationId: queue.organisationId,
              policy: queue.schedulingPolicy,
              claimed: [],
              skippedReason: 'drr_insufficient_deficit' as const,
            };
          }
        }

        // Atomically transition all selected locked rows from QUEUED -> DISPATCHING in a SINGLE
        // batched PostgreSQL UPDATE (eliminating N sequential round-trips under the org advisory lock).
        // Explicit WHERE guards + affected-row count assertion guarantee zero out-of-scope or
        // non-eligible transitions and atomic rollback of DRR/reservation state on any mismatch.
        if (selectedEntries.length > 0) {
          const updateRecords = JSON.stringify(
            selectedEntries.map((entry) => ({
              id: entry.row.id,
              scheduling_decision: entry.audit,
              deadline_missed_at: entry.deadlineMissedAt
                ? entry.deadlineMissedAt.toISOString()
                : null,
            })),
          );
          const updatedCount = await tx.$executeRaw`
            UPDATE jobs AS j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${params.claimerId},
                scheduling_decision = v.scheduling_decision,
                deadline_missed_at = COALESCE(v.deadline_missed_at, j.deadline_missed_at),
                updated_at = ${now}
            FROM jsonb_to_recordset(${updateRecords}::jsonb) AS v(
              id uuid,
              scheduling_decision jsonb,
              deadline_missed_at timestamptz
            )
            WHERE j.id = v.id
              AND j.queue_id = ${queue.id}::uuid
              AND j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'QUEUED'::"JobDispatchState"
              AND j.is_quarantined = false
          `;
          if (Number(updatedCount) !== selectedEntries.length) {
            throw new Error(
              `Batched scheduler claim count mismatch: expected ${selectedEntries.length}, updated ${updatedCount}`,
            );
          }
        }

        const claimLatencyMs = Math.max(0, Date.now() - claimStartedAt);

        const claimed: ClaimedScheduledJob[] = selectedEntries.map(
          ({ row, audit, deadlineMissedAt, evaluation }) => ({
            id: row.id,
            queueId: row.queue_id,
            name: row.name,
            priority: row.priority,
            payload: row.payload,
            maxRetries: row.max_retries,
            backoffMs: row.backoff_ms,
            delayMs: row.delay_ms,
            readyAt: row.ready_at,
            virtualRankAt: row.virtual_rank_at,
            schedulingCost: row.scheduling_cost,
            deadlineAt: row.deadline_at,
            deadlineMissedAt,
            schedulingDecision: audit,
            dispatchState: JobDispatchState.DISPATCHING,
            dispatchClaimedAt: now,
            dispatchClaimedBy: params.claimerId,
            evaluation,
          }),
        );

        schedulerMetricsRegistry.recordClaim(
          queue.schedulingPolicy,
          claimed.length,
          claimLatencyMs,
        );
        const starvedPromotions = claimed.filter((c) => c.evaluation.isStarvationPromoted).length;
        if (starvedPromotions > 0) {
          schedulerMetricsRegistry.recordStarvationPromotions(starvedPromotions);
        }
        for (const c of claimed) {
          if (c.deadlineAt) {
            schedulerMetricsRegistry.recordDeadlineDispatch();
            const dl = evaluateDeadlineUrgency(c.deadlineAt, now, queue.deadlineUrgencyWindowSec);
            if (dl.isExpired && dl.latenessMs !== null) {
              schedulerMetricsRegistry.recordDeadlineMiss(dl.latenessMs);
            }
          }
        }

        return {
          queueId: queue.id,
          organisationId: queue.organisationId,
          policy: queue.schedulingPolicy,
          claimed,
          skippedReason: null,
        };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * Executes index-backed `FOR UPDATE SKIP LOCKED` candidate selection within the caller's
   * transaction without modifying rows yet, so DRR head-of-line cost gating can decide which
   * locked candidates fit in the organisation's current deficit before transitioning only
   * selected rows from `QUEUED` -> `DISPATCHING`.
   */
  private async selectLockedCandidatesInTransaction(
    tx: Prisma.TransactionClient,
    queueId: string,
    config: SchedulingPolicyConfig,
    limit: number,
    now: Date,
  ): Promise<RawClaimedJobRow[]> {
    if (limit <= 0) {
      return [];
    }

    const cols = Prisma.sql`
      id, queue_id, name, priority, payload, max_retries,
      backoff_ms, delay_ms, ready_at, virtual_rank_at,
      scheduling_cost, deadline_at, deadline_missed_at,
      dispatch_state, dispatch_claimed_at, dispatch_claimed_by
    `;

    if (config.schedulingPolicy === SchedulingPolicy.FIFO) {
      return this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
          ORDER BY ready_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `,
      );
    }

    if (config.schedulingPolicy === SchedulingPolicy.STRICT_PRIORITY) {
      return this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
          ORDER BY priority DESC, ready_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `,
      );
    }

    const collected: RawClaimedJobRow[] = [];
    const collectedIds: string[] = [];
    let remaining = limit;

    const pushRows = (rows: RawClaimedJobRow[]) => {
      for (const r of rows) {
        collected.push(r);
        collectedIds.push(r.id);
      }
      remaining -= rows.length;
    };

    const excludeSql = () =>
      collectedIds.length > 0
        ? Prisma.sql`AND NOT (id = ANY(${collectedIds}::uuid[]))`
        : Prisma.empty;

    // Band 0 (all aging / DRR / deadline / hybrid policies): Hard starvation promotion
    if (config.starvationThresholdSec !== null && remaining > 0) {
      const starveCutoff = new Date(now.getTime() - config.starvationThresholdSec * 1000);
      const band0 = await this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${starveCutoff}
          ORDER BY ready_at ASC, id ASC
          LIMIT ${remaining}
          FOR UPDATE SKIP LOCKED
        `,
      );
      pushRows(band0);
    }

    // DEADLINE_AWARE: Band 1 unified strict EDF (all jobs with deadline_at IS NOT NULL ordered by deadline_at ASC)
    // Earlier absolute deadlines — including overdue ones — always precede later deadlines.
    if (config.schedulingPolicy === SchedulingPolicy.DEADLINE_AWARE && remaining > 0) {
      const band1 = await this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
            AND deadline_at IS NOT NULL
            ${excludeSql()}
          ORDER BY deadline_at ASC, priority DESC, ready_at ASC, id ASC
          LIMIT ${remaining}
          FOR UPDATE SKIP LOCKED
        `,
      );
      pushRows(band1);
    }

    // HYBRID_FAIR_DEADLINE: Band 1 approaching or overdue deadline (deadline_at <= now + urgencyWindowSec)
    // Uses jobs_sched_deadline_queued_idx and avoids dropping overdue jobs out of the urgent band.
    if (config.schedulingPolicy === SchedulingPolicy.HYBRID_FAIR_DEADLINE && remaining > 0) {
      const urgencyWindowSec = Math.max(
        5,
        config.deadlineUrgencyWindowSec ?? DRR_DEFAULTS.DEFAULT_DEADLINE_URGENCY_WINDOW_SEC,
      );
      const urgencyCutoff = new Date(now.getTime() + urgencyWindowSec * 1000);
      const band1 = await this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
            AND deadline_at IS NOT NULL
            AND deadline_at <= ${urgencyCutoff}
            ${excludeSql()}
          ORDER BY deadline_at ASC, priority DESC, ready_at ASC, id ASC
          LIMIT ${remaining}
          FOR UPDATE SKIP LOCKED
        `,
      );
      pushRows(band1);
    }

    // Clamped aging band (`virtual_rank_at <= clampCutoff`)
    if (remaining > 0) {
      const clampCutoff = computeClampCutoffAt(
        now,
        Math.max(QUEUE_LIMITS.MAX_PRIORITY, config.maxEffectivePriority),
        config.agingRatePerSec,
      );
      const noDeadlineFilter =
        config.schedulingPolicy === SchedulingPolicy.DEADLINE_AWARE
          ? Prisma.sql`AND deadline_at IS NULL`
          : Prisma.empty;
      const clampedBand = await this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
            AND virtual_rank_at <= ${clampCutoff}
            ${noDeadlineFilter}
            ${excludeSql()}
          ORDER BY ready_at ASC, id ASC
          LIMIT ${remaining}
          FOR UPDATE SKIP LOCKED
        `,
      );
      pushRows(clampedBand);
    }

    // Unclamped linear aging band (`virtual_rank_at ASC, ready_at ASC, id ASC`)
    if (remaining > 0) {
      const noDeadlineFilter =
        config.schedulingPolicy === SchedulingPolicy.DEADLINE_AWARE
          ? Prisma.sql`AND deadline_at IS NULL`
          : Prisma.empty;
      const linearBand = await this.claimBySql(
        tx,
        Prisma.sql`
          SELECT ${cols}
          FROM jobs
          WHERE queue_id = ${queueId}::uuid
            AND status = 'PENDING'::"JobStatus"
            AND dispatch_state = 'QUEUED'::"JobDispatchState"
            AND is_quarantined = false
            AND ready_at <= ${now}
            ${noDeadlineFilter}
            ${excludeSql()}
          ORDER BY virtual_rank_at ASC, ready_at ASC, id ASC
          LIMIT ${remaining}
          FOR UPDATE SKIP LOCKED
        `,
      );
      pushRows(linearBand);
    }

    return collected;
  }

  private async claimBySql(
    tx: Prisma.TransactionClient,
    query: Prisma.Sql,
  ): Promise<RawClaimedJobRow[]> {
    return tx.$queryRaw<RawClaimedJobRow[]>(query);
  }

  /**
   * Atomically marks successfully enqueued jobs as `DISPATCHED` (only if still held by `claimerId`)
   * and synchronizes their `JobDispatchOutbox` and `ScheduleExecution.dispatchedAt` records.
   */
  async markDispatched(jobIds: string[], claimerId: string): Promise<number> {
    if (jobIds.length === 0) return 0;
    const dispatchedAt = new Date();
    return db.$transaction(
      async (tx) => {
        const res = await tx.job.updateMany({
          where: {
            id: { in: jobIds },
            status: JobStatus.PENDING,
            dispatchState: JobDispatchState.DISPATCHING,
            dispatchClaimedBy: claimerId,
          },
          data: {
            dispatchState: JobDispatchState.DISPATCHED,
            dispatchClaimedAt: null,
            dispatchClaimedBy: null,
          },
        });

        await tx.jobDispatchOutbox.updateMany({
          where: {
            jobId: { in: jobIds },
            status: OutboxStatus.PENDING,
            job: { dispatchState: JobDispatchState.DISPATCHED },
          },
          data: {
            status: OutboxStatus.DISPATCHED,
            dispatchedAt,
            attempts: { increment: 1 },
            lastError: null,
          },
        });

        await tx.scheduleExecution.updateMany({
          where: {
            jobId: { in: jobIds },
            dispatchedAt: null,
            job: { dispatchState: JobDispatchState.DISPATCHED },
          },
          data: {
            dispatchedAt,
          },
        });

        return res.count;
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * Releases failed dispatch reservations back to `QUEUED` so capacity is never leaked.
   */
  async releaseReservations(jobIds: string[], claimerId: string): Promise<number> {
    if (jobIds.length === 0) return 0;
    const res = await db.job.updateMany({
      where: {
        id: { in: jobIds },
        status: JobStatus.PENDING,
        dispatchState: JobDispatchState.DISPATCHING,
        dispatchClaimedBy: claimerId,
      },
      data: {
        dispatchState: JobDispatchState.QUEUED,
        dispatchClaimedAt: null,
        dispatchClaimedBy: null,
      },
    });
    return res.count;
  }

  /**
   * Recovers stale `DISPATCHING` reservations left behind by crashed scheduler instances so
   * stale reservations can never permanently consume queue buffer or tenant `maxActiveJobs` capacity.
   *
   * Only touches `status = PENDING` + `dispatchState = DISPATCHING` rows older than `staleAfterMs`:
   * - Never steals live claims (`dispatchClaimedAt > now - staleAfterMs`).
   * - Never reverts jobs that already transitioned to `ACTIVE`, `COMPLETED`, or `FAILED` after a
   *   crash between BullMQ enqueue and DB state update.
   */
  async recoverStaleReservations(
    staleAfterMs: number = SCHEDULING_DEFAULTS.DEFAULT_RESERVATION_STALE_MS,
    now: Date = new Date(),
    queueId?: string,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - Math.max(100, staleAfterMs));
    const res = await db.job.updateMany({
      where: {
        ...(queueId ? { queueId } : {}),
        status: JobStatus.PENDING,
        dispatchState: JobDispatchState.DISPATCHING,
        dispatchClaimedAt: { lte: cutoff },
      },
      data: {
        dispatchState: JobDispatchState.QUEUED,
        dispatchClaimedAt: null,
        dispatchClaimedBy: null,
      },
    });
    if (res.count > 0) {
      this.staleRecoveriesTotal += res.count;
      schedulerMetricsRegistry.recordReservationRecovery(res.count);
      logger.warn('Recovered stale scheduler DISPATCHING reservations', {
        recoveredCount: res.count,
        staleAfterMs,
      });
    }
    return res.count;
  }

  /**
   * Decoupled orchestration helper: claims candidates from PostgreSQL and dispatches them via
   * an injected `JobDispatchAdapter` (defaulting to the production BullMQ transport adapter).
   */
  async dispatchBatchWithAdapter(
    queue: PersistedQueueDescriptor,
    params: Omit<ClaimCandidatesParams, 'queueId'>,
    adapter: JobDispatchAdapter = this.defaultAdapter,
  ): Promise<DispatchBatchSummary> {
    const claimResult = await this.claimCandidatesForQueue({
      ...params,
      queueId: queue.id,
    });

    if (claimResult.claimed.length === 0) {
      return {
        claimed: 0,
        dispatched: 0,
        released: 0,
        skippedReason: claimResult.skippedReason,
      };
    }

    this.claimsTotal += claimResult.claimed.length;

    const dispatchedIds: string[] = [];
    const failedIds: string[] = [];
    const nowMs = Date.now();
    const DISPATCH_CONCURRENCY = 8;

    for (let i = 0; i < claimResult.claimed.length; i += DISPATCH_CONCURRENCY) {
      const chunk = claimResult.claimed.slice(i, i + DISPATCH_CONCURRENCY);
      await Promise.all(
        chunk.map(async (job) => {
          try {
            const res = await adapter.dispatchClaimedJob(
              queue,
              job,
              job.evaluation.effectivePriority,
            );
            if (res.enqueued) {
              dispatchedIds.push(job.id);
              const latencyMs = Math.max(0, nowMs - job.readyAt.getTime());
              this.dispatchLatencySumMs += latencyMs;
              this.dispatchLatencyCount += 1;
              schedulerMetricsRegistry.recordDispatchSuccess(claimResult.policy, latencyMs);
            } else {
              failedIds.push(job.id);
              this.dispatchFailuresTotal += 1;
              schedulerMetricsRegistry.recordDispatchFailure(claimResult.policy);
            }
          } catch (err) {
            failedIds.push(job.id);
            this.dispatchFailuresTotal += 1;
            schedulerMetricsRegistry.recordDispatchFailure(claimResult.policy);
            logger.warn('Custom scheduler failed to dispatch claimed job to transport', {
              policy: claimResult.policy,
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    }

    const [dispatched, released] = await Promise.all([
      this.markDispatched(dispatchedIds, params.claimerId),
      this.releaseReservations(failedIds, params.claimerId),
    ]);

    if (dispatched > 0) {
      this.dispatchesTotal += dispatched;
      this.byPolicyDispatched[claimResult.policy] += dispatched;
    }

    return {
      claimed: claimResult.claimed.length,
      dispatched,
      released,
      skippedReason: null,
    };
  }

  /**
   * Runs one bounded, multi-tenant fair round-robin scheduling sweep across all active
   * non-legacy queues (`FIFO`, `STRICT_PRIORITY`, `PRIORITY_AGING`).
   *
   * - Rotates queue order on each tick so no single tenant can monopolize scheduler work.
   * - Bounds in-flight BullMQ dispatch per queue to `max(1, queue.concurrency)`.
   * - Respects `Organisation.maxActiveJobs` atomically across all queues & scheduler processes.
   * - Recovers stale `DISPATCHING` reservations before claiming.
   */
  async tickAllQueues(options?: {
    claimerId?: string;
    now?: Date;
    staleAfterMs?: number;
    maxQueuesPerTick?: number;
    organisationId?: string;
    queueId?: string;
    drrMinRoundIntervalMs?: number;
    adapter?: JobDispatchAdapter;
  }): Promise<SchedulerTickSummary> {
    const startedAt = Date.now();
    const now = options?.now ?? new Date();
    const claimerId = options?.claimerId ?? this.activeClaimerId;
    const staleAfterMs = options?.staleAfterMs ?? this.activeStaleAfterMs;
    const maxQueues = Math.max(1, options?.maxQueuesPerTick ?? 50);

    const summary: SchedulerTickSummary = {
      queuesScanned: 0,
      delayedPromoted: 0,
      staleRecovered: 0,
      claimed: 0,
      dispatched: 0,
      released: 0,
      orgCapacityDenials: 0,
      durationMs: 0,
    };

    try {
      summary.staleRecovered = await this.recoverStaleReservations(
        staleAfterMs,
        now,
        options?.queueId,
      );

      const queues = await db.queue.findMany({
        where: {
          ...(options?.queueId ? { id: options.queueId } : {}),
          ...(options?.organisationId ? { organisationId: options.organisationId } : {}),
          isPaused: false,
          schedulingPolicy: { not: SchedulingPolicy.LEGACY_BULLMQ },
        },
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
          schedulingWeight: true,
        },
        orderBy: [{ schedulingWeight: 'desc' }, { organisationId: 'asc' }, { id: 'asc' }],
      });

      if (queues.length === 0) {
        summary.durationMs = Date.now() - startedAt;
        this.lastTickDurationMs = summary.durationMs;
        return summary;
      }

      // Fair round-robin rotation across queues/organisations so no single tenant monopolizes ticks
      const offset = this.roundRobinOffset % queues.length;
      const rotated = [...queues.slice(offset), ...queues.slice(0, offset)].slice(0, maxQueues);
      this.roundRobinOffset = (this.roundRobinOffset + 1) % queues.length;

      summary.queuesScanned = rotated.length;
      const promotedBefore = this.delayedPromotedTotal;
      const accumulatedOrgIds = new Set<string>();

      for (const q of rotated) {
        const batchCap = Math.max(1, q.concurrency);
        const shouldAccumulateDrr = !accumulatedOrgIds.has(q.organisationId);
        if (isDrrPolicy(q.schedulingPolicy)) {
          accumulatedOrgIds.add(q.organisationId);
        }
        const batch = await this.dispatchBatchWithAdapter(
          q,
          {
            claimerId,
            limit: batchCap,
            maxInFlightForQueue: batchCap,
            enforceOrgActiveLimit: true,
            accumulateDrrRound: shouldAccumulateDrr,
            drrMinRoundIntervalMs: options?.drrMinRoundIntervalMs ?? this.activeIntervalMs,
            now,
          },
          options?.adapter ?? this.defaultAdapter,
        );
        summary.claimed += batch.claimed;
        summary.dispatched += batch.dispatched;
        summary.released += batch.released;
        if (batch.skippedReason === 'org_active_limit_reached') {
          summary.orgCapacityDenials += 1;
        }
      }

      summary.delayedPromoted = this.delayedPromotedTotal - promotedBefore;
      summary.durationMs = Date.now() - startedAt;
      this.lastTickDurationMs = summary.durationMs;
      schedulerMetricsRegistry.recordTickDuration(summary.durationMs);

      if (summary.dispatched > 0 || summary.released > 0 || summary.staleRecovered > 0) {
        logger.debug('Priority scheduler tick completed', {
          queuesScanned: summary.queuesScanned,
          claimed: summary.claimed,
          dispatched: summary.dispatched,
          released: summary.released,
          staleRecovered: summary.staleRecovered,
          orgCapacityDenials: summary.orgCapacityDenials,
          durationMs: summary.durationMs,
        });
      }

      return summary;
    } catch (err) {
      summary.durationMs = Date.now() - startedAt;
      this.lastTickDurationMs = summary.durationMs;
      logger.error('Priority scheduler tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return summary;
    }
  }

  /**
   * Non-blocking debounced nudge for a single custom-policy queue (e.g. immediately after
   * a worker finishes a job so the next eligible job starts with minimal latency).
   * Only fires when the scheduler loop is running.
   */
  nudgeQueue(queueId: string, delayMs: number = 10): void {
    if (!this.timer || this.nudgeTimers.has(queueId)) {
      return;
    }
    const handle = setTimeout(
      () => {
        this.nudgeTimers.delete(queueId);
        if (!this.timer) return;
        void this.tickAllQueues({ queueId, claimerId: this.activeClaimerId });
      },
      Math.max(0, delayMs),
    );
    handle.unref();
    this.nudgeTimers.set(queueId, handle);
  }

  /**
   * Starts the overlap-guarded periodic custom scheduler loop (idempotent).
   */
  start(options?: { intervalMs?: number; claimerId?: string; staleAfterMs?: number }): void {
    if (this.timer) {
      return;
    }
    this.activeIntervalMs = Math.max(50, options?.intervalMs ?? 250);
    this.activeClaimerId = options?.claimerId ?? `scheduler-${process.pid}`;
    this.activeStaleAfterMs =
      options?.staleAfterMs ?? SCHEDULING_DEFAULTS.DEFAULT_RESERVATION_STALE_MS;

    this.timer = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      void this.tickAllQueues({
        claimerId: this.activeClaimerId,
        staleAfterMs: this.activeStaleAfterMs,
      }).finally(() => {
        this.tickInFlight = false;
      });
    }, this.activeIntervalMs);
    this.timer.unref();
    schedulerMetricsRegistry.setLoopRunning(true);

    logger.info('Priority scheduler loop started', {
      claimerId: this.activeClaimerId,
      intervalMs: this.activeIntervalMs,
      staleAfterMs: this.activeStaleAfterMs,
    });
  }

  /**
   * Stops the periodic scheduler loop and clears all pending per-queue nudges.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      schedulerMetricsRegistry.setLoopRunning(false);
      logger.info('Priority scheduler loop stopped', {
        claimerId: this.activeClaimerId,
      });
    }
    for (const handle of this.nudgeTimers.values()) {
      clearTimeout(handle);
    }
    this.nudgeTimers.clear();
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const prioritySchedulerService = new PrioritySchedulerService();

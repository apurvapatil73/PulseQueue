import { SchedulingPolicy } from '@prisma/client';

/**
 * Bounded configuration constants for Deficit Round Robin (DRR) and Deadline-Aware (EDF) scheduling.
 */
export const DRR_DEFAULTS = {
  MIN_WEIGHT: 1,
  MAX_WEIGHT: 100,
  DEFAULT_WEIGHT: 1,
  MIN_BASE_QUANTUM: 1.0,
  MAX_BASE_QUANTUM: 1000.0,
  DEFAULT_BASE_QUANTUM: 10.0,
  MIN_MAX_DEFICIT: 10.0,
  MAX_MAX_DEFICIT: 10000.0,
  DEFAULT_MAX_DEFICIT: 200.0,
  MIN_JOB_COST: 1,
  MAX_JOB_COST: 100,
  DEFAULT_JOB_COST: 1,
  MIN_DEADLINE_URGENCY_WINDOW_SEC: 5,
  MAX_DEADLINE_URGENCY_WINDOW_SEC: 86_400,
  DEFAULT_DEADLINE_URGENCY_WINDOW_SEC: 60,
} as const;

export interface DeadlineUrgencyEvaluation {
  hasDeadline: boolean;
  /** True when deadlineAt is unexpired AND within `urgencyWindowSec` of `now`. */
  isApproaching: boolean;
  /** True when `now > deadlineAt` (deadline already missed). */
  isExpired: boolean;
  /** Milliseconds remaining until deadline (negative if expired), or null if no deadline. */
  remainingMs: number | null;
  /** Non-negative milliseconds past deadline if expired, else 0 (or null if no deadline). */
  latenessMs: number | null;
}

export interface SchedulingDecisionAudit {
  policy: SchedulingPolicy;
  band: number;
  reason: string;
  basePriority: number;
  effectivePriority: number;
  deadlineAt: string | null;
  deadlineRemainingMs: number | null;
  deadlineMissed: boolean;
  tenantWeight: number;
  queueWeight: number;
  schedulingCost: number;
  deficitBefore: number | null;
  deficitAfter: number | null;
  selectedAt: string;
}

export function isDrrPolicy(policy: SchedulingPolicy | undefined): boolean {
  return (
    policy === SchedulingPolicy.WEIGHTED_FAIR || policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE
  );
}

export function isDeadlinePolicy(policy: SchedulingPolicy | undefined): boolean {
  return (
    policy === SchedulingPolicy.DEADLINE_AWARE || policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE
  );
}

export function clampSchedulingCost(cost: number): number {
  return Math.max(DRR_DEFAULTS.MIN_JOB_COST, Math.min(DRR_DEFAULTS.MAX_JOB_COST, Math.round(cost)));
}

/**
 * DRR quantum formula:
 *   quantum_i = baseQuantum * weight_i
 */
export function computeDrrQuantum(baseQuantum: number, weight: number): number {
  const safeBase = Math.max(DRR_DEFAULTS.MIN_BASE_QUANTUM, baseQuantum);
  const safeWeight = Math.max(
    DRR_DEFAULTS.MIN_WEIGHT,
    Math.min(DRR_DEFAULTS.MAX_WEIGHT, Math.round(weight)),
  );
  return Math.round(safeBase * safeWeight * 1000) / 1000;
}

/**
 * DRR deficit accumulation with bounded ceiling:
 *   deficit_i = min(maxDeficit, max(0, currentDeficit) + baseQuantum * weight_i)
 *
 * Ensuring `maxDeficit >= MAX_JOB_COST (100)` guarantees large jobs can always accumulate
 * sufficient deficit across rounds and never starve indefinitely.
 */
export function accumulateDrrDeficit(
  currentDeficit: number,
  baseQuantum: number,
  weight: number,
  maxDeficit: number,
): number {
  const cap = Math.max(DRR_DEFAULTS.MAX_JOB_COST, maxDeficit);
  const quantum = computeDrrQuantum(baseQuantum, weight);
  const next = Math.min(cap, Math.max(0, currentDeficit) + quantum);
  return Math.round(next * 1000) / 1000;
}

/**
 * DRR deficit consumption check:
 * A job with cost `jobCost` is selectable iff `currentDeficit >= jobCost`.
 */
export function consumeDrrDeficit(
  currentDeficit: number,
  jobCost: number,
): { allowed: boolean; nextDeficit: number; cost: number } {
  const cost = clampSchedulingCost(jobCost);
  if (currentDeficit + 1e-9 < cost) {
    return {
      allowed: false,
      nextDeficit: Math.max(0, Math.round(currentDeficit * 1000) / 1000),
      cost,
    };
  }
  return {
    allowed: true,
    nextDeficit: Math.max(0, Math.round((currentDeficit - cost) * 1000) / 1000),
    cost,
  };
}

/**
 * Evaluates UTC deadline urgency relative to `now` and `urgencyWindowSec`.
 */
export function evaluateDeadlineUrgency(
  deadlineAt: Date | null | undefined,
  now: Date,
  urgencyWindowSec: number = DRR_DEFAULTS.DEFAULT_DEADLINE_URGENCY_WINDOW_SEC,
): DeadlineUrgencyEvaluation {
  if (!deadlineAt) {
    return {
      hasDeadline: false,
      isApproaching: false,
      isExpired: false,
      remainingMs: null,
      latenessMs: null,
    };
  }
  const remainingMs = deadlineAt.getTime() - now.getTime();
  const isExpired = remainingMs < 0;
  const windowMs = Math.max(1_000, urgencyWindowSec * 1000);
  const isApproaching = !isExpired && remainingMs <= windowMs;
  return {
    hasDeadline: true,
    isApproaching,
    isExpired,
    remainingMs,
    latenessMs: isExpired ? Math.abs(remainingMs) : 0,
  };
}

/**
 * Builds a compact, auditable explainability payload stored on `Job.schedulingDecision`
 * when a job is claimed by the scheduler.
 */
export function buildSchedulingDecisionAudit(params: {
  policy: SchedulingPolicy;
  band: number;
  reason: string;
  basePriority: number;
  effectivePriority: number;
  deadlineAt: Date | null;
  now: Date;
  tenantWeight: number;
  queueWeight: number;
  schedulingCost: number;
  deficitBefore: number | null;
  deficitAfter: number | null;
}): SchedulingDecisionAudit {
  const deadlineEval = evaluateDeadlineUrgency(params.deadlineAt, params.now);
  return {
    policy: params.policy,
    band: params.band,
    reason: params.reason,
    basePriority: params.basePriority,
    effectivePriority: Math.round(params.effectivePriority * 100) / 100,
    deadlineAt: params.deadlineAt ? params.deadlineAt.toISOString() : null,
    deadlineRemainingMs: deadlineEval.remainingMs,
    deadlineMissed: deadlineEval.isExpired,
    tenantWeight: params.tenantWeight,
    queueWeight: params.queueWeight,
    schedulingCost: params.schedulingCost,
    deficitBefore: params.deficitBefore,
    deficitAfter: params.deficitAfter,
    selectedAt: params.now.toISOString(),
  };
}

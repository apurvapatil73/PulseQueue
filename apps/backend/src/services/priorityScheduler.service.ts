import { JobDispatchState, JobStatus, Prisma, SchedulingPolicy } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { QUEUE_LIMITS } from '../validators/queue.validator.js';
import type { EnqueueResult, PersistedQueueDescriptor } from './bullmq.service.js';

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
}

export interface SchedulingCandidateInput {
  id: string;
  priority: number;
  readyAt: Date;
  virtualRankAt?: Date;
  pausedDurationMs?: number;
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
    | 'org_active_limit_reached';
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

  // PRIORITY_AGING (3-band virtual-time comparator)
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
            organisation: {
              select: {
                maxActiveJobs: true,
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

        let effectiveLimit = requestedLimit;

        // Optional queue-level bounded buffer ceiling (ACTIVE + DISPATCHING)
        if (params.maxInFlightForQueue !== undefined) {
          const inFlightCount = await tx.job.count({
            where: {
              queueId: queue.id,
              OR: [
                { status: JobStatus.ACTIVE },
                { status: JobStatus.PENDING, dispatchState: JobDispatchState.DISPATCHING },
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

        // Tenant-level active + dispatching reservation cap (`Organisation.maxActiveJobs`)
        const enforceOrgLimit = params.enforceOrgActiveLimit ?? true;
        if (enforceOrgLimit && queue.organisation.maxActiveJobs !== null) {
          const lockKey = hashOrgLockKey(queue.organisationId);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_DISPATCH}::int4, ${lockKey}::int4)`;

          const orgReserved = await tx.job.count({
            where: {
              queue: { organisationId: queue.organisationId },
              OR: [
                { status: JobStatus.ACTIVE },
                { status: JobStatus.PENDING, dispatchState: JobDispatchState.DISPATCHING },
              ],
            },
          });

          const orgHeadroom = Math.max(0, queue.organisation.maxActiveJobs - orgReserved);
          if (orgHeadroom === 0) {
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
        };

        const claimedRows = await this.claimOrderedRowsInTransaction(
          tx,
          queue.id,
          policyConfig,
          effectiveLimit,
          now,
          params.claimerId,
        );

        const claimed: ClaimedScheduledJob[] = claimedRows.map((row) => ({
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
          dispatchState: row.dispatch_state,
          dispatchClaimedAt: row.dispatch_claimed_at,
          dispatchClaimedBy: row.dispatch_claimed_by,
          evaluation: evaluateCandidateScore(
            {
              id: row.id,
              priority: row.priority,
              readyAt: row.ready_at,
              virtualRankAt: row.virtual_rank_at,
            },
            policyConfig,
            now,
          ),
        }));

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
   * Executes index-backed `FOR UPDATE SKIP LOCKED` candidate selection and transitions claimed
   * rows from `QUEUED` -> `DISPATCHING` atomically within the caller's transaction.
   *
   * For `PRIORITY_AGING`, uses exact 3-band index-backed selection:
   * - Band 0 (starvation): `ready_at <= starveCutoff` ordered by `ready_at ASC, id ASC`
   * - Band 1 (clamped at P_max): `virtual_rank_at <= clampCutoff` ordered by `ready_at ASC, id ASC`
   * - Band 2 (unclamped linear): remaining ready jobs ordered by `virtual_rank_at ASC, ready_at ASC, id ASC`
   */
  private async claimOrderedRowsInTransaction(
    tx: Prisma.TransactionClient,
    queueId: string,
    config: SchedulingPolicyConfig,
    limit: number,
    now: Date,
    claimerId: string,
  ): Promise<RawClaimedJobRow[]> {
    if (limit <= 0) {
      return [];
    }

    if (config.schedulingPolicy === SchedulingPolicy.FIFO) {
      return this.claimBySql(
        tx,
        Prisma.sql`
          WITH candidates AS (
            SELECT id
            FROM jobs
            WHERE queue_id = ${queueId}::uuid
              AND status = 'PENDING'::"JobStatus"
              AND dispatch_state = 'QUEUED'::"JobDispatchState"
              AND is_quarantined = false
              AND ready_at <= ${now}
            ORDER BY ready_at ASC, id ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          ),
          updated AS (
            UPDATE jobs j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${claimerId}
            FROM candidates c
            WHERE j.id = c.id
            RETURNING j.id, j.queue_id, j.name, j.priority, j.payload, j.max_retries,
                      j.backoff_ms, j.delay_ms, j.ready_at, j.virtual_rank_at,
                      j.dispatch_state, j.dispatch_claimed_at, j.dispatch_claimed_by
          )
          SELECT * FROM updated
          ORDER BY ready_at ASC, id ASC
        `,
      );
    }

    if (config.schedulingPolicy === SchedulingPolicy.STRICT_PRIORITY) {
      return this.claimBySql(
        tx,
        Prisma.sql`
          WITH candidates AS (
            SELECT id
            FROM jobs
            WHERE queue_id = ${queueId}::uuid
              AND status = 'PENDING'::"JobStatus"
              AND dispatch_state = 'QUEUED'::"JobDispatchState"
              AND is_quarantined = false
              AND ready_at <= ${now}
            ORDER BY priority DESC, ready_at ASC, id ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          ),
          updated AS (
            UPDATE jobs j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${claimerId}
            FROM candidates c
            WHERE j.id = c.id
            RETURNING j.id, j.queue_id, j.name, j.priority, j.payload, j.max_retries,
                      j.backoff_ms, j.delay_ms, j.ready_at, j.virtual_rank_at,
                      j.dispatch_state, j.dispatch_claimed_at, j.dispatch_claimed_by
          )
          SELECT * FROM updated
          ORDER BY priority DESC, ready_at ASC, id ASC
        `,
      );
    }

    // PRIORITY_AGING: exact 3-band index-backed selection inside the single transaction
    const collected: RawClaimedJobRow[] = [];
    let remaining = limit;

    // Band 0: Hard starvation promotion (`ready_at <= now - starvationThresholdSec`)
    if (config.starvationThresholdSec !== null && remaining > 0) {
      const starveCutoff = new Date(now.getTime() - config.starvationThresholdSec * 1000);
      const band0 = await this.claimBySql(
        tx,
        Prisma.sql`
          WITH candidates AS (
            SELECT id
            FROM jobs
            WHERE queue_id = ${queueId}::uuid
              AND status = 'PENDING'::"JobStatus"
              AND dispatch_state = 'QUEUED'::"JobDispatchState"
              AND is_quarantined = false
              AND ready_at <= ${starveCutoff}
            ORDER BY ready_at ASC, id ASC
            LIMIT ${remaining}
            FOR UPDATE SKIP LOCKED
          ),
          updated AS (
            UPDATE jobs j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${claimerId}
            FROM candidates c
            WHERE j.id = c.id
            RETURNING j.id, j.queue_id, j.name, j.priority, j.payload, j.max_retries,
                      j.backoff_ms, j.delay_ms, j.ready_at, j.virtual_rank_at,
                      j.dispatch_state, j.dispatch_claimed_at, j.dispatch_claimed_by
          )
          SELECT * FROM updated
          ORDER BY ready_at ASC, id ASC
        `,
      );
      collected.push(...band0);
      remaining -= band0.length;
    }

    // Band 1: Clamped at maxEffectivePriority (`virtual_rank_at <= clampCutoff`), ordered FIFO
    if (remaining > 0) {
      const clampCutoff = computeClampCutoffAt(
        now,
        Math.max(QUEUE_LIMITS.MAX_PRIORITY, config.maxEffectivePriority),
        config.agingRatePerSec,
      );
      const band1 = await this.claimBySql(
        tx,
        Prisma.sql`
          WITH candidates AS (
            SELECT id
            FROM jobs
            WHERE queue_id = ${queueId}::uuid
              AND status = 'PENDING'::"JobStatus"
              AND dispatch_state = 'QUEUED'::"JobDispatchState"
              AND is_quarantined = false
              AND ready_at <= ${now}
              AND virtual_rank_at <= ${clampCutoff}
            ORDER BY ready_at ASC, id ASC
            LIMIT ${remaining}
            FOR UPDATE SKIP LOCKED
          ),
          updated AS (
            UPDATE jobs j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${claimerId}
            FROM candidates c
            WHERE j.id = c.id
            RETURNING j.id, j.queue_id, j.name, j.priority, j.payload, j.max_retries,
                      j.backoff_ms, j.delay_ms, j.ready_at, j.virtual_rank_at,
                      j.dispatch_state, j.dispatch_claimed_at, j.dispatch_claimed_by
          )
          SELECT * FROM updated
          ORDER BY ready_at ASC, id ASC
        `,
      );
      collected.push(...band1);
      remaining -= band1.length;
    }

    // Band 2: Unclamped linear aging (`virtual_rank_at ASC, ready_at ASC, id ASC`)
    if (remaining > 0) {
      const band2 = await this.claimBySql(
        tx,
        Prisma.sql`
          WITH candidates AS (
            SELECT id
            FROM jobs
            WHERE queue_id = ${queueId}::uuid
              AND status = 'PENDING'::"JobStatus"
              AND dispatch_state = 'QUEUED'::"JobDispatchState"
              AND is_quarantined = false
              AND ready_at <= ${now}
            ORDER BY virtual_rank_at ASC, ready_at ASC, id ASC
            LIMIT ${remaining}
            FOR UPDATE SKIP LOCKED
          ),
          updated AS (
            UPDATE jobs j
            SET dispatch_state = 'DISPATCHING'::"JobDispatchState",
                dispatch_claimed_at = ${now},
                dispatch_claimed_by = ${claimerId}
            FROM candidates c
            WHERE j.id = c.id
            RETURNING j.id, j.queue_id, j.name, j.priority, j.payload, j.max_retries,
                      j.backoff_ms, j.delay_ms, j.ready_at, j.virtual_rank_at,
                      j.dispatch_state, j.dispatch_claimed_at, j.dispatch_claimed_by
          )
          SELECT * FROM updated
          ORDER BY virtual_rank_at ASC, ready_at ASC, id ASC
        `,
      );
      collected.push(...band2);
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
   * Marks successfully dispatched jobs as `DISPATCHED` only if still held by `claimerId`.
   */
  async markDispatched(jobIds: string[], claimerId: string): Promise<number> {
    if (jobIds.length === 0) return 0;
    const res = await db.job.updateMany({
      where: {
        id: { in: jobIds },
        dispatchState: JobDispatchState.DISPATCHING,
        dispatchClaimedBy: claimerId,
      },
      data: {
        dispatchState: JobDispatchState.DISPATCHED,
        dispatchClaimedAt: null,
        dispatchClaimedBy: null,
      },
    });
    return res.count;
  }

  /**
   * Releases failed dispatch reservations back to `QUEUED` so capacity is never leaked.
   */
  async releaseReservations(jobIds: string[], claimerId: string): Promise<number> {
    if (jobIds.length === 0) return 0;
    const res = await db.job.updateMany({
      where: {
        id: { in: jobIds },
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
        dispatchState: JobDispatchState.DISPATCHING,
        dispatchClaimedAt: { lte: cutoff },
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
   * Decoupled orchestration helper: claims candidates from PostgreSQL and dispatches them via
   * an injected `JobDispatchAdapter` (e.g., BullMQ in Milestone 8.3.2 or a mock adapter in tests).
   */
  async dispatchBatchWithAdapter(
    queue: PersistedQueueDescriptor,
    params: Omit<ClaimCandidatesParams, 'queueId'>,
    adapter: JobDispatchAdapter,
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

    const dispatchedIds: string[] = [];
    const failedIds: string[] = [];

    for (const job of claimResult.claimed) {
      try {
        const res = await adapter.dispatchClaimedJob(queue, job, job.evaluation.effectivePriority);
        if (res.enqueued) {
          dispatchedIds.push(job.id);
        } else {
          failedIds.push(job.id);
        }
      } catch {
        failedIds.push(job.id);
      }
    }

    const [dispatched, released] = await Promise.all([
      this.markDispatched(dispatchedIds, params.claimerId),
      this.releaseReservations(failedIds, params.claimerId),
    ]);

    return {
      claimed: claimResult.claimed.length,
      dispatched,
      released,
      skippedReason: null,
    };
  }
}

export const prioritySchedulerService = new PrioritySchedulerService();

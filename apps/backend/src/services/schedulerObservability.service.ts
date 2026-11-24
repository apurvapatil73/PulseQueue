import { JobDispatchState, JobStatus, SchedulingPolicy, WorkerHealthStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { MIN_PERCENTILE_SAMPLES } from './metrics.service.js';
import { SCHEDULING_DEFAULTS, prioritySchedulerService } from './priorityScheduler.service.js';
import {
  PRIORITY_TIERS,
  SCHEDULING_POLICIES,
  schedulerMetricsRegistry,
  type PriorityTier,
} from './schedulerMetrics.service.js';
import { workerHealthService } from './workerHealth.service.js';

export interface PriorityTierWaitStats {
  tier: PriorityTier;
  sampleCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface OrganisationSchedulerMetricsView {
  organisationId: string;
  windowMinutes: number;
  generatedAt: string;
  policyDistribution: Array<{
    policy: SchedulingPolicy;
    queueCount: number;
    eligibleQueuedJobs: number;
    delayedJobs: number;
  }>;
  backlog: {
    eligibleQueued: number;
    dispatching: number;
    dispatchedPending: number;
    delayed: number;
    paused: number;
    oldestEligibleAgeMs: number | null;
    maxWaitingMs: number | null;
    starvedEligibleCount: number;
    staleReservationsActive: number;
  };
  backlogByPriority: {
    byTier: Record<PriorityTier, number>;
    byPriority: Array<{ priority: number; count: number }>;
  };
  waitTimeByPriorityTier: PriorityTierWaitStats[];
  dispatchLatency: {
    sampleCount: number;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
  tenantCapacity: {
    maxActiveJobs: number | null;
    activeJobs: number;
    dispatchedPendingJobs: number;
    dispatchingJobs: number;
    reservedTotal: number;
    availableCapacity: number | null;
    utilizationPercent: number | null;
  };
  workerCapacity: {
    onlineWorkers: number;
    configuredConcurrency: number;
    activeJobs: number;
    availableWorkerCapacity: number;
    workerUtilizationPercent: number | null;
    jobsPerSecond: number;
    avgExecutionDurationMs: number | null;
  };
  schedulerHealth: {
    status: 'healthy' | 'degraded' | 'idle';
    isLoopRunning: boolean;
    lastTickDurationMs: number | null;
    staleReservationsActive: number;
    processCounters: {
      claimsTotal: number;
      dispatchesTotal: number;
      dispatchFailuresTotal: number;
      dispatchRetriesTotal: number;
      starvationPromotionsTotal: number;
      priorityInversionsTotal: number;
      reservationRecoveriesTotal: number;
      tenantCapacityDenialsTotal: number;
      drrRoundsTotal: number;
      drrDeficitConsumedTotal: number;
      drrFairnessDenialsTotal: number;
      deadlineAwareDispatchesTotal: number;
      deadlineMissesTotal: number;
    };
  };
  fairness: {
    schedulingWeight: number;
    drrBaseQuantum: number;
    drrMaxDeficit: number;
    schedulingDeficit: number;
    drrVersion: number;
    drrLastRoundAt: string | null;
  };
  deadlines: {
    withDeadlinePending: number;
    approachingDeadlineCount: number;
    missedInWindow: number;
    avgLatenessMs: number | null;
    p95LatenessMs: number | null;
  };
}

function roundMs(val: number | null | undefined): number | null {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  return Math.round(Math.max(0, val) * 100) / 100;
}

export class SchedulerObservabilityService {
  /**
   * Computes strictly organisation-scoped scheduler observability metrics using indexed
   * PostgreSQL aggregations (no full-table scans, zero cross-tenant leakage).
   */
  async getOrganisationSchedulerMetrics(
    orgId: string,
    windowMinutes: number = 60,
  ): Promise<OrganisationSchedulerMetricsView> {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        maxActiveJobs: true,
        schedulingWeight: true,
        drrBaseQuantum: true,
        drrMaxDeficit: true,
        schedulingDeficit: true,
        drrVersion: true,
        drrLastRoundAt: true,
      },
    });

    if (!org) {
      throw new NotFoundError('Organisation not found');
    }

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);
    const staleCutoff = new Date(now.getTime() - SCHEDULING_DEFAULTS.DEFAULT_RESERVATION_STALE_MS);

    const [
      queues,
      backlogRows,
      priorityRows,
      waitTierRows,
      dispatchLatencyRows,
      throughputRows,
      deadlineRows,
      workers,
    ] = await Promise.all([
      db.queue.findMany({
        where: { organisationId: orgId },
        select: {
          id: true,
          schedulingPolicy: true,
          isPaused: true,
          concurrency: true,
          starvationThresholdSec: true,
        },
      }),
      db.$queryRaw<
        Array<{
          scheduling_policy: SchedulingPolicy;
          eligible_queued: bigint;
          dispatching: bigint;
          dispatched_pending: bigint;
          active_jobs: bigint;
          delayed_jobs: bigint;
          paused_jobs: bigint;
          starved_eligible: bigint;
          stale_dispatching: bigint;
          oldest_eligible_ready_at: Date | null;
        }>
      >`
        SELECT
          q.scheduling_policy,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'QUEUED'::"JobDispatchState"
              AND j.is_quarantined = false
              AND j.ready_at <= ${now}
          ) AS eligible_queued,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'DISPATCHING'::"JobDispatchState"
          ) AS dispatching,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'DISPATCHED'::"JobDispatchState"
          ) AS dispatched_pending,
          COUNT(*) FILTER (WHERE j.status = 'ACTIVE'::"JobStatus") AS active_jobs,
          COUNT(*) FILTER (WHERE j.status = 'DELAYED'::"JobStatus") AS delayed_jobs,
          COUNT(*) FILTER (WHERE j.status = 'PAUSED'::"JobStatus") AS paused_jobs,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'QUEUED'::"JobDispatchState"
              AND j.is_quarantined = false
              AND q.starvation_threshold_sec IS NOT NULL
              AND j.ready_at <= (${now}::timestamp - (q.starvation_threshold_sec * INTERVAL '1 second'))
          ) AS starved_eligible,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'DISPATCHING'::"JobDispatchState"
              AND j.dispatch_claimed_at <= ${staleCutoff}
          ) AS stale_dispatching,
          MIN(j.ready_at) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.dispatch_state = 'QUEUED'::"JobDispatchState"
              AND j.is_quarantined = false
              AND j.ready_at <= ${now}
          ) AS oldest_eligible_ready_at
        FROM queues q
        LEFT JOIN jobs j ON j.queue_id = q.id
          AND j.status IN ('PENDING'::"JobStatus", 'ACTIVE'::"JobStatus", 'DELAYED'::"JobStatus", 'PAUSED'::"JobStatus")
        WHERE q.organisation_id = ${orgId}::uuid
        GROUP BY q.scheduling_policy
      `,
      db.$queryRaw<Array<{ priority: number; cnt: bigint }>>`
        SELECT j.priority, COUNT(*) AS cnt
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          AND j.status = 'PENDING'::"JobStatus"
          AND j.is_quarantined = false
        GROUP BY j.priority
        ORDER BY j.priority DESC
      `,
      db.$queryRaw<
        Array<{
          tier: PriorityTier;
          sample_count: bigint;
          avg_ms: number | null;
          p50_ms: number | null;
          p95_ms: number | null;
          p99_ms: number | null;
          max_ms: number | null;
        }>
      >`
        SELECT
          CASE
            WHEN j.priority >= 16 THEN 'critical'
            WHEN j.priority >= 11 THEN 'high'
            WHEN j.priority >= 6 THEN 'medium'
            ELSE 'low'
          END AS tier,
          COUNT(*) AS sample_count,
          AVG(GREATEST(0, EXTRACT(EPOCH FROM (j.first_started_at - j.ready_at)) * 1000)) AS avg_ms,
          PERCENTILE_CONT(0.50) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (j.first_started_at - j.ready_at)) * 1000)
          ) AS p50_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (j.first_started_at - j.ready_at)) * 1000)
          ) AS p95_ms,
          PERCENTILE_CONT(0.99) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (j.first_started_at - j.ready_at)) * 1000)
          ) AS p99_ms,
          MAX(GREATEST(0, EXTRACT(EPOCH FROM (j.first_started_at - j.ready_at)) * 1000)) AS max_ms
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          AND j.first_started_at IS NOT NULL
          AND j.first_started_at >= ${windowStart}
        GROUP BY tier
      `,
      db.$queryRaw<
        Array<{
          sample_count: bigint;
          avg_ms: number | null;
          p50_ms: number | null;
          p95_ms: number | null;
          p99_ms: number | null;
        }>
      >`
        SELECT
          COUNT(*) AS sample_count,
          AVG(GREATEST(0, EXTRACT(EPOCH FROM (o.dispatched_at - j.ready_at)) * 1000)) AS avg_ms,
          PERCENTILE_CONT(0.50) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (o.dispatched_at - j.ready_at)) * 1000)
          ) AS p50_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (o.dispatched_at - j.ready_at)) * 1000)
          ) AS p95_ms,
          PERCENTILE_CONT(0.99) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (o.dispatched_at - j.ready_at)) * 1000)
          ) AS p99_ms
        FROM job_dispatch_outbox o
        INNER JOIN jobs j ON j.id = o.job_id
        WHERE o.organisation_id = ${orgId}::uuid
          AND o.dispatched_at IS NOT NULL
          AND o.dispatched_at >= ${windowStart}
      `,
      db.$queryRaw<
        Array<{
          processed_count: bigint;
          avg_duration_ms: number | null;
        }>
      >`
        SELECT
          COUNT(*) AS processed_count,
          AVG(j.duration_ms) AS avg_duration_ms
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          AND (
            (j.status = 'COMPLETED'::"JobStatus" AND j.completed_at >= ${windowStart})
            OR (j.status = 'FAILED'::"JobStatus" AND j.failed_at >= ${windowStart})
          )
      `,
      db.$queryRaw<
        Array<{
          with_deadline_pending: bigint;
          approaching_deadline: bigint;
          missed_in_window: bigint;
          avg_lateness_ms: number | null;
          p95_lateness_ms: number | null;
        }>
      >`
        SELECT
          COUNT(*) FILTER (
            WHERE j.status IN ('PENDING'::"JobStatus", 'DELAYED'::"JobStatus")
              AND j.is_quarantined = false
              AND j.deadline_at IS NOT NULL
          ) AS with_deadline_pending,
          COUNT(*) FILTER (
            WHERE j.status = 'PENDING'::"JobStatus"
              AND j.is_quarantined = false
              AND j.deadline_at IS NOT NULL
              AND j.deadline_at >= ${now}
              AND j.deadline_at <= (${now}::timestamp + (q.deadline_urgency_window_sec * INTERVAL '1 second'))
          ) AS approaching_deadline,
          COUNT(*) FILTER (
            WHERE j.deadline_missed_at IS NOT NULL
              AND j.deadline_missed_at >= ${windowStart}
          ) AS missed_in_window,
          AVG(GREATEST(0, EXTRACT(EPOCH FROM (j.deadline_missed_at - j.deadline_at)) * 1000)) FILTER (
            WHERE j.deadline_missed_at IS NOT NULL
              AND j.deadline_at IS NOT NULL
              AND j.deadline_missed_at >= ${windowStart}
          ) AS avg_lateness_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (j.deadline_missed_at - j.deadline_at)) * 1000)
          ) FILTER (
            WHERE j.deadline_missed_at IS NOT NULL
              AND j.deadline_at IS NOT NULL
              AND j.deadline_missed_at >= ${windowStart}
          ) AS p95_lateness_ms
        FROM jobs j
        INNER JOIN queues q ON q.id = j.queue_id
        WHERE q.organisation_id = ${orgId}::uuid
          AND j.deadline_at IS NOT NULL
      `,
      workerHealthService.listWorkersForOrganisation(orgId),
    ]);

    // Policy distribution
    const queueCountByPolicy = new Map<SchedulingPolicy, number>();
    for (const q of queues) {
      queueCountByPolicy.set(
        q.schedulingPolicy,
        (queueCountByPolicy.get(q.schedulingPolicy) ?? 0) + 1,
      );
    }
    const backlogByPolicyMap = new Map(backlogRows.map((r) => [r.scheduling_policy, r]));

    let eligibleQueued = 0;
    let dispatching = 0;
    let dispatchedPending = 0;
    let customDispatchedPending = 0;
    let activeJobs = 0;
    let delayed = 0;
    let paused = 0;
    let starvedEligibleCount = 0;
    let staleReservationsActive = 0;
    let oldestEligibleReadyAt: Date | null = null;

    const policyDistribution = SCHEDULING_POLICIES.map((policy) => {
      const row = backlogByPolicyMap.get(policy);
      const eq = Number(row?.eligible_queued ?? 0n);
      const disp = Number(row?.dispatching ?? 0n);
      const dp = Number(row?.dispatched_pending ?? 0n);
      const act = Number(row?.active_jobs ?? 0n);
      const del = Number(row?.delayed_jobs ?? 0n);
      const pau = Number(row?.paused_jobs ?? 0n);
      const stv = Number(row?.starved_eligible ?? 0n);
      const stl = Number(row?.stale_dispatching ?? 0n);

      eligibleQueued += eq;
      dispatching += disp;
      dispatchedPending += dp;
      if (policy !== SchedulingPolicy.LEGACY_BULLMQ) {
        customDispatchedPending += dp;
      }
      activeJobs += act;
      delayed += del;
      paused += pau;
      starvedEligibleCount += stv;
      staleReservationsActive += stl;

      if (row?.oldest_eligible_ready_at) {
        if (
          !oldestEligibleReadyAt ||
          row.oldest_eligible_ready_at.getTime() < oldestEligibleReadyAt.getTime()
        ) {
          oldestEligibleReadyAt = row.oldest_eligible_ready_at;
        }
      }

      return {
        policy,
        queueCount: queueCountByPolicy.get(policy) ?? 0,
        eligibleQueuedJobs: eq,
        delayedJobs: del,
      };
    });

    const oldestEligibleAgeMs = oldestEligibleReadyAt
      ? Math.max(0, now.getTime() - (oldestEligibleReadyAt as Date).getTime())
      : null;

    // Backlog by priority tier & exact priority
    const byTier: Record<PriorityTier, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    const byPriority = priorityRows.map((r) => {
      const count = Number(r.cnt);
      if (r.priority >= 16) byTier.critical += count;
      else if (r.priority >= 11) byTier.high += count;
      else if (r.priority >= 6) byTier.medium += count;
      else byTier.low += count;
      return { priority: r.priority, count };
    });

    // Wait time by priority tier
    const tierMap = new Map(waitTierRows.map((r) => [r.tier, r]));
    let maxWaitingMs: number | null = oldestEligibleAgeMs;
    const waitTimeByPriorityTier: PriorityTierWaitStats[] = PRIORITY_TIERS.map((tier) => {
      const r = tierMap.get(tier);
      const sampleCount = Number(r?.sample_count ?? 0n);
      const tierMax = roundMs(r?.max_ms);
      if (tierMax !== null && (maxWaitingMs === null || tierMax > maxWaitingMs)) {
        maxWaitingMs = tierMax;
      }
      const hasPercentiles = sampleCount >= MIN_PERCENTILE_SAMPLES;
      return {
        tier,
        sampleCount,
        avgMs: roundMs(r?.avg_ms),
        p50Ms: hasPercentiles ? roundMs(r?.p50_ms) : null,
        p95Ms: hasPercentiles ? roundMs(r?.p95_ms) : null,
        p99Ms: hasPercentiles ? roundMs(r?.p99_ms) : null,
        maxMs: tierMax,
      };
    });

    // Dispatch latency
    const dlRow = dispatchLatencyRows[0];
    const dlSamples = Number(dlRow?.sample_count ?? 0n);
    const dlHasPercentiles = dlSamples >= MIN_PERCENTILE_SAMPLES;
    const dispatchLatency = {
      sampleCount: dlSamples,
      avgMs: roundMs(dlRow?.avg_ms),
      p50Ms: dlHasPercentiles ? roundMs(dlRow?.p50_ms) : null,
      p95Ms: dlHasPercentiles ? roundMs(dlRow?.p95_ms) : null,
      p99Ms: dlHasPercentiles ? roundMs(dlRow?.p99_ms) : null,
    };

    // Tenant capacity
    const reservedTotal = activeJobs + dispatching + customDispatchedPending;
    const availableCapacity =
      org.maxActiveJobs !== null ? Math.max(0, org.maxActiveJobs - reservedTotal) : null;
    const utilizationPercent =
      org.maxActiveJobs !== null && org.maxActiveJobs > 0
        ? Math.min(100, Math.round((reservedTotal / org.maxActiveJobs) * 1000) / 10)
        : null;

    // Worker capacity
    const onlineWorkers = workers.filter(
      (w) => w.status === WorkerHealthStatus.ONLINE || w.status === WorkerHealthStatus.DEGRADED,
    );
    const configuredConcurrency = onlineWorkers.reduce(
      (sum, w) => sum + (w.orgConfiguredConcurrency ?? 0),
      0,
    );
    const availableWorkerCapacity = Math.max(0, configuredConcurrency - activeJobs);
    const workerUtilizationPercent =
      configuredConcurrency > 0
        ? Math.min(100, Math.round((activeJobs / configuredConcurrency) * 1000) / 10)
        : null;

    const processedCount = Number(throughputRows[0]?.processed_count ?? 0n);
    const jobsPerSecond =
      windowMinutes > 0 ? Math.round((processedCount / (windowMinutes * 60)) * 1000) / 1000 : 0;
    const avgExecutionDurationMs = roundMs(throughputRows[0]?.avg_duration_ms);

    // Process-level scheduler health (strictly privacy-safe aggregates)
    const globalSnap = schedulerMetricsRegistry.getGlobalSnapshot();
    const isLoopRunning = prioritySchedulerService.isRunning();
    const healthStatus: 'healthy' | 'degraded' | 'idle' =
      staleReservationsActive > 0 || starvedEligibleCount > 0
        ? 'degraded'
        : isLoopRunning || eligibleQueued > 0
          ? 'healthy'
          : 'idle';

    return {
      organisationId: orgId,
      windowMinutes,
      generatedAt: now.toISOString(),
      policyDistribution,
      backlog: {
        eligibleQueued,
        dispatching,
        dispatchedPending,
        delayed,
        paused,
        oldestEligibleAgeMs,
        maxWaitingMs,
        starvedEligibleCount,
        staleReservationsActive,
      },
      backlogByPriority: {
        byTier,
        byPriority,
      },
      waitTimeByPriorityTier,
      dispatchLatency,
      tenantCapacity: {
        maxActiveJobs: org.maxActiveJobs,
        activeJobs,
        dispatchedPendingJobs: customDispatchedPending,
        dispatchingJobs: dispatching,
        reservedTotal,
        availableCapacity,
        utilizationPercent,
      },
      workerCapacity: {
        onlineWorkers: onlineWorkers.length,
        configuredConcurrency,
        activeJobs,
        availableWorkerCapacity,
        workerUtilizationPercent,
        jobsPerSecond,
        avgExecutionDurationMs,
      },
      schedulerHealth: {
        status: healthStatus,
        isLoopRunning,
        lastTickDurationMs: globalSnap.gauges.lastTickDurationMs,
        staleReservationsActive,
        processCounters: {
          claimsTotal: globalSnap.counters.claimsTotal,
          dispatchesTotal: globalSnap.counters.dispatchesTotal,
          dispatchFailuresTotal: globalSnap.counters.dispatchFailuresTotal,
          dispatchRetriesTotal: globalSnap.counters.dispatchRetriesTotal,
          starvationPromotionsTotal: globalSnap.counters.starvationPromotionsTotal,
          priorityInversionsTotal: globalSnap.counters.priorityInversionsTotal,
          reservationRecoveriesTotal: globalSnap.counters.reservationRecoveriesTotal,
          tenantCapacityDenialsTotal: globalSnap.counters.tenantCapacityDenialsTotal,
          drrRoundsTotal: globalSnap.counters.drrRoundsTotal,
          drrDeficitConsumedTotal: globalSnap.counters.drrDeficitConsumedTotal,
          drrFairnessDenialsTotal: globalSnap.counters.drrFairnessDenialsTotal,
          deadlineAwareDispatchesTotal: globalSnap.counters.deadlineAwareDispatchesTotal,
          deadlineMissesTotal: globalSnap.counters.deadlineMissesTotal,
        },
      },
      fairness: {
        schedulingWeight: org.schedulingWeight,
        drrBaseQuantum: org.drrBaseQuantum,
        drrMaxDeficit: org.drrMaxDeficit,
        schedulingDeficit: Math.round(org.schedulingDeficit * 1000) / 1000,
        drrVersion: org.drrVersion,
        drrLastRoundAt: org.drrLastRoundAt ? org.drrLastRoundAt.toISOString() : null,
      },
      deadlines: {
        withDeadlinePending: Number(deadlineRows[0]?.with_deadline_pending ?? 0n),
        approachingDeadlineCount: Number(deadlineRows[0]?.approaching_deadline ?? 0n),
        missedInWindow: Number(deadlineRows[0]?.missed_in_window ?? 0n),
        avgLatenessMs: roundMs(deadlineRows[0]?.avg_lateness_ms),
        p95LatenessMs:
          Number(deadlineRows[0]?.missed_in_window ?? 0n) >= MIN_PERCENTILE_SAMPLES
            ? roundMs(deadlineRows[0]?.p95_lateness_ms)
            : null,
      },
    };
  }
}

// Re-export enum references used in query filters for convenience
export { JobDispatchState, JobStatus };
export const schedulerObservabilityService = new SchedulerObservabilityService();

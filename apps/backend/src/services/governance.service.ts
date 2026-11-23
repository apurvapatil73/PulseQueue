import crypto from 'node:crypto';
import { JobStatus, PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { NotFoundError, TooManyRequestsError } from '../utils/errors.js';
import type { UpdateOrgQuotasInput } from '../validators/governance.validator.js';

const LOCK_NS_ADMISSION = 82001;
const LOCK_NS_RETRY_BUDGET = 82002;

function hashOrgLockKey(orgId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < orgId.length; i += 1) {
    hash ^= orgId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

/**
 * Computes a deterministic, normalized failure signature for poison-job detection.
 * Strips UUIDs, ISO timestamps, and volatile numeric IDs so repeated identical error
 * classes hash to the same 16-character hex signature.
 */
export function computeFailureSignature(jobName: string, errorMessage: string): string {
  const normalized = errorMessage
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, '<ts>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  return crypto
    .createHash('sha256')
    .update(`${jobName.toLowerCase()}:${normalized}`)
    .digest('hex')
    .slice(0, 16);
}

export interface PoisonClassificationInput {
  jobName: string;
  errorMessage: string;
  isNonRetryable: boolean;
  previousSignature: string | null;
  previousConsecutiveSameFailures: number;
  poisonFailureThreshold: number;
  stalledCount: number;
}

export interface PoisonClassificationResult {
  isPoison: boolean;
  quarantineReason: string | null;
  failureSignature: string;
  consecutiveSameFailures: number;
}

/**
 * Deterministic poison-job classifier.
 * Never quarantines a job for a single transient error.
 */
export function classifyPoisonJob(input: PoisonClassificationInput): PoisonClassificationResult {
  const failureSignature = computeFailureSignature(input.jobName, input.errorMessage);
  const consecutiveSameFailures =
    input.previousSignature === failureSignature ? input.previousConsecutiveSameFailures + 1 : 1;

  if (input.isNonRetryable) {
    return {
      isPoison: true,
      quarantineReason: 'Deterministic non-retryable processor or payload error',
      failureSignature,
      consecutiveSameFailures,
    };
  }

  const threshold = Math.max(2, input.poisonFailureThreshold);
  if (consecutiveSameFailures >= threshold) {
    return {
      isPoison: true,
      quarantineReason: `Repeated identical failure signature (${consecutiveSameFailures} consecutive times, signature=${failureSignature})`,
      failureSignature,
      consecutiveSameFailures,
    };
  }

  if (input.stalledCount >= 3) {
    return {
      isPoison: true,
      quarantineReason: `Repeated stalled executions (${input.stalledCount} recoveries)`,
      failureSignature,
      consecutiveSameFailures,
    };
  }

  return {
    isPoison: false,
    quarantineReason: null,
    failureSignature,
    consecutiveSameFailures,
  };
}

export interface AdmissionRejectionDetails {
  reason:
    | 'ORG_MAX_PAYLOAD_BYTES'
    | 'ORG_MAX_OUTSTANDING_JOBS'
    | 'ORG_MAX_QUEUED_JOBS'
    | 'ORG_MAX_DELAYED_JOBS'
    | 'ORG_MAX_ACTIVE_JOBS'
    | 'QUEUE_BACKPRESSURE_DEPTH'
    | 'QUEUE_BACKPRESSURE_AGE';
  scope: 'organisation' | 'queue';
  limit: number;
  current: number;
  queueId?: string;
  queueName?: string;
  retryAfterSeconds: number;
}

export interface RetryBudgetCheckResult {
  allowed: boolean;
  scope?: 'organisation' | 'queue';
  used?: number;
  limit?: number;
  windowSeconds?: number;
  reason?: string;
}

export interface OrganisationGovernanceView {
  organisationId: string;
  quotas: {
    maxOutstandingJobs: number | null;
    maxActiveJobs: number | null;
    maxQueuedJobs: number | null;
    maxDelayedJobs: number | null;
    maxPayloadBytes: number | null;
    retryBudgetMaxRetries: number | null;
    retryBudgetWindowSeconds: number;
  };
  usage: {
    outstandingJobs: number;
    activeJobs: number;
    queuedJobs: number;
    delayedJobs: number;
    utilizationPercent: {
      outstanding: number | null;
      active: number | null;
      queued: number | null;
      delayed: number | null;
    };
  };
  retryBudget: {
    windowSeconds: number;
    usedInWindow: number;
    limit: number | null;
    exhausted: boolean;
    exhaustedEventsInWindow: number;
  };
  backpressure: {
    admissionRejectionsInWindow: number;
    queues: Array<{
      queueId: string;
      queueName: string;
      depth: number;
      maxQueueDepth: number | null;
      oldestPendingAgeMs: number | null;
      backpressureMaxAgeMs: number | null;
      status: 'NORMAL' | 'DEGRADED' | 'REJECTING';
      retryBudgetLimit: number | null;
      retryBudgetWindowSeconds: number;
      retriesInWindow: number;
      poisonFailureThreshold: number;
    }>;
  };
  quarantine: {
    openQuarantinedCount: number;
    totalQuarantinedJobs: number;
    recentReasons: Array<{
      dlqId: string;
      jobId: string;
      jobName: string;
      queueName: string;
      quarantineReason: string | null;
      failureSignature: string | null;
      failedAt: Date;
    }>;
  };
}

function pct(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.round((used / limit) * 10_000) / 100;
}

export class GovernanceService {
  /**
   * Enforces organisation quotas and queue-level backpressure atomically inside the
   * caller's PostgreSQL transaction. Uses a transaction-scoped advisory lock per
   * organisation ONLY when at least one quota or backpressure limit is configured.
   */
  async enforceAdmissionInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      orgId: string;
      queue: {
        id: string;
        name: string;
        maxQueueDepth: number | null;
        backpressureMaxAgeMs: number | null;
      };
      payload: unknown;
      initialStatus: JobStatus;
    },
  ): Promise<void> {
    const org = await tx.organisation.findUnique({
      where: { id: params.orgId },
      select: {
        maxOutstandingJobs: true,
        maxQueuedJobs: true,
        maxDelayedJobs: true,
        maxPayloadBytes: true,
      },
    });

    if (!org) {
      throw new NotFoundError('Organisation not found');
    }

    // Fast path: if no admission-time quotas or backpressure limits are configured, incur zero lock/count overhead.
    // Note: maxActiveJobs is a worker-side execution concurrency limit (exposed in governance overview
    // and reserved for scheduler-level worker enforcement) and must not reject valid queued submissions.
    const hasOrgQuota =
      org.maxOutstandingJobs !== null ||
      org.maxQueuedJobs !== null ||
      org.maxDelayedJobs !== null ||
      org.maxPayloadBytes !== null;
    const hasQueueBackpressure =
      params.queue.maxQueueDepth !== null || params.queue.backpressureMaxAgeMs !== null;

    if (!hasOrgQuota && !hasQueueBackpressure) {
      return;
    }

    // 1. Payload size check (no lock needed)
    if (org.maxPayloadBytes !== null) {
      const payloadBytes = Buffer.byteLength(JSON.stringify(params.payload ?? {}), 'utf8');
      if (payloadBytes > org.maxPayloadBytes) {
        const details: AdmissionRejectionDetails = {
          reason: 'ORG_MAX_PAYLOAD_BYTES',
          scope: 'organisation',
          limit: org.maxPayloadBytes,
          current: payloadBytes,
          queueId: params.queue.id,
          queueName: params.queue.name,
          retryAfterSeconds: 0,
        };
        throw new TooManyRequestsError(
          `Job payload size (${payloadBytes} bytes) exceeds organisation quota (${org.maxPayloadBytes} bytes)`,
          details,
        );
      }
    }

    const needsCountLock =
      org.maxOutstandingJobs !== null ||
      org.maxQueuedJobs !== null ||
      org.maxDelayedJobs !== null ||
      hasQueueBackpressure;

    if (!needsCountLock) {
      return;
    }

    // Serialize admission decisions per organisation to prevent concurrent race on last quota slot
    const lockKey = hashOrgLockKey(params.orgId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_ADMISSION}::int4, ${lockKey}::int4)`;

    // 2. Organisation-level admission quotas (outstanding, queued, delayed)
    if (
      org.maxOutstandingJobs !== null ||
      org.maxQueuedJobs !== null ||
      org.maxDelayedJobs !== null
    ) {
      const groups = await tx.job.groupBy({
        by: ['status'],
        where: {
          queue: { organisationId: params.orgId },
          status: {
            in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED, JobStatus.PAUSED],
          },
        },
        _count: { _all: true },
      });

      let pending = 0;
      let active = 0;
      let delayed = 0;
      let paused = 0;
      for (const g of groups) {
        if (g.status === JobStatus.PENDING) pending = g._count._all;
        if (g.status === JobStatus.ACTIVE) active = g._count._all;
        if (g.status === JobStatus.DELAYED) delayed = g._count._all;
        if (g.status === JobStatus.PAUSED) paused = g._count._all;
      }

      const outstanding = pending + active + delayed + paused;
      const queued = pending + paused;

      if (org.maxOutstandingJobs !== null && outstanding >= org.maxOutstandingJobs) {
        const details: AdmissionRejectionDetails = {
          reason: 'ORG_MAX_OUTSTANDING_JOBS',
          scope: 'organisation',
          limit: org.maxOutstandingJobs,
          current: outstanding,
          queueId: params.queue.id,
          queueName: params.queue.name,
          retryAfterSeconds: 5,
        };
        throw new TooManyRequestsError(
          `Organisation outstanding job quota exceeded (${outstanding}/${org.maxOutstandingJobs})`,
          details,
        );
      }

      if (
        org.maxQueuedJobs !== null &&
        (params.initialStatus === JobStatus.PENDING || params.initialStatus === JobStatus.PAUSED) &&
        queued >= org.maxQueuedJobs
      ) {
        const details: AdmissionRejectionDetails = {
          reason: 'ORG_MAX_QUEUED_JOBS',
          scope: 'organisation',
          limit: org.maxQueuedJobs,
          current: queued,
          queueId: params.queue.id,
          queueName: params.queue.name,
          retryAfterSeconds: 5,
        };
        throw new TooManyRequestsError(
          `Organisation queued job quota exceeded (${queued}/${org.maxQueuedJobs})`,
          details,
        );
      }

      if (
        org.maxDelayedJobs !== null &&
        params.initialStatus === JobStatus.DELAYED &&
        delayed >= org.maxDelayedJobs
      ) {
        const details: AdmissionRejectionDetails = {
          reason: 'ORG_MAX_DELAYED_JOBS',
          scope: 'organisation',
          limit: org.maxDelayedJobs,
          current: delayed,
          queueId: params.queue.id,
          queueName: params.queue.name,
          retryAfterSeconds: 5,
        };
        throw new TooManyRequestsError(
          `Organisation delayed job quota exceeded (${delayed}/${org.maxDelayedJobs})`,
          details,
        );
      }
    }

    // 3. Queue-level backpressure (depth & oldest pending age)
    if (params.queue.maxQueueDepth !== null) {
      const queueDepth = await tx.job.count({
        where: {
          queueId: params.queue.id,
          status: { in: [JobStatus.PENDING, JobStatus.DELAYED, JobStatus.PAUSED] },
        },
      });
      if (queueDepth >= params.queue.maxQueueDepth) {
        const details: AdmissionRejectionDetails = {
          reason: 'QUEUE_BACKPRESSURE_DEPTH',
          scope: 'queue',
          limit: params.queue.maxQueueDepth,
          current: queueDepth,
          queueId: params.queue.id,
          queueName: params.queue.name,
          retryAfterSeconds: 5,
        };
        throw new TooManyRequestsError(
          `Queue "${params.queue.name}" backpressure active: depth ${queueDepth} reached limit ${params.queue.maxQueueDepth}`,
          details,
        );
      }
    }

    if (params.queue.backpressureMaxAgeMs !== null) {
      const oldest = await tx.job.findFirst({
        where: { queueId: params.queue.id, status: JobStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      if (oldest) {
        const ageMs = Date.now() - oldest.createdAt.getTime();
        if (ageMs >= params.queue.backpressureMaxAgeMs) {
          const details: AdmissionRejectionDetails = {
            reason: 'QUEUE_BACKPRESSURE_AGE',
            scope: 'queue',
            limit: params.queue.backpressureMaxAgeMs,
            current: ageMs,
            queueId: params.queue.id,
            queueName: params.queue.name,
            retryAfterSeconds: 5,
          };
          throw new TooManyRequestsError(
            `Queue "${params.queue.name}" backpressure active: oldest pending job age (${ageMs}ms) exceeded limit (${params.queue.backpressureMaxAgeMs}ms)`,
            details,
          );
        }
      }
    }
  }

  /**
   * Evaluates organisation and queue retry budgets inside an existing Prisma transaction,
   * acquiring a per-organisation advisory lock so that the caller's subsequent `JOB_RETRIED`
   * event insert is strictly serialized against concurrent workers (zero TOCTOU race).
   */
  async evaluateRetryBudgetInTransaction(
    tx: Prisma.TransactionClient,
    orgId: string,
    queueId: string,
  ): Promise<RetryBudgetCheckResult> {
    const [org, queue] = await Promise.all([
      tx.organisation.findUnique({
        where: { id: orgId },
        select: { retryBudgetMaxRetries: true, retryBudgetWindowSeconds: true },
      }),
      tx.queue.findFirst({
        where: { id: queueId, organisationId: orgId },
        select: { retryBudgetMaxRetries: true, retryBudgetWindowSeconds: true },
      }),
    ]);

    const hasOrgBudget =
      org?.retryBudgetMaxRetries !== null && org?.retryBudgetMaxRetries !== undefined;
    const hasQueueBudget =
      queue?.retryBudgetMaxRetries !== null && queue?.retryBudgetMaxRetries !== undefined;

    if (!hasOrgBudget && !hasQueueBudget) {
      return { allowed: true };
    }

    const lockKey = hashOrgLockKey(orgId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_RETRY_BUDGET}::int4, ${lockKey}::int4)`;

    const now = Date.now();

    if (hasOrgBudget && org) {
      const windowSec = org.retryBudgetWindowSeconds;
      const since = new Date(now - windowSec * 1000);
      const used = await tx.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_RETRIED,
          createdAt: { gte: since },
        },
      });
      if (used >= org.retryBudgetMaxRetries!) {
        return {
          allowed: false,
          scope: 'organisation' as const,
          used,
          limit: org.retryBudgetMaxRetries!,
          windowSeconds: windowSec,
          reason: `Organisation retry budget exhausted (${used}/${org.retryBudgetMaxRetries} retries in ${windowSec}s window)`,
        };
      }
    }

    if (hasQueueBudget && queue) {
      const windowSec = queue.retryBudgetWindowSeconds;
      const since = new Date(now - windowSec * 1000);
      const used = await tx.platformEvent.count({
        where: {
          organisationId: orgId,
          queueId,
          type: PlatformEventType.JOB_RETRIED,
          createdAt: { gte: since },
        },
      });
      if (used >= queue.retryBudgetMaxRetries!) {
        return {
          allowed: false,
          scope: 'queue' as const,
          used,
          limit: queue.retryBudgetMaxRetries!,
          windowSeconds: windowSec,
          reason: `Queue retry budget exhausted (${used}/${queue.retryBudgetMaxRetries} retries in ${windowSec}s window)`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Standalone retry-budget evaluation wrapper for read/inspection or unit checks.
   */
  async evaluateRetryBudget(orgId: string, queueId: string): Promise<RetryBudgetCheckResult> {
    return db.$transaction(
      async (tx) => this.evaluateRetryBudgetInTransaction(tx, orgId, queueId),
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  async updateOrganisationQuotas(
    orgId: string,
    input: UpdateOrgQuotasInput,
  ): Promise<OrganisationGovernanceView> {
    const existing = await db.organisation.findUnique({
      where: { id: orgId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError('Organisation not found');
    }

    await db.organisation.update({
      where: { id: orgId },
      data: {
        ...(input.maxOutstandingJobs !== undefined
          ? { maxOutstandingJobs: input.maxOutstandingJobs }
          : {}),
        ...(input.maxActiveJobs !== undefined ? { maxActiveJobs: input.maxActiveJobs } : {}),
        ...(input.maxQueuedJobs !== undefined ? { maxQueuedJobs: input.maxQueuedJobs } : {}),
        ...(input.maxDelayedJobs !== undefined ? { maxDelayedJobs: input.maxDelayedJobs } : {}),
        ...(input.maxPayloadBytes !== undefined ? { maxPayloadBytes: input.maxPayloadBytes } : {}),
        ...(input.retryBudgetMaxRetries !== undefined
          ? { retryBudgetMaxRetries: input.retryBudgetMaxRetries }
          : {}),
        ...(input.retryBudgetWindowSeconds !== undefined
          ? { retryBudgetWindowSeconds: input.retryBudgetWindowSeconds }
          : {}),
      },
    });

    return this.getOrganisationGovernance(orgId);
  }

  async getOrganisationGovernance(orgId: string): Promise<OrganisationGovernanceView> {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        maxOutstandingJobs: true,
        maxActiveJobs: true,
        maxQueuedJobs: true,
        maxDelayedJobs: true,
        maxPayloadBytes: true,
        retryBudgetMaxRetries: true,
        retryBudgetWindowSeconds: true,
      },
    });
    if (!org) {
      throw new NotFoundError('Organisation not found');
    }

    const now = Date.now();
    const orgRetrySince = new Date(now - org.retryBudgetWindowSeconds * 1000);
    const recentWindowSince = new Date(now - 60 * 60 * 1000); // 1h window for rejection metrics

    const [
      jobGroups,
      queues,
      orgRetriesInWindow,
      retryBudgetExhaustedInWindow,
      admissionRejectionsInWindow,
      openQuarantinedCount,
      totalQuarantinedJobs,
      recentQuarantined,
    ] = await Promise.all([
      db.job.groupBy({
        by: ['status'],
        where: {
          queue: { organisationId: orgId },
          status: {
            in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED, JobStatus.PAUSED],
          },
        },
        _count: { _all: true },
      }),
      db.queue.findMany({
        where: { organisationId: orgId },
        select: {
          id: true,
          name: true,
          maxQueueDepth: true,
          backpressureMaxAgeMs: true,
          retryBudgetMaxRetries: true,
          retryBudgetWindowSeconds: true,
          poisonFailureThreshold: true,
        },
        orderBy: { name: 'asc' },
      }),
      db.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_RETRIED,
          createdAt: { gte: orgRetrySince },
        },
      }),
      db.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_RETRY_BUDGET_EXHAUSTED,
          createdAt: { gte: recentWindowSince },
        },
      }),
      db.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_ADMISSION_REJECTED,
          createdAt: { gte: recentWindowSince },
        },
      }),
      db.deadLetterJob.count({
        where: { organisationId: orgId, status: 'OPEN', isQuarantined: true },
      }),
      db.job.count({
        where: { queue: { organisationId: orgId }, isQuarantined: true },
      }),
      db.deadLetterJob.findMany({
        where: { organisationId: orgId, isQuarantined: true },
        orderBy: { failedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          originalJobId: true,
          jobName: true,
          queueName: true,
          quarantineReason: true,
          failureSignature: true,
          failedAt: true,
        },
      }),
    ]);

    let pending = 0;
    let active = 0;
    let delayed = 0;
    let paused = 0;
    for (const g of jobGroups) {
      if (g.status === JobStatus.PENDING) pending = g._count._all;
      if (g.status === JobStatus.ACTIVE) active = g._count._all;
      if (g.status === JobStatus.DELAYED) delayed = g._count._all;
      if (g.status === JobStatus.PAUSED) paused = g._count._all;
    }

    const outstandingJobs = pending + active + delayed + paused;
    const queuedJobs = pending + paused;

    const queueStatuses = await Promise.all(
      queues.map(async (q) => {
        const qRetrySince = new Date(now - q.retryBudgetWindowSeconds * 1000);
        const [depth, oldestPending, qRetries] = await Promise.all([
          db.job.count({
            where: {
              queueId: q.id,
              status: { in: [JobStatus.PENDING, JobStatus.DELAYED, JobStatus.PAUSED] },
            },
          }),
          db.job.findFirst({
            where: { queueId: q.id, status: JobStatus.PENDING },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          }),
          db.platformEvent.count({
            where: {
              organisationId: orgId,
              queueId: q.id,
              type: PlatformEventType.JOB_RETRIED,
              createdAt: { gte: qRetrySince },
            },
          }),
        ]);

        const oldestPendingAgeMs = oldestPending
          ? Math.max(0, now - oldestPending.createdAt.getTime())
          : null;
        let status: 'NORMAL' | 'DEGRADED' | 'REJECTING' = 'NORMAL';
        if (
          (q.maxQueueDepth !== null && depth >= q.maxQueueDepth) ||
          (q.backpressureMaxAgeMs !== null &&
            oldestPendingAgeMs !== null &&
            oldestPendingAgeMs >= q.backpressureMaxAgeMs)
        ) {
          status = 'REJECTING';
        } else if (
          (q.maxQueueDepth !== null && depth >= q.maxQueueDepth * 0.8) ||
          (q.backpressureMaxAgeMs !== null &&
            oldestPendingAgeMs !== null &&
            oldestPendingAgeMs >= q.backpressureMaxAgeMs * 0.8)
        ) {
          status = 'DEGRADED';
        }

        return {
          queueId: q.id,
          queueName: q.name,
          depth,
          maxQueueDepth: q.maxQueueDepth,
          oldestPendingAgeMs,
          backpressureMaxAgeMs: q.backpressureMaxAgeMs,
          status,
          retryBudgetLimit: q.retryBudgetMaxRetries,
          retryBudgetWindowSeconds: q.retryBudgetWindowSeconds,
          retriesInWindow: qRetries,
          poisonFailureThreshold: q.poisonFailureThreshold,
        };
      }),
    );

    return {
      organisationId: orgId,
      quotas: {
        maxOutstandingJobs: org.maxOutstandingJobs,
        maxActiveJobs: org.maxActiveJobs,
        maxQueuedJobs: org.maxQueuedJobs,
        maxDelayedJobs: org.maxDelayedJobs,
        maxPayloadBytes: org.maxPayloadBytes,
        retryBudgetMaxRetries: org.retryBudgetMaxRetries,
        retryBudgetWindowSeconds: org.retryBudgetWindowSeconds,
      },
      usage: {
        outstandingJobs,
        activeJobs: active,
        queuedJobs,
        delayedJobs: delayed,
        utilizationPercent: {
          outstanding: pct(outstandingJobs, org.maxOutstandingJobs),
          active: pct(active, org.maxActiveJobs),
          queued: pct(queuedJobs, org.maxQueuedJobs),
          delayed: pct(delayed, org.maxDelayedJobs),
        },
      },
      retryBudget: {
        windowSeconds: org.retryBudgetWindowSeconds,
        usedInWindow: orgRetriesInWindow,
        limit: org.retryBudgetMaxRetries,
        exhausted:
          org.retryBudgetMaxRetries !== null && orgRetriesInWindow >= org.retryBudgetMaxRetries,
        exhaustedEventsInWindow: retryBudgetExhaustedInWindow,
      },
      backpressure: {
        admissionRejectionsInWindow,
        queues: queueStatuses,
      },
      quarantine: {
        openQuarantinedCount,
        totalQuarantinedJobs,
        recentReasons: recentQuarantined.map((d) => ({
          dlqId: d.id,
          jobId: d.originalJobId,
          jobName: d.jobName,
          queueName: d.queueName,
          quarantineReason: d.quarantineReason,
          failureSignature: d.failureSignature,
          failedAt: d.failedAt,
        })),
      },
    };
  }
}

export const governanceService = new GovernanceService();

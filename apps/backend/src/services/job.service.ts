import { JobStatus, OutboxStatus, PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  assertValidJobTransition,
  isCancellableJobStatus,
  isTerminalJobStatus,
  resolveInitialJobStatus,
} from '../utils/jobLifecycle.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import type { CreateJobInput, ListJobsQuery } from '../validators/job.validator.js';
import {
  buildBullMQQueueName,
  bullMQService,
  type EnqueueResult,
  type PersistedQueueDescriptor,
} from './bullmq.service.js';
import { deadLetterService } from './dlq.service.js';
import { eventService } from './event.service.js';

export const DEFAULT_JOB_LEASE_MS = 30_000;

export interface JobView {
  id: string;
  queueId: string;
  queueName: string;
  organisationId: string;
  name: string;
  status: JobStatus;
  priority: number;
  payload: Prisma.JsonValue;
  maxRetries: number;
  backoffMs: number;
  delayMs: number;
  idempotencyKey: string | null;
  fencingToken: number;
  leaseExpiresAt: Date | null;
  attemptsMade: number;
  stalledCount: number;
  durationMs: number | null;
  lastWorkerId: string | null;
  replayedFromDlqId: string | null;
  result: Prisma.JsonValue | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  lastRecoveredAt: Date | null;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedJobsView {
  jobs: JobView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface CancelJobResult {
  cancelled: true;
  jobId: string;
  queueId: string;
  organisationId: string;
  previousStatus: JobStatus;
}

export interface JobSubmissionResult {
  job: JobView;
  dispatch: EnqueueResult;
  deduplicated?: boolean;
}

export type WorkerActivationOutcome =
  | {
      outcome: 'activated';
      job: JobView;
      fencingToken: number;
      leaseExpiresAt: Date;
      maxDurationMs?: number | null;
    }
  | { outcome: 'already_terminal'; status: JobStatus }
  | { outcome: 'already_active' }
  | { outcome: 'missing' };

export type WorkerSyncOutcome =
  | { outcome: 'updated'; job: JobView }
  | { outcome: 'already_terminal'; status: JobStatus }
  | { outcome: 'not_active'; status: JobStatus }
  | { outcome: 'stale_fencing_token'; currentFencingToken: number }
  | { outcome: 'missing' };

const MAX_ERROR_MESSAGE_LENGTH = 2000;

const JOB_INCLUDE = {
  queue: {
    select: {
      id: true,
      name: true,
      organisationId: true,
    },
  },
  createdBy: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} as const;

type JobWithMeta = Prisma.JobGetPayload<{ include: typeof JOB_INCLUDE }>;

function sanitizeErrorMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function toJobView(j: JobWithMeta): JobView {
  return {
    id: j.id,
    queueId: j.queueId,
    queueName: j.queue.name,
    organisationId: j.queue.organisationId,
    name: j.name,
    status: j.status,
    priority: j.priority,
    payload: j.payload,
    maxRetries: j.maxRetries,
    backoffMs: j.backoffMs,
    delayMs: j.delayMs,
    idempotencyKey: j.idempotencyKey,
    fencingToken: j.fencingToken,
    leaseExpiresAt: j.leaseExpiresAt,
    attemptsMade: j.attemptsMade,
    stalledCount: j.stalledCount,
    durationMs: j.durationMs,
    lastWorkerId: j.lastWorkerId,
    replayedFromDlqId: j.replayedFromDlqId,
    result: j.result,
    errorMessage: j.errorMessage,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    failedAt: j.failedAt,
    lastRecoveredAt: j.lastRecoveredAt,
    createdBy: j.createdBy,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

export class JobService {
  /**
   * Submits and persists a new job + transactional outbox record atomically in PostgreSQL,
   * then dispatches the job to BullMQ and updates the outbox state accordingly.
   * Respects queue default priority, retry/backoff defaults, and pause state.
   */
  async create(
    orgId: string,
    queueId: string,
    userId: string,
    input: CreateJobInput,
  ): Promise<JobSubmissionResult> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    type CreateTxResult =
      | { deduplicated: true; existingJob: JobWithMeta; queueName: string }
      | {
          deduplicated: false;
          persistedQueue: PersistedQueueDescriptor;
          createdJob: JobWithMeta;
          outboxId: string;
        };

    let txResult: CreateTxResult;
    try {
      txResult = await db.$transaction(
        async (tx) => {
          const queue = await tx.queue.findFirst({
            where: {
              id: queueId,
              organisationId: orgId,
            },
            select: {
              id: true,
              name: true,
              organisationId: true,
              isPaused: true,
              concurrency: true,
              defaultPriority: true,
              maxRetries: true,
              backoffMs: true,
            },
          });

          if (!queue) {
            throw new NotFoundError('Queue not found');
          }

          if (input.idempotencyKey) {
            const existing = await tx.job.findUnique({
              where: {
                queueId_idempotencyKey: {
                  queueId: queue.id,
                  idempotencyKey: input.idempotencyKey,
                },
              },
              include: JOB_INCLUDE,
            });
            if (existing) {
              return { deduplicated: true as const, existingJob: existing, queueName: queue.name };
            }
          }

          const initialStatus = resolveInitialJobStatus({
            queueIsPaused: queue.isPaused,
            delayMs: input.delayMs,
          });

          const job = await tx.job.create({
            data: {
              queueId: queue.id,
              name: input.name,
              status: initialStatus,
              priority: input.priority ?? queue.defaultPriority,
              payload: input.payload as Prisma.InputJsonValue,
              maxRetries: input.maxRetries ?? queue.maxRetries,
              backoffMs: input.backoffMs ?? queue.backoffMs,
              delayMs: input.delayMs,
              idempotencyKey: input.idempotencyKey ?? null,
              createdById: userId,
            },
            include: JOB_INCLUDE,
          });

          // Commit durable outbox record in the exact same PostgreSQL transaction
          const outbox = await tx.jobDispatchOutbox.create({
            data: {
              jobId: job.id,
              queueId: queue.id,
              organisationId: orgId,
              status: OutboxStatus.PENDING,
            },
            select: { id: true },
          });

          return {
            deduplicated: false as const,
            persistedQueue: queue,
            createdJob: job,
            outboxId: outbox.id,
          };
        },
        { maxWait: 10_000, timeout: 10_000 },
      );
    } catch (err) {
      // Handle concurrent identical idempotencyKey racing on unique constraint
      if (
        input.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await db.job.findFirst({
          where: {
            queueId,
            idempotencyKey: input.idempotencyKey,
            queue: { organisationId: orgId },
          },
          include: JOB_INCLUDE,
        });
        if (existing) {
          return {
            job: toJobView(existing),
            dispatch: {
              broker: 'bullmq',
              enqueued: true,
              deduplicated: true,
              bullmqQueueName: buildBullMQQueueName(orgId, existing.queue.name),
              bullmqJobId: existing.id,
            },
            deduplicated: true,
          };
        }
      }
      throw err;
    }

    if (txResult.deduplicated) {
      return {
        job: toJobView(txResult.existingJob),
        dispatch: {
          broker: 'bullmq',
          enqueued: true,
          deduplicated: true,
          bullmqQueueName: buildBullMQQueueName(orgId, txResult.queueName),
          bullmqJobId: txResult.existingJob.id,
        },
        deduplicated: true,
      };
    }

    const { persistedQueue, createdJob, outboxId } = txResult;

    logger.info('Job submitted', {
      jobId: createdJob.id,
      queueId: createdJob.queueId,
      organisationId: orgId,
      status: createdJob.status,
      priority: createdJob.priority,
      createdById: userId,
    });

    // Dispatch to BullMQ after durable PostgreSQL commit.
    // Partial failure leaves the outbox PENDING so OutboxReconciler redispatches idempotently.
    const dispatch = await bullMQService.enqueueJob(persistedQueue, createdJob);

    try {
      if (dispatch.enqueued) {
        await db.jobDispatchOutbox.updateMany({
          where: { id: outboxId, status: OutboxStatus.PENDING },
          data: {
            status: OutboxStatus.DISPATCHED,
            dispatchedAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
          },
        });
      } else {
        await db.jobDispatchOutbox.updateMany({
          where: { id: outboxId, status: OutboxStatus.PENDING },
          data: {
            attempts: { increment: 1 },
            lastError: sanitizeErrorMessage(dispatch.error ?? 'Redis unavailable'),
            nextAttemptAt: new Date(Date.now() + 2000),
          },
        });
      }
    } catch (err) {
      // Non-fatal: outbox remains PENDING and BullMQ deduplicates on stable jobId if retried
      logger.warn('Failed to update outbox status after BullMQ dispatch', {
        outboxId,
        jobId: createdJob.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await eventService.record({
      type: PlatformEventType.JOB_SUBMITTED,
      organisationId: orgId,
      queueId: createdJob.queueId,
      jobId: createdJob.id,
      message: `Job "${createdJob.name}" submitted to queue "${persistedQueue.name}"`,
      metadata: {
        queueName: persistedQueue.name,
        status: createdJob.status,
        priority: createdJob.priority,
        delayMs: createdJob.delayMs,
        enqueued: dispatch.enqueued,
      },
    });

    return {
      job: toJobView(createdJob),
      dispatch,
    };
  }

  /**
   * Lists jobs within a queue belonging to the authenticated user's organisation,
   * supporting status filtering and pagination.
   */
  async listByQueue(
    orgId: string,
    queueId: string,
    query: ListJobsQuery,
  ): Promise<PaginatedJobsView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const queue = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
      select: { id: true },
    });

    if (!queue) {
      throw new NotFoundError('Queue not found');
    }

    const where: Prisma.JobWhereInput = {
      queueId: queue.id,
      queue: { organisationId: orgId },
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, jobs] = await Promise.all([
      db.job.count({ where }),
      db.job.findMany({
        where,
        include: JOB_INCLUDE,
        orderBy: [{ createdAt: query.sortOrder }, { id: query.sortOrder }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      jobs: jobs.map(toJobView),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        hasNextPage: query.page < totalPages,
        hasPreviousPage: query.page > 1 && totalPages > 0,
      },
    };
  }

  /**
   * Retrieves an individual job strictly scoped by organisation (and optional queueId).
   */
  async getById(orgId: string, jobId: string, queueId?: string): Promise<JobView> {
    if (!uuidSchema.safeParse(jobId).success) {
      throw new NotFoundError('Job not found');
    }

    if (queueId !== undefined && !uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Job not found');
    }

    const job = await db.job.findFirst({
      where: {
        id: jobId,
        ...(queueId !== undefined ? { queueId } : {}),
        queue: { organisationId: orgId },
      },
      include: JOB_INCLUDE,
    });

    if (!job) {
      throw new NotFoundError('Job not found');
    }

    return toJobView(job);
  }

  /**
   * Safely cancels a job that has not started processing (PENDING, DELAYED, PAUSED).
   * Rejects ACTIVE, COMPLETED, or FAILED jobs with 409 Conflict.
   */
  async cancel(
    orgId: string,
    jobId: string,
    actorUserId: string,
    queueId?: string,
  ): Promise<CancelJobResult> {
    if (!uuidSchema.safeParse(jobId).success) {
      throw new NotFoundError('Job not found');
    }

    if (queueId !== undefined && !uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Job not found');
    }

    const precheck = await db.job.findFirst({
      where: {
        id: jobId,
        ...(queueId !== undefined ? { queueId } : {}),
        queue: { organisationId: orgId },
      },
      select: { id: true },
    });

    if (!precheck) {
      throw new NotFoundError('Job not found');
    }

    const { result, queueDescriptor } = await db.$transaction(
      async (tx) => {
        const job = await tx.job.findFirst({
          where: {
            id: jobId,
            ...(queueId !== undefined ? { queueId } : {}),
            queue: { organisationId: orgId },
          },
          select: {
            id: true,
            queueId: true,
            status: true,
            queue: {
              select: {
                id: true,
                organisationId: true,
                name: true,
                isPaused: true,
                concurrency: true,
                defaultPriority: true,
                maxRetries: true,
                backoffMs: true,
              },
            },
          },
        });

        if (!job) {
          throw new NotFoundError('Job not found');
        }

        if (!isCancellableJobStatus(job.status)) {
          throw new ConflictError(
            `Cannot cancel job in ${job.status} status. Only PENDING, DELAYED, or PAUSED jobs can be cancelled.`,
            { currentStatus: job.status },
          );
        }

        // Guarded delete also cascades to job_dispatch_outbox via FK ON DELETE CASCADE
        const deleted = await tx.job.deleteMany({
          where: {
            id: job.id,
            status: job.status,
            queue: { organisationId: orgId },
          },
        });

        if (deleted.count !== 1) {
          throw new ConflictError('Job status changed concurrently and could not be cancelled');
        }

        const cancelResult: CancelJobResult = {
          cancelled: true,
          jobId: job.id,
          queueId: job.queueId,
          organisationId: orgId,
          previousStatus: job.status,
        };

        return {
          result: cancelResult,
          queueDescriptor: job.queue as PersistedQueueDescriptor,
        };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    // Best-effort removal from BullMQ so a cancelled job does not linger in Redis
    await bullMQService.removeJobFromBullMQ(queueDescriptor, result.jobId);

    logger.info('Job cancelled', {
      jobId: result.jobId,
      queueId: result.queueId,
      organisationId: orgId,
      previousStatus: result.previousStatus,
      cancelledBy: actorUserId,
    });

    return result;
  }

  /**
   * Trusted internal lifecycle transition method enforcing valid JobStatus state transitions
   * and strict organisation scoping. Never exposed as a public client-facing endpoint.
   */
  async transitionStatus(orgId: string, jobId: string, targetStatus: JobStatus): Promise<JobView> {
    if (!uuidSchema.safeParse(jobId).success) {
      throw new NotFoundError('Job not found');
    }

    return db.$transaction(
      async (tx) => {
        const existing = await tx.job.findFirst({
          where: {
            id: jobId,
            queue: { organisationId: orgId },
          },
          select: { id: true, status: true },
        });

        if (!existing) {
          throw new NotFoundError('Job not found');
        }

        assertValidJobTransition(existing.status, targetStatus);

        const updated = await tx.job.update({
          where: { id: existing.id },
          data: { status: targetStatus },
          include: JOB_INCLUDE,
        });

        logger.info('Job status transitioned', {
          jobId: updated.id,
          organisationId: orgId,
          from: existing.status,
          to: targetStatus,
        });

        return toJobView(updated);
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  // ─── Trusted Worker Execution Synchronisation Methods ─────────────────────

  /**
   * Atomically claims a PostgreSQL job for active execution.
   * Respects valid lifecycle paths (PENDING/DELAYED -> ACTIVE, or PAUSED -> PENDING -> ACTIVE),
   * never overwrites terminal (COMPLETED/FAILED) states, and handles missing/deleted jobs safely.
   */
  async markJobActive(
    orgId: string,
    jobId: string,
    attemptNumber: number,
    workerId?: string,
    options?: { leaseDurationMs?: number },
  ): Promise<WorkerActivationOutcome> {
    if (!uuidSchema.safeParse(jobId).success) {
      return { outcome: 'missing' };
    }

    const leaseDurationMs = Math.max(1_000, options?.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS);

    const activation = await db.$transaction(
      async (tx) => {
        const existing = await tx.job.findFirst({
          where: {
            id: jobId,
            queue: { organisationId: orgId },
          },
          select: { id: true, status: true, firstStartedAt: true },
        });

        if (!existing) {
          return { outcome: 'missing' as const };
        }

        if (isTerminalJobStatus(existing.status)) {
          return { outcome: 'already_terminal' as const, status: existing.status };
        }

        if (existing.status === JobStatus.ACTIVE) {
          return { outcome: 'already_active' as const };
        }

        // If a job was still PAUSED (e.g. BullMQ resume raced ahead of PG), explicitly
        // transition PAUSED -> PENDING before PENDING -> ACTIVE
        if (existing.status === JobStatus.PAUSED) {
          assertValidJobTransition(JobStatus.PAUSED, JobStatus.PENDING);
          assertValidJobTransition(JobStatus.PENDING, JobStatus.ACTIVE);
        } else {
          assertValidJobTransition(existing.status, JobStatus.ACTIVE);
        }

        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
        const claimed = await tx.job.updateMany({
          where: {
            id: existing.id,
            status: existing.status,
            queue: { organisationId: orgId },
          },
          data: {
            status: JobStatus.ACTIVE,
            ...(existing.firstStartedAt ? {} : { firstStartedAt: now }),
            startedAt: now,
            leaseExpiresAt,
            fencingToken: { increment: 1 },
            attemptsMade: Math.max(1, attemptNumber),
            ...(workerId ? { lastWorkerId: workerId } : {}),
          },
        });

        if (claimed.count !== 1) {
          const reread = await tx.job.findUnique({
            where: { id: existing.id },
            select: { status: true },
          });
          if (!reread) return { outcome: 'missing' as const };
          if (isTerminalJobStatus(reread.status)) {
            return { outcome: 'already_terminal' as const, status: reread.status };
          }
          return { outcome: 'already_active' as const };
        }

        const updated = await tx.job.findUnique({
          where: { id: existing.id },
          include: {
            ...JOB_INCLUDE,
            scheduleExecution: {
              select: {
                id: true,
                startedAt: true,
                schedule: { select: { maxDurationMs: true } },
              },
            },
          },
        });

        if (!updated) {
          return { outcome: 'missing' as const };
        }

        if (updated.scheduleExecution) {
          await tx.scheduleExecution.update({
            where: { id: updated.scheduleExecution.id },
            data: {
              ...(updated.scheduleExecution.startedAt
                ? {}
                : { startedAt: updated.startedAt ?? new Date() }),
              finalJobStatus: JobStatus.ACTIVE,
              retryCount: Math.max(0, attemptNumber - 1),
            },
          });
        }

        return {
          outcome: 'activated' as const,
          job: toJobView(updated),
          fencingToken: updated.fencingToken,
          leaseExpiresAt: updated.leaseExpiresAt ?? leaseExpiresAt,
          maxDurationMs: updated.scheduleExecution?.schedule?.maxDurationMs ?? null,
        };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    if (activation.outcome === 'activated') {
      await eventService.record({
        type: PlatformEventType.JOB_STARTED,
        organisationId: orgId,
        queueId: activation.job.queueId,
        jobId: activation.job.id,
        workerId: workerId ?? null,
        message: `Job "${activation.job.name}" started (attempt ${attemptNumber})`,
        metadata: {
          attemptNumber,
          fencingToken: activation.fencingToken,
          leaseExpiresAt: activation.leaseExpiresAt.toISOString(),
          queueName: activation.job.queueName,
        },
      });
    }

    return activation;
  }

  /**
   * Renews an active job's execution lease ONLY if the caller still owns the current
   * fencing token and worker identity. Prevents stale workers from extending expired leases.
   */
  async renewJobLease(
    orgId: string,
    jobId: string,
    workerId: string,
    fencingToken: number,
    leaseDurationMs: number = DEFAULT_JOB_LEASE_MS,
  ): Promise<{ renewed: boolean; leaseExpiresAt: Date }> {
    const leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseDurationMs));
    if (!uuidSchema.safeParse(jobId).success) {
      return { renewed: false, leaseExpiresAt };
    }

    const res = await db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.ACTIVE,
        lastWorkerId: workerId,
        fencingToken,
        queue: { organisationId: orgId },
      },
      data: {
        leaseExpiresAt,
      },
    });

    return { renewed: res.count === 1, leaseExpiresAt };
  }

  /**
   * Atomically marks an ACTIVE job COMPLETED and persists structured result, duration & timestamp.
   * Never overwrites a job that has already reached a terminal state.
   */
  async markJobCompleted(
    orgId: string,
    jobId: string,
    result: Prisma.InputJsonValue,
    attemptNumber: number,
    options?: { durationMs?: number; workerId?: string; fencingToken?: number },
  ): Promise<WorkerSyncOutcome> {
    if (!uuidSchema.safeParse(jobId).success) {
      return { outcome: 'missing' };
    }

    assertValidJobTransition(JobStatus.ACTIVE, JobStatus.COMPLETED);

    const completedAt = new Date();
    const updatedCount = await db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.ACTIVE,
        ...(options?.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
        queue: { organisationId: orgId },
      },
      data: {
        status: JobStatus.COMPLETED,
        result,
        errorMessage: null,
        completedAt,
        leaseExpiresAt: null,
        attemptsMade: Math.max(1, attemptNumber),
        ...(options?.durationMs !== undefined
          ? { durationMs: Math.max(0, options.durationMs) }
          : {}),
        ...(options?.workerId ? { lastWorkerId: options.workerId } : {}),
      },
    });

    const job = await db.job.findFirst({
      where: { id: jobId, queue: { organisationId: orgId } },
      include: JOB_INCLUDE,
    });

    if (!job) {
      return { outcome: 'missing' };
    }

    if (updatedCount.count !== 1) {
      if (options?.fencingToken !== undefined && job.fencingToken !== options.fencingToken) {
        await eventService.record({
          type: PlatformEventType.JOB_FENCING_REJECTED,
          organisationId: orgId,
          queueId: job.queueId,
          jobId: job.id,
          workerId: options?.workerId ?? null,
          message: `Rejected stale completion for job "${job.name}" (supplied fencing token ${options.fencingToken}, current ${job.fencingToken})`,
          metadata: {
            attemptedAction: 'COMPLETED',
            suppliedFencingToken: options.fencingToken,
            currentFencingToken: job.fencingToken,
            currentStatus: job.status,
          },
        });
        return { outcome: 'stale_fencing_token', currentFencingToken: job.fencingToken };
      }
      if (isTerminalJobStatus(job.status)) {
        return { outcome: 'already_terminal', status: job.status };
      }
      return { outcome: 'not_active', status: job.status };
    }

    // Persist immutable execution telemetry onto linked ScheduleExecution (if any)
    await db.scheduleExecution.updateMany({
      where: { jobId: job.id },
      data: {
        finalJobStatus: JobStatus.COMPLETED,
        completedAt: job.completedAt ?? completedAt,
        ...(job.durationMs !== null ? { durationMs: job.durationMs } : {}),
        retryCount: Math.max(0, attemptNumber - 1),
      },
    });

    await eventService.record({
      type: PlatformEventType.JOB_COMPLETED,
      organisationId: orgId,
      queueId: job.queueId,
      jobId: job.id,
      workerId: options?.workerId ?? null,
      message: `Job "${job.name}" completed on attempt ${attemptNumber}`,
      metadata: {
        attemptNumber,
        durationMs: options?.durationMs ?? null,
        queueName: job.queue.name,
      },
    });

    return { outcome: 'updated', job: toJobView(job) };
  }

  /**
   * Atomically transitions an ACTIVE job to DELAYED when an attempt failed but BullMQ
   * still has remaining retry attempts. Does NOT mark the job permanently FAILED.
   */
  async markJobRetryScheduled(
    orgId: string,
    jobId: string,
    errorMessage: string,
    attemptNumber: number,
    options?: { workerId?: string; fencingToken?: number },
  ): Promise<WorkerSyncOutcome> {
    if (!uuidSchema.safeParse(jobId).success) {
      return { outcome: 'missing' };
    }

    assertValidJobTransition(JobStatus.ACTIVE, JobStatus.DELAYED);
    const sanitizedError = sanitizeErrorMessage(errorMessage);

    const updatedCount = await db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.ACTIVE,
        ...(options?.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
        queue: { organisationId: orgId },
      },
      data: {
        status: JobStatus.DELAYED,
        errorMessage: sanitizedError,
        leaseExpiresAt: null,
        attemptsMade: Math.max(1, attemptNumber),
        ...(options?.workerId ? { lastWorkerId: options.workerId } : {}),
      },
    });

    const job = await db.job.findFirst({
      where: { id: jobId, queue: { organisationId: orgId } },
      include: JOB_INCLUDE,
    });

    if (!job) {
      return { outcome: 'missing' };
    }

    if (updatedCount.count !== 1) {
      if (options?.fencingToken !== undefined && job.fencingToken !== options.fencingToken) {
        await eventService.record({
          type: PlatformEventType.JOB_FENCING_REJECTED,
          organisationId: orgId,
          queueId: job.queueId,
          jobId: job.id,
          workerId: options?.workerId ?? null,
          message: `Rejected stale retry update for job "${job.name}" (supplied fencing token ${options.fencingToken}, current ${job.fencingToken})`,
          metadata: {
            attemptedAction: 'DELAYED',
            suppliedFencingToken: options.fencingToken,
            currentFencingToken: job.fencingToken,
            currentStatus: job.status,
          },
        });
        return { outcome: 'stale_fencing_token', currentFencingToken: job.fencingToken };
      }
      if (isTerminalJobStatus(job.status)) {
        return { outcome: 'already_terminal', status: job.status };
      }
      return { outcome: 'not_active', status: job.status };
    }

    await db.scheduleExecution.updateMany({
      where: { jobId: job.id },
      data: {
        finalJobStatus: JobStatus.DELAYED,
        retryCount: Math.max(1, attemptNumber),
      },
    });

    await eventService.record({
      type: PlatformEventType.JOB_RETRIED,
      organisationId: orgId,
      queueId: job.queueId,
      jobId: job.id,
      workerId: options?.workerId ?? null,
      message: `Job "${job.name}" failed attempt ${attemptNumber}; retry scheduled`,
      metadata: {
        attemptNumber,
        error: sanitizedError,
        queueName: job.queue.name,
      },
    });

    return { outcome: 'updated', job: toJobView(job) };
  }

  /**
   * Atomically marks an ACTIVE job permanently FAILED once all BullMQ retry attempts
   * are exhausted (or an unrecoverable error occurs), and routes it idempotently to DLQ.
   */
  async markJobFailed(
    orgId: string,
    jobId: string,
    errorMessage: string,
    attemptNumber: number,
    options?: {
      durationMs?: number;
      workerId?: string;
      routeToDlq?: boolean;
      fencingToken?: number;
    },
  ): Promise<WorkerSyncOutcome> {
    if (!uuidSchema.safeParse(jobId).success) {
      return { outcome: 'missing' };
    }

    assertValidJobTransition(JobStatus.ACTIVE, JobStatus.FAILED);
    const sanitizedError = sanitizeErrorMessage(errorMessage);
    const failedAt = new Date();

    const updatedCount = await db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.ACTIVE,
        ...(options?.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
        queue: { organisationId: orgId },
      },
      data: {
        status: JobStatus.FAILED,
        errorMessage: sanitizedError,
        failedAt,
        leaseExpiresAt: null,
        attemptsMade: Math.max(1, attemptNumber),
        ...(options?.durationMs !== undefined
          ? { durationMs: Math.max(0, options.durationMs) }
          : {}),
        ...(options?.workerId ? { lastWorkerId: options.workerId } : {}),
      },
    });

    const job = await db.job.findFirst({
      where: { id: jobId, queue: { organisationId: orgId } },
      include: JOB_INCLUDE,
    });

    if (!job) {
      return { outcome: 'missing' };
    }

    if (updatedCount.count !== 1) {
      if (options?.fencingToken !== undefined && job.fencingToken !== options.fencingToken) {
        await eventService.record({
          type: PlatformEventType.JOB_FENCING_REJECTED,
          organisationId: orgId,
          queueId: job.queueId,
          jobId: job.id,
          workerId: options?.workerId ?? null,
          message: `Rejected stale failure commit for job "${job.name}" (supplied fencing token ${options.fencingToken}, current ${job.fencingToken})`,
          metadata: {
            attemptedAction: 'FAILED',
            suppliedFencingToken: options.fencingToken,
            currentFencingToken: job.fencingToken,
            currentStatus: job.status,
          },
        });
        return { outcome: 'stale_fencing_token', currentFencingToken: job.fencingToken };
      }
      if (isTerminalJobStatus(job.status)) {
        return { outcome: 'already_terminal', status: job.status };
      }
      return { outcome: 'not_active', status: job.status };
    }

    await db.scheduleExecution.updateMany({
      where: { jobId: job.id },
      data: {
        finalJobStatus: JobStatus.FAILED,
        completedAt: job.failedAt ?? failedAt,
        ...(job.durationMs !== null ? { durationMs: job.durationMs } : {}),
        retryCount: Math.max(0, attemptNumber - 1),
      },
    });

    await eventService.record({
      type: PlatformEventType.JOB_FAILED,
      organisationId: orgId,
      queueId: job.queueId,
      jobId: job.id,
      workerId: options?.workerId ?? null,
      message: `Job "${job.name}" permanently failed on attempt ${attemptNumber}`,
      metadata: {
        attemptNumber,
        durationMs: options?.durationMs ?? null,
        error: sanitizedError,
        queueName: job.queue.name,
      },
    });

    // Route permanently failed job into DLQ idempotently (unless explicitly disabled)
    if (options?.routeToDlq !== false) {
      await deadLetterService.recordDeadLetter({
        originalJobId: job.id,
        organisationId: orgId,
        queueId: job.queueId,
        queueName: job.queue.name,
        jobName: job.name,
        payload: job.payload,
        failureReason: sanitizedError,
        attemptsMade: job.attemptsMade,
        maxRetries: job.maxRetries,
        failedAt: job.failedAt ?? failedAt,
        workerId: options?.workerId,
      });
    }

    return { outcome: 'updated', job: toJobView(job) };
  }
}

export const jobService = new JobService();

import {
  JobStatus,
  MisfirePolicy,
  OutboxStatus,
  PlatformEventType,
  Prisma,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isCancellableJobStatus } from '../utils/jobLifecycle.js';
import {
  assertValidScheduleTransition,
  isTerminalScheduleStatus,
} from '../utils/scheduleLifecycle.js';
import {
  computeNextCronRun,
  computeUpcomingCronRuns,
  formatInTimezone,
  parseScheduledTimestamp,
  validateCronExpression,
} from '../utils/scheduleTime.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import {
  SCHEDULE_LIMITS,
  type CreateScheduleServiceInput,
  type ListScheduleExecutionsQuery,
  type ListSchedulesQuery,
  type UpdateScheduleInput,
} from '../validators/schedule.validator.js';
import { bullMQService, type EnqueueResult } from './bullmq.service.js';
import { eventService } from './event.service.js';
import { governanceService, type AdmissionRejectionDetails } from './governance.service.js';
import {
  scheduleDispatcherService,
  type ScheduleBullMQReconcileSummary,
  type ScheduleTickSummary,
} from './scheduleDispatcher.service.js';

export interface ScheduleView {
  id: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  name: string;
  description: string | null;
  type: ScheduleType;
  status: ScheduleStatus;
  jobName: string;
  payload: Prisma.JsonValue;
  priority: number | null;
  maxRetries: number | null;
  backoffMs: number | null;
  cronExpression: string | null;
  timezone: string;
  runAt: Date | null;
  nextRunAt: Date | null;
  nextRunAtLocal: string | null;
  lastRunAt: Date | null;
  lastDispatchedAt: Date | null;
  runCount: number;
  preventOverlap: boolean;
  misfirePolicy: MisfirePolicy;
  maxCatchUpRuns: number;
  misfireGraceMs: number;
  maxConcurrentRuns: number | null;
  maxTotalRuns: number | null;
  maxDurationMs: number | null;
  minIntervalMs: number | null;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateScheduleResult {
  schedule: ScheduleView;
  initialJobId?: string;
  dispatch?: EnqueueResult;
}

export interface PaginatedSchedulesView {
  schedules: ScheduleView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface ScheduleExecutionView {
  id: string;
  scheduleId: string;
  jobId: string | null;
  scheduledFor: Date;
  dispatchedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  finalJobStatus: JobStatus | null;
  retryCount: number;
  durationMs: number | null;
  isCatchUp: boolean;
  status: ScheduleExecutionStatus;
  reason: string | null;
  job: {
    id: string;
    status: JobStatus;
    priority: number;
    attemptsMade: number;
    durationMs: number | null;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
  } | null;
  createdAt: Date;
}

export interface PaginatedScheduleExecutionsView {
  executions: ScheduleExecutionView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface NextRunPreviewView {
  scheduleId: string;
  type: ScheduleType;
  status: ScheduleStatus;
  timezone: string;
  cronExpression: string | null;
  nextRunAt: Date | null;
  nextRunAtLocal: string | null;
  upcomingRuns: Array<{ utc: string; local: string }>;
}

export interface ScheduleStatsView {
  scheduleId: string;
  name: string;
  type: ScheduleType;
  status: ScheduleStatus;
  misfirePolicy: MisfirePolicy;
  runCount: number;
  maxTotalRuns: number | null;
  remainingRuns: number | null;
  currentInFlight: number;
  totalExecutions: number;
  catchUpExecutions: number;
  byStatus: {
    scheduled: number;
    dispatched: number;
    missed: number;
    skippedOverlap: number;
    skippedConcurrency: number;
    skippedMinInterval: number;
    skippedMaxRuns: number;
    cancelled: number;
  };
  byFinalJobStatus: {
    completed: number;
    failed: number;
    inFlight: number;
  };
  totalRetries: number;
  durationMs: {
    avg: number | null;
    min: number | null;
    max: number | null;
  };
  lastRunAt: Date | null;
  lastDispatchedAt: Date | null;
  nextRunAt: Date | null;
}

export interface ReconcileSchedulesResult {
  bullmq: ScheduleBullMQReconcileSummary;
  tick: ScheduleTickSummary;
}

const SCHEDULE_INCLUDE = {
  queue: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

type ScheduleWithMeta = Prisma.ScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

function toScheduleView(s: ScheduleWithMeta): ScheduleView {
  return {
    id: s.id,
    organisationId: s.organisationId,
    queueId: s.queueId,
    queueName: s.queue.name,
    name: s.name,
    description: s.description,
    type: s.type,
    status: s.status,
    jobName: s.jobName,
    payload: s.payload,
    priority: s.priority,
    maxRetries: s.maxRetries,
    backoffMs: s.backoffMs,
    cronExpression: s.cronExpression,
    timezone: s.timezone,
    runAt: s.runAt,
    nextRunAt: s.nextRunAt,
    nextRunAtLocal: s.nextRunAt ? formatInTimezone(s.nextRunAt, s.timezone) : null,
    lastRunAt: s.lastRunAt,
    lastDispatchedAt: s.lastDispatchedAt,
    runCount: s.runCount,
    preventOverlap: s.preventOverlap,
    misfirePolicy: s.misfirePolicy,
    maxCatchUpRuns: s.maxCatchUpRuns,
    misfireGraceMs: s.misfireGraceMs,
    maxConcurrentRuns: s.maxConcurrentRuns,
    maxTotalRuns: s.maxTotalRuns,
    maxDurationMs: s.maxDurationMs,
    minIntervalMs: s.minIntervalMs,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const MAX_IMMEDIATE_DELAY_MS = 86_400_000; // 24 hours (safely within PostgreSQL INT4 delay_ms)

export class ScheduleService {
  /**
   * Creates a one-time or recurring schedule scoped strictly to `orgId`.
   * - Near-term ONE_TIME schedules (<= 24h away) atomically commit Schedule + delayed Job +
   *   ScheduleExecution + Outbox and dispatch a BullMQ delayed job using stable `jobId = job.id`.
   * - Far-future ONE_TIME schedules (> 24h away) persist durably in PostgreSQL without overflowing
   *   INT4 `delay_ms` or holding long-lived Redis keys; `ScheduleDispatcherService` materializes
   *   and dispatches the job automatically as `runAt` enters the dispatch lookahead window.
   * - RECURRING schedules validate cron + IANA timezone and persist canonical UTC `nextRunAt`.
   */
  async create(
    orgId: string,
    userId: string,
    input: CreateScheduleServiceInput,
  ): Promise<CreateScheduleResult> {
    const now = new Date();
    const timezone = input.timezone ?? 'UTC';
    const payload = input.payload ?? {};
    const misfirePolicy = input.misfirePolicy ?? MisfirePolicy.SKIP_MISSED;
    const maxCatchUpRuns = input.maxCatchUpRuns ?? SCHEDULE_LIMITS.DEFAULT_CATCH_UP_RUNS;
    const misfireGraceMs = input.misfireGraceMs ?? SCHEDULE_LIMITS.DEFAULT_MISFIRE_GRACE_MS;

    let runAtUtc: Date | null = null;
    let nextRunAtUtc: Date | null = null;
    let cronExpression: string | null = null;

    if (input.type === ScheduleType.ONE_TIME) {
      runAtUtc = parseScheduledTimestamp(input.runAt!, timezone, now);
      nextRunAtUtc = runAtUtc;
    } else {
      cronExpression = input.cronExpression!.trim();
      validateCronExpression(cronExpression, timezone);
      nextRunAtUtc = computeNextCronRun(cronExpression, timezone, now);
    }

    const effectiveMaxConcurrentRuns = input.maxConcurrentRuns ?? null;
    const effectivePreventOverlap =
      input.preventOverlap !== undefined
        ? input.preventOverlap
        : effectiveMaxConcurrentRuns !== null && effectiveMaxConcurrentRuns > 1
          ? false
          : true;

    // Verify queue belongs to the authenticated user's organisation
    const queue = await db.queue.findFirst({
      where: { id: input.queueId, organisationId: orgId },
    });

    if (!queue) {
      throw new NotFoundError('Queue not found');
    }

    // Check duplicate schedule name within organisation
    const duplicate = await db.schedule.findUnique({
      where: { organisationId_name: { organisationId: orgId, name: input.name } },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictError(
        `A schedule named "${input.name}" already exists in this organisation`,
      );
    }

    const commonControlFields = {
      preventOverlap: effectivePreventOverlap,
      misfirePolicy,
      maxCatchUpRuns,
      misfireGraceMs,
      maxConcurrentRuns: effectiveMaxConcurrentRuns,
      maxTotalRuns: input.maxTotalRuns ?? null,
      maxDurationMs: input.maxDurationMs ?? null,
      minIntervalMs: input.minIntervalMs ?? null,
    };

    try {
      if (input.type === ScheduleType.ONE_TIME && runAtUtc) {
        const delayMs = Math.max(0, runAtUtc.getTime() - Date.now());

        if (delayMs > MAX_IMMEDIATE_DELAY_MS) {
          const schedule = await db.schedule.create({
            data: {
              organisationId: orgId,
              queueId: queue.id,
              name: input.name,
              description: input.description ?? null,
              type: ScheduleType.ONE_TIME,
              status: ScheduleStatus.ACTIVE,
              jobName: input.jobName,
              payload: payload as Prisma.InputJsonValue,
              priority: input.priority ?? null,
              maxRetries: input.maxRetries ?? null,
              backoffMs: input.backoffMs ?? null,
              timezone,
              runAt: runAtUtc,
              nextRunAt: runAtUtc,
              ...commonControlFields,
              createdById: userId,
            },
            include: SCHEDULE_INCLUDE,
          });

          logger.info('Far-future one-time schedule created (deferred dispatch window)', {
            scheduleId: schedule.id,
            organisationId: orgId,
            queueId: queue.id,
            runAt: runAtUtc.toISOString(),
            timezone,
          });

          return { schedule: toScheduleView(schedule) };
        }

        const initialJobStatus = queue.isPaused ? JobStatus.PAUSED : JobStatus.DELAYED;

        const { schedule, createdJob, executionId, outboxId } = await db.$transaction(
          async (tx) => {
            await governanceService.enforceAdmissionInTransaction(tx, {
              orgId,
              queue: {
                id: queue.id,
                name: queue.name,
                maxQueueDepth: queue.maxQueueDepth,
                backpressureMaxAgeMs: queue.backpressureMaxAgeMs,
              },
              payload,
              initialStatus: initialJobStatus,
            });

            const sched = await tx.schedule.create({
              data: {
                organisationId: orgId,
                queueId: queue.id,
                name: input.name,
                description: input.description ?? null,
                type: ScheduleType.ONE_TIME,
                status: ScheduleStatus.ACTIVE,
                jobName: input.jobName,
                payload: payload as Prisma.InputJsonValue,
                priority: input.priority ?? null,
                maxRetries: input.maxRetries ?? null,
                backoffMs: input.backoffMs ?? null,
                timezone,
                runAt: runAtUtc,
                nextRunAt: runAtUtc,
                lastDispatchedAt: now,
                ...commonControlFields,
                createdById: userId,
              },
              include: SCHEDULE_INCLUDE,
            });

            const job = await tx.job.create({
              data: {
                queueId: queue.id,
                name: input.jobName,
                status: initialJobStatus,
                priority: input.priority ?? queue.defaultPriority,
                payload: payload as Prisma.InputJsonValue,
                maxRetries: input.maxRetries ?? queue.maxRetries,
                backoffMs: input.backoffMs ?? queue.backoffMs,
                delayMs,
                createdById: userId,
              },
            });

            const exec = await tx.scheduleExecution.create({
              data: {
                scheduleId: sched.id,
                jobId: job.id,
                scheduledFor: runAtUtc,
                status: ScheduleExecutionStatus.SCHEDULED,
                finalJobStatus: initialJobStatus,
              },
              select: { id: true },
            });

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
              schedule: sched,
              createdJob: job,
              executionId: exec.id,
              outboxId: outbox.id,
            };
          },
          { maxWait: 10_000, timeout: 10_000 },
        );

        const dispatch = await bullMQService.enqueueJob(queue, createdJob);

        if (dispatch.enqueued) {
          const dispatchedAt = new Date();
          await Promise.all([
            db.jobDispatchOutbox.updateMany({
              where: { id: outboxId, status: OutboxStatus.PENDING },
              data: {
                status: OutboxStatus.DISPATCHED,
                dispatchedAt,
                attempts: { increment: 1 },
                lastError: null,
              },
            }),
            db.scheduleExecution.updateMany({
              where: { id: executionId, dispatchedAt: null },
              data: { dispatchedAt },
            }),
          ]);
        } else {
          await db.jobDispatchOutbox.updateMany({
            where: { id: outboxId, status: OutboxStatus.PENDING },
            data: {
              attempts: { increment: 1 },
              lastError: (dispatch.error ?? 'Redis unavailable').slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + 2000),
            },
          });
        }

        await eventService.record({
          type: PlatformEventType.JOB_SUBMITTED,
          organisationId: orgId,
          queueId: queue.id,
          jobId: createdJob.id,
          message: `One-time scheduled job "${createdJob.name}" scheduled for ${runAtUtc.toISOString()}`,
          metadata: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            timezone,
            runAt: runAtUtc.toISOString(),
            enqueued: dispatch.enqueued,
          },
        });

        logger.info('One-time schedule created', {
          scheduleId: schedule.id,
          organisationId: orgId,
          queueId: queue.id,
          jobId: createdJob.id,
          runAt: runAtUtc.toISOString(),
          timezone,
        });

        return {
          schedule: toScheduleView(schedule),
          initialJobId: createdJob.id,
          dispatch,
        };
      }

      // RECURRING schedule creation
      const schedule = await db.schedule.create({
        data: {
          organisationId: orgId,
          queueId: queue.id,
          name: input.name,
          description: input.description ?? null,
          type: ScheduleType.RECURRING,
          status: ScheduleStatus.ACTIVE,
          jobName: input.jobName,
          payload: payload as Prisma.InputJsonValue,
          priority: input.priority ?? null,
          maxRetries: input.maxRetries ?? null,
          backoffMs: input.backoffMs ?? null,
          cronExpression,
          timezone,
          nextRunAt: nextRunAtUtc,
          ...commonControlFields,
          createdById: userId,
        },
        include: SCHEDULE_INCLUDE,
      });

      logger.info('Recurring schedule created', {
        scheduleId: schedule.id,
        organisationId: orgId,
        queueId: queue.id,
        cronExpression,
        timezone,
        misfirePolicy: schedule.misfirePolicy,
        nextRunAt: nextRunAtUtc?.toISOString(),
      });

      return { schedule: toScheduleView(schedule) };
    } catch (err) {
      if (err instanceof TooManyRequestsError) {
        const details = err.details as AdmissionRejectionDetails | undefined;
        await eventService.record({
          type: PlatformEventType.JOB_ADMISSION_REJECTED,
          organisationId: orgId,
          queueId: queue.id,
          message: err.message,
          metadata: {
            source: 'schedule_create',
            scheduleName: input.name,
            jobName: input.jobName,
            reason: details?.reason ?? 'QUOTA_EXCEEDED',
            scope: details?.scope ?? 'organisation',
            limit: details?.limit ?? null,
            current: details?.current ?? null,
            retryAfterSeconds: details?.retryAfterSeconds ?? 5,
          },
        });
        throw err;
      }
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(
          `A schedule named "${input.name}" already exists in this organisation`,
        );
      }
      throw err;
    }
  }

  async list(orgId: string, query: ListSchedulesQuery): Promise<PaginatedSchedulesView> {
    const where: Prisma.ScheduleWhereInput = {
      organisationId: orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.queueId ? { queueId: query.queueId } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, schedules] = await Promise.all([
      db.schedule.count({ where }),
      db.schedule.findMany({
        where,
        include: SCHEDULE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      schedules: schedules.map(toScheduleView),
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

  async getById(orgId: string, scheduleId: string): Promise<ScheduleView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const schedule = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: SCHEDULE_INCLUDE,
    });

    if (!schedule) {
      throw new NotFoundError('Schedule not found');
    }

    return toScheduleView(schedule);
  }

  async update(
    orgId: string,
    scheduleId: string,
    input: UpdateScheduleInput,
    actorUserId: string,
  ): Promise<ScheduleView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const existing = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: { queue: true },
    });

    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }

    if (isTerminalScheduleStatus(existing.status)) {
      throw new ConflictError(`Cannot update a schedule in ${existing.status} status`);
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const dup = await db.schedule.findUnique({
        where: { organisationId_name: { organisationId: orgId, name: input.name } },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictError(
          `A schedule named "${input.name}" already exists in this organisation`,
        );
      }
    }

    // Validate concurrency combination against existing settings
    const effectiveMaxConcurrentRuns =
      input.maxConcurrentRuns !== undefined ? input.maxConcurrentRuns : existing.maxConcurrentRuns;
    let effectivePreventOverlap =
      input.preventOverlap !== undefined ? input.preventOverlap : existing.preventOverlap;

    if (effectiveMaxConcurrentRuns !== null && effectiveMaxConcurrentRuns > 1) {
      if (input.preventOverlap === true) {
        throw new BadRequestError(
          'preventOverlap: true cannot be combined with maxConcurrentRuns > 1',
        );
      }
      if (input.maxConcurrentRuns !== undefined && input.preventOverlap === undefined) {
        effectivePreventOverlap = false;
      }
    }

    // Validate maxTotalRuns against persisted runCount
    if (
      input.maxTotalRuns !== undefined &&
      input.maxTotalRuns !== null &&
      input.maxTotalRuns < existing.runCount
    ) {
      throw new BadRequestError(
        `maxTotalRuns (${input.maxTotalRuns}) cannot be less than current runCount (${existing.runCount})`,
      );
    }

    const now = new Date();
    const effectiveTimezone = input.timezone ?? existing.timezone;
    let nextRunAt = existing.nextRunAt;
    let runAt = existing.runAt;
    let cronExpression = existing.cronExpression;
    let nextStatus: ScheduleStatus = existing.status;

    if (existing.type === ScheduleType.ONE_TIME) {
      if (input.cronExpression !== undefined) {
        throw new BadRequestError('cronExpression cannot be set on a ONE_TIME schedule');
      }
      if (input.runAt !== undefined) {
        runAt = parseScheduledTimestamp(input.runAt, effectiveTimezone, now);
        nextRunAt = existing.status === ScheduleStatus.ACTIVE ? runAt : existing.nextRunAt;
      }
    } else {
      if (input.runAt !== undefined) {
        throw new BadRequestError('runAt cannot be set on a RECURRING schedule');
      }
      if (input.cronExpression !== undefined || input.timezone !== undefined) {
        cronExpression = (input.cronExpression ?? existing.cronExpression)!.trim();
        validateCronExpression(cronExpression, effectiveTimezone);
        if (existing.status === ScheduleStatus.ACTIVE) {
          // Always compute strictly after max(now, lastRunAt) so already-materialized occurrences cannot duplicate
          const baseTime =
            existing.lastRunAt && existing.lastRunAt.getTime() > now.getTime()
              ? existing.lastRunAt
              : now;
          nextRunAt = computeNextCronRun(cronExpression, effectiveTimezone, baseTime);
        }
      }
    }

    if (
      input.maxTotalRuns !== undefined &&
      input.maxTotalRuns !== null &&
      input.maxTotalRuns === existing.runCount &&
      existing.status === ScheduleStatus.ACTIVE
    ) {
      nextStatus = ScheduleStatus.COMPLETED;
      nextRunAt = null;
    }

    const updated = await db.schedule.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.jobName !== undefined ? { jobName: input.jobName } : {}),
        ...(input.payload !== undefined ? { payload: input.payload as Prisma.InputJsonValue } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
        ...(input.backoffMs !== undefined ? { backoffMs: input.backoffMs } : {}),
        ...(input.misfirePolicy !== undefined ? { misfirePolicy: input.misfirePolicy } : {}),
        ...(input.maxCatchUpRuns !== undefined ? { maxCatchUpRuns: input.maxCatchUpRuns } : {}),
        ...(input.misfireGraceMs !== undefined ? { misfireGraceMs: input.misfireGraceMs } : {}),
        ...(input.maxTotalRuns !== undefined ? { maxTotalRuns: input.maxTotalRuns } : {}),
        ...(input.maxDurationMs !== undefined ? { maxDurationMs: input.maxDurationMs } : {}),
        ...(input.minIntervalMs !== undefined ? { minIntervalMs: input.minIntervalMs } : {}),
        preventOverlap: effectivePreventOverlap,
        maxConcurrentRuns: effectiveMaxConcurrentRuns,
        status: nextStatus,
        timezone: effectiveTimezone,
        cronExpression,
        runAt,
        nextRunAt,
      },
      include: SCHEDULE_INCLUDE,
    });

    // If a ONE_TIME schedule's runAt changed while ACTIVE, reschedule its pre-execution job cleanly
    if (
      existing.type === ScheduleType.ONE_TIME &&
      nextStatus === ScheduleStatus.ACTIVE &&
      input.runAt !== undefined &&
      runAt
    ) {
      await this.cancelPendingOneTimeJobs(existing.id, orgId, existing.queue);
      await this.scheduleOneTimeExecution(updated, existing.queue, runAt, actorUserId);
    }

    logger.info('Schedule updated', {
      scheduleId: updated.id,
      organisationId: orgId,
      updatedBy: actorUserId,
    });

    return toScheduleView(updated);
  }

  /**
   * Pauses an ACTIVE schedule. Stops recurring occurrences immediately and cancels any
   * pre-execution pending one-time job in PostgreSQL + BullMQ so it does not fire while paused.
   */
  async pause(orgId: string, scheduleId: string, actorUserId: string): Promise<ScheduleView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const existing = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: { ...SCHEDULE_INCLUDE, queue: true },
    });

    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }

    if (existing.status === ScheduleStatus.PAUSED) {
      return toScheduleView(existing);
    }

    assertValidScheduleTransition(existing.status, ScheduleStatus.PAUSED, 'pause schedule');

    if (existing.type === ScheduleType.ONE_TIME) {
      await this.cancelPendingOneTimeJobs(existing.id, orgId, existing.queue);
    }

    const updated = await db.schedule.update({
      where: { id: existing.id },
      data: {
        status: ScheduleStatus.PAUSED,
        nextRunAt: null,
      },
      include: SCHEDULE_INCLUDE,
    });

    logger.info('Schedule paused', {
      scheduleId: updated.id,
      organisationId: orgId,
      pausedBy: actorUserId,
    });

    return toScheduleView(updated);
  }

  /**
   * Resumes a PAUSED schedule, recalculating a valid future `nextRunAt` and
   * re-enqueueing one-time schedules if `runAt` is still in the future.
   */
  async resume(orgId: string, scheduleId: string, actorUserId: string): Promise<ScheduleView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const existing = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: { ...SCHEDULE_INCLUDE, queue: true },
    });

    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }

    if (existing.status === ScheduleStatus.ACTIVE) {
      return toScheduleView(existing);
    }

    assertValidScheduleTransition(existing.status, ScheduleStatus.ACTIVE, 'resume schedule');

    if (existing.maxTotalRuns !== null && existing.runCount >= existing.maxTotalRuns) {
      throw new ConflictError(
        `Cannot resume schedule: it has already reached maxTotalRuns (${existing.maxTotalRuns})`,
      );
    }

    const now = new Date();
    let nextRunAt: Date;

    if (existing.type === ScheduleType.RECURRING) {
      const baseTime =
        existing.lastRunAt && existing.lastRunAt.getTime() > now.getTime()
          ? existing.lastRunAt
          : now;
      nextRunAt = computeNextCronRun(existing.cronExpression!, existing.timezone, baseTime);
    } else {
      if (!existing.runAt || existing.runAt.getTime() <= now.getTime()) {
        throw new BadRequestError(
          'Cannot resume a ONE_TIME schedule whose runAt timestamp is in the past. Update runAt first.',
        );
      }
      nextRunAt = existing.runAt;
    }

    const updated = await db.schedule.update({
      where: { id: existing.id },
      data: {
        status: ScheduleStatus.ACTIVE,
        nextRunAt,
      },
      include: SCHEDULE_INCLUDE,
    });

    if (existing.type === ScheduleType.ONE_TIME && existing.runAt) {
      await this.scheduleOneTimeExecution(updated, existing.queue, existing.runAt, actorUserId);
    }

    logger.info('Schedule resumed', {
      scheduleId: updated.id,
      organisationId: orgId,
      nextRunAt: nextRunAt.toISOString(),
      resumedBy: actorUserId,
    });

    return toScheduleView(updated);
  }

  /**
   * Cancels a schedule permanently and removes any pre-execution pending jobs from PG & BullMQ,
   * leaving any already in-flight ACTIVE jobs intact so workers finish them safely.
   */
  async cancel(orgId: string, scheduleId: string, actorUserId: string): Promise<ScheduleView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const existing = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: { ...SCHEDULE_INCLUDE, queue: true },
    });

    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }

    if (existing.status === ScheduleStatus.CANCELLED) {
      return toScheduleView(existing);
    }

    assertValidScheduleTransition(existing.status, ScheduleStatus.CANCELLED, 'cancel schedule');

    await this.cancelPendingOneTimeJobs(existing.id, orgId, existing.queue);

    const updated = await db.schedule.update({
      where: { id: existing.id },
      data: {
        status: ScheduleStatus.CANCELLED,
        nextRunAt: null,
      },
      include: SCHEDULE_INCLUDE,
    });

    logger.info('Schedule cancelled', {
      scheduleId: updated.id,
      organisationId: orgId,
      cancelledBy: actorUserId,
    });

    return toScheduleView(updated);
  }

  /**
   * Deletes a schedule safely (OWNER only), cancelling any pre-execution pending jobs first
   * while allowing any in-flight ACTIVE jobs to complete cleanly.
   */
  async delete(orgId: string, scheduleId: string, actorUserId: string): Promise<void> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const existing = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      include: { queue: true },
    });

    if (!existing) {
      throw new NotFoundError('Schedule not found');
    }

    await this.cancelPendingOneTimeJobs(existing.id, orgId, existing.queue);

    await db.schedule.deleteMany({
      where: { id: existing.id, organisationId: orgId },
    });

    logger.info('Schedule deleted', {
      scheduleId: existing.id,
      organisationId: orgId,
      deletedBy: actorUserId,
    });
  }

  /**
   * Lists immutable execution history for a schedule scoped strictly to `orgId`.
   */
  async listExecutions(
    orgId: string,
    scheduleId: string,
    query: ListScheduleExecutionsQuery,
  ): Promise<PaginatedScheduleExecutionsView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const schedule = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
      select: { id: true },
    });

    if (!schedule) {
      throw new NotFoundError('Schedule not found');
    }

    const where: Prisma.ScheduleExecutionWhereInput = {
      scheduleId: schedule.id,
      ...(query.status ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, executions] = await Promise.all([
      db.scheduleExecution.count({ where }),
      db.scheduleExecution.findMany({
        where,
        include: {
          job: {
            select: {
              id: true,
              status: true,
              priority: true,
              attemptsMade: true,
              durationMs: true,
              errorMessage: true,
              startedAt: true,
              completedAt: true,
              failedAt: true,
            },
          },
        },
        orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      executions,
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
   * Computes genuine PostgreSQL-persisted statistics for an organisation-scoped schedule.
   */
  async getStats(orgId: string, scheduleId: string): Promise<ScheduleStatsView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const schedule = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
    });

    if (!schedule) {
      throw new NotFoundError('Schedule not found');
    }

    const [statusGroups, jobStatusGroups, catchUpCount, currentInFlight, agg] = await Promise.all([
      db.scheduleExecution.groupBy({
        by: ['status'],
        where: { scheduleId: schedule.id },
        _count: { _all: true },
      }),
      db.scheduleExecution.groupBy({
        by: ['finalJobStatus'],
        where: { scheduleId: schedule.id, finalJobStatus: { not: null } },
        _count: { _all: true },
      }),
      db.scheduleExecution.count({
        where: { scheduleId: schedule.id, isCatchUp: true },
      }),
      db.job.count({
        where: {
          scheduleExecution: { scheduleId: schedule.id },
          status: { in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED] },
        },
      }),
      db.scheduleExecution.aggregate({
        where: { scheduleId: schedule.id },
        _count: { _all: true },
        _sum: { retryCount: true },
        _avg: { durationMs: true },
        _min: { durationMs: true },
        _max: { durationMs: true },
      }),
    ]);

    const statusMap = new Map<ScheduleExecutionStatus, number>();
    for (const row of statusGroups) {
      statusMap.set(row.status, row._count._all);
    }

    const jobStatusMap = new Map<JobStatus, number>();
    for (const row of jobStatusGroups) {
      if (row.finalJobStatus) {
        jobStatusMap.set(row.finalJobStatus, row._count._all);
      }
    }

    const inFlightFromFinal =
      (jobStatusMap.get(JobStatus.PENDING) ?? 0) +
      (jobStatusMap.get(JobStatus.ACTIVE) ?? 0) +
      (jobStatusMap.get(JobStatus.DELAYED) ?? 0);

    return {
      scheduleId: schedule.id,
      name: schedule.name,
      type: schedule.type,
      status: schedule.status,
      misfirePolicy: schedule.misfirePolicy,
      runCount: schedule.runCount,
      maxTotalRuns: schedule.maxTotalRuns,
      remainingRuns:
        schedule.maxTotalRuns !== null
          ? Math.max(0, schedule.maxTotalRuns - schedule.runCount)
          : null,
      currentInFlight,
      totalExecutions: agg._count._all,
      catchUpExecutions: catchUpCount,
      byStatus: {
        scheduled: statusMap.get(ScheduleExecutionStatus.SCHEDULED) ?? 0,
        dispatched: statusMap.get(ScheduleExecutionStatus.DISPATCHED) ?? 0,
        missed: statusMap.get(ScheduleExecutionStatus.MISSED) ?? 0,
        skippedOverlap: statusMap.get(ScheduleExecutionStatus.SKIPPED_OVERLAP) ?? 0,
        skippedConcurrency: statusMap.get(ScheduleExecutionStatus.SKIPPED_CONCURRENCY) ?? 0,
        skippedMinInterval: statusMap.get(ScheduleExecutionStatus.SKIPPED_MIN_INTERVAL) ?? 0,
        skippedMaxRuns: statusMap.get(ScheduleExecutionStatus.SKIPPED_MAX_RUNS) ?? 0,
        cancelled: statusMap.get(ScheduleExecutionStatus.CANCELLED) ?? 0,
      },
      byFinalJobStatus: {
        completed: jobStatusMap.get(JobStatus.COMPLETED) ?? 0,
        failed: jobStatusMap.get(JobStatus.FAILED) ?? 0,
        inFlight: inFlightFromFinal,
      },
      totalRetries: agg._sum.retryCount ?? 0,
      durationMs: {
        avg: agg._avg.durationMs !== null ? Math.round(agg._avg.durationMs) : null,
        min: agg._min.durationMs,
        max: agg._max.durationMs,
      },
      lastRunAt: schedule.lastRunAt,
      lastDispatchedAt: schedule.lastDispatchedAt,
      nextRunAt: schedule.nextRunAt,
    };
  }

  /**
   * Runs an organisation-scoped BullMQ reconciliation + scheduling recovery pass.
   */
  async reconcileOrganisationSchedules(orgId: string): Promise<ReconcileSchedulesResult> {
    const bullmq = await scheduleDispatcherService.reconcileWithBullMQ({ organisationId: orgId });
    const tick = await scheduleDispatcherService.tick(new Date(), { organisationId: orgId });
    return { bullmq, tick };
  }

  /**
   * Returns next execution timestamp (UTC + schedule timezone) and up to 5 upcoming runs.
   */
  async getNextRunPreview(orgId: string, scheduleId: string): Promise<NextRunPreviewView> {
    if (!uuidSchema.safeParse(scheduleId).success) {
      throw new NotFoundError('Schedule not found');
    }

    const schedule = await db.schedule.findFirst({
      where: { id: scheduleId, organisationId: orgId },
    });

    if (!schedule) {
      throw new NotFoundError('Schedule not found');
    }

    let upcomingDates: Date[] = [];

    if (schedule.status === ScheduleStatus.ACTIVE) {
      if (schedule.type === ScheduleType.RECURRING && schedule.cronExpression) {
        const base =
          schedule.nextRunAt && schedule.nextRunAt.getTime() > Date.now()
            ? new Date(schedule.nextRunAt.getTime() - 1)
            : new Date();
        upcomingDates = computeUpcomingCronRuns(
          schedule.cronExpression,
          schedule.timezone,
          5,
          base,
        );
      } else if (schedule.type === ScheduleType.ONE_TIME && schedule.nextRunAt) {
        upcomingDates = [schedule.nextRunAt];
      }
    }

    return {
      scheduleId: schedule.id,
      type: schedule.type,
      status: schedule.status,
      timezone: schedule.timezone,
      cronExpression: schedule.cronExpression,
      nextRunAt: schedule.nextRunAt,
      nextRunAtLocal: schedule.nextRunAt
        ? formatInTimezone(schedule.nextRunAt, schedule.timezone)
        : null,
      upcomingRuns: upcomingDates.map((d) => ({
        utc: d.toISOString(),
        local: formatInTimezone(d, schedule.timezone),
      })),
    };
  }

  private async cancelPendingOneTimeJobs(
    scheduleId: string,
    orgId: string,
    queue: {
      id: string;
      organisationId: string;
      name: string;
      isPaused: boolean;
      concurrency: number;
      defaultPriority: number;
      maxRetries: number;
      backoffMs: number;
    },
  ): Promise<void> {
    const executions = await db.scheduleExecution.findMany({
      where: {
        scheduleId,
        status: { in: [ScheduleExecutionStatus.SCHEDULED, ScheduleExecutionStatus.DISPATCHED] },
        jobId: { not: null },
      },
      include: { job: { select: { id: true, status: true } } },
    });

    for (const exec of executions) {
      if (exec.job && isCancellableJobStatus(exec.job.status)) {
        await db.job.deleteMany({
          where: {
            id: exec.job.id,
            status: exec.job.status,
            queue: { organisationId: orgId },
          },
        });
        await bullMQService.removeJobFromBullMQ(queue, exec.job.id);
        await db.scheduleExecution.update({
          where: { id: exec.id },
          data: {
            status: ScheduleExecutionStatus.CANCELLED,
            jobId: null,
            reason: 'Cancelled before job execution started',
          },
        });
      }
    }
  }

  private async scheduleOneTimeExecution(
    schedule: ScheduleWithMeta,
    queue: {
      id: string;
      organisationId: string;
      name: string;
      isPaused: boolean;
      concurrency: number;
      defaultPriority: number;
      maxRetries: number;
      backoffMs: number;
    },
    runAtUtc: Date,
    actorUserId: string,
  ): Promise<void> {
    const delayMs = Math.max(0, runAtUtc.getTime() - Date.now());

    // Far-future one-time schedules (> 24h) remain durably in PostgreSQL until the dispatcher window
    if (delayMs > MAX_IMMEDIATE_DELAY_MS) {
      return;
    }

    const initialJobStatus = queue.isPaused ? JobStatus.PAUSED : JobStatus.DELAYED;

    const { createdJob, executionId, outboxId } = await db.$transaction(
      async (tx) => {
        const job = await tx.job.create({
          data: {
            queueId: queue.id,
            name: schedule.jobName,
            status: initialJobStatus,
            priority: schedule.priority ?? queue.defaultPriority,
            payload: schedule.payload as Prisma.InputJsonValue,
            maxRetries: schedule.maxRetries ?? queue.maxRetries,
            backoffMs: schedule.backoffMs ?? queue.backoffMs,
            delayMs,
            createdById: actorUserId,
          },
        });

        const exec = await tx.scheduleExecution.upsert({
          where: {
            scheduleId_scheduledFor: {
              scheduleId: schedule.id,
              scheduledFor: runAtUtc,
            },
          },
          create: {
            scheduleId: schedule.id,
            jobId: job.id,
            scheduledFor: runAtUtc,
            status: ScheduleExecutionStatus.SCHEDULED,
            finalJobStatus: initialJobStatus,
          },
          update: {
            jobId: job.id,
            status: ScheduleExecutionStatus.SCHEDULED,
            finalJobStatus: initialJobStatus,
            reason: null,
          },
          select: { id: true },
        });

        const outbox = await tx.jobDispatchOutbox.create({
          data: {
            jobId: job.id,
            queueId: queue.id,
            organisationId: schedule.organisationId,
            status: OutboxStatus.PENDING,
          },
          select: { id: true },
        });

        await tx.schedule.update({
          where: { id: schedule.id },
          data: { lastDispatchedAt: new Date() },
        });

        return { createdJob: job, executionId: exec.id, outboxId: outbox.id };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    const dispatch = await bullMQService.enqueueJob(queue, createdJob);
    if (dispatch.enqueued) {
      const dispatchedAt = new Date();
      await Promise.all([
        db.jobDispatchOutbox.updateMany({
          where: { id: outboxId, status: OutboxStatus.PENDING },
          data: {
            status: OutboxStatus.DISPATCHED,
            dispatchedAt,
            attempts: { increment: 1 },
            lastError: null,
          },
        }),
        db.scheduleExecution.updateMany({
          where: { id: executionId, dispatchedAt: null },
          data: { dispatchedAt },
        }),
      ]);
    }
  }
}

export const scheduleService = new ScheduleService();

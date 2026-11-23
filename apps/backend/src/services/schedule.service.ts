import {
  JobStatus,
  OutboxStatus,
  PlatformEventType,
  Prisma,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isCancellableJobStatus } from '../utils/jobLifecycle.js';
import {
  computeNextCronRun,
  computeUpcomingCronRuns,
  formatInTimezone,
  parseScheduledTimestamp,
  validateCronExpression,
} from '../utils/scheduleTime.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import type {
  CreateScheduleInput,
  ListScheduleExecutionsQuery,
  ListSchedulesQuery,
  UpdateScheduleInput,
} from '../validators/schedule.validator.js';
import { bullMQService, type EnqueueResult } from './bullmq.service.js';
import { eventService } from './event.service.js';

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
  runCount: number;
  preventOverlap: boolean;
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
    runCount: s.runCount,
    preventOverlap: s.preventOverlap,
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
    input: CreateScheduleInput,
  ): Promise<CreateScheduleResult> {
    const now = new Date();
    const timezone = input.timezone;

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
              payload: input.payload as Prisma.InputJsonValue,
              priority: input.priority ?? null,
              maxRetries: input.maxRetries ?? null,
              backoffMs: input.backoffMs ?? null,
              timezone,
              runAt: runAtUtc,
              nextRunAt: runAtUtc,
              preventOverlap: input.preventOverlap,
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

        const { schedule, createdJob, outboxId } = await db.$transaction(
          async (tx) => {
            const sched = await tx.schedule.create({
              data: {
                organisationId: orgId,
                queueId: queue.id,
                name: input.name,
                description: input.description ?? null,
                type: ScheduleType.ONE_TIME,
                status: ScheduleStatus.ACTIVE,
                jobName: input.jobName,
                payload: input.payload as Prisma.InputJsonValue,
                priority: input.priority ?? null,
                maxRetries: input.maxRetries ?? null,
                backoffMs: input.backoffMs ?? null,
                timezone,
                runAt: runAtUtc,
                nextRunAt: runAtUtc,
                preventOverlap: input.preventOverlap,
                createdById: userId,
              },
              include: SCHEDULE_INCLUDE,
            });

            const job = await tx.job.create({
              data: {
                queueId: queue.id,
                name: input.jobName,
                status: queue.isPaused ? JobStatus.PAUSED : JobStatus.DELAYED,
                priority: input.priority ?? queue.defaultPriority,
                payload: input.payload as Prisma.InputJsonValue,
                maxRetries: input.maxRetries ?? queue.maxRetries,
                backoffMs: input.backoffMs ?? queue.backoffMs,
                delayMs,
                createdById: userId,
              },
            });

            await tx.scheduleExecution.create({
              data: {
                scheduleId: sched.id,
                jobId: job.id,
                scheduledFor: runAtUtc,
                status: ScheduleExecutionStatus.SCHEDULED,
              },
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

            return { schedule: sched, createdJob: job, outboxId: outbox.id };
          },
          { maxWait: 10_000, timeout: 10_000 },
        );

        const dispatch = await bullMQService.enqueueJob(queue, createdJob);

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
          payload: input.payload as Prisma.InputJsonValue,
          priority: input.priority ?? null,
          maxRetries: input.maxRetries ?? null,
          backoffMs: input.backoffMs ?? null,
          cronExpression,
          timezone,
          nextRunAt: nextRunAtUtc,
          preventOverlap: input.preventOverlap,
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
        nextRunAt: nextRunAtUtc?.toISOString(),
      });

      return { schedule: toScheduleView(schedule) };
    } catch (err) {
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

    if (
      existing.status === ScheduleStatus.COMPLETED ||
      existing.status === ScheduleStatus.CANCELLED
    ) {
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

    const effectiveTimezone = input.timezone ?? existing.timezone;
    let nextRunAt = existing.nextRunAt;
    let runAt = existing.runAt;
    let cronExpression = existing.cronExpression;

    if (existing.type === ScheduleType.ONE_TIME) {
      if (input.cronExpression !== undefined) {
        throw new BadRequestError('cronExpression cannot be set on a ONE_TIME schedule');
      }
      if (input.runAt !== undefined) {
        runAt = parseScheduledTimestamp(input.runAt, effectiveTimezone, new Date());
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
          nextRunAt = computeNextCronRun(cronExpression, effectiveTimezone, new Date());
        }
      }
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
        ...(input.preventOverlap !== undefined ? { preventOverlap: input.preventOverlap } : {}),
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
      existing.status === ScheduleStatus.ACTIVE &&
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

    if (
      existing.status === ScheduleStatus.COMPLETED ||
      existing.status === ScheduleStatus.CANCELLED
    ) {
      throw new ConflictError(`Cannot pause a schedule in ${existing.status} status`);
    }

    if (existing.status === ScheduleStatus.PAUSED) {
      return toScheduleView(existing);
    }

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

    if (
      existing.status === ScheduleStatus.COMPLETED ||
      existing.status === ScheduleStatus.CANCELLED
    ) {
      throw new ConflictError(`Cannot resume a schedule in ${existing.status} status`);
    }

    if (existing.status === ScheduleStatus.ACTIVE) {
      return toScheduleView(existing);
    }

    const now = new Date();
    let nextRunAt: Date;

    if (existing.type === ScheduleType.RECURRING) {
      nextRunAt = computeNextCronRun(existing.cronExpression!, existing.timezone, now);
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
   * Cancels a schedule permanently and removes any pre-execution pending jobs from PG & BullMQ.
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

    if (existing.status === ScheduleStatus.COMPLETED) {
      throw new ConflictError('Cannot cancel a schedule that has already completed');
    }

    if (existing.status === ScheduleStatus.CANCELLED) {
      return toScheduleView(existing);
    }

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
   * Deletes a schedule safely (OWNER only), cancelling any pre-execution pending jobs first.
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
   * Lists execution history for a schedule scoped strictly to `orgId`.
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

    const skip = (query.page - 1) * query.limit;

    const [total, executions] = await Promise.all([
      db.scheduleExecution.count({ where: { scheduleId: schedule.id } }),
      db.scheduleExecution.findMany({
        where: { scheduleId: schedule.id },
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
          data: { status: ScheduleExecutionStatus.CANCELLED, jobId: null },
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

    const { createdJob, outboxId } = await db.$transaction(
      async (tx) => {
        const job = await tx.job.create({
          data: {
            queueId: queue.id,
            name: schedule.jobName,
            status: queue.isPaused ? JobStatus.PAUSED : JobStatus.DELAYED,
            priority: schedule.priority ?? queue.defaultPriority,
            payload: schedule.payload as Prisma.InputJsonValue,
            maxRetries: schedule.maxRetries ?? queue.maxRetries,
            backoffMs: schedule.backoffMs ?? queue.backoffMs,
            delayMs,
            createdById: actorUserId,
          },
        });

        await tx.scheduleExecution.upsert({
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
          },
          update: {
            jobId: job.id,
            status: ScheduleExecutionStatus.SCHEDULED,
            reason: null,
          },
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

        return { createdJob: job, outboxId: outbox.id };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    const dispatch = await bullMQService.enqueueJob(queue, createdJob);
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
    }
  }
}

export const scheduleService = new ScheduleService();

import { JobStatus, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  assertValidJobTransition,
  isCancellableJobStatus,
  resolveInitialJobStatus,
} from '../utils/jobLifecycle.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import type { CreateJobInput, ListJobsQuery } from '../validators/job.validator.js';

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
    createdBy: j.createdBy,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

export class JobService {
  /**
   * Submits and persists a new job into an organisation-scoped queue.
   * Respects queue default priority, retry/backoff defaults, and pause state.
   */
  async create(
    orgId: string,
    queueId: string,
    userId: string,
    input: CreateJobInput,
  ): Promise<JobView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const job = await db.$transaction(
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
            defaultPriority: true,
            maxRetries: true,
            backoffMs: true,
          },
        });

        if (!queue) {
          throw new NotFoundError('Queue not found');
        }

        const initialStatus = resolveInitialJobStatus({
          queueIsPaused: queue.isPaused,
          delayMs: input.delayMs,
        });

        return tx.job.create({
          data: {
            queueId: queue.id,
            name: input.name,
            status: initialStatus,
            priority: input.priority ?? queue.defaultPriority,
            payload: input.payload as Prisma.InputJsonValue,
            maxRetries: input.maxRetries ?? queue.maxRetries,
            backoffMs: input.backoffMs ?? queue.backoffMs,
            delayMs: input.delayMs,
            createdById: userId,
          },
          include: JOB_INCLUDE,
        });
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    logger.info('Job submitted', {
      jobId: job.id,
      queueId: job.queueId,
      organisationId: orgId,
      status: job.status,
      priority: job.priority,
      createdById: userId,
    });

    return toJobView(job);
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

    // Fast-fail org-scoped check before acquiring a transaction connection slot
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

    const result = await db.$transaction(
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

        // Guarded delete ensures a concurrent status change cannot delete a started job
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

        return {
          cancelled: true as const,
          jobId: job.id,
          queueId: job.queueId,
          organisationId: orgId,
          previousStatus: job.status,
        };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

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
   * Trusted internal lifecycle transition method for future worker/scheduler subsystems.
   * Enforces valid JobStatus state transitions and strict organisation scoping.
   * Intentionally NOT exposed as a public client-facing status override endpoint.
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
}

export const jobService = new JobService();

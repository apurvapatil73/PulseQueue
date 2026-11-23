import { JobStatus, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import type { CreateQueueInput, UpdateQueueInput } from '../validators/queue.validator.js';
import { bullMQService } from './bullmq.service.js';

export interface QueueView {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  isPaused: boolean;
  pausedAt: Date | null;
  concurrency: number;
  defaultPriority: number;
  maxRetries: number;
  backoffMs: number;
  maxQueueDepth: number | null;
  backpressureMaxAgeMs: number | null;
  retryBudgetMaxRetries: number | null;
  retryBudgetWindowSeconds: number;
  poisonFailureThreshold: number;
  jobCount: number;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QueueStatsView {
  queueId: string;
  organisationId: string;
  name: string;
  isPaused: boolean;
  pausedAt: Date | null;
  config: {
    concurrency: number;
    defaultPriority: number;
    maxRetries: number;
    backoffMs: number;
  };
  jobs: {
    total: number;
    byStatus: Record<JobStatus, number>;
  };
  createdAt: Date;
  updatedAt: Date;
}

const QUEUE_INCLUDE = {
  _count: { select: { jobs: true } },
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

type QueueWithMeta = Prisma.QueueGetPayload<{ include: typeof QUEUE_INCLUDE }>;

function toQueueView(q: QueueWithMeta): QueueView {
  return {
    id: q.id,
    organisationId: q.organisationId,
    name: q.name,
    description: q.description,
    isPaused: q.isPaused,
    pausedAt: q.pausedAt,
    concurrency: q.concurrency,
    defaultPriority: q.defaultPriority,
    maxRetries: q.maxRetries,
    backoffMs: q.backoffMs,
    maxQueueDepth: q.maxQueueDepth,
    backpressureMaxAgeMs: q.backpressureMaxAgeMs,
    retryBudgetMaxRetries: q.retryBudgetMaxRetries,
    retryBudgetWindowSeconds: q.retryBudgetWindowSeconds,
    poisonFailureThreshold: q.poisonFailureThreshold,
    jobCount: q._count.jobs,
    createdBy: q.createdBy,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class QueueService {
  async create(orgId: string, userId: string, input: CreateQueueInput): Promise<QueueView> {
    const existing = await db.queue.findUnique({
      where: {
        organisationId_name: {
          organisationId: orgId,
          name: input.name,
        },
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(`A queue named "${input.name}" already exists in this organisation`);
    }

    try {
      const queue = await db.queue.create({
        data: {
          organisationId: orgId,
          name: input.name,
          description: input.description ?? null,
          concurrency: input.concurrency,
          defaultPriority: input.defaultPriority,
          maxRetries: input.maxRetries,
          backoffMs: input.backoffMs,
          ...(input.maxQueueDepth !== undefined ? { maxQueueDepth: input.maxQueueDepth } : {}),
          ...(input.backpressureMaxAgeMs !== undefined
            ? { backpressureMaxAgeMs: input.backpressureMaxAgeMs }
            : {}),
          ...(input.retryBudgetMaxRetries !== undefined
            ? { retryBudgetMaxRetries: input.retryBudgetMaxRetries }
            : {}),
          ...(input.retryBudgetWindowSeconds !== undefined
            ? { retryBudgetWindowSeconds: input.retryBudgetWindowSeconds }
            : {}),
          ...(input.poisonFailureThreshold !== undefined
            ? { poisonFailureThreshold: input.poisonFailureThreshold }
            : {}),
          createdById: userId,
        },
        include: QUEUE_INCLUDE,
      });

      logger.info('Queue created', {
        queueId: queue.id,
        organisationId: orgId,
        name: queue.name,
        createdById: userId,
      });

      return toQueueView(queue);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(
          `A queue named "${input.name}" already exists in this organisation`,
        );
      }
      throw err;
    }
  }

  async list(orgId: string, filters?: { isPaused?: boolean }): Promise<QueueView[]> {
    const queues = await db.queue.findMany({
      where: {
        organisationId: orgId,
        ...(filters?.isPaused !== undefined ? { isPaused: filters.isPaused } : {}),
      },
      include: QUEUE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return queues.map(toQueueView);
  }

  async getById(orgId: string, queueId: string): Promise<QueueView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const queue = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
      include: QUEUE_INCLUDE,
    });

    if (!queue) {
      throw new NotFoundError('Queue not found');
    }

    return toQueueView(queue);
  }

  async update(
    orgId: string,
    queueId: string,
    input: UpdateQueueInput,
    actorUserId: string,
  ): Promise<QueueView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const existing = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
    });

    if (!existing) {
      throw new NotFoundError('Queue not found');
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const duplicate = await db.queue.findUnique({
        where: {
          organisationId_name: {
            organisationId: orgId,
            name: input.name,
          },
        },
        select: { id: true },
      });

      if (duplicate) {
        throw new ConflictError(
          `A queue named "${input.name}" already exists in this organisation`,
        );
      }
    }

    try {
      const updated = await db.queue.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
          ...(input.defaultPriority !== undefined
            ? { defaultPriority: input.defaultPriority }
            : {}),
          ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
          ...(input.backoffMs !== undefined ? { backoffMs: input.backoffMs } : {}),
          ...(input.maxQueueDepth !== undefined ? { maxQueueDepth: input.maxQueueDepth } : {}),
          ...(input.backpressureMaxAgeMs !== undefined
            ? { backpressureMaxAgeMs: input.backpressureMaxAgeMs }
            : {}),
          ...(input.retryBudgetMaxRetries !== undefined
            ? { retryBudgetMaxRetries: input.retryBudgetMaxRetries }
            : {}),
          ...(input.retryBudgetWindowSeconds !== undefined
            ? { retryBudgetWindowSeconds: input.retryBudgetWindowSeconds }
            : {}),
          ...(input.poisonFailureThreshold !== undefined
            ? { poisonFailureThreshold: input.poisonFailureThreshold }
            : {}),
        },
        include: QUEUE_INCLUDE,
      });

      logger.info('Queue updated', {
        queueId: updated.id,
        organisationId: orgId,
        updatedBy: actorUserId,
      });

      // Keep BullMQ registry aligned if the queue was renamed or already registered
      if (input.name !== undefined && input.name !== existing.name) {
        await bullMQService.unregisterQueue(orgId, existing.name);
      } else if (bullMQService.getRegisteredQueue(orgId, updated.name)) {
        bullMQService.getOrRegisterQueue(updated);
      }

      return toQueueView(updated);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(
          `A queue named "${input.name}" already exists in this organisation`,
        );
      }
      throw err;
    }
  }

  async delete(orgId: string, queueId: string, actorUserId: string): Promise<void> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    // Fast-fail scoped check before acquiring a transaction connection slot
    const existing = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
      select: { id: true, name: true },
    });

    if (!existing) {
      throw new NotFoundError('Queue not found');
    }

    await db.$transaction(
      async (tx) => {
        const queue = await tx.queue.findFirst({
          where: {
            id: queueId,
            organisationId: orgId,
          },
          select: { id: true },
        });

        if (!queue) {
          throw new NotFoundError('Queue not found');
        }

        const jobCount = await tx.job.count({
          where: { queueId: queue.id },
        });

        if (jobCount > 0) {
          throw new ConflictError(
            'Cannot delete queue while it still contains jobs. Remove or drain jobs before deleting.',
            { jobCount },
          );
        }

        await tx.queue.deleteMany({
          where: {
            id: queue.id,
            organisationId: orgId,
          },
        });
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    await bullMQService.unregisterQueue(orgId, existing.name);

    logger.info('Queue deleted', {
      queueId,
      organisationId: orgId,
      deletedBy: actorUserId,
    });
  }

  async pause(orgId: string, queueId: string, actorUserId: string): Promise<QueueView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const existing = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
      include: QUEUE_INCLUDE,
    });

    if (!existing) {
      throw new NotFoundError('Queue not found');
    }

    if (existing.isPaused) {
      return toQueueView(existing);
    }

    const updated = await db.queue.update({
      where: { id: existing.id },
      data: {
        isPaused: true,
        pausedAt: new Date(),
      },
      include: QUEUE_INCLUDE,
    });

    // Best-effort sync with BullMQ; PostgreSQL remains authoritative on Redis outage
    await bullMQService.syncQueuePauseState(updated);

    logger.info('Queue paused', {
      queueId: updated.id,
      organisationId: orgId,
      pausedBy: actorUserId,
    });

    return toQueueView(updated);
  }

  async resume(orgId: string, queueId: string, actorUserId: string): Promise<QueueView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const existing = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
      include: QUEUE_INCLUDE,
    });

    if (!existing) {
      throw new NotFoundError('Queue not found');
    }

    if (!existing.isPaused) {
      return toQueueView(existing);
    }

    const updated = await db.$transaction(
      async (tx) => {
        const resumedQueue = await tx.queue.update({
          where: { id: existing.id },
          data: {
            isPaused: false,
            pausedAt: null,
          },
          include: QUEUE_INCLUDE,
        });

        // Promote PAUSED jobs in PostgreSQL along valid lifecycle paths (PAUSED -> PENDING / DELAYED)
        await tx.job.updateMany({
          where: {
            queueId: existing.id,
            status: JobStatus.PAUSED,
            delayMs: 0,
          },
          data: { status: JobStatus.PENDING },
        });

        await tx.job.updateMany({
          where: {
            queueId: existing.id,
            status: JobStatus.PAUSED,
            delayMs: { gt: 0 },
          },
          data: { status: JobStatus.DELAYED },
        });

        return resumedQueue;
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    // Best-effort sync with BullMQ; PostgreSQL remains authoritative on Redis outage
    await bullMQService.syncQueuePauseState(updated);

    logger.info('Queue resumed', {
      queueId: updated.id,
      organisationId: orgId,
      resumedBy: actorUserId,
    });

    return toQueueView(updated);
  }

  async getStats(orgId: string, queueId: string): Promise<QueueStatsView> {
    if (!uuidSchema.safeParse(queueId).success) {
      throw new NotFoundError('Queue not found');
    }

    const queue = await db.queue.findFirst({
      where: {
        id: queueId,
        organisationId: orgId,
      },
    });

    if (!queue) {
      throw new NotFoundError('Queue not found');
    }

    const grouped = await db.job.groupBy({
      by: ['status'],
      where: {
        queueId: queue.id,
        queue: { organisationId: orgId },
      },
      _count: { _all: true },
    });

    const byStatus: Record<JobStatus, number> = {
      [JobStatus.PENDING]: 0,
      [JobStatus.ACTIVE]: 0,
      [JobStatus.COMPLETED]: 0,
      [JobStatus.FAILED]: 0,
      [JobStatus.DELAYED]: 0,
      [JobStatus.PAUSED]: 0,
    };

    let total = 0;
    for (const row of grouped) {
      byStatus[row.status] = row._count._all;
      total += row._count._all;
    }

    return {
      queueId: queue.id,
      organisationId: queue.organisationId,
      name: queue.name,
      isPaused: queue.isPaused,
      pausedAt: queue.pausedAt,
      config: {
        concurrency: queue.concurrency,
        defaultPriority: queue.defaultPriority,
        maxRetries: queue.maxRetries,
        backoffMs: queue.backoffMs,
      },
      jobs: {
        total,
        byStatus,
      },
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt,
    };
  }
}

export const queueService = new QueueService();

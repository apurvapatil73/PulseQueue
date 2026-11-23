import { DeadLetterStatus, OutboxStatus, PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { resolveInitialJobStatus } from '../utils/jobLifecycle.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { bullMQService, type EnqueueResult } from './bullmq.service.js';
import { eventService } from './event.service.js';

export interface DeadLetterJobView {
  id: string;
  originalJobId: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  jobName: string;
  payloadSummary: Prisma.JsonValue;
  failureReason: string;
  attemptsMade: number;
  maxRetries: number;
  status: DeadLetterStatus;
  failedAt: Date;
  replayedAt: Date | null;
  replayedById: string | null;
  replayedJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListDlqQuery {
  status?: DeadLetterStatus;
  queueId?: string;
  page: number;
  limit: number;
}

export interface PaginatedDlqView {
  items: DeadLetterJobView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface ReplayDlqResult {
  deadLetterJob: DeadLetterJobView;
  replayedJob: {
    id: string;
    queueId: string;
    organisationId: string;
    name: string;
    status: string;
    priority: number;
    replayedFromDlqId: string | null;
    createdAt: Date;
  };
  dispatch: EnqueueResult;
}

/**
 * Builds a safe, non-sensitive summary of a job payload for DLQ inspection without
 * exposing raw sensitive payload values unnecessarily.
 */
export function buildSafePayloadSummary(payload: Prisma.JsonValue): Prisma.InputJsonValue {
  let byteLength = 0;
  try {
    byteLength = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8');
  } catch {
    byteLength = 0;
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const keys = Object.keys(payload).sort().slice(0, 25);
    return {
      keyCount: Object.keys(payload).length,
      keys,
      byteLength,
    };
  }

  return {
    keyCount: 0,
    keys: [],
    byteLength,
  };
}

/**
 * Dead-Letter Queue (DLQ) service.
 *
 * Guarantees:
 * - Database-enforced uniqueness on `originalJobId` prevents duplicate DLQ records.
 * - Strict organisation isolation on every read and replay.
 * - Atomic `OPEN -> REPLAYED` claim prevents concurrent duplicate replays.
 * - Original failed Job + DeadLetterJob history remain intact on replay.
 */
export class DeadLetterService {
  /**
   * Idempotently routes a permanently failed job into the Dead-Letter Queue.
   * Safe to call multiple times for the same originalJobId (never creates duplicates).
   */
  async recordDeadLetter(input: {
    originalJobId: string;
    organisationId: string;
    queueId: string;
    queueName: string;
    jobName: string;
    payload: Prisma.JsonValue;
    failureReason: string;
    attemptsMade: number;
    maxRetries: number;
    failedAt: Date;
    workerId?: string;
  }): Promise<{ record: DeadLetterJobView; created: boolean }> {
    const existing = await db.deadLetterJob.findUnique({
      where: { originalJobId: input.originalJobId },
    });

    if (existing) {
      return { record: existing, created: false };
    }

    const payloadSummary = buildSafePayloadSummary(input.payload);
    const truncatedReason = input.failureReason.replace(/\s+/g, ' ').trim().slice(0, 2000);

    try {
      const created = await db.deadLetterJob.create({
        data: {
          originalJobId: input.originalJobId,
          organisationId: input.organisationId,
          queueId: input.queueId,
          queueName: input.queueName,
          jobName: input.jobName,
          payloadSummary,
          failureReason: truncatedReason,
          attemptsMade: input.attemptsMade,
          maxRetries: input.maxRetries,
          status: DeadLetterStatus.OPEN,
          failedAt: input.failedAt,
        },
      });

      logger.warn('Job moved to Dead-Letter Queue', {
        dlqId: created.id,
        originalJobId: input.originalJobId,
        organisationId: input.organisationId,
        queueId: input.queueId,
        attemptsMade: input.attemptsMade,
      });

      await eventService.record({
        type: PlatformEventType.JOB_MOVED_TO_DLQ,
        organisationId: input.organisationId,
        queueId: input.queueId,
        jobId: input.originalJobId,
        workerId: input.workerId ?? null,
        message: `Job "${input.jobName}" moved to DLQ after ${input.attemptsMade} attempt(s)`,
        metadata: {
          dlqId: created.id,
          attemptsMade: input.attemptsMade,
          maxRetries: input.maxRetries,
          failureReason: truncatedReason,
        },
      });

      return { record: created, created: true };
    } catch (err) {
      // Handle concurrent unique constraint race cleanly (P2002 on original_job_id)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await db.deadLetterJob.findUnique({
          where: { originalJobId: input.originalJobId },
        });
        if (raced) {
          return { record: raced, created: false };
        }
      }
      throw err;
    }
  }

  /**
   * Lists dead-letter jobs strictly scoped to the caller's organisation.
   */
  async listForOrganisation(orgId: string, query: ListDlqQuery): Promise<PaginatedDlqView> {
    if (query.queueId !== undefined && !uuidSchema.safeParse(query.queueId).success) {
      return {
        items: [],
        pagination: {
          page: query.page,
          limit: query.limit,
          total: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
    }

    const where: Prisma.DeadLetterJobWhereInput = {
      organisationId: orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.queueId ? { queueId: query.queueId } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, items] = await Promise.all([
      db.deadLetterJob.count({ where }),
      db.deadLetterJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      items,
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
   * Retrieves a single dead-letter record strictly scoped to the caller's organisation.
   */
  async getById(orgId: string, dlqId: string): Promise<DeadLetterJobView> {
    if (!uuidSchema.safeParse(dlqId).success) {
      throw new NotFoundError('Dead-letter job not found');
    }

    const record = await db.deadLetterJob.findFirst({
      where: { id: dlqId, organisationId: orgId },
    });

    if (!record) {
      throw new NotFoundError('Dead-letter job not found');
    }

    return record;
  }

  /**
   * Safely replays an OPEN dead-letter job by creating a new Job + transactional outbox
   * inside a single atomic transaction, preserving the original failed job and DLQ history.
   *
   * Rejects already-replayed DLQ records (or concurrent duplicate replay attempts) with 409 Conflict.
   */
  async replay(
    orgId: string,
    dlqId: string,
    actorUserId: string,
    overrides?: {
      payload?: Record<string, unknown>;
      priority?: number;
      maxRetries?: number;
      backoffMs?: number;
    },
  ): Promise<ReplayDlqResult> {
    if (!uuidSchema.safeParse(dlqId).success) {
      throw new NotFoundError('Dead-letter job not found');
    }

    const { updatedDlq, newJob, persistedQueue, outboxId } = await db.$transaction(
      async (tx) => {
        const dlq = await tx.deadLetterJob.findFirst({
          where: { id: dlqId, organisationId: orgId },
          include: {
            originalJob: true,
            queue: true,
          },
        });

        if (!dlq) {
          throw new NotFoundError('Dead-letter job not found');
        }

        if (dlq.status !== DeadLetterStatus.OPEN) {
          throw new ConflictError('Dead-letter job has already been replayed', {
            dlqId: dlq.id,
            replayedJobId: dlq.replayedJobId,
            replayedAt: dlq.replayedAt,
          });
        }

        const initialStatus = resolveInitialJobStatus({
          queueIsPaused: dlq.queue.isPaused,
          delayMs: 0,
        });

        // Create a fresh Job preserving link to the DLQ record and original failure history
        const createdJob = await tx.job.create({
          data: {
            queueId: dlq.queue.id,
            name: dlq.originalJob.name,
            status: initialStatus,
            priority: overrides?.priority ?? dlq.originalJob.priority,
            payload: (overrides?.payload ?? dlq.originalJob.payload) as Prisma.InputJsonValue,
            maxRetries: overrides?.maxRetries ?? dlq.originalJob.maxRetries,
            backoffMs: overrides?.backoffMs ?? dlq.originalJob.backoffMs,
            delayMs: 0,
            replayedFromDlqId: dlq.id,
            createdById: actorUserId,
          },
        });

        // Atomic optimistic claim prevents concurrent duplicate replays
        const claimed = await tx.deadLetterJob.updateMany({
          where: {
            id: dlq.id,
            organisationId: orgId,
            status: DeadLetterStatus.OPEN,
          },
          data: {
            status: DeadLetterStatus.REPLAYED,
            replayedAt: new Date(),
            replayedById: actorUserId,
            replayedJobId: createdJob.id,
          },
        });

        if (claimed.count !== 1) {
          throw new ConflictError('Dead-letter job was already replayed concurrently');
        }

        const outbox = await tx.jobDispatchOutbox.create({
          data: {
            jobId: createdJob.id,
            queueId: dlq.queue.id,
            organisationId: orgId,
            status: OutboxStatus.PENDING,
          },
          select: { id: true },
        });

        const refreshedDlq = await tx.deadLetterJob.findUniqueOrThrow({
          where: { id: dlq.id },
        });

        return {
          updatedDlq: refreshedDlq,
          newJob: createdJob,
          persistedQueue: dlq.queue,
          outboxId: outbox.id,
        };
      },
      { maxWait: 10_000, timeout: 10_000 },
    );

    // Dispatch replayed job to BullMQ with stable jobId = newJob.id
    const dispatch = await bullMQService.enqueueJob(persistedQueue, newJob);

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
            lastError: (dispatch.error ?? 'Redis unavailable').slice(0, 1000),
            nextAttemptAt: new Date(Date.now() + 2000),
          },
        });
      }
    } catch (err) {
      logger.warn('Failed to update outbox status after DLQ replay dispatch', {
        dlqId,
        replayedJobId: newJob.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Dead-letter job replayed', {
      dlqId: updatedDlq.id,
      originalJobId: updatedDlq.originalJobId,
      replayedJobId: newJob.id,
      organisationId: orgId,
      replayedBy: actorUserId,
    });

    await eventService.record({
      type: PlatformEventType.JOB_REPLAYED,
      organisationId: orgId,
      queueId: persistedQueue.id,
      jobId: newJob.id,
      message: `Replayed DLQ job "${newJob.name}" from original job ${updatedDlq.originalJobId}`,
      metadata: {
        dlqId: updatedDlq.id,
        originalJobId: updatedDlq.originalJobId,
        replayedJobId: newJob.id,
        replayedById: actorUserId,
        enqueued: dispatch.enqueued,
      },
    });

    return {
      deadLetterJob: updatedDlq,
      replayedJob: {
        id: newJob.id,
        queueId: newJob.queueId,
        organisationId: orgId,
        name: newJob.name,
        status: newJob.status,
        priority: newJob.priority,
        replayedFromDlqId: newJob.replayedFromDlqId,
        createdAt: newJob.createdAt,
      },
      dispatch,
    };
  }
}

export const deadLetterService = new DeadLetterService();

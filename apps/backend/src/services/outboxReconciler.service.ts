import { OutboxStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { bullMQService, type BullMQService } from './bullmq.service.js';

export interface ReconciliationSummary {
  scanned: number;
  dispatched: number;
  deduplicated: number;
  failed: number;
  skipped: number;
}

export interface OutboxReconcilerOptions {
  bullMQ?: BullMQService;
  batchSize?: number;
  maxBackoffMs?: number;
  baseBackoffMs?: number;
}

/**
 * Durable PostgreSQL-to-BullMQ outbox reconciler.
 *
 * Scans due PENDING rows from `job_dispatch_outbox` in bounded batches,
 * idempotently enqueues them to BullMQ using the job UUID as a stable jobId,
 * and applies bounded exponential backoff on Redis outages without uncontrolled polling.
 */
export class OutboxReconciler {
  private readonly bullMQ: BullMQService;
  private readonly batchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: OutboxReconcilerOptions = {}) {
    this.bullMQ = options.bullMQ ?? bullMQService;
    this.batchSize = options.batchSize ?? 50;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  /**
   * Computes bounded exponential backoff delay for retryable outbox dispatch failures.
   */
  computeNextBackoffMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(attemptCount, 10));
    return Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, exponent));
  }

  /**
   * Executes one bounded, overlap-guarded reconciliation pass.
   */
  async reconcileOnce(batchSize: number = this.batchSize): Promise<ReconciliationSummary> {
    if (this.inFlight) {
      return { scanned: 0, dispatched: 0, deduplicated: 0, failed: 0, skipped: 0 };
    }

    this.inFlight = true;
    const summary: ReconciliationSummary = {
      scanned: 0,
      dispatched: 0,
      deduplicated: 0,
      failed: 0,
      skipped: 0,
    };

    try {
      const now = new Date();
      const pendingRecords = await db.jobDispatchOutbox.findMany({
        where: {
          status: OutboxStatus.PENDING,
          nextAttemptAt: { lte: now },
        },
        include: {
          job: {
            include: {
              queue: true,
            },
          },
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: batchSize,
      });

      summary.scanned = pendingRecords.length;

      for (const record of pendingRecords) {
        // Defensive guard in case job was concurrently cancelled or already terminal
        if (!record.job || !record.job.queue) {
          summary.skipped += 1;
          continue;
        }

        if (
          record.job.status === 'COMPLETED' ||
          record.job.status === 'FAILED' ||
          record.job.isQuarantined
        ) {
          await db.jobDispatchOutbox.updateMany({
            where: { id: record.id, status: OutboxStatus.PENDING },
            data: { status: OutboxStatus.CANCELLED },
          });
          summary.skipped += 1;
          continue;
        }

        // Preserve accurate target execution time for delayed/scheduled jobs across outages
        const remainingDelayMs =
          record.job.delayMs > 0
            ? Math.max(0, record.job.createdAt.getTime() + record.job.delayMs - Date.now())
            : 0;

        const dispatchRes = await this.bullMQ.enqueueJob(record.job.queue, {
          ...record.job,
          delayMs: remainingDelayMs,
        });

        if (dispatchRes.enqueued) {
          const dispatchedAt = new Date();
          await Promise.all([
            db.jobDispatchOutbox.updateMany({
              where: { id: record.id, status: OutboxStatus.PENDING },
              data: {
                status: OutboxStatus.DISPATCHED,
                dispatchedAt,
                attempts: { increment: 1 },
                lastError: null,
              },
            }),
            db.scheduleExecution.updateMany({
              where: { jobId: record.jobId, dispatchedAt: null },
              data: { dispatchedAt },
            }),
          ]);

          summary.dispatched += 1;
          if (dispatchRes.deduplicated) {
            summary.deduplicated += 1;
          }
        } else {
          const nextAttempts = record.attempts + 1;
          const backoffMs = this.computeNextBackoffMs(nextAttempts);

          await db.jobDispatchOutbox.updateMany({
            where: { id: record.id, status: OutboxStatus.PENDING },
            data: {
              attempts: { increment: 1 },
              lastError: (dispatchRes.error ?? 'Redis unavailable').slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + backoffMs),
            },
          });

          summary.failed += 1;
        }
      }

      if (summary.scanned > 0) {
        logger.info('Outbox reconciliation pass completed', { ...summary });
      }

      return summary;
    } catch (err) {
      logger.error('Outbox reconciliation pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return summary;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Starts controlled periodic reconciliation (idempotent — ignores duplicate start calls).
   */
  start(intervalMs: number = 5000): void {
    if (this.timer) {
      return;
    }

    const safeInterval = Math.max(1000, intervalMs);
    this.timer = setInterval(() => {
      void this.reconcileOnce();
    }, safeInterval);
    this.timer.unref();

    logger.info('Outbox reconciler started', {
      intervalMs: safeInterval,
      batchSize: this.batchSize,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Outbox reconciler stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const outboxReconciler = new OutboxReconciler();

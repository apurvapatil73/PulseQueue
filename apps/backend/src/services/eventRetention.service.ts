import { Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const MIN_EVENT_RETENTION_DAYS = 1;
export const DEFAULT_RETENTION_BATCH_SIZE = 500;
export const MAX_RETENTION_BATCH_SIZE = 5000;
export const DEFAULT_RETENTION_MAX_BATCHES = 10;
export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface EventRetentionOptions {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface PurgeExpiredEventsParams {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  now?: Date;
  /** Optional organisation scope (useful for isolated testing without touching other rows). */
  organisationId?: string;
}

export interface EventRetentionSummary {
  retentionDays: number;
  cutoff: string;
  batchSize: number;
  maxBatches: number;
  batchesExecuted: number;
  deletedCount: number;
  hasMore: boolean;
  durationMs: number;
  skippedOverlap: boolean;
}

/**
 * Bounded, safe retention cleanup service for `platform_events`.
 *
 * - Retains events for 30 days by default (enforces a minimum safety floor of 1 day).
 * - Deletes expired rows in bounded batches using short independent SQL statements
 *   (never holding long-running transactions or table locks).
 * - Overlap-guarded so concurrent ticks never pile up.
 */
export class EventRetentionService {
  private readonly defaultRetentionDays: number;
  private readonly defaultBatchSize: number;
  private readonly defaultMaxBatches: number;

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: EventRetentionOptions = {}) {
    this.defaultRetentionDays = Math.max(
      MIN_EVENT_RETENTION_DAYS,
      Math.floor(options.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS),
    );
    this.defaultBatchSize = Math.min(
      MAX_RETENTION_BATCH_SIZE,
      Math.max(1, Math.floor(options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE)),
    );
    this.defaultMaxBatches = Math.max(
      1,
      Math.floor(options.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES),
    );
  }

  async purgeExpiredEvents(params: PurgeExpiredEventsParams = {}): Promise<EventRetentionSummary> {
    const startedMs = Date.now();
    const retentionDays = params.retentionDays ?? this.defaultRetentionDays;
    if (!Number.isFinite(retentionDays) || retentionDays < MIN_EVENT_RETENTION_DAYS) {
      throw new Error(`retentionDays must be at least ${MIN_EVENT_RETENTION_DAYS}`);
    }

    const batchSize = Math.min(
      MAX_RETENTION_BATCH_SIZE,
      Math.max(1, Math.floor(params.batchSize ?? this.defaultBatchSize)),
    );
    const maxBatches = Math.max(1, Math.floor(params.maxBatches ?? this.defaultMaxBatches));
    const now = params.now ?? new Date();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    if (this.inFlight) {
      return {
        retentionDays,
        cutoff: cutoff.toISOString(),
        batchSize,
        maxBatches,
        batchesExecuted: 0,
        deletedCount: 0,
        hasMore: false,
        durationMs: 0,
        skippedOverlap: true,
      };
    }

    this.inFlight = true;
    let batchesExecuted = 0;
    let deletedCount = 0;
    let hasMore = false;

    const orgFilter = params.organisationId
      ? Prisma.sql`AND organisation_id = ${params.organisationId}::uuid`
      : Prisma.empty;

    try {
      for (let i = 0; i < maxBatches; i += 1) {
        // Each batch executes as its own short statement — no long-running transaction.
        const deleted = await db.$executeRaw`
          DELETE FROM platform_events
          WHERE id IN (
            SELECT id
            FROM platform_events
            WHERE created_at < ${cutoff}::timestamp
              ${orgFilter}
            ORDER BY created_at ASC, id ASC
            LIMIT ${batchSize}
          )
        `;

        const batchDeleted = Number(deleted);
        batchesExecuted += 1;
        deletedCount += batchDeleted;

        if (batchDeleted < batchSize) {
          hasMore = false;
          break;
        }

        // If we hit the maxBatches cap on a full batch, check if more expired rows remain
        if (i === maxBatches - 1) {
          const remaining = await db.$queryRaw<Array<{ exists: boolean }>>`
            SELECT EXISTS (
              SELECT 1
              FROM platform_events
              WHERE created_at < ${cutoff}::timestamp
                ${orgFilter}
              LIMIT 1
            ) AS "exists"
          `;
          hasMore = Boolean(remaining[0]?.exists);
        }
      }

      const durationMs = Math.max(0, Date.now() - startedMs);
      const summary: EventRetentionSummary = {
        retentionDays,
        cutoff: cutoff.toISOString(),
        batchSize,
        maxBatches,
        batchesExecuted,
        deletedCount,
        hasMore,
        durationMs,
        skippedOverlap: false,
      };

      if (deletedCount > 0) {
        logger.info('Platform event retention purge completed', { ...summary });
      }

      return summary;
    } catch (err) {
      logger.error('Platform event retention purge failed', {
        retentionDays,
        cutoff: cutoff.toISOString(),
        batchesExecuted,
        deletedCount,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  start(intervalMs: number = DEFAULT_RETENTION_INTERVAL_MS): void {
    if (this.timer) return;
    const safeInterval = Math.max(60_000, intervalMs);
    this.timer = setInterval(() => {
      void this.purgeExpiredEvents().catch(() => {
        // Logged inside purgeExpiredEvents
      });
    }, safeInterval);
    this.timer.unref();
    logger.info('Platform event retention scheduler started', {
      intervalMs: safeInterval,
      retentionDays: this.defaultRetentionDays,
      batchSize: this.defaultBatchSize,
      maxBatches: this.defaultMaxBatches,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Platform event retention scheduler stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const eventRetentionService = new EventRetentionService();

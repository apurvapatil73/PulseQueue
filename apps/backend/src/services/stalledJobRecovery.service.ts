import { JobDispatchState, JobStatus, OutboxStatus, PlatformEventType } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { bullMQService, type BullMQService } from './bullmq.service.js';
import { deadLetterService } from './dlq.service.js';
import { eventService } from './event.service.js';
import { isCustomSchedulingPolicy, prioritySchedulerService } from './priorityScheduler.service.js';

export interface StalledRecoveryOptions {
  bullMQ?: BullMQService;
  /** Duration a job can remain ACTIVE before being considered stalled (default 60s). */
  staleActiveThresholdMs?: number;
  /** Maximum stalled recoveries before routing permanently to FAILED + DLQ (default 3). */
  maxStalledRecoveries?: number;
  /** Maximum stale jobs inspected per sweep pass. */
  batchSize?: number;
}

export interface StalledRecoverySummary {
  scanned: number;
  recovered: number;
  movedToDlq: number;
  skipped: number;
}

/**
 * Stalled-job detection and recovery service.
 *
 * Detects jobs stuck in PostgreSQL `ACTIVE` beyond `staleActiveThresholdMs` (e.g. after
 * a worker crash), reconciles against BullMQ Redis state, uses atomic conditional DB
 * updates (`where: { id, status: 'ACTIVE', stalledCount }`) to prevent concurrent duplicate
 * recovery and never overwrite terminal states, and bounds recovery attempts via
 * `maxStalledRecoveries` to prevent infinite recovery loops (routing exhausted jobs to DLQ).
 */
export class StalledJobRecoveryService {
  private readonly bullMQ: BullMQService;
  private readonly staleActiveThresholdMs: number;
  private readonly maxStalledRecoveries: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: StalledRecoveryOptions = {}) {
    this.bullMQ = options.bullMQ ?? bullMQService;
    this.staleActiveThresholdMs = options.staleActiveThresholdMs ?? 60_000;
    this.maxStalledRecoveries = options.maxStalledRecoveries ?? 3;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Runs one bounded, overlap-guarded stalled-job recovery pass.
   * Optionally scoped to a single `organisationId` (e.g. when invoked via org admin API).
   */
  async recoverStalledJobs(params?: {
    organisationId?: string;
    staleActiveThresholdMs?: number;
    maxStalledRecoveries?: number;
  }): Promise<StalledRecoverySummary> {
    if (this.inFlight) {
      return { scanned: 0, recovered: 0, movedToDlq: 0, skipped: 0 };
    }

    this.inFlight = true;
    const summary: StalledRecoverySummary = {
      scanned: 0,
      recovered: 0,
      movedToDlq: 0,
      skipped: 0,
    };

    const thresholdMs = params?.staleActiveThresholdMs ?? this.staleActiveThresholdMs;
    const maxRecoveries = params?.maxStalledRecoveries ?? this.maxStalledRecoveries;

    try {
      const sweepNow = new Date();
      const cutoff = new Date(sweepNow.getTime() - thresholdMs);

      const candidates = await db.job.findMany({
        where: {
          status: JobStatus.ACTIVE,
          ...(params?.organisationId ? { queue: { organisationId: params.organisationId } } : {}),
          OR: [
            { leaseExpiresAt: { lte: sweepNow } },
            { leaseExpiresAt: null, startedAt: { lte: cutoff } },
          ],
        },
        include: {
          queue: true,
        },
        orderBy: [{ leaseExpiresAt: 'asc' }, { startedAt: 'asc' }],
        take: this.batchSize,
      });

      summary.scanned = candidates.length;

      for (const job of candidates) {
        const orgId = job.queue.organisationId;
        const bullState = await this.bullMQ.getBullJobState(job.queue, job.id);

        // If Redis confirms the job is genuinely still locked & actively executing within
        // BullMQ, avoid interrupting it if we shouldn't force-steal; if absent, waiting,
        // delayed, failed, or unknown after timeout, proceed with safe PostgreSQL recovery.
        if (bullState === 'completed') {
          summary.skipped += 1;
          continue;
        }

        const now = new Date();
        const isLeaseExpired = job.leaseExpiresAt !== null && job.leaseExpiresAt <= now;

        // Guard against endless recovery loops: once maxStalledRecoveries is reached,
        // mark permanently FAILED and route to DLQ.
        if (job.stalledCount >= maxRecoveries) {
          const failureReason = `Job exceeded maximum stalled-job recovery limit (${maxRecoveries})`;

          const failedClaim = await db.job.updateMany({
            where: {
              id: job.id,
              status: JobStatus.ACTIVE,
              stalledCount: job.stalledCount,
              fencingToken: job.fencingToken,
              queue: { organisationId: orgId },
            },
            data: {
              status: JobStatus.FAILED,
              errorMessage: failureReason,
              failedAt: now,
              leaseExpiresAt: null,
              fencingToken: { increment: 1 },
            },
          });

          if (failedClaim.count !== 1) {
            summary.skipped += 1;
            continue;
          }

          if (isLeaseExpired) {
            await eventService.record({
              type: PlatformEventType.JOB_LEASE_EXPIRED,
              organisationId: orgId,
              queueId: job.queueId,
              jobId: job.id,
              workerId: job.lastWorkerId,
              message: `Execution lease expired for job "${job.name}" (fencing token ${job.fencingToken})`,
              metadata: {
                stalledCount: job.stalledCount,
                previousFencingToken: job.fencingToken,
                leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
              },
            });
          }

          await eventService.record({
            type: PlatformEventType.JOB_STALLED,
            organisationId: orgId,
            queueId: job.queueId,
            jobId: job.id,
            workerId: job.lastWorkerId,
            message: `Job "${job.name}" stalled and exceeded max recovery attempts (${maxRecoveries})`,
            metadata: { stalledCount: job.stalledCount, bullState },
          });

          await eventService.record({
            type: PlatformEventType.JOB_FAILED,
            organisationId: orgId,
            queueId: job.queueId,
            jobId: job.id,
            workerId: job.lastWorkerId,
            message: failureReason,
            metadata: { stalledCount: job.stalledCount, attemptsMade: job.attemptsMade },
          });

          await deadLetterService.recordDeadLetter({
            originalJobId: job.id,
            organisationId: orgId,
            queueId: job.queueId,
            queueName: job.queue.name,
            jobName: job.name,
            payload: job.payload,
            failureReason,
            attemptsMade: job.attemptsMade,
            maxRetries: job.maxRetries,
            failedAt: now,
          });

          await this.bullMQ.removeJobFromBullMQ(job.queue, job.id);

          summary.movedToDlq += 1;
          continue;
        }

        // Atomic recovery claim: fails cleanly (count=0) if another sweeper already
        // recovered it or if the job transitioned to COMPLETED/FAILED in the meantime.
        const nextStatus = job.queue.isPaused ? JobStatus.PAUSED : JobStatus.PENDING;
        const isCustomPolicy = isCustomSchedulingPolicy(job.queue.schedulingPolicy);
        const recovered = await db.$transaction(
          async (tx) => {
            const claim = await tx.job.updateMany({
              where: {
                id: job.id,
                status: JobStatus.ACTIVE,
                stalledCount: job.stalledCount,
                fencingToken: job.fencingToken,
                queue: { organisationId: orgId },
              },
              data: {
                status: nextStatus,
                ...(isCustomPolicy
                  ? {
                      dispatchState: JobDispatchState.QUEUED,
                      dispatchClaimedAt: null,
                      dispatchClaimedBy: null,
                    }
                  : {}),
                stalledCount: { increment: 1 },
                fencingToken: { increment: 1 },
                leaseExpiresAt: null,
                lastRecoveredAt: now,
                errorMessage: isLeaseExpired
                  ? `Recovered after execution lease expired (recovery #${job.stalledCount + 1})`
                  : `Recovered from stalled ACTIVE state (recovery #${job.stalledCount + 1})`,
              },
            });

            if (claim.count !== 1) {
              return false;
            }

            // Ensure durable outbox entry is PENDING so recovery survives Redis outages too
            await tx.jobDispatchOutbox.upsert({
              where: { jobId: job.id },
              create: {
                jobId: job.id,
                queueId: job.queueId,
                organisationId: orgId,
                status: OutboxStatus.PENDING,
                nextAttemptAt: now,
              },
              update: {
                status: OutboxStatus.PENDING,
                nextAttemptAt: now,
                lastError: null,
              },
            });

            return true;
          },
          { maxWait: 10_000, timeout: 10_000 },
        );

        if (!recovered) {
          summary.skipped += 1;
          continue;
        }

        // If BullMQ still has a stale/failed entry for this jobId, remove it before re-enqueueing
        if (bullState === 'failed' || bullState === 'active' || bullState === 'completed') {
          await this.bullMQ.removeJobFromBullMQ(job.queue, job.id);
        }

        let reEnqueued = false;
        if (isCustomPolicy) {
          // Custom-policy jobs re-enter PrioritySchedulerService (readyAt preserved)
          if (!job.queue.isPaused) {
            prioritySchedulerService.nudgeQueue(job.queueId);
          }
        } else {
          const dispatch = await this.bullMQ.enqueueJob(job.queue, job);
          reEnqueued = dispatch.enqueued;
          if (dispatch.enqueued) {
            await db.jobDispatchOutbox.updateMany({
              where: { jobId: job.id, status: OutboxStatus.PENDING },
              data: {
                status: OutboxStatus.DISPATCHED,
                dispatchedAt: new Date(),
                attempts: { increment: 1 },
                lastError: null,
              },
            });
          }
        }

        logger.warn('Stalled job detected and recovered', {
          jobId: job.id,
          organisationId: orgId,
          queueId: job.queueId,
          stalledCount: job.stalledCount + 1,
          previousFencingToken: job.fencingToken,
          newFencingToken: job.fencingToken + 1,
          isLeaseExpired,
          previousBullState: bullState,
          reEnqueued,
        });

        if (isLeaseExpired) {
          await eventService.record({
            type: PlatformEventType.JOB_LEASE_EXPIRED,
            organisationId: orgId,
            queueId: job.queueId,
            jobId: job.id,
            workerId: job.lastWorkerId,
            message: `Execution lease expired for job "${job.name}" (fencing token ${job.fencingToken} -> ${job.fencingToken + 1})`,
            metadata: {
              stalledCount: job.stalledCount + 1,
              previousFencingToken: job.fencingToken,
              newFencingToken: job.fencingToken + 1,
              leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
            },
          });
        }

        await eventService.record({
          type: PlatformEventType.JOB_STALLED,
          organisationId: orgId,
          queueId: job.queueId,
          jobId: job.id,
          workerId: job.lastWorkerId,
          message: `Job "${job.name}" detected stalled in ACTIVE state`,
          metadata: {
            stalledCount: job.stalledCount + 1,
            previousBullState: bullState,
          },
        });

        await eventService.record({
          type: PlatformEventType.JOB_RECOVERED,
          organisationId: orgId,
          queueId: job.queueId,
          jobId: job.id,
          workerId: job.lastWorkerId,
          message: `Job "${job.name}" recovered to ${nextStatus} (recovery #${job.stalledCount + 1})`,
          metadata: {
            stalledCount: job.stalledCount + 1,
            nextStatus,
            reEnqueued,
          },
        });

        summary.recovered += 1;
      }

      if (summary.scanned > 0) {
        logger.info('Stalled-job recovery pass completed', { ...summary });
      }

      return summary;
    } catch (err) {
      logger.error('Stalled-job recovery pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return summary;
    } finally {
      this.inFlight = false;
    }
  }

  start(intervalMs: number = 15_000): void {
    if (this.timer) return;
    const safeInterval = Math.max(2000, intervalMs);
    this.timer = setInterval(() => {
      void this.recoverStalledJobs();
    }, safeInterval);
    this.timer.unref();
    logger.info('Stalled-job recovery service started', {
      intervalMs: safeInterval,
      staleActiveThresholdMs: this.staleActiveThresholdMs,
      maxStalledRecoveries: this.maxStalledRecoveries,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Stalled-job recovery service stopped');
    }
  }
}

export const stalledJobRecoveryService = new StalledJobRecoveryService();

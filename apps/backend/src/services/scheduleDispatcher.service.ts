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
import { logger } from '../utils/logger.js';
import { computeNextCronRun } from '../utils/scheduleTime.js';
import { bullMQService, type BullMQService } from './bullmq.service.js';
import { eventService } from './event.service.js';

export interface ScheduleTickSummary {
  scanned: number;
  dispatched: number;
  skippedOverlap: number;
  skippedContention: number;
  completedOneTime: number;
  outboxDeferred: number;
}

export interface ScheduleDispatcherOptions {
  bullMQ?: BullMQService;
  batchSize?: number;
}

/**
 * PostgreSQL-authoritative Schedule Dispatcher.
 *
 * Safely supports multiple concurrent scheduler instances, restarts, and Redis outages:
 * - Claims each due recurring occurrence atomically via optimistic concurrency
 *   (`where: { id, status: 'ACTIVE', nextRunAt }`) + DB `@@unique([scheduleId, scheduledFor])`.
 * - Enforces `preventOverlap` before spawning a new job, logging `SKIPPED_OVERLAP` when busy.
 * - Commits `Job` + `ScheduleExecution` + `JobDispatchOutbox(PENDING)` in a single transaction,
 *   then dispatches to BullMQ with stable `jobId = job.id`.
 * - Reconciles completed `ONE_TIME` schedules to `ScheduleStatus.COMPLETED`.
 */
export class ScheduleDispatcherService {
  private readonly bullMQ: BullMQService;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: ScheduleDispatcherOptions = {}) {
    this.bullMQ = options.bullMQ ?? bullMQService;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Executes one bounded, overlap-guarded scheduling tick.
   */
  async tick(now: Date = new Date()): Promise<ScheduleTickSummary> {
    if (this.inFlight) {
      return {
        scanned: 0,
        dispatched: 0,
        skippedOverlap: 0,
        skippedContention: 0,
        completedOneTime: 0,
        outboxDeferred: 0,
      };
    }

    this.inFlight = true;
    const summary: ScheduleTickSummary = {
      scanned: 0,
      dispatched: 0,
      skippedOverlap: 0,
      skippedContention: 0,
      completedOneTime: 0,
      outboxDeferred: 0,
    };

    try {
      // 1. Reconcile & materialize ONE_TIME schedules
      // - If linked job is COMPLETED/FAILED -> transition Schedule to COMPLETED.
      // - If far-future ONE_TIME schedule enters the 60s lookahead window without an active
      //   execution -> atomically materialize Job + ScheduleExecution + Outbox and enqueue.
      const oneTimeLookahead = new Date(now.getTime() + 60_000);
      const activeOneTime = await db.schedule.findMany({
        where: {
          type: ScheduleType.ONE_TIME,
          status: ScheduleStatus.ACTIVE,
        },
        include: {
          queue: true,
          executions: {
            include: { job: { select: { id: true, status: true } } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        take: this.batchSize,
      });

      for (const sched of activeOneTime) {
        const latestExec = sched.executions[0];
        if (
          latestExec?.job &&
          (latestExec.job.status === JobStatus.COMPLETED ||
            latestExec.job.status === JobStatus.FAILED)
        ) {
          const updated = await db.schedule.updateMany({
            where: { id: sched.id, status: ScheduleStatus.ACTIVE },
            data: {
              status: ScheduleStatus.COMPLETED,
              nextRunAt: null,
              lastRunAt: latestExec.scheduledFor,
              runCount: { increment: 1 },
            },
          });

          if (updated.count === 1) {
            await db.scheduleExecution.updateMany({
              where: { id: latestExec.id, status: ScheduleExecutionStatus.SCHEDULED },
              data: { status: ScheduleExecutionStatus.DISPATCHED },
            });
            summary.completedOneTime += 1;
          }
          continue;
        }

        // Deferred far-future ONE_TIME materialization when entering lookahead window
        const hasActiveExecution =
          latestExec &&
          (latestExec.status === ScheduleExecutionStatus.SCHEDULED ||
            latestExec.status === ScheduleExecutionStatus.DISPATCHED);

        if (
          !hasActiveExecution &&
          sched.nextRunAt &&
          sched.nextRunAt.getTime() <= oneTimeLookahead.getTime()
        ) {
          const targetRunAt = sched.nextRunAt;
          const delayMs = Math.max(0, targetRunAt.getTime() - now.getTime());

          let materializeOutcome:
            | { type: 'skipped' }
            | {
                type: 'created';
                job: {
                  id: string;
                  queueId: string;
                  name: string;
                  priority: number;
                  payload: Prisma.JsonValue;
                  maxRetries: number;
                  backoffMs: number;
                  delayMs: number;
                };
                outboxId: string;
              };

          try {
            materializeOutcome = await db.$transaction(
              async (tx) => {
                const currentSched = await tx.schedule.findFirst({
                  where: { id: sched.id, status: ScheduleStatus.ACTIVE },
                  select: { id: true },
                });
                if (!currentSched) {
                  return { type: 'skipped' as const };
                }

                const existingExec = await tx.scheduleExecution.findUnique({
                  where: {
                    scheduleId_scheduledFor: {
                      scheduleId: sched.id,
                      scheduledFor: targetRunAt,
                    },
                  },
                });

                if (existingExec && existingExec.status !== ScheduleExecutionStatus.CANCELLED) {
                  return { type: 'skipped' as const };
                }

                const job = await tx.job.create({
                  data: {
                    queueId: sched.queue.id,
                    name: sched.jobName,
                    status: sched.queue.isPaused
                      ? JobStatus.PAUSED
                      : delayMs > 0
                        ? JobStatus.DELAYED
                        : JobStatus.PENDING,
                    priority: sched.priority ?? sched.queue.defaultPriority,
                    payload: sched.payload as Prisma.InputJsonValue,
                    maxRetries: sched.maxRetries ?? sched.queue.maxRetries,
                    backoffMs: sched.backoffMs ?? sched.queue.backoffMs,
                    delayMs,
                    createdById: sched.createdById,
                  },
                });

                if (existingExec) {
                  const claimed = await tx.scheduleExecution.updateMany({
                    where: { id: existingExec.id, status: ScheduleExecutionStatus.CANCELLED },
                    data: {
                      jobId: job.id,
                      status: ScheduleExecutionStatus.SCHEDULED,
                      reason: null,
                    },
                  });
                  if (claimed.count !== 1) {
                    throw new Prisma.PrismaClientKnownRequestError(
                      'Concurrent one-time materialization',
                      { code: 'P2002', clientVersion: '6.19.3' },
                    );
                  }
                } else {
                  await tx.scheduleExecution.create({
                    data: {
                      scheduleId: sched.id,
                      jobId: job.id,
                      scheduledFor: targetRunAt,
                      status: ScheduleExecutionStatus.SCHEDULED,
                    },
                  });
                }

                const outbox = await tx.jobDispatchOutbox.create({
                  data: {
                    jobId: job.id,
                    queueId: sched.queue.id,
                    organisationId: sched.organisationId,
                    status: OutboxStatus.PENDING,
                  },
                  select: { id: true },
                });

                return { type: 'created' as const, job, outboxId: outbox.id };
              },
              { maxWait: 10_000, timeout: 10_000 },
            );
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              summary.skippedContention += 1;
              continue;
            }
            throw err;
          }

          if (materializeOutcome.type === 'skipped') {
            summary.skippedContention += 1;
            continue;
          }

          const dispatch = await this.bullMQ.enqueueJob(sched.queue, materializeOutcome.job);
          if (dispatch.enqueued) {
            await db.jobDispatchOutbox.updateMany({
              where: { id: materializeOutcome.outboxId, status: OutboxStatus.PENDING },
              data: {
                status: OutboxStatus.DISPATCHED,
                dispatchedAt: new Date(),
                attempts: { increment: 1 },
                lastError: null,
              },
            });
            summary.dispatched += 1;
          } else {
            await db.jobDispatchOutbox.updateMany({
              where: { id: materializeOutcome.outboxId, status: OutboxStatus.PENDING },
              data: {
                attempts: { increment: 1 },
                lastError: (dispatch.error ?? 'Redis unavailable').slice(0, 1000),
                nextAttemptAt: new Date(Date.now() + 2000),
              },
            });
            summary.outboxDeferred += 1;
          }
        }
      }

      // 2. Find due ACTIVE RECURRING schedules (`nextRunAt <= now`)
      const dueRecurring = await db.schedule.findMany({
        where: {
          type: ScheduleType.RECURRING,
          status: ScheduleStatus.ACTIVE,
          nextRunAt: { lte: now },
        },
        include: {
          queue: true,
        },
        orderBy: [{ nextRunAt: 'asc' }],
        take: this.batchSize,
      });

      summary.scanned = dueRecurring.length;

      for (const schedule of dueRecurring) {
        if (!schedule.cronExpression || !schedule.nextRunAt) {
          continue;
        }

        const occurrenceTime = schedule.nextRunAt;
        // Compute strictly future next run relative to `now` so downtime does not burst-flood backlog
        const followingRunAt = computeNextCronRun(schedule.cronExpression, schedule.timezone, now);

        let claimOutcome:
          | { type: 'contention' }
          | { type: 'overlap' }
          | {
              type: 'created';
              job: {
                id: string;
                queueId: string;
                name: string;
                priority: number;
                payload: Prisma.JsonValue;
                maxRetries: number;
                backoffMs: number;
                delayMs: number;
              };
              outboxId: string;
            };

        try {
          claimOutcome = await db.$transaction(
            async (tx) => {
              // Optimistic concurrency claim: only ONE concurrent scheduler wins this occurrence
              const claimed = await tx.schedule.updateMany({
                where: {
                  id: schedule.id,
                  status: ScheduleStatus.ACTIVE,
                  nextRunAt: occurrenceTime,
                },
                data: {
                  nextRunAt: followingRunAt,
                },
              });

              if (claimed.count !== 1) {
                return { type: 'contention' as const };
              }

              // Overlap prevention check
              if (schedule.preventOverlap) {
                const runningCount = await tx.job.count({
                  where: {
                    scheduleExecution: { scheduleId: schedule.id },
                    status: {
                      in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED],
                    },
                  },
                });

                if (runningCount > 0) {
                  await tx.scheduleExecution.create({
                    data: {
                      scheduleId: schedule.id,
                      scheduledFor: occurrenceTime,
                      status: ScheduleExecutionStatus.SKIPPED_OVERLAP,
                      reason: `Skipped because ${runningCount} previous occurrence(s) are still in progress`,
                    },
                  });

                  return { type: 'overlap' as const };
                }
              }

              const job = await tx.job.create({
                data: {
                  queueId: schedule.queue.id,
                  name: schedule.jobName,
                  status: schedule.queue.isPaused ? JobStatus.PAUSED : JobStatus.PENDING,
                  priority: schedule.priority ?? schedule.queue.defaultPriority,
                  payload: schedule.payload as Prisma.InputJsonValue,
                  maxRetries: schedule.maxRetries ?? schedule.queue.maxRetries,
                  backoffMs: schedule.backoffMs ?? schedule.queue.backoffMs,
                  delayMs: 0,
                  createdById: schedule.createdById,
                },
              });

              await tx.scheduleExecution.create({
                data: {
                  scheduleId: schedule.id,
                  jobId: job.id,
                  scheduledFor: occurrenceTime,
                  status: ScheduleExecutionStatus.DISPATCHED,
                },
              });

              const outbox = await tx.jobDispatchOutbox.create({
                data: {
                  jobId: job.id,
                  queueId: schedule.queue.id,
                  organisationId: schedule.organisationId,
                  status: OutboxStatus.PENDING,
                },
                select: { id: true },
              });

              await tx.schedule.update({
                where: { id: schedule.id },
                data: {
                  lastRunAt: occurrenceTime,
                  runCount: { increment: 1 },
                },
              });

              return { type: 'created' as const, job, outboxId: outbox.id };
            },
            { maxWait: 10_000, timeout: 10_000 },
          );
        } catch (err) {
          // Unique constraint guard (`schedule_id, scheduled_for`) protects against races
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            summary.skippedContention += 1;
            continue;
          }
          throw err;
        }

        if (claimOutcome.type === 'contention') {
          summary.skippedContention += 1;
          continue;
        }

        if (claimOutcome.type === 'overlap') {
          summary.skippedOverlap += 1;
          logger.warn('Recurring schedule occurrence skipped due to active overlap', {
            scheduleId: schedule.id,
            organisationId: schedule.organisationId,
            scheduledFor: occurrenceTime.toISOString(),
          });
          continue;
        }

        // Dispatch committed job to BullMQ with stable jobId; OutboxReconciler recovers if Redis is down
        const dispatch = await this.bullMQ.enqueueJob(schedule.queue, claimOutcome.job);

        if (dispatch.enqueued) {
          await db.jobDispatchOutbox.updateMany({
            where: { id: claimOutcome.outboxId, status: OutboxStatus.PENDING },
            data: {
              status: OutboxStatus.DISPATCHED,
              dispatchedAt: new Date(),
              attempts: { increment: 1 },
              lastError: null,
            },
          });
          summary.dispatched += 1;
        } else {
          await db.jobDispatchOutbox.updateMany({
            where: { id: claimOutcome.outboxId, status: OutboxStatus.PENDING },
            data: {
              attempts: { increment: 1 },
              lastError: (dispatch.error ?? 'Redis unavailable').slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + 2000),
            },
          });
          summary.outboxDeferred += 1;
        }

        await eventService.record({
          type: PlatformEventType.JOB_SUBMITTED,
          organisationId: schedule.organisationId,
          queueId: schedule.queueId,
          jobId: claimOutcome.job.id,
          message: `Recurring schedule "${schedule.name}" spawned job "${claimOutcome.job.name}"`,
          metadata: {
            scheduleId: schedule.id,
            scheduledFor: occurrenceTime.toISOString(),
            nextRunAt: followingRunAt.toISOString(),
            enqueued: dispatch.enqueued,
          },
        });
      }

      if (summary.dispatched > 0 || summary.skippedOverlap > 0 || summary.completedOneTime > 0) {
        logger.info('Schedule dispatcher tick completed', { ...summary });
      }

      return summary;
    } catch (err) {
      logger.error('Schedule dispatcher tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return summary;
    } finally {
      this.inFlight = false;
    }
  }

  start(intervalMs: number = 1000): void {
    if (this.timer) return;
    const safeInterval = Math.max(500, intervalMs);
    this.timer = setInterval(() => {
      void this.tick();
    }, safeInterval);
    this.timer.unref();
    logger.info('Schedule dispatcher started', { intervalMs: safeInterval });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Schedule dispatcher stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const scheduleDispatcherService = new ScheduleDispatcherService();

import {
  JobStatus,
  MisfirePolicy,
  OutboxStatus,
  PlatformEventType,
  Prisma,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
  SchedulingPolicy,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { TooManyRequestsError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  collectDueCronRuns,
  computeLatestMissedCronRun,
  computeNextCronRun,
  isCronOccurrenceMisfired,
} from '../utils/scheduleTime.js';
import { bullMQService, type BullMQService } from './bullmq.service.js';
import { eventService } from './event.service.js';
import { governanceService, type AdmissionRejectionDetails } from './governance.service.js';
import {
  buildInitialSchedulingFields,
  isCustomSchedulingPolicy,
  prioritySchedulerService,
} from './priorityScheduler.service.js';

const MAX_SKIP_AUDIT_RECORDS = 10;

export interface ScheduleTickSummary {
  scanned: number;
  dispatched: number;
  catchUpDispatched: number;
  missedRecorded: number;
  skippedOverlap: number;
  skippedConcurrency: number;
  skippedMinInterval: number;
  skippedMaxRuns: number;
  skippedContention: number;
  completedOneTime: number;
  completedMaxRuns: number;
  outboxDeferred: number;
}

export interface ScheduleBullMQReconcileSummary {
  scanned: number;
  reEnqueued: number;
  alreadyPresent: number;
  failed: number;
}

export interface ScheduleDispatcherOptions {
  bullMQ?: BullMQService;
  batchSize?: number;
}

export interface ScheduleTickOptions {
  organisationId?: string;
}

interface TargetOccurrence {
  scheduledFor: Date;
  isCatchUp: boolean;
  reason: string | null;
}

interface MissedAuditEntry {
  scheduledFor: Date;
  reason: string;
}

interface DispatchedJobRecord {
  executionId: string;
  outboxId: string;
  scheduledFor: Date;
  isCatchUp: boolean;
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
}

function emptyTickSummary(): ScheduleTickSummary {
  return {
    scanned: 0,
    dispatched: 0,
    catchUpDispatched: 0,
    missedRecorded: 0,
    skippedOverlap: 0,
    skippedConcurrency: 0,
    skippedMinInterval: 0,
    skippedMaxRuns: 0,
    skippedContention: 0,
    completedOneTime: 0,
    completedMaxRuns: 0,
    outboxDeferred: 0,
  };
}

/**
 * PostgreSQL-authoritative Schedule Dispatcher (Step 5.1 + Step 5.2).
 *
 * Safely supports multiple concurrent scheduler/worker processes, restarts, Redis outages,
 * and extended downtime:
 * - Serializes per-schedule claim/limit checks via PostgreSQL transaction-scoped advisory
 *   locks (`pg_advisory_xact_lock`) + optimistic concurrency + `@@unique([scheduleId, scheduledFor])`.
 * - Implements configurable misfire policies: `SKIP_MISSED`, `FIRE_ONCE`, and bounded `CATCH_UP`.
 * - Atomically enforces `preventOverlap`, `maxConcurrentRuns`, `maxTotalRuns`, and `minIntervalMs`.
 * - Persists immutable execution telemetry (`dispatchedAt`, `isCatchUp`, skip/miss reasons).
 * - Reconciles persisted pending/delayed scheduled jobs back into BullMQ if Redis lost state.
 */
export class ScheduleDispatcherService {
  private readonly bullMQ: BullMQService;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private reconcileInFlight = false;

  constructor(options: ScheduleDispatcherOptions = {}) {
    this.bullMQ = options.bullMQ ?? bullMQService;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Executes one bounded, overlap-guarded scheduling tick.
   */
  async tick(
    now: Date = new Date(),
    options: ScheduleTickOptions = {},
  ): Promise<ScheduleTickSummary> {
    if (this.inFlight) {
      return emptyTickSummary();
    }

    this.inFlight = true;
    const summary = emptyTickSummary();

    try {
      const orgFilter = options.organisationId ? { organisationId: options.organisationId } : {};

      // 1. Reconcile & materialize ONE_TIME schedules
      const oneTimeLookahead = new Date(now.getTime() + 60_000);
      const activeOneTime = await db.schedule.findMany({
        where: {
          ...orgFilter,
          type: ScheduleType.ONE_TIME,
          status: ScheduleStatus.ACTIVE,
        },
        include: {
          queue: true,
          executions: {
            include: {
              job: {
                select: {
                  id: true,
                  status: true,
                  startedAt: true,
                  completedAt: true,
                  failedAt: true,
                  durationMs: true,
                  attemptsMade: true,
                },
              },
            },
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
              where: { id: latestExec.id },
              data: {
                ...(latestExec.status === ScheduleExecutionStatus.SCHEDULED
                  ? { status: ScheduleExecutionStatus.DISPATCHED }
                  : {}),
                finalJobStatus: latestExec.job.status,
                startedAt: latestExec.startedAt ?? latestExec.job.startedAt,
                completedAt:
                  latestExec.completedAt ?? latestExec.job.completedAt ?? latestExec.job.failedAt,
                durationMs: latestExec.durationMs ?? latestExec.job.durationMs,
                retryCount: Math.max(
                  latestExec.retryCount,
                  Math.max(0, latestExec.job.attemptsMade - 1),
                ),
              },
            });
            summary.completedOneTime += 1;
          }
          continue;
        }

        // Deferred far-future ONE_TIME materialization when entering 60s lookahead window
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
            { type: 'skipped' } | { type: 'created'; record: DispatchedJobRecord };

          try {
            materializeOutcome = await db.$transaction(
              async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pulsequeue:schedule:${sched.id}`}))`;

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

                const initialStatus = sched.queue.isPaused
                  ? JobStatus.PAUSED
                  : delayMs > 0
                    ? JobStatus.DELAYED
                    : JobStatus.PENDING;

                await governanceService.enforceAdmissionInTransaction(tx, {
                  orgId: sched.organisationId,
                  queue: {
                    id: sched.queue.id,
                    name: sched.queue.name,
                    maxQueueDepth: sched.queue.maxQueueDepth,
                    backpressureMaxAgeMs: sched.queue.backpressureMaxAgeMs,
                  },
                  payload: sched.payload,
                  initialStatus,
                });

                const effectivePriority = sched.priority ?? sched.queue.defaultPriority;
                const schedFields = buildInitialSchedulingFields(
                  sched.queue,
                  effectivePriority,
                  0,
                  delayMs > 0 ? targetRunAt : now,
                );

                const job = await tx.job.create({
                  data: {
                    queueId: sched.queue.id,
                    name: sched.jobName,
                    status: initialStatus,
                    priority: effectivePriority,
                    payload: sched.payload as Prisma.InputJsonValue,
                    maxRetries: sched.maxRetries ?? sched.queue.maxRetries,
                    backoffMs: sched.backoffMs ?? sched.queue.backoffMs,
                    delayMs,
                    dispatchState: schedFields.dispatchState,
                    readyAt: schedFields.readyAt,
                    virtualRankAt: schedFields.virtualRankAt,
                    createdById: sched.createdById,
                  },
                });

                let executionId: string;
                if (existingExec) {
                  const claimed = await tx.scheduleExecution.updateMany({
                    where: { id: existingExec.id, status: ScheduleExecutionStatus.CANCELLED },
                    data: {
                      jobId: job.id,
                      status: ScheduleExecutionStatus.SCHEDULED,
                      finalJobStatus: initialStatus,
                      reason: null,
                    },
                  });
                  if (claimed.count !== 1) {
                    throw new Prisma.PrismaClientKnownRequestError(
                      'Concurrent one-time materialization',
                      { code: 'P2002', clientVersion: '6.19.3' },
                    );
                  }
                  executionId = existingExec.id;
                } else {
                  const createdExec = await tx.scheduleExecution.create({
                    data: {
                      scheduleId: sched.id,
                      jobId: job.id,
                      scheduledFor: targetRunAt,
                      status: ScheduleExecutionStatus.SCHEDULED,
                      finalJobStatus: initialStatus,
                    },
                    select: { id: true },
                  });
                  executionId = createdExec.id;
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

                await tx.schedule.update({
                  where: { id: sched.id },
                  data: { lastDispatchedAt: now },
                });

                return {
                  type: 'created' as const,
                  record: {
                    executionId,
                    outboxId: outbox.id,
                    scheduledFor: targetRunAt,
                    isCatchUp: false,
                    job,
                  },
                };
              },
              { maxWait: 10_000, timeout: 10_000 },
            );
          } catch (err) {
            if (err instanceof TooManyRequestsError) {
              const details = err.details as AdmissionRejectionDetails | undefined;
              summary.skippedConcurrency += 1;
              await eventService.record({
                type: PlatformEventType.JOB_ADMISSION_REJECTED,
                organisationId: sched.organisationId,
                queueId: sched.queue.id,
                message: err.message,
                metadata: {
                  source: 'schedule_dispatcher_one_time',
                  scheduleId: sched.id,
                  scheduleName: sched.name,
                  jobName: sched.jobName,
                  reason: details?.reason ?? 'QUOTA_EXCEEDED',
                  scope: details?.scope ?? 'organisation',
                  limit: details?.limit ?? null,
                  current: details?.current ?? null,
                },
              });
              logger.warn(
                'Deferred one-time schedule materialization rejected by quota/backpressure',
                {
                  scheduleId: sched.id,
                  organisationId: sched.organisationId,
                  reason: details?.reason,
                },
              );
              continue;
            }
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

          await this.dispatchJobRecord(
            sched.queue,
            sched.id,
            sched.name,
            sched.organisationId,
            sched.misfirePolicy,
            null,
            materializeOutcome.record,
            summary,
          );
        }
      }

      // 2. Process due ACTIVE RECURRING schedules (`nextRunAt <= now`)
      const dueRecurring = await db.schedule.findMany({
        where: {
          ...orgFilter,
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

        await this.processDueRecurringSchedule(schedule, now, summary);
      }

      if (
        summary.dispatched > 0 ||
        summary.missedRecorded > 0 ||
        summary.skippedOverlap > 0 ||
        summary.skippedConcurrency > 0 ||
        summary.skippedMinInterval > 0 ||
        summary.skippedMaxRuns > 0 ||
        summary.completedOneTime > 0 ||
        summary.completedMaxRuns > 0
      ) {
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

  /**
   * Handles one due recurring schedule atomically with misfire policy evaluation,
   * advisory locking, concurrency/interval/maxTotalRuns enforcement, and BullMQ dispatch.
   */
  private async processDueRecurringSchedule(
    schedule: Prisma.ScheduleGetPayload<{ include: { queue: true } }>,
    now: Date,
    summary: ScheduleTickSummary,
  ): Promise<void> {
    const cron = schedule.cronExpression!;
    const occurrenceTime = schedule.nextRunAt!;
    const followingRunAt = computeNextCronRun(cron, schedule.timezone, now);

    const misfired = isCronOccurrenceMisfired(
      cron,
      schedule.timezone,
      occurrenceTime,
      now,
      schedule.misfireGraceMs,
    );

    const targets: TargetOccurrence[] = [];
    const missedAudit: MissedAuditEntry[] = [];

    if (!misfired) {
      targets.push({ scheduledFor: occurrenceTime, isCatchUp: false, reason: null });
    } else if (schedule.misfirePolicy === MisfirePolicy.SKIP_MISSED) {
      const { runs, truncated } = collectDueCronRuns(
        cron,
        schedule.timezone,
        occurrenceTime,
        now,
        MAX_SKIP_AUDIT_RECORDS,
      );
      runs.forEach((slot, idx) => {
        const isLastAndTruncated = truncated && idx === runs.length - 1;
        missedAudit.push({
          scheduledFor: slot,
          reason: isLastAndTruncated
            ? `Skipped under SKIP_MISSED misfire policy (additional missed occurrences before ${now.toISOString()} were also skipped)`
            : 'Skipped under SKIP_MISSED misfire policy',
        });
      });
    } else if (schedule.misfirePolicy === MisfirePolicy.FIRE_ONCE) {
      const latestMissed = computeLatestMissedCronRun(cron, schedule.timezone, occurrenceTime, now);
      if (latestMissed.getTime() > occurrenceTime.getTime()) {
        missedAudit.push({
          scheduledFor: occurrenceTime,
          reason: `Coalesced into single FIRE_ONCE catch-up execution for ${latestMissed.toISOString()}`,
        });
      }
      targets.push({
        scheduledFor: latestMissed,
        isCatchUp: true,
        reason:
          latestMissed.getTime() > occurrenceTime.getTime()
            ? `Recovered single catch-up execution under FIRE_ONCE misfire policy (missed window since ${occurrenceTime.toISOString()})`
            : 'Recovered single catch-up execution under FIRE_ONCE misfire policy',
      });
    } else if (schedule.misfirePolicy === MisfirePolicy.CATCH_UP) {
      const catchUpLimit = Math.max(1, schedule.maxCatchUpRuns);
      const { runs, truncated } = collectDueCronRuns(
        cron,
        schedule.timezone,
        occurrenceTime,
        now,
        catchUpLimit,
      );
      for (const slot of runs) {
        targets.push({
          scheduledFor: slot,
          isCatchUp: true,
          reason: `Replayed under CATCH_UP misfire policy (limit ${catchUpLimit})`,
        });
      }
      if (truncated && runs.length > 0) {
        const latestMissed = computeLatestMissedCronRun(
          cron,
          schedule.timezone,
          occurrenceTime,
          now,
        );
        const lastReplayed = runs[runs.length - 1];
        if (latestMissed.getTime() > lastReplayed.getTime()) {
          missedAudit.push({
            scheduledFor: latestMissed,
            reason: `Skipped because missed occurrences exceeded maxCatchUpRuns limit (${catchUpLimit}) before ${now.toISOString()}`,
          });
        }
      }
    }

    let txOutcome: {
      contention: boolean;
      created: DispatchedJobRecord[];
      missedRecorded: number;
      skippedOverlap: number;
      skippedConcurrency: number;
      skippedMinInterval: number;
      skippedMaxRuns: number;
      skippedContention: number;
      completedMaxRuns: boolean;
      admissionRejections: Array<{
        message: string;
        details?: AdmissionRejectionDetails;
      }>;
    };

    try {
      txOutcome = await db.$transaction(
        async (tx) => {
          // Cross-process PostgreSQL advisory lock per schedule ID
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pulsequeue:schedule:${schedule.id}`}))`;

          const fresh = await tx.schedule.findUnique({
            where: { id: schedule.id },
          });

          if (
            !fresh ||
            fresh.status !== ScheduleStatus.ACTIVE ||
            !fresh.nextRunAt ||
            fresh.nextRunAt.getTime() !== occurrenceTime.getTime()
          ) {
            return {
              contention: true,
              created: [],
              missedRecorded: 0,
              skippedOverlap: 0,
              skippedConcurrency: 0,
              skippedMinInterval: 0,
              skippedMaxRuns: 0,
              skippedContention: 0,
              completedMaxRuns: false,
              admissionRejections: [] as Array<{
                message: string;
                details?: AdmissionRejectionDetails;
              }>,
            };
          }

          let missedRecorded = 0;
          let skippedOverlap = 0;
          let skippedConcurrency = 0;
          let skippedMinInterval = 0;
          let skippedMaxRuns = 0;
          let skippedContention = 0;
          const created: DispatchedJobRecord[] = [];
          const admissionRejections: Array<{
            message: string;
            details?: AdmissionRejectionDetails;
          }> = [];

          // Record MISSED audit rows idempotently
          for (const missed of missedAudit) {
            const exists = await tx.scheduleExecution.findUnique({
              where: {
                scheduleId_scheduledFor: {
                  scheduleId: fresh.id,
                  scheduledFor: missed.scheduledFor,
                },
              },
              select: { id: true },
            });
            if (!exists) {
              await tx.scheduleExecution.create({
                data: {
                  scheduleId: fresh.id,
                  scheduledFor: missed.scheduledFor,
                  status: ScheduleExecutionStatus.MISSED,
                  reason: missed.reason,
                },
              });
              missedRecorded += 1;
            }
          }

          // Load live concurrency count, runCount, and lastDispatchedAt inside the lock
          const effectiveMaxConcurrent =
            fresh.maxConcurrentRuns ?? (fresh.preventOverlap ? 1 : null);

          let currentInFlight =
            effectiveMaxConcurrent !== null
              ? await tx.job.count({
                  where: {
                    scheduleExecution: { scheduleId: fresh.id },
                    status: {
                      in: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.DELAYED],
                    },
                  },
                })
              : 0;

          let currentRunCount = fresh.runCount;
          let currentLastDispatchedAt = fresh.lastDispatchedAt;
          let latestDispatchedSlot = fresh.lastRunAt;
          let reachedMaxRuns = fresh.maxTotalRuns !== null && currentRunCount >= fresh.maxTotalRuns;

          for (const target of targets) {
            // Idempotency guard: never duplicate an already-recorded occurrence timestamp
            const existingExec = await tx.scheduleExecution.findUnique({
              where: {
                scheduleId_scheduledFor: {
                  scheduleId: fresh.id,
                  scheduledFor: target.scheduledFor,
                },
              },
              select: { id: true },
            });
            if (existingExec) {
              skippedContention += 1;
              continue;
            }

            // 1. maxTotalRuns guard
            if (fresh.maxTotalRuns !== null && currentRunCount >= fresh.maxTotalRuns) {
              reachedMaxRuns = true;
              await tx.scheduleExecution.create({
                data: {
                  scheduleId: fresh.id,
                  scheduledFor: target.scheduledFor,
                  status: ScheduleExecutionStatus.SKIPPED_MAX_RUNS,
                  isCatchUp: target.isCatchUp,
                  reason: `Skipped because schedule reached maxTotalRuns limit (${fresh.maxTotalRuns})`,
                },
              });
              skippedMaxRuns += 1;
              continue;
            }

            // 2. Overlap / maxConcurrentRuns guard
            if (effectiveMaxConcurrent !== null && currentInFlight >= effectiveMaxConcurrent) {
              const isOverlapSingle = fresh.preventOverlap && effectiveMaxConcurrent === 1;
              await tx.scheduleExecution.create({
                data: {
                  scheduleId: fresh.id,
                  scheduledFor: target.scheduledFor,
                  status: isOverlapSingle
                    ? ScheduleExecutionStatus.SKIPPED_OVERLAP
                    : ScheduleExecutionStatus.SKIPPED_CONCURRENCY,
                  isCatchUp: target.isCatchUp,
                  reason: isOverlapSingle
                    ? `Skipped because ${currentInFlight} previous occurrence(s) are still in progress`
                    : `Skipped because ${currentInFlight} concurrent execution(s) reached maxConcurrentRuns limit (${effectiveMaxConcurrent})`,
                },
              });
              if (isOverlapSingle) {
                skippedOverlap += 1;
              } else {
                skippedConcurrency += 1;
              }
              continue;
            }

            // 3. minIntervalMs guard
            if (fresh.minIntervalMs !== null && currentLastDispatchedAt !== null) {
              const elapsedMs = now.getTime() - currentLastDispatchedAt.getTime();
              if (elapsedMs < fresh.minIntervalMs) {
                await tx.scheduleExecution.create({
                  data: {
                    scheduleId: fresh.id,
                    scheduledFor: target.scheduledFor,
                    status: ScheduleExecutionStatus.SKIPPED_MIN_INTERVAL,
                    isCatchUp: target.isCatchUp,
                    reason: `Skipped because minimum interval (${fresh.minIntervalMs}ms) has not elapsed (${Math.max(0, elapsedMs)}ms since last dispatch)`,
                  },
                });
                skippedMinInterval += 1;
                continue;
              }
            }

            // 4. Enforce tenant quotas & queue backpressure before materializing scheduled job
            const initialJobStatus = schedule.queue.isPaused ? JobStatus.PAUSED : JobStatus.PENDING;
            try {
              await governanceService.enforceAdmissionInTransaction(tx, {
                orgId: fresh.organisationId,
                queue: {
                  id: schedule.queue.id,
                  name: schedule.queue.name,
                  maxQueueDepth: schedule.queue.maxQueueDepth,
                  backpressureMaxAgeMs: schedule.queue.backpressureMaxAgeMs,
                },
                payload: fresh.payload,
                initialStatus: initialJobStatus,
              });
            } catch (admissionErr) {
              if (admissionErr instanceof TooManyRequestsError) {
                const details = admissionErr.details as AdmissionRejectionDetails | undefined;
                await tx.scheduleExecution.create({
                  data: {
                    scheduleId: fresh.id,
                    scheduledFor: target.scheduledFor,
                    status: ScheduleExecutionStatus.SKIPPED_CONCURRENCY,
                    isCatchUp: target.isCatchUp,
                    reason: `Admission rejected: ${admissionErr.message}`,
                  },
                });
                skippedConcurrency += 1;
                admissionRejections.push({ message: admissionErr.message, details });
                continue;
              }
              throw admissionErr;
            }

            // 5. Commit Job + ScheduleExecution + Outbox atomically
            const effectivePriority = fresh.priority ?? schedule.queue.defaultPriority;
            const schedFields = buildInitialSchedulingFields(
              schedule.queue,
              effectivePriority,
              0,
              now,
            );

            const job = await tx.job.create({
              data: {
                queueId: schedule.queue.id,
                name: fresh.jobName,
                status: initialJobStatus,
                priority: effectivePriority,
                payload: fresh.payload as Prisma.InputJsonValue,
                maxRetries: fresh.maxRetries ?? schedule.queue.maxRetries,
                backoffMs: fresh.backoffMs ?? schedule.queue.backoffMs,
                delayMs: 0,
                dispatchState: schedFields.dispatchState,
                readyAt: schedFields.readyAt,
                virtualRankAt: schedFields.virtualRankAt,
                createdById: fresh.createdById,
              },
            });

            const exec = await tx.scheduleExecution.create({
              data: {
                scheduleId: fresh.id,
                jobId: job.id,
                scheduledFor: target.scheduledFor,
                status: ScheduleExecutionStatus.DISPATCHED,
                finalJobStatus: initialJobStatus,
                isCatchUp: target.isCatchUp,
                reason: target.reason,
              },
              select: { id: true },
            });

            const outbox = await tx.jobDispatchOutbox.create({
              data: {
                jobId: job.id,
                queueId: schedule.queue.id,
                organisationId: fresh.organisationId,
                status: OutboxStatus.PENDING,
              },
              select: { id: true },
            });

            currentRunCount += 1;
            currentInFlight += 1;
            currentLastDispatchedAt = now;
            latestDispatchedSlot = target.scheduledFor;

            created.push({
              executionId: exec.id,
              outboxId: outbox.id,
              scheduledFor: target.scheduledFor,
              isCatchUp: target.isCatchUp,
              job,
            });

            if (fresh.maxTotalRuns !== null && currentRunCount >= fresh.maxTotalRuns) {
              reachedMaxRuns = true;
            }
          }

          const shouldComplete =
            reachedMaxRuns ||
            (fresh.maxTotalRuns !== null && currentRunCount >= fresh.maxTotalRuns);

          await tx.schedule.update({
            where: { id: fresh.id },
            data: {
              status: shouldComplete ? ScheduleStatus.COMPLETED : ScheduleStatus.ACTIVE,
              nextRunAt: shouldComplete ? null : followingRunAt,
              ...(created.length > 0
                ? {
                    lastRunAt: latestDispatchedSlot,
                    lastDispatchedAt: now,
                    runCount: currentRunCount,
                  }
                : {}),
            },
          });

          return {
            contention: false,
            created,
            missedRecorded,
            skippedOverlap,
            skippedConcurrency,
            skippedMinInterval,
            skippedMaxRuns,
            skippedContention,
            completedMaxRuns: shouldComplete,
            admissionRejections,
          };
        },
        { maxWait: 10_000, timeout: 10_000 },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        summary.skippedContention += 1;
        return;
      }
      throw err;
    }

    if (txOutcome.contention) {
      summary.skippedContention += 1;
      return;
    }

    summary.missedRecorded += txOutcome.missedRecorded;
    summary.skippedOverlap += txOutcome.skippedOverlap;
    summary.skippedConcurrency += txOutcome.skippedConcurrency;
    summary.skippedMinInterval += txOutcome.skippedMinInterval;
    summary.skippedMaxRuns += txOutcome.skippedMaxRuns;
    summary.skippedContention += txOutcome.skippedContention;
    if (txOutcome.completedMaxRuns) {
      summary.completedMaxRuns += 1;
    }

    for (const rejection of txOutcome.admissionRejections) {
      await eventService.record({
        type: PlatformEventType.JOB_ADMISSION_REJECTED,
        organisationId: schedule.organisationId,
        queueId: schedule.queue.id,
        message: rejection.message,
        metadata: {
          source: 'schedule_dispatcher_recurring',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          jobName: schedule.jobName,
          reason: rejection.details?.reason ?? 'QUOTA_EXCEEDED',
          scope: rejection.details?.scope ?? 'organisation',
          limit: rejection.details?.limit ?? null,
          current: rejection.details?.current ?? null,
        },
      });
    }

    if (txOutcome.skippedOverlap > 0) {
      logger.warn('Recurring schedule occurrence skipped due to active overlap', {
        scheduleId: schedule.id,
        organisationId: schedule.organisationId,
        skippedOverlap: txOutcome.skippedOverlap,
      });
    }
    if (txOutcome.skippedConcurrency > 0) {
      logger.warn('Recurring schedule occurrence skipped due to maxConcurrentRuns limit', {
        scheduleId: schedule.id,
        organisationId: schedule.organisationId,
        maxConcurrentRuns: schedule.maxConcurrentRuns,
        skippedConcurrency: txOutcome.skippedConcurrency,
      });
    }
    if (txOutcome.skippedMinInterval > 0) {
      logger.warn('Recurring schedule occurrence skipped due to minIntervalMs limit', {
        scheduleId: schedule.id,
        organisationId: schedule.organisationId,
        minIntervalMs: schedule.minIntervalMs,
        skippedMinInterval: txOutcome.skippedMinInterval,
      });
    }

    for (const record of txOutcome.created) {
      await this.dispatchJobRecord(
        schedule.queue,
        schedule.id,
        schedule.name,
        schedule.organisationId,
        schedule.misfirePolicy,
        txOutcome.completedMaxRuns ? null : followingRunAt,
        record,
        summary,
      );
    }
  }

  /**
   * Dispatches a committed job record to BullMQ with stable jobId, updates outbox +
   * `ScheduleExecution.dispatchedAt`, and records an audit event.
   */
  private async dispatchJobRecord(
    queue: Prisma.ScheduleGetPayload<{ include: { queue: true } }>['queue'],
    scheduleId: string,
    scheduleName: string,
    organisationId: string,
    misfirePolicy: MisfirePolicy,
    followingRunAt: Date | null,
    record: DispatchedJobRecord,
    summary: ScheduleTickSummary,
  ): Promise<void> {
    const isCustomPolicy = isCustomSchedulingPolicy(queue.schedulingPolicy);
    let enqueued = false;

    if (isCustomPolicy) {
      // Custom-policy scheduled jobs stay QUEUED in PostgreSQL until PrioritySchedulerService
      // dispatches them once readyAt <= now (never bypassing custom scheduling).
      summary.outboxDeferred += 1;
      if (!queue.isPaused && record.job.delayMs === 0) {
        prioritySchedulerService.nudgeQueue(queue.id);
      }
    } else {
      const dispatch = await this.bullMQ.enqueueJob(queue, record.job);
      enqueued = dispatch.enqueued;

      if (dispatch.enqueued) {
        const dispatchedAt = new Date();
        await Promise.all([
          db.jobDispatchOutbox.updateMany({
            where: { id: record.outboxId, status: OutboxStatus.PENDING },
            data: {
              status: OutboxStatus.DISPATCHED,
              dispatchedAt,
              attempts: { increment: 1 },
              lastError: null,
            },
          }),
          db.scheduleExecution.updateMany({
            where: { id: record.executionId, dispatchedAt: null },
            data: { dispatchedAt },
          }),
        ]);
        summary.dispatched += 1;
        if (record.isCatchUp) {
          summary.catchUpDispatched += 1;
        }
      } else {
        await db.jobDispatchOutbox.updateMany({
          where: { id: record.outboxId, status: OutboxStatus.PENDING },
          data: {
            attempts: { increment: 1 },
            lastError: (dispatch.error ?? 'Redis unavailable').slice(0, 1000),
            nextAttemptAt: new Date(Date.now() + 2000),
          },
        });
        summary.outboxDeferred += 1;
      }
    }

    await eventService.record({
      type: PlatformEventType.JOB_SUBMITTED,
      organisationId,
      queueId: queue.id,
      jobId: record.job.id,
      message: record.isCatchUp
        ? `Schedule "${scheduleName}" dispatched catch-up job "${record.job.name}" (${misfirePolicy})`
        : `Schedule "${scheduleName}" spawned job "${record.job.name}"`,
      metadata: {
        scheduleId,
        scheduledFor: record.scheduledFor.toISOString(),
        nextRunAt: followingRunAt?.toISOString() ?? null,
        isCatchUp: record.isCatchUp,
        misfirePolicy,
        enqueued,
      },
    });
  }

  /**
   * Reconciles persisted pending/delayed scheduled jobs in PostgreSQL against BullMQ Redis.
   * If Redis lost job state (e.g. flush/restart) while PostgreSQL still holds a PENDING/DELAYED
   * scheduled job whose outbox was previously marked DISPATCHED, re-enqueues it idempotently
   * with accurate remaining delay. Bounded per call to avoid excessive Redis operations.
   */
  async reconcileWithBullMQ(
    options: ScheduleTickOptions = {},
  ): Promise<ScheduleBullMQReconcileSummary> {
    if (this.reconcileInFlight) {
      return { scanned: 0, reEnqueued: 0, alreadyPresent: 0, failed: 0 };
    }

    this.reconcileInFlight = true;
    const summary: ScheduleBullMQReconcileSummary = {
      scanned: 0,
      reEnqueued: 0,
      alreadyPresent: 0,
      failed: 0,
    };

    try {
      const candidates = await db.scheduleExecution.findMany({
        where: {
          status: { in: [ScheduleExecutionStatus.SCHEDULED, ScheduleExecutionStatus.DISPATCHED] },
          jobId: { not: null },
          schedule: {
            status: ScheduleStatus.ACTIVE,
            ...(options.organisationId ? { organisationId: options.organisationId } : {}),
          },
          job: {
            status: { in: [JobStatus.PENDING, JobStatus.DELAYED] },
            queue: {
              schedulingPolicy: SchedulingPolicy.LEGACY_BULLMQ,
            },
            dispatchOutbox: {
              status: OutboxStatus.DISPATCHED,
            },
          },
        },
        include: {
          job: {
            include: {
              queue: true,
            },
          },
        },
        orderBy: [{ scheduledFor: 'asc' }],
        take: this.batchSize,
      });

      summary.scanned = candidates.length;

      for (const exec of candidates) {
        if (!exec.job || !exec.job.queue) {
          continue;
        }

        const bullState = await this.bullMQ.getBullJobState(exec.job.queue, exec.job.id);
        if (bullState !== null) {
          summary.alreadyPresent += 1;
          continue;
        }

        const remainingDelayMs =
          exec.job.delayMs > 0
            ? Math.max(0, exec.job.createdAt.getTime() + exec.job.delayMs - Date.now())
            : 0;

        const dispatch = await this.bullMQ.enqueueJob(exec.job.queue, {
          ...exec.job,
          delayMs: remainingDelayMs,
        });

        if (dispatch.enqueued) {
          if (!exec.dispatchedAt) {
            await db.scheduleExecution.updateMany({
              where: { id: exec.id, dispatchedAt: null },
              data: { dispatchedAt: new Date() },
            });
          }
          summary.reEnqueued += 1;
          logger.warn('Reconciled missing scheduled job back into BullMQ from PostgreSQL', {
            scheduleId: exec.scheduleId,
            jobId: exec.job.id,
            organisationId: exec.job.queue.organisationId,
            remainingDelayMs,
          });
        } else {
          summary.failed += 1;
        }
      }

      return summary;
    } catch (err) {
      logger.error('Schedule BullMQ reconciliation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return summary;
    } finally {
      this.reconcileInFlight = false;
    }
  }

  start(intervalMs: number = 1000, reconcileIntervalMs: number = 30_000): void {
    if (this.timer) return;
    const safeInterval = Math.max(500, intervalMs);
    this.timer = setInterval(() => {
      void this.tick();
    }, safeInterval);
    this.timer.unref();

    const safeReconcileInterval = Math.max(5_000, reconcileIntervalMs);
    this.reconcileTimer = setInterval(() => {
      void this.reconcileWithBullMQ();
    }, safeReconcileInterval);
    this.reconcileTimer.unref();

    logger.info('Schedule dispatcher started', {
      intervalMs: safeInterval,
      reconcileIntervalMs: safeReconcileInterval,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    logger.info('Schedule dispatcher stopped');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const scheduleDispatcherService = new ScheduleDispatcherService();

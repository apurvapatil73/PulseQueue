import { DeadLetterStatus, JobStatus, PlatformEventType } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { workerHealthService, type OrgSafeWorkerView } from './workerHealth.service.js';

export interface QueueMetricsItem {
  queueId: string;
  name: string;
  isPaused: boolean;
  concurrency: number;
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  averageDurationMs: number | null;
  openDeadLetters: number;
}

export interface OrganisationMetricsView {
  organisationId: string;
  summary: {
    totalSubmitted: number;
    totalProcessed: number;
    succeeded: number;
    failed: number;
    active: number;
    pending: number;
    delayed: number;
    paused: number;
    retriedJobs: number;
    totalRetryEvents: number;
    stalledRecoveries: number;
    deadLetterOpen: number;
    deadLetterReplayed: number;
    averageDurationMs: number | null;
  };
  throughput: {
    windowMinutes: number;
    completedInWindow: number;
    failedInWindow: number;
    processedInWindow: number;
    jobsPerMinute: number;
  };
  queues: QueueMetricsItem[];
  workers: OrgSafeWorkerView[];
  generatedAt: string;
}

/**
 * Genuine persisted execution metrics service.
 * Aggregates exclusively from live PostgreSQL records — never returns synthetic or hardcoded values.
 */
export class MetricsService {
  async getOrganisationMetrics(
    orgId: string,
    windowMinutes: number = 60,
  ): Promise<OrganisationMetricsView> {
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);

    const [
      queues,
      jobsByQueueAndStatus,
      durationAgg,
      durationByQueue,
      retriedJobsCount,
      retryEventsCount,
      stalledSumAgg,
      dlqByStatus,
      dlqOpenByQueue,
      completedInWindow,
      failedInWindow,
      workers,
    ] = await Promise.all([
      db.queue.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true, isPaused: true, concurrency: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.job.groupBy({
        by: ['queueId', 'status'],
        where: { queue: { organisationId: orgId } },
        _count: { _all: true },
      }),
      db.job.aggregate({
        where: {
          queue: { organisationId: orgId },
          durationMs: { not: null },
        },
        _avg: { durationMs: true },
      }),
      db.job.groupBy({
        by: ['queueId'],
        where: {
          queue: { organisationId: orgId },
          durationMs: { not: null },
        },
        _avg: { durationMs: true },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          attemptsMade: { gt: 1 },
        },
      }),
      db.platformEvent.count({
        where: {
          organisationId: orgId,
          type: PlatformEventType.JOB_RETRIED,
        },
      }),
      db.job.aggregate({
        where: { queue: { organisationId: orgId } },
        _sum: { stalledCount: true },
      }),
      db.deadLetterJob.groupBy({
        by: ['status'],
        where: { organisationId: orgId },
        _count: { _all: true },
      }),
      db.deadLetterJob.groupBy({
        by: ['queueId'],
        where: {
          organisationId: orgId,
          status: DeadLetterStatus.OPEN,
        },
        _count: { _all: true },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          status: JobStatus.COMPLETED,
          completedAt: { gte: windowStart },
        },
      }),
      db.job.count({
        where: {
          queue: { organisationId: orgId },
          status: JobStatus.FAILED,
          failedAt: { gte: windowStart },
        },
      }),
      workerHealthService.listWorkersForOrganisation(orgId),
    ]);

    const statusTotals: Record<JobStatus, number> = {
      [JobStatus.PENDING]: 0,
      [JobStatus.ACTIVE]: 0,
      [JobStatus.COMPLETED]: 0,
      [JobStatus.FAILED]: 0,
      [JobStatus.DELAYED]: 0,
      [JobStatus.PAUSED]: 0,
    };

    const queueStatusMap = new Map<string, Record<JobStatus, number>>();
    for (const row of jobsByQueueAndStatus) {
      statusTotals[row.status] += row._count._all;

      let qMap = queueStatusMap.get(row.queueId);
      if (!qMap) {
        qMap = {
          [JobStatus.PENDING]: 0,
          [JobStatus.ACTIVE]: 0,
          [JobStatus.COMPLETED]: 0,
          [JobStatus.FAILED]: 0,
          [JobStatus.DELAYED]: 0,
          [JobStatus.PAUSED]: 0,
        };
        queueStatusMap.set(row.queueId, qMap);
      }
      qMap[row.status] = row._count._all;
    }

    const durationMap = new Map<string, number | null>();
    for (const row of durationByQueue) {
      durationMap.set(
        row.queueId,
        row._avg.durationMs !== null ? Math.round(row._avg.durationMs * 100) / 100 : null,
      );
    }

    const dlqQueueMap = new Map<string, number>();
    for (const row of dlqOpenByQueue) {
      dlqQueueMap.set(row.queueId, row._count._all);
    }

    let deadLetterOpen = 0;
    let deadLetterReplayed = 0;
    for (const row of dlqByStatus) {
      if (row.status === DeadLetterStatus.OPEN) deadLetterOpen = row._count._all;
      if (row.status === DeadLetterStatus.REPLAYED) deadLetterReplayed = row._count._all;
    }

    const totalSubmitted = Object.values(statusTotals).reduce((acc, v) => acc + v, 0);
    const totalProcessed = statusTotals[JobStatus.COMPLETED] + statusTotals[JobStatus.FAILED];
    const processedInWindow = completedInWindow + failedInWindow;
    const jobsPerMinute =
      windowMinutes > 0 ? Math.round((processedInWindow / windowMinutes) * 1000) / 1000 : 0;

    const queueMetrics: QueueMetricsItem[] = queues.map((q) => {
      const byStatus = queueStatusMap.get(q.id) ?? {
        [JobStatus.PENDING]: 0,
        [JobStatus.ACTIVE]: 0,
        [JobStatus.COMPLETED]: 0,
        [JobStatus.FAILED]: 0,
        [JobStatus.DELAYED]: 0,
        [JobStatus.PAUSED]: 0,
      };
      const totalJobs = Object.values(byStatus).reduce((acc, v) => acc + v, 0);

      return {
        queueId: q.id,
        name: q.name,
        isPaused: q.isPaused,
        concurrency: q.concurrency,
        totalJobs,
        byStatus,
        averageDurationMs: durationMap.get(q.id) ?? null,
        openDeadLetters: dlqQueueMap.get(q.id) ?? 0,
      };
    });

    return {
      organisationId: orgId,
      summary: {
        totalSubmitted,
        totalProcessed,
        succeeded: statusTotals[JobStatus.COMPLETED],
        failed: statusTotals[JobStatus.FAILED],
        active: statusTotals[JobStatus.ACTIVE],
        pending: statusTotals[JobStatus.PENDING],
        delayed: statusTotals[JobStatus.DELAYED],
        paused: statusTotals[JobStatus.PAUSED],
        retriedJobs: retriedJobsCount,
        totalRetryEvents: retryEventsCount,
        stalledRecoveries: stalledSumAgg._sum.stalledCount ?? 0,
        deadLetterOpen,
        deadLetterReplayed,
        averageDurationMs:
          durationAgg._avg.durationMs !== null
            ? Math.round(durationAgg._avg.durationMs * 100) / 100
            : null,
      },
      throughput: {
        windowMinutes,
        completedInWindow,
        failedInWindow,
        processedInWindow,
        jobsPerMinute,
      },
      queues: queueMetrics,
      workers,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const metricsService = new MetricsService();

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../config/queryClient';
import { AuthProvider } from '../contexts/AuthContext';
import { OrganisationProvider } from '../contexts/OrganisationContext';
import { AppRoutes } from '../App';
import { authApi } from '../api/auth.api';
import { dlqApi } from '../api/dlq.api';
import { healthApi } from '../api/health.api';
import { jobApi } from '../api/job.api';
import { monitoringApi } from '../api/monitoring.api';
import { organisationApi } from '../api/organisation.api';
import { queueApi } from '../api/queue.api';
import { scheduleApi } from '../api/schedule.api';
import type {
  DeadLetterJobView,
  JobView,
  MemberView,
  OrganisationMetricsView,
  OrganisationView,
  QueueView,
  ScheduleView,
} from '../types/api';

function renderFullApp(initialEntries: string[] = ['/dashboard'], qc = createQueryClient()) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={initialEntries}>
          <AuthProvider>
            <OrganisationProvider>
              <AppRoutes />
            </OrganisationProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function buildOrgMetrics(
  orgId: string,
  queues: QueueView[],
  jobs: JobView[],
): OrganisationMetricsView {
  const completed = jobs.filter((j) => j.status === 'COMPLETED').length;
  const failed = jobs.filter((j) => j.status === 'FAILED').length;
  const pending = jobs.filter((j) => j.status === 'PENDING').length;
  const active = jobs.filter((j) => j.status === 'ACTIVE').length;
  const delayed = jobs.filter((j) => j.status === 'DELAYED').length;
  const paused = jobs.filter((j) => j.status === 'PAUSED').length;

  return {
    organisationId: orgId,
    summary: {
      totalSubmitted: jobs.length,
      totalProcessed: completed + failed,
      succeeded: completed,
      failed,
      active,
      pending,
      delayed,
      paused,
      retriedJobs: failed,
      totalRetryEvents: failed,
      stalledRecoveries: 0,
      deadLetterOpen: failed,
      deadLetterReplayed: 0,
      averageDurationMs: 25,
    },
    throughput: {
      windowMinutes: 60,
      completedInWindow: completed,
      failedInWindow: failed,
      processedInWindow: completed + failed,
      jobsPerMinute: 2.0,
    },
    queues: queues.map((q) => {
      const qJobs = jobs.filter((j) => j.queueId === q.id);
      return {
        queueId: q.id,
        name: q.name,
        isPaused: q.isPaused,
        concurrency: q.concurrency,
        totalJobs: qJobs.length,
        byStatus: {
          PENDING: qJobs.filter((j) => j.status === 'PENDING').length,
          ACTIVE: qJobs.filter((j) => j.status === 'ACTIVE').length,
          COMPLETED: qJobs.filter((j) => j.status === 'COMPLETED').length,
          FAILED: qJobs.filter((j) => j.status === 'FAILED').length,
          DELAYED: qJobs.filter((j) => j.status === 'DELAYED').length,
          PAUSED: qJobs.filter((j) => j.status === 'PAUSED').length,
        },
        averageDurationMs: 25,
        openDeadLetters: qJobs.filter((j) => j.status === 'FAILED').length,
      };
    }),
    workers: [
      {
        workerInstanceId: `worker-${orgId}-01`,
        hostname: 'worker-host-1',
        pid: 4100,
        status: 'ONLINE',
        registeredQueues: queues.map((q) => `org_${orgId}__${q.name}`),
        jobsProcessed: completed + failed,
        jobsSucceeded: completed,
        jobsFailed: failed,
        lastError: null,
        lastHeartbeatAt: '2026-11-23T08:00:00.000Z',
        startedAt: '2026-11-23T00:00:00.000Z',
        stoppedAt: null,
        heartbeatAgeMs: 1200,
      },
    ],
    generatedAt: '2026-11-23T08:00:00.000Z',
  };
}

describe('Step 6.4.5 — Cross-Module Frontend Integration & End-to-End User Journeys', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();

    vi.spyOn(healthApi, 'getHealth').mockResolvedValue({
      status: 'ok',
      services: { database: 'connected', redis: 'connected' },
      timestamp: '2026-11-23T08:00:00.000Z',
    });
  });

  it('Workflow 1: Unauthenticated Login -> Dashboard Overview -> Queue Creation -> Pause/Resume -> Job Submission -> Job Detail Inspection', async () => {
    const user = userEvent.setup();

    const orgAlpha: OrganisationView = {
      id: 'org-alpha',
      name: 'Acme Payments',
      role: 'OWNER',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };

    const queues: QueueView[] = [];
    const jobs: JobView[] = [];

    // Start unauthenticated
    vi.spyOn(authApi, 'restoreSession').mockResolvedValue(null);
    vi.spyOn(authApi, 'login').mockResolvedValue({
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    vi.spyOn(organisationApi, 'list').mockImplementation(async () => [orgAlpha]);
    vi.spyOn(monitoringApi, 'getMetrics').mockImplementation(async (orgId) =>
      buildOrgMetrics(orgId, queues, jobs),
    );
    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [],
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(scheduleApi, 'list').mockResolvedValue({
      schedules: [],
      pagination: {
        page: 1,
        limit: 5,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    vi.spyOn(queueApi, 'list').mockImplementation(async () => [...queues]);
    vi.spyOn(queueApi, 'getById').mockImplementation(async (_orgId, qId) => {
      const found = queues.find((q) => q.id === qId);
      if (!found) throw new Error('Queue not found');
      return found;
    });
    vi.spyOn(queueApi, 'getStats').mockImplementation(async (_orgId, qId) => {
      const found = queues.find((q) => q.id === qId)!;
      const qJobs = jobs.filter((j) => j.queueId === qId);
      return {
        queueId: found.id,
        organisationId: 'org-alpha',
        name: found.name,
        isPaused: found.isPaused,
        pausedAt: found.pausedAt,
        config: {
          concurrency: found.concurrency,
          defaultPriority: found.defaultPriority,
          maxRetries: found.maxRetries,
          backoffMs: found.backoffMs,
        },
        jobs: {
          total: qJobs.length,
          byStatus: {
            PENDING: qJobs.filter((j) => j.status === 'PENDING').length,
            ACTIVE: qJobs.filter((j) => j.status === 'ACTIVE').length,
            COMPLETED: qJobs.filter((j) => j.status === 'COMPLETED').length,
            FAILED: qJobs.filter((j) => j.status === 'FAILED').length,
            DELAYED: qJobs.filter((j) => j.status === 'DELAYED').length,
            PAUSED: qJobs.filter((j) => j.status === 'PAUSED').length,
          },
        },
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
      };
    });

    vi.spyOn(queueApi, 'create').mockImplementation(async (_orgId, payload) => {
      const created: QueueView = {
        id: 'q-settlements-1',
        organisationId: 'org-alpha',
        name: payload.name,
        description: payload.description ?? null,
        isPaused: false,
        pausedAt: null,
        concurrency: payload.concurrency,
        defaultPriority: payload.defaultPriority,
        maxRetries: payload.maxRetries,
        backoffMs: payload.backoffMs,
        jobCount: 0,
        createdBy: {
          id: 'user-owner',
          name: 'Apurva Owner',
          email: 'owner@pulsequeue.dev',
        },
        createdAt: '2026-11-23T08:00:00.000Z',
        updatedAt: '2026-11-23T08:00:00.000Z',
      };
      queues.push(created);
      return created;
    });

    vi.spyOn(queueApi, 'pause').mockImplementation(async (_orgId, qId) => {
      const found = queues.find((q) => q.id === qId)!;
      found.isPaused = true;
      found.pausedAt = '2026-11-23T08:01:00.000Z';
      return { ...found };
    });

    vi.spyOn(queueApi, 'resume').mockImplementation(async (_orgId, qId) => {
      const found = queues.find((q) => q.id === qId)!;
      found.isPaused = false;
      found.pausedAt = null;
      return { ...found };
    });

    vi.spyOn(jobApi, 'listByQueue').mockImplementation(async (_orgId, qId) => {
      const qJobs = jobs.filter((j) => j.queueId === qId);
      return {
        jobs: qJobs,
        pagination: {
          page: 1,
          limit: 20,
          total: qJobs.length,
          totalPages: qJobs.length > 0 ? 1 : 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
    });

    vi.spyOn(jobApi, 'submit').mockImplementation(async (_orgId, qId, payload) => {
      const targetQueue = queues.find((q) => q.id === qId)!;
      const createdJob: JobView = {
        id: 'job-settle-111122223333',
        queueId: qId,
        queueName: targetQueue.name,
        organisationId: 'org-alpha',
        name: payload.name,
        status: targetQueue.isPaused ? 'PAUSED' : 'COMPLETED',
        priority: payload.priority ?? targetQueue.defaultPriority,
        payload: payload.payload,
        maxRetries: payload.maxRetries ?? targetQueue.maxRetries,
        backoffMs: payload.backoffMs ?? targetQueue.backoffMs,
        delayMs: payload.delayMs ?? 0,
        attemptsMade: targetQueue.isPaused ? 0 : 1,
        stalledCount: 0,
        durationMs: targetQueue.isPaused ? null : 19,
        lastWorkerId: targetQueue.isPaused ? null : 'worker-org-alpha-01',
        replayedFromDlqId: null,
        result: targetQueue.isPaused
          ? null
          : { processor: 'math.sum', output: { sum: 200, count: 4 } },
        errorMessage: null,
        startedAt: targetQueue.isPaused ? null : '2026-11-23T08:02:00.000Z',
        completedAt: targetQueue.isPaused ? null : '2026-11-23T08:02:00.019Z',
        failedAt: null,
        lastRecoveredAt: null,
        createdBy: {
          id: 'user-owner',
          name: 'Apurva Owner',
          email: 'owner@pulsequeue.dev',
        },
        createdAt: '2026-11-23T08:02:00.000Z',
        updatedAt: '2026-11-23T08:02:00.019Z',
      };
      jobs.unshift(createdJob);
      targetQueue.jobCount = jobs.length;
      return {
        job: createdJob,
        dispatch: {
          enqueued: true,
          deduplicated: false,
          bullmqJobId: createdJob.id,
          bullmqQueueName: `org_org-alpha__${targetQueue.name}`,
        },
      };
    });

    vi.spyOn(jobApi, 'getById').mockImplementation(async (_orgId, jId) => {
      return jobs.find((j) => j.id === jId)!;
    });

    // 1. Start at protected /dashboard -> redirected to /login
    renderFullApp(['/dashboard']);
    expect(await screen.findByLabelText('Work Email')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Work Email'), 'owner@pulsequeue.dev');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // 2. Arrives on Dashboard Overview for Acme Payments
    expect(
      await screen.findByText(/Real-time operational telemetry for Acme Payments/i),
    ).toBeInTheDocument();

    // 3. Navigate to Queues via Sidebar and create a queue
    await user.click(screen.getByRole('link', { name: 'Queues' }));
    expect(await screen.findByText('No queues created yet')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Create Queue/i })[0]);
    const createQueueModal = await screen.findByRole('dialog');
    await user.type(within(createQueueModal).getByLabelText('Queue Name'), 'settlements-prod');
    await user.click(within(createQueueModal).getByRole('button', { name: 'Create Queue' }));

    expect(await screen.findByText('settlements-prod')).toBeInTheDocument();

    // 4. Open QueueDetailPage -> Pause -> Resume -> Submit Job
    await user.click(screen.getByRole('link', { name: 'settlements-prod' }));
    expect(await screen.findByText('Queue Configuration')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Pause Queue/i }));
    const pauseDialog = await screen.findByRole('dialog');
    await user.click(within(pauseDialog).getByRole('button', { name: 'Pause Queue' }));
    expect(await screen.findByText(/Queue "settlements-prod" paused/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Resume Queue/i }));
    expect(await screen.findByText(/Queue "settlements-prod" resumed/i)).toBeInTheDocument();

    // Submit math.sum job from QueueDetailPage
    await user.click(screen.getAllByRole('button', { name: /Submit Job/i })[0]);
    const submitJobDialog = await screen.findByRole('dialog');
    await user.click(within(submitJobDialog).getByRole('button', { name: 'math.sum' }));
    await user.click(within(submitJobDialog).getByRole('button', { name: 'Submit Job' }));

    expect(await screen.findByText('math.sum')).toBeInTheDocument();

    // 5. Click into JobDetailPage and verify completed worker output & link back to queue
    await user.click(screen.getByRole('link', { name: 'math.sum' }));
    expect(await screen.findByText(/Completed successfully in 19 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/"sum": 200/)).toBeInTheDocument();
  }, 15_000);

  it('Workflow 2: Failed Job -> DLQ Inspection -> Replay -> Replayed Job Detail -> Linked Schedule Detail -> Spawned Job Navigation', async () => {
    const user = userEvent.setup();

    const orgAlpha: OrganisationView = {
      id: 'org-alpha',
      name: 'Acme Payments',
      role: 'OWNER',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };

    const queue: QueueView = {
      id: 'q-11111111-1111-4111-8111-111111111111',
      organisationId: 'org-alpha',
      name: 'billing-invoices',
      description: 'Billing queue',
      isPaused: false,
      pausedAt: null,
      concurrency: 5,
      defaultPriority: 5,
      maxRetries: 2,
      backoffMs: 1000,
      jobCount: 2,
      createdBy: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };

    const schedule: ScheduleView = {
      id: 'sched-11111111-1111-4111-8111-111111111111',
      organisationId: 'org-alpha',
      queueId: queue.id,
      queueName: queue.name,
      name: 'Hourly-Billing-Cron',
      description: 'Dispatches hourly billing jobs',
      type: 'RECURRING',
      status: 'ACTIVE',
      jobName: 'echo',
      payload: { message: 'scheduled-run' },
      priority: 3,
      maxRetries: 2,
      backoffMs: 1000,
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      runAt: null,
      nextRunAt: '2026-11-23T09:00:00.000Z',
      nextRunAtLocal: '2026-11-23T09:00:00.000Z',
      lastRunAt: '2026-11-23T08:00:00.000Z',
      lastDispatchedAt: '2026-11-23T08:00:00.050Z',
      runCount: 1,
      preventOverlap: true,
      misfirePolicy: 'SKIP_MISSED',
      maxCatchUpRuns: 5,
      misfireGraceMs: 60000,
      maxConcurrentRuns: null,
      maxTotalRuns: null,
      maxDurationMs: null,
      minIntervalMs: null,
      createdBy: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-23T08:00:00.050Z',
    };

    const originalFailedJob: JobView = {
      id: 'job-failed-0001-0001-4001-8001-000000000001',
      queueId: queue.id,
      queueName: queue.name,
      organisationId: 'org-alpha',
      name: 'echo',
      status: 'FAILED',
      priority: 3,
      payload: { message: 'scheduled-run' },
      maxRetries: 2,
      backoffMs: 1000,
      delayMs: 0,
      attemptsMade: 3,
      stalledCount: 0,
      durationMs: 95,
      lastWorkerId: 'worker-01',
      replayedFromDlqId: null,
      result: null,
      errorMessage: 'Downstream ledger timeout (attempt 3/3)',
      startedAt: '2026-11-23T08:00:01.000Z',
      completedAt: null,
      failedAt: '2026-11-23T08:00:05.000Z',
      lastRecoveredAt: null,
      createdBy: null,
      createdAt: '2026-11-23T08:00:00.050Z',
      updatedAt: '2026-11-23T08:00:05.000Z',
    };

    const dlqRecord: DeadLetterJobView = {
      id: 'dlq-0001-0001-4001-8001-000000000001',
      originalJobId: originalFailedJob.id,
      organisationId: 'org-alpha',
      queueId: queue.id,
      queueName: queue.name,
      jobName: 'echo',
      payloadSummary: { keyCount: 1, keys: ['message'], byteLength: 28 },
      failureReason: 'Downstream ledger timeout (attempt 3/3)',
      attemptsMade: 3,
      maxRetries: 2,
      status: 'OPEN',
      failedAt: '2026-11-23T08:00:05.000Z',
      replayedAt: null,
      replayedById: null,
      replayedJobId: null,
      createdAt: '2026-11-23T08:00:05.000Z',
      updatedAt: '2026-11-23T08:00:05.000Z',
    };

    const replayedCompletedJob: JobView = {
      ...originalFailedJob,
      id: 'job-replayed-0002-0002-4002-8002-000000000002',
      status: 'COMPLETED',
      attemptsMade: 1,
      durationMs: 22,
      replayedFromDlqId: dlqRecord.id,
      result: { processor: 'echo', output: { echoed: 'scheduled-run', length: 13 } },
      errorMessage: null,
      completedAt: '2026-11-23T08:05:01.022Z',
      failedAt: null,
    };

    vi.spyOn(authApi, 'restoreSession').mockResolvedValue({
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    vi.spyOn(organisationApi, 'list').mockResolvedValue([orgAlpha]);
    vi.spyOn(queueApi, 'list').mockResolvedValue([queue]);

    vi.spyOn(dlqApi, 'list').mockImplementation(async () => ({
      items: [dlqRecord],
      pagination: {
        page: 1,
        limit: 15,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    }));

    vi.spyOn(dlqApi, 'replay').mockImplementation(async () => {
      dlqRecord.status = 'REPLAYED';
      dlqRecord.replayedAt = '2026-11-23T08:05:00.000Z';
      dlqRecord.replayedJobId = replayedCompletedJob.id;
      return {
        deadLetterJob: { ...dlqRecord },
        replayedJob: {
          id: replayedCompletedJob.id,
          queueId: queue.id,
          organisationId: 'org-alpha',
          name: 'echo',
          status: 'COMPLETED',
          priority: 3,
          replayedFromDlqId: dlqRecord.id,
          createdAt: '2026-11-23T08:05:00.000Z',
        },
        dispatch: {
          enqueued: true,
          deduplicated: false,
          bullmqJobId: replayedCompletedJob.id,
          bullmqQueueName: 'org_org-alpha__billing-invoices',
        },
      };
    });

    vi.spyOn(jobApi, 'getById').mockImplementation(async (_orgId, jId) => {
      return jId === replayedCompletedJob.id ? replayedCompletedJob : originalFailedJob;
    });

    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [
        {
          id: 'evt-sched-1',
          type: 'JOB_SUBMITTED',
          organisationId: 'org-alpha',
          queueId: queue.id,
          jobId: replayedCompletedJob.id,
          workerId: null,
          message: 'Scheduled job submitted',
          metadata: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            scheduledFor: '2026-11-23T08:00:00.000Z',
          },
          createdAt: '2026-11-23T08:00:00.050Z',
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    vi.spyOn(scheduleApi, 'getById').mockResolvedValue(schedule);
    vi.spyOn(scheduleApi, 'getStats').mockResolvedValue({
      scheduleId: schedule.id,
      name: schedule.name,
      type: 'RECURRING',
      status: 'ACTIVE',
      misfirePolicy: 'SKIP_MISSED',
      runCount: 1,
      maxTotalRuns: null,
      remainingRuns: null,
      currentInFlight: 0,
      totalExecutions: 1,
      catchUpExecutions: 0,
      byStatus: {
        scheduled: 0,
        dispatched: 1,
        missed: 0,
        skippedOverlap: 0,
        skippedConcurrency: 0,
        skippedMinInterval: 0,
        skippedMaxRuns: 0,
        cancelled: 0,
      },
      byFinalJobStatus: { completed: 0, failed: 1, inFlight: 0 },
      totalRetries: 2,
      durationMs: { avg: 95, min: 95, max: 95 },
      lastRunAt: '2026-11-23T08:00:00.000Z',
      lastDispatchedAt: '2026-11-23T08:00:00.050Z',
      nextRunAt: '2026-11-23T09:00:00.000Z',
    });
    vi.spyOn(scheduleApi, 'getNextRun').mockResolvedValue({
      scheduleId: schedule.id,
      type: 'RECURRING',
      status: 'ACTIVE',
      timezone: 'UTC',
      cronExpression: '0 * * * *',
      nextRunAt: '2026-11-23T09:00:00.000Z',
      nextRunAtLocal: '2026-11-23T09:00:00.000Z',
      upcomingRuns: [{ utc: '2026-11-23T09:00:00.000Z', local: '2026-11-23T09:00:00.000Z' }],
    });
    vi.spyOn(scheduleApi, 'listExecutions').mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          scheduleId: schedule.id,
          jobId: originalFailedJob.id,
          scheduledFor: '2026-11-23T08:00:00.000Z',
          dispatchedAt: '2026-11-23T08:00:00.050Z',
          startedAt: '2026-11-23T08:00:01.000Z',
          completedAt: '2026-11-23T08:00:05.000Z',
          finalJobStatus: 'FAILED',
          retryCount: 2,
          durationMs: 95,
          isCatchUp: false,
          status: 'DISPATCHED',
          reason: null,
          job: {
            id: originalFailedJob.id,
            status: 'FAILED',
            priority: 3,
            attemptsMade: 3,
            durationMs: 95,
            errorMessage: originalFailedJob.errorMessage,
            startedAt: originalFailedJob.startedAt,
            completedAt: null,
            failedAt: originalFailedJob.failedAt,
          },
          createdAt: '2026-11-23T08:00:00.050Z',
        },
      ],
      pagination: {
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    // 1. Start on /dlq -> replay the OPEN dead-letter record
    renderFullApp(['/dlq']);
    expect(await screen.findByText('Downstream ledger timeout (attempt 3/3)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replay DLQ job echo' }));
    const replayDialog = await screen.findByRole('dialog');
    await user.click(within(replayDialog).getByRole('button', { name: 'Confirm Replay' }));

    // 2. Click "View Replayed Job" link from the success banner -> navigates to /jobs/:replayedJobId
    const viewReplayedLink = await screen.findByRole('link', { name: 'View Replayed Job' });
    await user.click(viewReplayedLink);

    expect(await screen.findByText(/Completed successfully in 22 ms/i)).toBeInTheDocument();
    expect(screen.getByText(dlqRecord.id)).toBeInTheDocument();

    // 3. Click the schedule link in the "Spawned by schedule Hourly-Billing-Cron" banner -> navigates to /schedules/:scheduleId
    await user.click(screen.getByRole('link', { name: 'Hourly-Billing-Cron' }));
    expect(await screen.findByText('Immutable Execution History')).toBeInTheDocument();

    // 4. Click the spawned job link in the Schedule Execution History table -> navigates to /jobs/:originalFailedJobId
    await user.click(screen.getByRole('link', { name: /job-fail…0001/i }));
    expect(await screen.findByText('Job permanently failed')).toBeInTheDocument();
    expect(screen.getByText('Downstream ledger timeout (attempt 3/3)')).toBeInTheDocument();
  }, 15_000);

  it('Workflow 3: Invitation Acceptance -> Automatic Organisation Switch -> Ownership Transfer -> Live RBAC Permission Downgrade Across Modules', async () => {
    const user = userEvent.setup();

    const orgs: OrganisationView[] = [
      {
        id: 'org-alpha',
        name: 'Acme Primary',
        role: 'OWNER',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ];

    const alphaMembers: MemberView[] = [
      {
        id: 'mem-owner',
        role: 'OWNER',
        createdAt: '2026-11-01T00:00:00.000Z',
        user: {
          id: 'user-owner',
          name: 'Apurva Owner',
          email: 'owner@pulsequeue.dev',
        },
      },
      {
        id: 'mem-admin',
        role: 'ADMIN',
        createdAt: '2026-11-05T00:00:00.000Z',
        user: {
          id: 'user-rohan',
          name: 'Rohan Admin',
          email: 'rohan@pulsequeue.dev',
        },
      },
    ];

    vi.spyOn(authApi, 'restoreSession').mockResolvedValue({
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    vi.spyOn(organisationApi, 'list').mockImplementation(async () => [...orgs]);
    vi.spyOn(organisationApi, 'getById').mockImplementation(async (orgId) => {
      return orgs.find((o) => o.id === orgId)!;
    });
    vi.spyOn(organisationApi, 'listMembers').mockImplementation(async (orgId) => {
      if (orgId === 'org-alpha') return [...alphaMembers];
      return [
        {
          id: 'mem-beta-1',
          role: 'MEMBER',
          createdAt: '2026-11-23T08:00:00.000Z',
          user: {
            id: 'user-owner',
            name: 'Apurva Owner',
            email: 'owner@pulsequeue.dev',
          },
        },
      ];
    });
    vi.spyOn(organisationApi, 'listInvitations').mockResolvedValue([]);

    vi.spyOn(organisationApi, 'acceptInvitation').mockImplementation(async () => {
      const joinedOrg: OrganisationView = {
        id: 'org-joined-partner',
        name: 'Partner Workspace',
        role: 'MEMBER',
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-23T08:00:00.000Z',
      };
      orgs.push(joinedOrg);
      return {
        organisationId: joinedOrg.id,
        role: 'MEMBER',
        membershipId: 'mem-beta-1',
      };
    });

    vi.spyOn(organisationApi, 'transferOwnership').mockImplementation(async () => {
      orgs[0] = { ...orgs[0], role: 'ADMIN' };
      alphaMembers[0] = { ...alphaMembers[0], role: 'ADMIN' };
      alphaMembers[1] = { ...alphaMembers[1], role: 'OWNER' };
      return {
        organisationId: 'org-alpha',
        newOwnerId: 'user-rohan',
        previousOwnerId: 'user-owner',
      };
    });

    vi.spyOn(queueApi, 'list').mockImplementation(async (orgId) => [
      {
        id: `q-${orgId}`,
        organisationId: orgId,
        name: orgId === 'org-alpha' ? 'alpha-core-queue' : 'partner-readonly-queue',
        description: null,
        isPaused: false,
        pausedAt: null,
        concurrency: 5,
        defaultPriority: 5,
        maxRetries: 3,
        backoffMs: 1000,
        jobCount: 0,
        createdBy: null,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-23T00:00:00.000Z',
      },
    ]);
    vi.spyOn(monitoringApi, 'getMetrics').mockImplementation(async (orgId) =>
      buildOrgMetrics(orgId, [], []),
    );

    renderFullApp(['/settings']);

    // 1. Initially on Acme Primary as OWNER -> Transfer Ownership card is visible
    expect(await screen.findByText('Transfer Organisation Ownership')).toBeInTheDocument();

    // 2. Accept invitation token for Partner Workspace (role: MEMBER)
    await user.type(screen.getByLabelText('Invitation Token'), 'partner-invite-token-777');
    await user.click(screen.getByRole('button', { name: 'Accept Invitation' }));

    // Active organisation automatically switches to Partner Workspace where user is MEMBER
    expect(await screen.findByText(/MEMBER · Read-only/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Organisation Name')).toHaveValue('Partner Workspace');
    expect(screen.getByLabelText('Organisation Name')).toBeDisabled();

    // Navigate to Queues in Partner Workspace -> Verify MEMBER read-only (no Create/Edit/Delete Queue buttons)
    await user.click(screen.getByRole('link', { name: 'Queues' }));
    expect(await screen.findByText('partner-readonly-queue')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Queue/i })).not.toBeInTheDocument();

    // 3. Switch back to Acme Primary (OWNER) via TopHeader organisation selector
    await user.click(screen.getByRole('button', { name: /Partner Workspace/i }));
    await user.click(screen.getByRole('option', { name: /Acme Primary/i }));

    expect(await screen.findByText('alpha-core-queue')).toBeInTheDocument();
    // As OWNER, Delete button is visible on alpha-core-queue
    expect(screen.getByRole('button', { name: 'Delete alpha-core-queue' })).toBeInTheDocument();

    // 4. Go to Organisation Settings and transfer ownership to Rohan Admin
    await user.click(screen.getByRole('link', { name: 'Organisation Settings' }));
    expect(await screen.findByText('Transfer Organisation Ownership')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Transfer Ownership…/i }));
    const transferDialog = await screen.findByRole('dialog');
    await user.click(
      within(transferDialog).getByRole('button', { name: 'Confirm Ownership Transfer' }),
    );

    expect(await screen.findByText(/Ownership transferred to Rohan Admin/i)).toBeInTheDocument();
    // Transfer card disappears immediately because caller is now ADMIN
    await waitFor(() => {
      expect(screen.queryByText('Transfer Organisation Ownership')).not.toBeInTheDocument();
    });

    // 5. Navigate back to Queues -> as ADMIN, Edit is still visible but OWNER-only Delete is now hidden
    await user.click(screen.getByRole('link', { name: 'Queues' }));
    expect(await screen.findByText('alpha-core-queue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit alpha-core-queue' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete alpha-core-queue' }),
    ).not.toBeInTheDocument();
  }, 15_000);
});

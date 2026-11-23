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
import { organisationApi } from '../api/organisation.api';
import { queueApi } from '../api/queue.api';
import { jobApi } from '../api/job.api';
import { monitoringApi } from '../api/monitoring.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type { JobView, OrgRole, QueueView } from '../types/api';

function makeQueue(overrides: Partial<QueueView> = {}): QueueView {
  return {
    id: overrides.id ?? 'q-11111111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    name: overrides.name ?? 'billing-invoices',
    description: overrides.description ?? 'Outbound customer invoices',
    isPaused: overrides.isPaused ?? false,
    pausedAt: overrides.pausedAt ?? null,
    concurrency: overrides.concurrency ?? 8,
    defaultPriority: overrides.defaultPriority ?? 6,
    maxRetries: overrides.maxRetries ?? 3,
    backoffMs: overrides.backoffMs ?? 1000,
    jobCount: overrides.jobCount ?? 3,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-23T09:00:00.000Z',
  };
}

function makeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: overrides.id ?? 'job-aaaa1111-1111-4111-8111-111111111111',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    organisationId: overrides.organisationId ?? 'org-alpha',
    name: overrides.name ?? 'echo',
    status: overrides.status ?? 'COMPLETED',
    priority: overrides.priority ?? 3,
    payload: overrides.payload ?? { message: 'invoice-77' },
    maxRetries: overrides.maxRetries ?? 3,
    backoffMs: overrides.backoffMs ?? 1000,
    delayMs: overrides.delayMs ?? 0,
    attemptsMade: overrides.attemptsMade ?? 1,
    stalledCount: overrides.stalledCount ?? 0,
    durationMs: 'durationMs' in overrides ? (overrides.durationMs ?? null) : 28,
    lastWorkerId: overrides.lastWorkerId ?? 'worker-node-01',
    replayedFromDlqId: overrides.replayedFromDlqId ?? null,
    result:
      overrides.result !== undefined
        ? overrides.result
        : { processor: 'echo', output: { echoed: 'invoice-77', length: 10 } },
    errorMessage: overrides.errorMessage ?? null,
    startedAt: overrides.startedAt ?? '2026-11-23T10:00:01.000Z',
    completedAt:
      overrides.completedAt !== undefined ? overrides.completedAt : '2026-11-23T10:00:01.028Z',
    failedAt: overrides.failedAt ?? null,
    lastRecoveredAt: overrides.lastRecoveredAt ?? null,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: overrides.createdAt ?? '2026-11-23T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-23T10:00:01.028Z',
  };
}

function renderJobsApp(initialEntries: string[] = ['/jobs']) {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <OrganisationProvider>
            <AppRoutes />
          </OrganisationProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Job Management UI — List, Filters, Submission, Detail, Cancellation & RBAC (Step 6.3)', () => {
  const queueAlpha = makeQueue();
  const queueWebhook = makeQueue({
    id: 'q-22222222-2222-4222-8222-222222222222',
    name: 'webhook-delivery',
  });

  const completedJob = makeJob();
  const pendingJob = makeJob({
    id: 'job-bbbb2222-2222-4222-8222-222222222222',
    name: 'math.sum',
    status: 'PENDING',
    priority: 15,
    payload: { numbers: [10, 20, 30] },
    attemptsMade: 0,
    durationMs: null,
    result: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-11-23T10:05:00.000Z',
  });
  const failedJob = makeJob({
    id: 'job-cccc3333-3333-4333-8333-333333333333',
    queueId: queueWebhook.id,
    queueName: queueWebhook.name,
    name: 'test.fail',
    status: 'FAILED',
    priority: 8,
    attemptsMade: 3,
    maxRetries: 2,
    durationMs: 112,
    result: null,
    errorMessage: 'Downstream webhook 502 Bad Gateway (attempt 3/3)',
    completedAt: null,
    failedAt: '2026-11-23T10:08:00.000Z',
    createdAt: '2026-11-23T10:07:00.000Z',
  });

  function setupMocks(role: OrgRole = 'OWNER') {
    vi.spyOn(authApi, 'restoreSession').mockResolvedValue({
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    vi.spyOn(healthApi, 'getHealth').mockResolvedValue({
      status: 'ok',
      services: { database: 'connected', redis: 'connected' },
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(organisationApi, 'list').mockResolvedValue([
      {
        id: 'org-alpha',
        name: 'Acme Production',
        role,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        id: 'org-beta',
        name: 'Beta Sandbox',
        role: 'ADMIN',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);

    vi.spyOn(queueApi, 'list').mockImplementation(async (orgId) =>
      orgId === 'org-alpha'
        ? [queueAlpha, queueWebhook]
        : [makeQueue({ id: 'q-beta', organisationId: 'org-beta', name: 'beta-jobs' })],
    );

    vi.spyOn(jobApi, 'listByQueue').mockImplementation(async (_orgId, qId) => {
      const jobs =
        qId === queueAlpha.id
          ? [pendingJob, completedJob]
          : qId === queueWebhook.id
            ? [failedJob]
            : [
                makeJob({
                  id: 'job-beta-9999',
                  organisationId: 'org-beta',
                  queueId: 'q-beta',
                  queueName: 'beta-jobs',
                  name: 'transform.json',
                }),
              ];
      return {
        jobs,
        pagination: {
          page: 1,
          limit: 100,
          total: jobs.length,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };
    });

    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          type: 'JOB_SUBMITTED',
          organisationId: 'org-alpha',
          queueId: queueAlpha.id,
          jobId: completedJob.id,
          workerId: null,
          message: 'Job "echo" submitted to queue "billing-invoices"',
          metadata: {
            scheduleId: 'sched-123',
            scheduleName: 'Hourly-Invoice-Sync',
            scheduledFor: '2026-11-23T10:00:00.000Z',
            isCatchUp: true,
          },
          createdAt: '2026-11-23T10:00:00.000Z',
        },
        {
          id: 'evt-2',
          type: 'JOB_STARTED',
          organisationId: 'org-alpha',
          queueId: queueAlpha.id,
          jobId: completedJob.id,
          workerId: 'worker-node-01',
          message: 'Job "echo" started (attempt 1)',
          metadata: {},
          createdAt: '2026-11-23T10:00:01.000Z',
        },
        {
          id: 'evt-3',
          type: 'JOB_COMPLETED',
          organisationId: 'org-alpha',
          queueId: queueAlpha.id,
          jobId: completedJob.id,
          workerId: 'worker-node-01',
          message: 'Job "echo" completed on attempt 1',
          metadata: {},
          createdAt: '2026-11-23T10:00:01.028Z',
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        total: 3,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    setupMocks('OWNER');
  });

  it('renders job list across queues with status, priority, attempts, duration, and supports search and filters', async () => {
    const user = userEvent.setup();
    renderJobsApp(['/jobs']);

    expect(await screen.findByText('echo')).toBeInTheDocument();
    expect(screen.getByText('math.sum')).toBeInTheDocument();
    expect(screen.getByText('test.fail')).toBeInTheDocument();
    expect(screen.getByText('28ms')).toBeInTheDocument();

    // Search by job name
    const searchInput = screen.getByLabelText('Search jobs by ID or name');
    await user.type(searchInput, 'math.sum');
    expect(screen.getByText('math.sum')).toBeInTheDocument();
    expect(screen.queryByText('echo')).not.toBeInTheDocument();

    await user.clear(searchInput);
    expect(screen.getByText('echo')).toBeInTheDocument();

    // Filter by Priority Band: High (1-5) -> only completedJob (p3) matches
    await user.selectOptions(screen.getByLabelText('Filter by priority'), 'high');
    expect(screen.getByText('echo')).toBeInTheDocument();
    expect(screen.queryByText('math.sum')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by priority'), 'all');

    // Filter by specific queue
    await user.selectOptions(screen.getByLabelText('Filter by queue'), queueWebhook.id);
    expect(await screen.findByText('test.fail')).toBeInTheDocument();
    expect(screen.queryByText('math.sum')).not.toBeInTheDocument();
  });

  it('validates JSON payload syntax and object structure before submitting a job and handles backend errors', async () => {
    const user = userEvent.setup();
    const submitSpy = vi
      .spyOn(jobApi, 'submit')
      .mockRejectedValueOnce(new ApiClientError('Queue is unavailable', 400, 'BAD_REQUEST'))
      .mockResolvedValueOnce({
        job: makeJob({
          id: 'job-dddd4444-4444-4444-8444-444444444444',
          name: 'math.sum',
          status: 'PENDING',
          payload: { numbers: [12, 28, 40, 120] },
        }),
        dispatch: {
          enqueued: true,
          deduplicated: false,
          bullmqJobId: 'job-dddd4444-4444-4444-8444-444444444444',
          bullmqQueueName: `org_org-alpha__${queueAlpha.name}`,
        },
      });

    renderJobsApp(['/jobs']);
    await screen.findByText('echo');

    await user.click(screen.getByRole('button', { name: /Submit Job/i }));
    const dialog = await screen.findByRole('dialog');

    // 1. Invalid JSON syntax -> rejected client-side
    const payloadInput = within(dialog).getByLabelText('JSON Payload');
    await user.clear(payloadInput);
    await user.paste('{ broken json');
    await user.click(within(dialog).getByRole('button', { name: 'Submit Job' }));

    expect(await within(dialog).findByText(/Invalid JSON syntax/i)).toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();

    // 2. JSON array instead of JSON object -> rejected client-side
    await user.clear(payloadInput);
    await user.paste('[1, 2, 3]');
    await user.click(within(dialog).getByRole('button', { name: 'Submit Job' }));

    expect(await within(dialog).findByText(/Payload must be a JSON object/i)).toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();

    // 3. Click built-in processor template "math.sum" -> pre-fills valid JSON object
    await user.click(within(dialog).getByRole('button', { name: 'math.sum' }));

    // First API attempt returns backend error banner cleanly
    await user.click(within(dialog).getByRole('button', { name: 'Submit Job' }));
    expect(await within(dialog).findByText('Queue is unavailable')).toBeInTheDocument();

    // Second attempt succeeds
    await user.click(within(dialog).getByRole('button', { name: 'Submit Job' }));
    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        'org-alpha',
        queueAlpha.id,
        expect.objectContaining({
          name: 'math.sum',
          payload: { numbers: [12, 28, 40, 120] },
        }),
      );
    });
    expect(
      await screen.findByText(/Job "math.sum" \(job-dddd\) submitted with status PENDING/i),
    ).toBeInTheDocument();
  });

  it('renders JobDetailPage for completed and failed jobs with JSON payload, output/error, schedule association, and timeline', async () => {
    vi.spyOn(jobApi, 'getById').mockResolvedValueOnce(completedJob);

    const { unmount } = renderJobsApp([`/jobs/${completedJob.id}`]);

    expect(await screen.findByText('Hourly-Invoice-Sync')).toBeInTheDocument();
    expect(screen.getByText('Catch-Up')).toBeInTheDocument();
    expect(screen.getAllByText(/invoice-77/)).toHaveLength(2);
    expect(screen.getByText(/Completed successfully in 28 ms/i)).toBeInTheDocument();
    expect(screen.getByText('Job "echo" started (attempt 1)')).toBeInTheDocument();

    unmount();

    // Render failed job detail view
    vi.spyOn(jobApi, 'getById').mockResolvedValueOnce(failedJob);
    renderJobsApp([`/jobs/${failedJob.id}`]);

    expect(await screen.findByText('Job permanently failed')).toBeInTheDocument();
    expect(
      screen.getByText('Downstream webhook 502 Bad Gateway (attempt 3/3)'),
    ).toBeInTheDocument();
  });

  it('cancels eligible PENDING jobs, hides cancel for COMPLETED/FAILED jobs, and surfaces HTTP 409 Conflict errors', async () => {
    const user = userEvent.setup();
    const cancelSpy = vi
      .spyOn(jobApi, 'cancel')
      .mockRejectedValueOnce(
        new ApiClientError(
          'Cannot cancel job in ACTIVE status. Only PENDING, DELAYED, or PAUSED jobs can be cancelled.',
          409,
          'CONFLICT',
        ),
      )
      .mockResolvedValueOnce({
        cancelled: true,
        jobId: pendingJob.id,
        queueId: pendingJob.queueId,
        organisationId: 'org-alpha',
        previousStatus: 'PENDING',
        message: 'Job cancelled successfully',
      });

    renderJobsApp(['/jobs']);
    await screen.findByText('math.sum');

    // Cancel button exists ONLY on pendingJob (math.sum), NOT on completedJob (echo) or failedJob (test.fail)
    expect(screen.getByRole('button', { name: 'Cancel job math.sum' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job echo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job test.fail' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel job math.sum' }));
    const dialog = await screen.findByRole('dialog');

    // First click hits 409 Conflict -> displayed inside modal
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Cancel' }));
    expect(
      await within(dialog).findByText(/Cannot cancel job in ACTIVE status/i),
    ).toBeInTheDocument();

    // Second click succeeds
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Cancel' }));
    await waitFor(() => {
      expect(cancelSpy).toHaveBeenCalledWith('org-alpha', pendingJob.id);
    });
    expect(await screen.findByText(/Job "math.sum" \(job-bbbb\) cancelled/i)).toBeInTheDocument();
  });

  it('enforces RBAC (MEMBER can view & submit jobs but cannot cancel) and switches organisations cleanly', async () => {
    const user = userEvent.setup();
    setupMocks('MEMBER');

    renderJobsApp(['/jobs']);
    await screen.findByText('math.sum');

    // MEMBER can still submit jobs, but cannot cancel pendingJob
    expect(screen.getByRole('button', { name: /Submit Job/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job math.sum' })).not.toBeInTheDocument();

    // Switch organisation to Beta Sandbox (where user is ADMIN)
    await user.click(screen.getByRole('button', { name: /Acme Production/i }));
    await user.click(screen.getByRole('option', { name: /Beta Sandbox/i }));

    expect(await screen.findByText('transform.json')).toBeInTheDocument();
  });

  it('integrates QueueDetailPage with queue jobs table and navigates to /jobs?queueId=...', async () => {
    const user = userEvent.setup();
    vi.spyOn(queueApi, 'getById').mockResolvedValue(queueAlpha);
    vi.spyOn(queueApi, 'getStats').mockResolvedValue({
      queueId: queueAlpha.id,
      organisationId: 'org-alpha',
      name: queueAlpha.name,
      isPaused: false,
      pausedAt: null,
      config: { concurrency: 8, defaultPriority: 6, maxRetries: 3, backoffMs: 1000 },
      jobs: {
        total: 2,
        byStatus: { PENDING: 1, ACTIVE: 0, COMPLETED: 1, FAILED: 0, DELAYED: 0, PAUSED: 0 },
      },
      createdAt: queueAlpha.createdAt,
      updatedAt: queueAlpha.updatedAt,
    });

    renderJobsApp([`/queues/${queueAlpha.id}`]);

    expect(await screen.findByText('Jobs in This Queue')).toBeInTheDocument();
    expect(await screen.findByText('math.sum')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /View All in Jobs/i }));
    expect(await screen.findByLabelText('Search jobs by ID or name')).toBeInTheDocument();
  });
});

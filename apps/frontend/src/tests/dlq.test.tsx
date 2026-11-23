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
import { jobApi } from '../api/job.api';
import { monitoringApi } from '../api/monitoring.api';
import { organisationApi } from '../api/organisation.api';
import { queueApi } from '../api/queue.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type { DeadLetterJobView, JobView, OrgRole, QueueView } from '../types/api';

function makeQueue(overrides: Partial<QueueView> = {}): QueueView {
  return {
    id: overrides.id ?? 'q-11111111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    name: overrides.name ?? 'billing-invoices',
    description: overrides.description ?? 'Customer invoice delivery queue',
    isPaused: overrides.isPaused ?? false,
    pausedAt: overrides.pausedAt ?? null,
    concurrency: overrides.concurrency ?? 5,
    defaultPriority: overrides.defaultPriority ?? 5,
    maxRetries: overrides.maxRetries ?? 2,
    backoffMs: overrides.backoffMs ?? 1000,
    jobCount: overrides.jobCount ?? 5,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  };
}

function makeDlqItem(overrides: Partial<DeadLetterJobView> = {}): DeadLetterJobView {
  return {
    id: overrides.id ?? 'dlq-11111111-1111-4111-8111-111111111111',
    originalJobId: overrides.originalJobId ?? 'job-orig1111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    jobName: overrides.jobName ?? 'test.fail',
    payloadSummary: overrides.payloadSummary ?? {
      keyCount: 2,
      keys: ['failUntilAttempt', 'reason'],
      byteLength: 74,
    },
    failureReason:
      overrides.failureReason ?? 'Downstream payment gateway 503 Service Unavailable (attempt 3/3)',
    attemptsMade: overrides.attemptsMade ?? 3,
    maxRetries: overrides.maxRetries ?? 2,
    status: overrides.status ?? 'OPEN',
    failedAt: overrides.failedAt ?? '2026-11-23T06:15:00.000Z',
    replayedAt: 'replayedAt' in overrides ? (overrides.replayedAt ?? null) : null,
    replayedById: 'replayedById' in overrides ? (overrides.replayedById ?? null) : null,
    replayedJobId: 'replayedJobId' in overrides ? (overrides.replayedJobId ?? null) : null,
    createdAt: overrides.createdAt ?? '2026-11-23T06:15:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-23T06:15:00.000Z',
  };
}

function makeOriginalJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: overrides.id ?? 'job-orig1111-1111-4111-8111-111111111111',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    organisationId: overrides.organisationId ?? 'org-alpha',
    name: overrides.name ?? 'test.fail',
    status: 'FAILED',
    priority: 5,
    payload: overrides.payload ?? {
      reason: 'Downstream payment gateway 503 Service Unavailable',
      failUntilAttempt: 3,
    },
    maxRetries: 2,
    backoffMs: 1000,
    delayMs: 0,
    attemptsMade: 3,
    stalledCount: 0,
    durationMs: 142,
    lastWorkerId: 'worker-node-01',
    replayedFromDlqId: null,
    result: null,
    errorMessage: 'Downstream payment gateway 503 Service Unavailable (attempt 3/3)',
    startedAt: '2026-11-23T06:14:58.000Z',
    completedAt: null,
    failedAt: '2026-11-23T06:15:00.000Z',
    lastRecoveredAt: null,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-23T06:14:55.000Z',
    updatedAt: '2026-11-23T06:15:00.000Z',
  };
}

function renderDlqApp(initialEntries: string[] = ['/dlq'], qc = createQueryClient()) {
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

describe('Dead Letter Queue UI — Listing, Filters, Details, Replay, Errors & RBAC (Step 6.4.3)', () => {
  const queueBilling = makeQueue();
  const queueWebhooks = makeQueue({
    id: 'q-22222222-2222-4222-8222-222222222222',
    name: 'webhook-delivery',
  });

  const openDlq = makeDlqItem();
  const replayedDlq = makeDlqItem({
    id: 'dlq-22222222-2222-4222-8222-222222222222',
    originalJobId: 'job-orig2222-2222-4222-8222-222222222222',
    queueId: queueWebhooks.id,
    queueName: queueWebhooks.name,
    jobName: 'transform.json',
    failureReason: 'Malformed upstream JSON record at index 4',
    attemptsMade: 2,
    maxRetries: 1,
    status: 'REPLAYED',
    failedAt: '2026-11-23T05:00:00.000Z',
    replayedAt: '2026-11-23T05:30:00.000Z',
    replayedById: 'user-owner',
    replayedJobId: 'job-repl9999-9999-4999-8999-999999999999',
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
    ]);

    vi.spyOn(queueApi, 'list').mockResolvedValue([queueBilling, queueWebhooks]);

    vi.spyOn(dlqApi, 'list').mockImplementation(async (_orgId, params) => {
      const all = [openDlq, replayedDlq];
      const filtered = all.filter((item) => {
        if (params?.status && item.status !== params.status) return false;
        if (params?.queueId && item.queueId !== params.queueId) return false;
        return true;
      });
      return {
        items: filtered,
        pagination: {
          page: params?.page ?? 1,
          limit: params?.limit ?? 15,
          total: filtered.length,
          totalPages: filtered.length > 0 ? 2 : 0,
          hasNextPage: (params?.page ?? 1) < 2,
          hasPreviousPage: (params?.page ?? 1) > 1,
        },
      };
    });

    vi.spyOn(jobApi, 'getById').mockResolvedValue(makeOriginalJob());

    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [
        {
          id: 'evt-dlq-1',
          type: 'JOB_RETRIED',
          organisationId: 'org-alpha',
          queueId: queueBilling.id,
          jobId: openDlq.originalJobId,
          workerId: 'worker-node-01',
          message: 'Job "test.fail" failed attempt 1/3; retry scheduled',
          metadata: {},
          createdAt: '2026-11-23T06:14:58.500Z',
        },
        {
          id: 'evt-dlq-2',
          type: 'JOB_MOVED_TO_DLQ',
          organisationId: 'org-alpha',
          queueId: queueBilling.id,
          jobId: openDlq.originalJobId,
          workerId: 'worker-node-01',
          message: 'Job "test.fail" moved to DLQ after 3 attempt(s)',
          metadata: {},
          createdAt: '2026-11-23T06:15:00.000Z',
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        total: 2,
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

  it('renders DLQ list with job/queue links, payload summaries, search, status/queue/processor filters, and server pagination', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(dlqApi, 'list');

    renderDlqApp(['/dlq']);

    expect(
      await screen.findByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Malformed upstream JSON record at index 4')).toBeInTheDocument();
    expect(screen.getAllByText('2 key(s) · 74 B')).toHaveLength(2);

    // Verify original job link and queue link
    const origJobLink = screen.getByRole('link', { name: /job-orig…1111/i });
    expect(origJobLink).toHaveAttribute('href', `/jobs/${openDlq.originalJobId}`);
    const queueLink = screen.getByRole('link', { name: 'billing-invoices' });
    expect(queueLink).toHaveAttribute('href', `/queues/${queueBilling.id}`);

    // Client-side search by failure reason
    const searchInput = screen.getByLabelText('Search dead-letter jobs');
    await user.type(searchInput, 'Malformed upstream');
    expect(screen.getByText('Malformed upstream JSON record at index 4')).toBeInTheDocument();
    expect(
      screen.queryByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)'),
    ).not.toBeInTheDocument();
    await user.clear(searchInput);

    // Filter by processor name
    await user.selectOptions(screen.getByLabelText('Filter DLQ by processor'), 'test.fail');
    expect(
      screen.getByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Malformed upstream JSON record at index 4')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter DLQ by processor'), 'all');

    // Server-side filter by status
    await user.selectOptions(screen.getByLabelText('Filter DLQ by status'), 'OPEN');
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({ status: 'OPEN', page: 1 }),
      );
    });

    // Server-side filter by queue
    await user.selectOptions(screen.getByLabelText('Filter DLQ by queue'), queueBilling.id);
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({ queueId: queueBilling.id, page: 1 }),
      );
    });

    // Server-side pagination Next
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith('org-alpha', expect.objectContaining({ page: 2 }));
    });
  });

  it('renders empty state and retryable error state when DLQ API fails', async () => {
    const user = userEvent.setup();
    const listSpy = vi
      .spyOn(dlqApi, 'list')
      .mockRejectedValue(new ApiClientError('DLQ storage unavailable', 503, 'UNAVAILABLE'));

    renderDlqApp(['/dlq']);

    expect(
      await screen.findByText('Unable to load dead-letter queue', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('DLQ storage unavailable')).toBeInTheDocument();

    listSpy.mockResolvedValue({
      items: [],
      pagination: {
        page: 1,
        limit: 15,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    await user.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByText('No dead-letter jobs recorded')).toBeInTheDocument();
  });

  it('opens DlqDetailModal showing original job payload, failure reason, and retry audit trail', async () => {
    const user = userEvent.setup();
    renderDlqApp(['/dlq']);

    await screen.findByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)');

    await user.click(screen.getByRole('button', { name: 'Inspect DLQ job test.fail' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(`DLQ ID: ${openDlq.id}`)).toBeInTheDocument();
    expect(within(dialog).getByText('3 / 3 (2 max retries)')).toBeInTheDocument();
    expect(await within(dialog).findByText(/"failUntilAttempt": 3/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('Job "test.fail" failed attempt 1/3; retry scheduled'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Job "test.fail" moved to DLQ after 3 attempt(s)'),
    ).toBeInTheDocument();
  });

  it('replays an OPEN DLQ record with confirmation, invalidates caches, and handles HTTP 400/404/409 errors', async () => {
    const user = userEvent.setup();
    const qc = createQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const replaySpy = vi
      .spyOn(dlqApi, 'replay')
      .mockRejectedValueOnce(
        new ApiClientError('Dead-letter job has already been replayed', 409, 'CONFLICT'),
      )
      .mockRejectedValueOnce(new ApiClientError('Dead-letter job not found', 404, 'NOT_FOUND'))
      .mockResolvedValueOnce({
        deadLetterJob: {
          ...openDlq,
          status: 'REPLAYED',
          replayedAt: '2026-11-23T07:00:00.000Z',
          replayedJobId: 'job-replayed-888877776666',
        },
        replayedJob: {
          id: 'job-replayed-888877776666',
          queueId: queueBilling.id,
          organisationId: 'org-alpha',
          name: 'test.fail',
          status: 'PENDING',
          priority: 2,
          replayedFromDlqId: openDlq.id,
          createdAt: '2026-11-23T07:00:00.000Z',
        },
        dispatch: {
          enqueued: true,
          deduplicated: false,
          bullmqJobId: 'job-replayed-888877776666',
          bullmqQueueName: 'org_org-alpha__billing-invoices',
        },
      });

    renderDlqApp(['/dlq'], qc);
    await screen.findByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)');

    // Replay button exists ONLY on OPEN dlq record (test.fail), NOT on REPLAYED record (transform.json)
    expect(screen.getByRole('button', { name: 'Replay DLQ job test.fail' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Replay DLQ job transform.json' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Replay DLQ job test.fail' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText(/Replaying will execute this job processor again/i),
    ).toBeInTheDocument();

    // 1. First click hits HTTP 409 Conflict -> displayed inside modal
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Replay' }));
    expect(
      await within(dialog).findByText('Dead-letter job has already been replayed'),
    ).toBeInTheDocument();

    // 2. Second click hits HTTP 404 Not Found -> displayed inside modal
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Replay' }));
    expect(await within(dialog).findByText('Dead-letter job not found')).toBeInTheDocument();

    // 3. Customize priority override (400 client validation then valid 2)
    await user.click(within(dialog).getByRole('button', { name: /Customize Replay Overrides/i }));
    const prioInput = within(dialog).getByLabelText('Priority (1–20)');
    await user.clear(prioInput);
    await user.type(prioInput, '99');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Replay' }));
    expect(
      await within(dialog).findByText(/Priority must be an integer between 1 and 20/i),
    ).toBeInTheDocument();

    await user.clear(prioInput);
    await user.type(prioInput, '2');

    // 4. Confirm replay succeeds
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Replay' }));

    await waitFor(() => {
      expect(replaySpy).toHaveBeenLastCalledWith(
        'org-alpha',
        openDlq.id,
        expect.objectContaining({ priority: 2 }),
      );
    });

    expect(
      await screen.findByText(/Dead-letter job "test.fail" replayed as new job job-repl/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Replayed Job' })).toHaveAttribute(
      'href',
      '/jobs/job-replayed-888877776666',
    );

    // Verify cache invalidations
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dlq', 'org-alpha'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['jobs', 'org-alpha'] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['queue-stats', 'org-alpha', queueBilling.id],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['org-metrics', 'org-alpha'] });
  });

  it('enforces RBAC: MEMBER can inspect DLQ records and details but cannot replay, while ADMIN and OWNER can replay', async () => {
    const user = userEvent.setup();
    setupMocks('MEMBER');

    const { unmount } = renderDlqApp(['/dlq']);
    await screen.findByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)');

    expect(screen.getByText(/MEMBER · Read-only/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Replay DLQ job test.fail' }),
    ).not.toBeInTheDocument();

    // MEMBER can still open Inspect modal, and Replay Job button is hidden inside modal too
    await user.click(screen.getByRole('button', { name: 'Inspect DLQ job test.fail' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`DLQ ID: ${openDlq.id}`)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Replay Job' })).not.toBeInTheDocument();

    unmount();

    // ADMIN role sees Replay button
    setupMocks('ADMIN');
    renderDlqApp(['/dlq']);
    await screen.findByText('Downstream payment gateway 503 Service Unavailable (attempt 3/3)');
    expect(screen.getByRole('button', { name: 'Replay DLQ job test.fail' })).toBeInTheDocument();
  });
});

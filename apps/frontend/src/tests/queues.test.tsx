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
import { monitoringApi } from '../api/monitoring.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type { OrgRole, QueueStatsView, QueueView } from '../types/api';

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
    maxRetries: overrides.maxRetries ?? 4,
    backoffMs: overrides.backoffMs ?? 1500,
    jobCount: overrides.jobCount ?? 17,
    createdBy: overrides.createdBy ?? {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: overrides.createdAt ?? '2026-11-20T09:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-11-23T09:00:00.000Z',
  };
}

function makeStats(queue: QueueView): QueueStatsView {
  return {
    queueId: queue.id,
    organisationId: queue.organisationId,
    name: queue.name,
    isPaused: queue.isPaused,
    pausedAt: queue.pausedAt,
    config: {
      concurrency: queue.concurrency,
      defaultPriority: queue.defaultPriority,
      maxRetries: queue.maxRetries,
      backoffMs: queue.backoffMs,
    },
    jobs: {
      total: 17,
      byStatus: {
        PENDING: 3,
        ACTIVE: 2,
        COMPLETED: 10,
        FAILED: 1,
        DELAYED: 1,
        PAUSED: 0,
      },
    },
    createdAt: queue.createdAt,
    updatedAt: queue.updatedAt,
  };
}

function renderQueuesApp(initialEntries: string[] = ['/queues']) {
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

describe('Queue Management UI — Overview, CRUD, Pause/Resume, Detail & RBAC (Step 6.2)', () => {
  const queue1 = makeQueue();
  const queue2 = makeQueue({
    id: 'q-22222222-2222-4222-8222-222222222222',
    name: 'webhook-delivery',
    description: 'Partner webhook notifications',
    isPaused: true,
    pausedAt: '2026-11-23T10:00:00.000Z',
    concurrency: 12,
    defaultPriority: 10,
    maxRetries: 5,
    backoffMs: 2000,
    jobCount: 0,
  });

  function setupOrgMocks(role: OrgRole = 'OWNER') {
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

    vi.spyOn(monitoringApi, 'getMetrics').mockResolvedValue({
      organisationId: 'org-alpha',
      summary: {
        totalSubmitted: 17,
        totalProcessed: 11,
        succeeded: 10,
        failed: 1,
        active: 2,
        pending: 3,
        delayed: 1,
        paused: 0,
        retriedJobs: 1,
        totalRetryEvents: 1,
        stalledRecoveries: 0,
        deadLetterOpen: 1,
        deadLetterReplayed: 0,
        averageDurationMs: 35,
      },
      throughput: {
        windowMinutes: 60,
        completedInWindow: 10,
        failedInWindow: 1,
        processedInWindow: 11,
        jobsPerMinute: 0.2,
      },
      queues: [
        {
          queueId: queue1.id,
          name: queue1.name,
          isPaused: false,
          concurrency: queue1.concurrency,
          totalJobs: 17,
          byStatus: {
            PENDING: 3,
            ACTIVE: 2,
            COMPLETED: 10,
            FAILED: 1,
            DELAYED: 1,
            PAUSED: 0,
          },
          averageDurationMs: 35,
          openDeadLetters: 1,
        },
      ],
      workers: [],
      generatedAt: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    setupOrgMocks('OWNER');
    vi.spyOn(queueApi, 'list').mockResolvedValue([queue1, queue2]);
    vi.spyOn(queueApi, 'getById').mockResolvedValue(queue1);
    vi.spyOn(queueApi, 'getStats').mockResolvedValue(makeStats(queue1));
  });

  it('renders queue list with real configuration, status badges, and job status counts, plus search and status filter', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(queueApi, 'list');

    renderQueuesApp(['/queues']);

    expect(await screen.findByText('billing-invoices')).toBeInTheDocument();
    expect(screen.getByText('webhook-delivery')).toBeInTheDocument();
    expect(screen.getByText('8c')).toBeInTheDocument();
    expect(screen.getByText('1500ms')).toBeInTheDocument();

    // Filter by search query
    const searchInput = screen.getByLabelText('Search queues by name');
    await user.type(searchInput, 'webhook');
    expect(screen.queryByText('billing-invoices')).not.toBeInTheDocument();
    expect(screen.getByText('webhook-delivery')).toBeInTheDocument();

    await user.clear(searchInput);
    expect(screen.getByText('billing-invoices')).toBeInTheDocument();

    // Filter by status (Paused Only -> calls backend with isPaused: true)
    await user.selectOptions(screen.getByLabelText('Filter by queue status'), 'paused');
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('org-alpha', { isPaused: true });
    });
  });

  it('renders empty state when no queues exist and retryable error state when API fails', async () => {
    const user = userEvent.setup();
    const listSpy = vi
      .spyOn(queueApi, 'list')
      .mockRejectedValue(new ApiClientError('Database connection interrupted', 503));

    renderQueuesApp(['/queues']);

    expect(
      await screen.findByText('Unable to load queues', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Database connection interrupted')).toBeInTheDocument();

    // Recover into empty state on retry
    listSpy.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(await screen.findByText('No queues created yet')).toBeInTheDocument();
  });

  it('validates create queue form inputs and creates a new queue with query invalidation', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(queueApi, 'create').mockResolvedValue(
      makeQueue({
        id: 'q-new',
        name: 'email-dispatches',
        concurrency: 15,
        defaultPriority: 8,
        maxRetries: 2,
        backoffMs: 500,
      }),
    );

    renderQueuesApp(['/queues']);
    await screen.findByText('billing-invoices');

    await user.click(screen.getByRole('button', { name: /Create Queue/i }));
    const dialog = await screen.findByRole('dialog');

    // Invalid queue name containing colon -> rejected by client Zod validator matching backend
    await user.type(within(dialog).getByLabelText('Queue Name'), 'bad:name');
    await user.click(within(dialog).getByRole('button', { name: 'Create Queue' }));

    expect(
      await within(dialog).findByText(/Queue name must start with a letter or digit/i),
    ).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    // Fix name and submit valid configuration
    const nameInput = within(dialog).getByLabelText('Queue Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'email-dispatches');

    const concInput = within(dialog).getByLabelText('Concurrency (1–100)');
    await user.clear(concInput);
    await user.type(concInput, '15');

    await user.click(within(dialog).getByRole('button', { name: 'Create Queue' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        'org-alpha',
        expect.objectContaining({
          name: 'email-dispatches',
          concurrency: 15,
        }),
      );
    });
    expect(
      await screen.findByText('Queue "email-dispatches" created successfully.'),
    ).toBeInTheDocument();
  });

  it('edits an existing queue, pauses with confirmation, and resumes cleanly', async () => {
    const user = userEvent.setup();
    const updateSpy = vi
      .spyOn(queueApi, 'update')
      .mockResolvedValue(makeQueue({ ...queue1, concurrency: 20 }));
    const pauseSpy = vi
      .spyOn(queueApi, 'pause')
      .mockResolvedValue(makeQueue({ ...queue1, isPaused: true }));
    const resumeSpy = vi
      .spyOn(queueApi, 'resume')
      .mockResolvedValue(makeQueue({ ...queue2, isPaused: false }));

    renderQueuesApp(['/queues']);
    await screen.findByText('billing-invoices');

    // Edit queue1
    await user.click(screen.getByRole('button', { name: 'Edit billing-invoices' }));
    const editDialog = await screen.findByRole('dialog');
    const concInput = within(editDialog).getByLabelText('Concurrency (1–100)');
    await user.clear(concInput);
    await user.type(concInput, '20');
    await user.click(within(editDialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'org-alpha',
        queue1.id,
        expect.objectContaining({ concurrency: 20 }),
      );
    });

    // Pause queue1 via confirmation dialog
    await user.click(screen.getByRole('button', { name: 'Pause billing-invoices' }));
    const pauseDialog = await screen.findByRole('dialog');
    await user.click(within(pauseDialog).getByRole('button', { name: 'Pause Queue' }));

    await waitFor(() => {
      expect(pauseSpy).toHaveBeenCalledWith('org-alpha', queue1.id);
    });

    // Resume paused queue2
    await user.click(screen.getByRole('button', { name: 'Resume webhook-delivery' }));
    await waitFor(() => {
      expect(resumeSpy).toHaveBeenCalledWith('org-alpha', queue2.id);
    });
  });

  it('handles HTTP 409 Conflict when deleting a queue that contains jobs and deletes empty queues', async () => {
    const user = userEvent.setup();
    const deleteSpy = vi
      .spyOn(queueApi, 'delete')
      .mockRejectedValueOnce(
        new ApiClientError(
          'Cannot delete queue while it still contains jobs. Remove or drain jobs before deleting.',
          409,
          'CONFLICT',
        ),
      )
      .mockResolvedValueOnce();

    renderQueuesApp(['/queues']);
    await screen.findByText('billing-invoices');

    // Attempt to delete queue1 (contains 17 jobs -> backend returns 409 Conflict)
    await user.click(screen.getByRole('button', { name: 'Delete billing-invoices' }));
    const deleteDialog = await screen.findByRole('dialog');
    expect(
      within(deleteDialog).getByText(/Deletion is blocked when jobs exist in the queue/i),
    ).toBeInTheDocument();

    await user.click(within(deleteDialog).getByRole('button', { name: 'Delete Queue' }));

    expect(
      await within(deleteDialog).findByText(/Cannot delete queue while it still contains jobs/i),
    ).toBeInTheDocument();

    // Cancel and delete empty queue2 -> succeeds
    await user.click(within(deleteDialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete webhook-delivery' }));
    const dialog2 = await screen.findByRole('dialog');
    await user.click(within(dialog2).getByRole('button', { name: 'Delete Queue' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('org-alpha', queue2.id);
    });
    expect(await screen.findByText('Queue "webhook-delivery" deleted.')).toBeInTheDocument();
  });

  it('enforces RBAC action visibility for MEMBER vs ADMIN vs OWNER and refetches on organisation switch', async () => {
    const user = userEvent.setup();
    setupOrgMocks('MEMBER');
    const listSpy = vi
      .spyOn(queueApi, 'list')
      .mockImplementation(async (orgId) =>
        orgId === 'org-alpha'
          ? [queue1]
          : [makeQueue({ id: 'q-beta', organisationId: 'org-beta', name: 'beta-events' })],
      );

    renderQueuesApp(['/queues']);
    await screen.findByText('billing-invoices');

    // MEMBER sees View and Read-only badge, but NO Create, Edit, Pause, or Delete buttons
    expect(screen.getByText(/MEMBER · Read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Queue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit billing-invoices' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Pause billing-invoices' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete billing-invoices' }),
    ).not.toBeInTheDocument();

    // Switch organisation to Beta Sandbox (where user has ADMIN role)
    await user.click(screen.getByRole('button', { name: /Acme Production/i }));
    await user.click(screen.getByRole('option', { name: /Beta Sandbox/i }));

    expect(await screen.findByText('beta-events')).toBeInTheDocument();
    expect(listSpy).toHaveBeenCalledWith('org-beta', undefined);

    // ADMIN sees Create, Edit, Pause, but NO Delete (OWNER-only)
    expect(screen.getByRole('button', { name: /Create Queue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit beta-events' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause beta-events' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete beta-events' })).not.toBeInTheDocument();
  });

  it('renders dedicated QueueDetailPage with real configuration and GET /queues/:queueId/stats breakdown', async () => {
    renderQueuesApp([`/queues/${queue1.id}`]);

    expect(await screen.findByText('billing-invoices')).toBeInTheDocument();
    expect(screen.getByText('Queue Configuration')).toBeInTheDocument();
    expect(screen.getByText('1500 ms')).toBeInTheDocument();
    expect(screen.getByText('Apurva Owner (owner@pulsequeue.dev)')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });
});

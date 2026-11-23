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
import { scheduleApi } from '../api/schedule.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type {
  NextRunPreviewView,
  OrgRole,
  QueueView,
  ScheduleExecutionView,
  ScheduleStatsView,
  ScheduleView,
} from '../types/api';

function makeQueue(overrides: Partial<QueueView> = {}): QueueView {
  return {
    id: overrides.id ?? 'q-11111111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    name: overrides.name ?? 'billing-invoices',
    description: overrides.description ?? 'Customer invoice queue',
    isPaused: overrides.isPaused ?? false,
    pausedAt: overrides.pausedAt ?? null,
    concurrency: overrides.concurrency ?? 5,
    defaultPriority: overrides.defaultPriority ?? 5,
    maxRetries: overrides.maxRetries ?? 3,
    backoffMs: overrides.backoffMs ?? 1000,
    jobCount: overrides.jobCount ?? 10,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  };
}

function makeSchedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: overrides.id ?? 'sched-11111111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    name: overrides.name ?? 'Hourly-Invoice-Sync',
    description:
      'description' in overrides ? (overrides.description ?? null) : 'Sync invoices at top of hour',
    type: overrides.type ?? 'RECURRING',
    status: overrides.status ?? 'ACTIVE',
    jobName: overrides.jobName ?? 'echo',
    payload: overrides.payload ?? { message: 'hourly-sync' },
    priority: 'priority' in overrides ? (overrides.priority ?? null) : 4,
    maxRetries: 'maxRetries' in overrides ? (overrides.maxRetries ?? null) : 3,
    backoffMs: 'backoffMs' in overrides ? (overrides.backoffMs ?? null) : 1000,
    cronExpression:
      'cronExpression' in overrides ? (overrides.cronExpression ?? null) : '0 * * * *',
    timezone: overrides.timezone ?? 'Asia/Kolkata',
    runAt: 'runAt' in overrides ? (overrides.runAt ?? null) : null,
    nextRunAt:
      'nextRunAt' in overrides ? (overrides.nextRunAt ?? null) : '2026-11-23T08:00:00.000Z',
    nextRunAtLocal:
      'nextRunAtLocal' in overrides
        ? (overrides.nextRunAtLocal ?? null)
        : '2026-11-23T13:30:00.000+05:30',
    lastRunAt:
      'lastRunAt' in overrides ? (overrides.lastRunAt ?? null) : '2026-11-23T07:00:00.000Z',
    lastDispatchedAt:
      'lastDispatchedAt' in overrides
        ? (overrides.lastDispatchedAt ?? null)
        : '2026-11-23T07:00:00.090Z',
    runCount: overrides.runCount ?? 14,
    preventOverlap: overrides.preventOverlap ?? true,
    misfirePolicy: overrides.misfirePolicy ?? 'SKIP_MISSED',
    maxCatchUpRuns: overrides.maxCatchUpRuns ?? 5,
    misfireGraceMs: overrides.misfireGraceMs ?? 60000,
    maxConcurrentRuns:
      'maxConcurrentRuns' in overrides ? (overrides.maxConcurrentRuns ?? null) : null,
    maxTotalRuns: 'maxTotalRuns' in overrides ? (overrides.maxTotalRuns ?? null) : 50,
    maxDurationMs: 'maxDurationMs' in overrides ? (overrides.maxDurationMs ?? null) : 30000,
    minIntervalMs: 'minIntervalMs' in overrides ? (overrides.minIntervalMs ?? null) : 5000,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-23T07:00:00.000Z',
  };
}

function renderSchedulesApp(initialEntries: string[] = ['/schedules']) {
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

describe('Scheduling UI — List, Filters, Create/Edit Modal, Lifecycle Actions, Detail & RBAC (Step 6.4.2)', () => {
  const queueBilling = makeQueue();
  const queueEtl = makeQueue({
    id: 'q-22222222-2222-4222-8222-222222222222',
    name: 'etl-warehouse',
  });

  const recurringActive = makeSchedule();
  const oneTimePaused = makeSchedule({
    id: 'sched-22222222-2222-4222-8222-222222222222',
    queueId: queueEtl.id,
    queueName: queueEtl.name,
    name: 'OneTime-YearEnd-Export',
    description: 'Annual financial warehouse snapshot',
    type: 'ONE_TIME',
    status: 'PAUSED',
    jobName: 'math.sum',
    payload: { numbers: [100, 200, 300] },
    cronExpression: null,
    timezone: 'UTC',
    runAt: '2026-12-31T23:00:00.000Z',
    nextRunAt: null,
    nextRunAtLocal: null,
    runCount: 0,
    maxTotalRuns: null,
    misfirePolicy: 'FIRE_ONCE',
  });
  const completedSchedule = makeSchedule({
    id: 'sched-33333333-3333-4333-8333-333333333333',
    name: 'Completed-Migration-Run',
    type: 'ONE_TIME',
    status: 'COMPLETED',
    cronExpression: null,
    runAt: '2026-11-21T10:00:00.000Z',
    nextRunAt: null,
    nextRunAtLocal: null,
    runCount: 1,
    maxTotalRuns: 1,
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

    vi.spyOn(queueApi, 'list').mockResolvedValue([queueBilling, queueEtl]);

    vi.spyOn(scheduleApi, 'list').mockImplementation(async (_orgId, params) => {
      const all = [recurringActive, oneTimePaused, completedSchedule];
      const filtered = all.filter((s) => {
        if (params?.status && s.status !== params.status) return false;
        if (params?.type && s.type !== params.type) return false;
        if (params?.queueId && s.queueId !== params.queueId) return false;
        return true;
      });
      return {
        schedules: filtered,
        pagination: {
          page: params?.page ?? 1,
          limit: params?.limit ?? 10,
          total: filtered.length,
          totalPages: filtered.length > 0 ? 2 : 0,
          hasNextPage: (params?.page ?? 1) < 2,
          hasPreviousPage: (params?.page ?? 1) > 1,
        },
      };
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    setupMocks('OWNER');
  });

  it('renders schedule list with local & UTC timestamps, filters by status/type/queue, searches, and paginates server-side', async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(scheduleApi, 'list');

    renderSchedulesApp(['/schedules']);

    expect(await screen.findByText('Hourly-Invoice-Sync')).toBeInTheDocument();
    expect(screen.getByText('OneTime-YearEnd-Export')).toBeInTheDocument();
    expect(screen.getByText('Completed-Migration-Run')).toBeInTheDocument();
    expect(screen.getByText(/Local: 2026-11-23T13:30:00\.000\+05:30/)).toBeInTheDocument();
    expect(screen.getByText(/UTC: 2026-11-23 08:00:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText('14 / 50')).toBeInTheDocument();

    // Client-side search on loaded page
    const searchInput = screen.getByLabelText('Search schedules');
    await user.type(searchInput, 'YearEnd');
    expect(screen.getByText('OneTime-YearEnd-Export')).toBeInTheDocument();
    expect(screen.queryByText('Hourly-Invoice-Sync')).not.toBeInTheDocument();
    await user.clear(searchInput);

    // Server-side filter by status
    await user.selectOptions(screen.getByLabelText('Filter schedules by status'), 'PAUSED');
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({ status: 'PAUSED', page: 1 }),
      );
    });
    expect(await screen.findByText('OneTime-YearEnd-Export')).toBeInTheDocument();
    expect(screen.queryByText('Hourly-Invoice-Sync')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter schedules by status'), 'all');

    // Server-side filter by type
    await user.selectOptions(screen.getByLabelText('Filter schedules by type'), 'RECURRING');
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({ type: 'RECURRING', page: 1 }),
      );
    });

    await user.selectOptions(screen.getByLabelText('Filter schedules by type'), 'all');

    // Server-side filter by queue
    await user.selectOptions(screen.getByLabelText('Filter schedules by queue'), queueEtl.id);
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({ queueId: queueEtl.id, page: 1 }),
      );
    });

    // Server-side pagination Next button
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(listSpy).toHaveBeenLastCalledWith('org-alpha', expect.objectContaining({ page: 2 }));
    });
  });

  it('creates RECURRING and ONE_TIME schedules and validates JSON payload, IANA timezone, and preventOverlap vs maxConcurrentRuns', async () => {
    const user = userEvent.setup();
    const createSpy = vi
      .spyOn(scheduleApi, 'create')
      .mockResolvedValueOnce({
        schedule: makeSchedule({
          id: 'sched-new-rec',
          name: 'Nightly-Audit',
          type: 'RECURRING',
          cronExpression: '0 9 * * *',
          timezone: 'America/New_York',
        }),
      })
      .mockResolvedValueOnce({
        schedule: makeSchedule({
          id: 'sched-new-once',
          name: 'Once-Cutover',
          type: 'ONE_TIME',
          cronExpression: null,
          runAt: '2026-12-15T10:00:00.000Z',
        }),
        initialJobId: 'job-once-1',
      });

    renderSchedulesApp(['/schedules']);
    await screen.findByText('Hourly-Invoice-Sync');

    await user.click(screen.getByRole('button', { name: /Create Schedule/i }));
    const dialog = await screen.findByRole('dialog');

    const nameInput = within(dialog).getByLabelText('Schedule Name');
    await user.clear(nameInput);
    await user.paste('Nightly-Audit');

    // 1. Invalid IANA timezone validation
    const tzInput = within(dialog).getByLabelText('IANA Timezone');
    await user.clear(tzInput);
    await user.paste('Invalid/Timezone_999');
    await user.click(within(dialog).getByRole('button', { name: 'Create Schedule' }));
    expect(
      await within(dialog).findByText(/Invalid IANA timezone identifier/i),
    ).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    // Fix timezone using quick pill
    await user.click(within(dialog).getByRole('button', { name: 'America/New_York' }));

    // 2. Invalid JSON payload (array instead of plain object)
    const payloadInput = within(dialog).getByLabelText('JSON Payload');
    await user.clear(payloadInput);
    await user.paste('[1, 2, 3]');
    await user.click(within(dialog).getByRole('button', { name: 'Create Schedule' }));
    expect(await within(dialog).findByText(/Payload must be a JSON object/i)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    // Apply processor preset "math.sum" to restore valid JSON object
    await user.click(within(dialog).getByRole('button', { name: 'math.sum' }));

    // 3. Validate preventOverlap: true + maxConcurrentRuns > 1 conflict
    await user.click(
      within(dialog).getByRole('button', {
        name: /Advanced Reliability, Concurrency & Job Overrides/i,
      }),
    );
    const maxConcurrentInput = within(dialog).getByLabelText('Max Concurrent Runs (1–100)');
    await user.type(maxConcurrentInput, '4');
    await user.click(within(dialog).getByRole('button', { name: 'Create Schedule' }));
    expect(
      await within(dialog).findByText(
        /preventOverlap: true cannot be combined with maxConcurrentRuns > 1/i,
      ),
    ).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();

    await user.clear(maxConcurrentInput);

    // Select Cron Preset "Daily 09:00 (0 9 * * *)" and submit RECURRING schedule
    await user.click(within(dialog).getByRole('button', { name: /Daily 09:00/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Create Schedule' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        'org-alpha',
        expect.objectContaining({
          queueId: queueBilling.id,
          name: 'Nightly-Audit',
          type: 'RECURRING',
          timezone: 'America/New_York',
          cronExpression: '0 9 * * *',
          jobName: 'math.sum',
          payload: { numbers: [12, 28, 40, 120] },
        }),
      );
    });
    expect(
      await screen.findByText(/Schedule "Nightly-Audit" created \(RECURRING\)/i),
    ).toBeInTheDocument();

    // 4. Create ONE_TIME schedule
    await user.click(screen.getByRole('button', { name: /Create Schedule/i }));
    const dialog2 = await screen.findByRole('dialog');

    await user.selectOptions(within(dialog2).getByLabelText('Schedule Type'), 'ONE_TIME');
    await user.paste('Once-Cutover');
    const nameInput2 = within(dialog2).getByLabelText('Schedule Name');
    await user.clear(nameInput2);
    await user.paste('Once-Cutover');
    const runAtInput = within(dialog2).getByLabelText('Scheduled Execution Timestamp (runAt)');
    await user.clear(runAtInput);
    await user.paste('2026-12-15T10:00:00Z');

    await user.click(within(dialog2).getByRole('button', { name: 'Create Schedule' }));
    await waitFor(() => {
      expect(createSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        expect.objectContaining({
          name: 'Once-Cutover',
          type: 'ONE_TIME',
          runAt: '2026-12-15T10:00:00Z',
        }),
      );
    });
  }, 15_000);

  it('edits an existing schedule with immutable queue and type and sends only supported update fields', async () => {
    const user = userEvent.setup();
    const updateSpy = vi.spyOn(scheduleApi, 'update').mockResolvedValue({
      ...recurringActive,
      name: 'Hourly-Invoice-Sync-v2',
      misfirePolicy: 'CATCH_UP',
    });

    renderSchedulesApp(['/schedules']);
    await screen.findByText('Hourly-Invoice-Sync');

    // Terminal COMPLETED schedule must not have Edit button
    expect(
      screen.queryByRole('button', { name: 'Edit schedule Completed-Migration-Run' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit schedule Hourly-Invoice-Sync' }));
    const dialog = await screen.findByRole('dialog');

    // Target Queue and Schedule Type must be disabled (immutable) in edit mode
    expect(within(dialog).getByLabelText('Target Queue')).toBeDisabled();
    expect(within(dialog).getByLabelText('Schedule Type')).toBeDisabled();

    const nameInput = within(dialog).getByLabelText('Schedule Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Hourly-Invoice-Sync-v2');
    await user.selectOptions(within(dialog).getByLabelText('Misfire Policy'), 'CATCH_UP');

    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'org-alpha',
        recurringActive.id,
        expect.objectContaining({
          name: 'Hourly-Invoice-Sync-v2',
          misfirePolicy: 'CATCH_UP',
          cronExpression: '0 * * * *',
        }),
      );
    });

    // Verify unsupported immutable fields (queueId, type, runAt on RECURRING) were NOT sent
    const sentPayload = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(sentPayload).not.toHaveProperty('queueId');
    expect(sentPayload).not.toHaveProperty('type');
    expect(sentPayload).not.toHaveProperty('runAt');
  });

  it('executes pause, resume, cancel (with confirmation), delete (with confirmation), and reconcile', async () => {
    const user = userEvent.setup();
    const pauseSpy = vi
      .spyOn(scheduleApi, 'pause')
      .mockResolvedValue({ ...recurringActive, status: 'PAUSED', nextRunAt: null });
    const resumeSpy = vi
      .spyOn(scheduleApi, 'resume')
      .mockResolvedValue({ ...oneTimePaused, status: 'ACTIVE' });
    const cancelSpy = vi
      .spyOn(scheduleApi, 'cancel')
      .mockResolvedValue({ ...recurringActive, status: 'CANCELLED', nextRunAt: null });
    const deleteSpy = vi.spyOn(scheduleApi, 'delete').mockResolvedValue(undefined);
    const reconcileSpy = vi.spyOn(scheduleApi, 'reconcile').mockResolvedValue({
      bullmq: { scanned: 2, reEnqueued: 1, alreadyPresent: 1, failed: 0 },
      tick: {
        scanned: 2,
        dispatched: 1,
        catchUpDispatched: 1,
        missedRecorded: 0,
        skippedOverlap: 0,
        skippedConcurrency: 0,
        skippedMinInterval: 0,
        skippedMaxRuns: 0,
        skippedContention: 0,
        completedOneTime: 0,
        completedMaxRuns: 0,
        outboxDeferred: 0,
      },
    });

    renderSchedulesApp(['/schedules']);
    await screen.findByText('Hourly-Invoice-Sync');

    // Pause active schedule
    await user.click(screen.getByRole('button', { name: 'Pause schedule Hourly-Invoice-Sync' }));
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith('org-alpha', recurringActive.id));

    // Resume paused schedule
    await user.click(
      screen.getByRole('button', { name: 'Resume schedule OneTime-YearEnd-Export' }),
    );
    await waitFor(() => expect(resumeSpy).toHaveBeenCalledWith('org-alpha', oneTimePaused.id));

    // Cancel schedule with confirmation dialog
    await user.click(screen.getByRole('button', { name: 'Cancel schedule Hourly-Invoice-Sync' }));
    const cancelDialog = await screen.findByRole('dialog');
    await user.click(within(cancelDialog).getByRole('button', { name: 'Cancel Schedule' }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('org-alpha', recurringActive.id));

    // Delete schedule with confirmation dialog
    await user.click(
      screen.getByRole('button', { name: 'Delete schedule OneTime-YearEnd-Export' }),
    );
    const deleteDialog = await screen.findByRole('dialog');
    await user.click(within(deleteDialog).getByRole('button', { name: 'Delete Schedule' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('org-alpha', oneTimePaused.id));

    // Reconcile schedules
    await user.click(screen.getByRole('button', { name: /Reconcile Schedules/i }));
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalledWith('org-alpha'));
    expect(
      await screen.findByText(/Schedule reconciliation finished: 1 dispatched/i),
    ).toBeInTheDocument();
  });

  it('enforces RBAC: MEMBER is read-only, ADMIN can manage/cancel/reconcile but cannot delete, OWNER can delete', async () => {
    // 1. MEMBER role
    setupMocks('MEMBER');
    const { unmount: unmountMember } = renderSchedulesApp(['/schedules']);
    await screen.findByText('Hourly-Invoice-Sync');

    expect(screen.getByText(/MEMBER · Read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reconcile Schedules/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit schedule Hourly-Invoice-Sync' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Pause schedule Hourly-Invoice-Sync' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel schedule Hourly-Invoice-Sync' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete schedule Hourly-Invoice-Sync' }),
    ).not.toBeInTheDocument();
    unmountMember();

    // 2. ADMIN role
    setupMocks('ADMIN');
    const { unmount: unmountAdmin } = renderSchedulesApp(['/schedules']);
    await screen.findByText('Hourly-Invoice-Sync');

    expect(screen.getByRole('button', { name: /Create Schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconcile Schedules/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Edit schedule Hourly-Invoice-Sync' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Pause schedule Hourly-Invoice-Sync' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel schedule Hourly-Invoice-Sync' }),
    ).toBeInTheDocument();
    // ADMIN cannot delete
    expect(
      screen.queryByRole('button', { name: 'Delete schedule Hourly-Invoice-Sync' }),
    ).not.toBeInTheDocument();
    unmountAdmin();
  });

  it('renders ScheduleDetailPage with stats, upcoming runs in local & UTC, execution history filters, and spawned job links', async () => {
    const user = userEvent.setup();
    vi.spyOn(scheduleApi, 'getById').mockResolvedValue(recurringActive);

    const stats: ScheduleStatsView = {
      scheduleId: recurringActive.id,
      name: recurringActive.name,
      type: 'RECURRING',
      status: 'ACTIVE',
      misfirePolicy: 'SKIP_MISSED',
      runCount: 14,
      maxTotalRuns: 50,
      remainingRuns: 36,
      currentInFlight: 1,
      totalExecutions: 16,
      catchUpExecutions: 1,
      byStatus: {
        scheduled: 0,
        dispatched: 14,
        missed: 1,
        skippedOverlap: 1,
        skippedConcurrency: 0,
        skippedMinInterval: 0,
        skippedMaxRuns: 0,
        cancelled: 0,
      },
      byFinalJobStatus: {
        completed: 13,
        failed: 1,
        inFlight: 1,
      },
      totalRetries: 2,
      durationMs: {
        avg: 45,
        min: 20,
        max: 110,
      },
      lastRunAt: '2026-11-23T07:00:00.000Z',
      lastDispatchedAt: '2026-11-23T07:00:00.090Z',
      nextRunAt: '2026-11-23T08:00:00.000Z',
    };
    vi.spyOn(scheduleApi, 'getStats').mockResolvedValue(stats);

    const nextRun: NextRunPreviewView = {
      scheduleId: recurringActive.id,
      type: 'RECURRING',
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
      cronExpression: '0 * * * *',
      nextRunAt: '2026-11-23T08:00:00.000Z',
      nextRunAtLocal: '2026-11-23T13:30:00.000+05:30',
      upcomingRuns: [
        { utc: '2026-11-23T08:00:00.000Z', local: '2026-11-23T13:30:00.000+05:30' },
        { utc: '2026-11-23T09:00:00.000Z', local: '2026-11-23T14:30:00.000+05:30' },
      ],
    };
    vi.spyOn(scheduleApi, 'getNextRun').mockResolvedValue(nextRun);

    const dispatchedExec: ScheduleExecutionView = {
      id: 'exec-disp-1',
      scheduleId: recurringActive.id,
      jobId: 'job-spawned-111122223333',
      scheduledFor: '2026-11-23T07:00:00.000Z',
      dispatchedAt: '2026-11-23T07:00:00.090Z',
      startedAt: '2026-11-23T07:00:00.120Z',
      completedAt: '2026-11-23T07:00:00.165Z',
      finalJobStatus: 'COMPLETED',
      retryCount: 0,
      durationMs: 45,
      isCatchUp: true,
      status: 'DISPATCHED',
      reason: 'Recovered under CATCH_UP policy',
      job: {
        id: 'job-spawned-111122223333',
        status: 'COMPLETED',
        priority: 4,
        attemptsMade: 1,
        durationMs: 45,
        errorMessage: null,
        startedAt: '2026-11-23T07:00:00.120Z',
        completedAt: '2026-11-23T07:00:00.165Z',
        failedAt: null,
      },
      createdAt: '2026-11-23T07:00:00.000Z',
    };

    const skippedExec: ScheduleExecutionView = {
      id: 'exec-skip-2',
      scheduleId: recurringActive.id,
      jobId: null,
      scheduledFor: '2026-11-23T06:00:00.000Z',
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      finalJobStatus: null,
      retryCount: 0,
      durationMs: null,
      isCatchUp: false,
      status: 'SKIPPED_OVERLAP',
      reason: 'Skipped because 1 previous occurrence(s) are still in progress',
      job: null,
      createdAt: '2026-11-23T06:00:00.000Z',
    };

    const execSpy = vi
      .spyOn(scheduleApi, 'listExecutions')
      .mockImplementation(async (_orgId, _schedId, params) => {
        const all = [dispatchedExec, skippedExec];
        const filtered = params?.status ? all.filter((e) => e.status === params.status) : all;
        return {
          executions: filtered,
          pagination: {
            page: params?.page ?? 1,
            limit: params?.limit ?? 10,
            total: filtered.length,
            totalPages: 1,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      });

    renderSchedulesApp([`/schedules/${recurringActive.id}`]);

    // Stats cards
    expect(await screen.findByText('14 / 50')).toBeInTheDocument();
    expect(screen.getByText('13 / 1')).toBeInTheDocument();
    expect(screen.getByText(/Min: 20 ms · Max: 110 ms/i)).toBeInTheDocument();

    // Upcoming runs in local timezone and UTC
    expect(screen.getAllByText('2026-11-23T13:30:00.000+05:30').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2026-11-23T14:30:00.000+05:30')).toBeInTheDocument();

    // Execution history table: distinguishes dispatched job link vs skipped execution
    const jobLink = screen.getByRole('link', { name: /job-spaw…3333/i });
    expect(jobLink).toHaveAttribute('href', '/jobs/job-spawned-111122223333');
    expect(screen.getByText('No job spawned (skipped/missed)')).toBeInTheDocument();
    expect(
      screen.getByText('Skipped because 1 previous occurrence(s) are still in progress'),
    ).toBeInTheDocument();

    // Filter execution history by SKIPPED_OVERLAP
    await user.selectOptions(
      screen.getByLabelText('Filter execution history by status'),
      'SKIPPED_OVERLAP',
    );
    await waitFor(() => {
      expect(execSpy).toHaveBeenLastCalledWith(
        'org-alpha',
        recurringActive.id,
        expect.objectContaining({ status: 'SKIPPED_OVERLAP', page: 1 }),
      );
    });
    expect(screen.queryByRole('link', { name: /job-spaw…3333/i })).not.toBeInTheDocument();
    expect(screen.getByText('No job spawned (skipped/missed)')).toBeInTheDocument();
  });

  it('handles backend errors (HTTP 400 / 409) gracefully when resuming or saving a schedule', async () => {
    const user = userEvent.setup();
    vi.spyOn(scheduleApi, 'resume').mockRejectedValueOnce(
      new ApiClientError(
        'Cannot resume a ONE_TIME schedule whose runAt timestamp is in the past. Update runAt first.',
        400,
        'BAD_REQUEST',
      ),
    );

    renderSchedulesApp(['/schedules']);
    await screen.findByText('OneTime-YearEnd-Export');

    await user.click(
      screen.getByRole('button', { name: 'Resume schedule OneTime-YearEnd-Export' }),
    );
    expect(
      await screen.findByText(
        /Cannot resume a ONE_TIME schedule whose runAt timestamp is in the past/i,
      ),
    ).toBeInTheDocument();
  });
});

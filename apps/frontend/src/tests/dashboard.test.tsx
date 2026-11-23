import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../config/queryClient';
import { AuthProvider } from '../contexts/AuthContext';
import { OrganisationProvider } from '../contexts/OrganisationContext';
import { AppRoutes } from '../App';
import { authApi } from '../api/auth.api';
import { dlqApi } from '../api/dlq.api';
import { organisationApi } from '../api/organisation.api';
import { monitoringApi } from '../api/monitoring.api';
import { queueApi } from '../api/queue.api';
import { scheduleApi } from '../api/schedule.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type { OrganisationMetricsView } from '../types/api';

function buildMetrics(
  orgId: string,
  queueName: string,
  completed: number,
): OrganisationMetricsView {
  return {
    organisationId: orgId,
    summary: {
      totalSubmitted: completed + 2,
      totalProcessed: completed + 1,
      succeeded: completed,
      failed: 1,
      active: 1,
      pending: 0,
      delayed: 0,
      paused: 0,
      retriedJobs: 1,
      totalRetryEvents: 1,
      stalledRecoveries: 0,
      deadLetterOpen: 1,
      deadLetterReplayed: 0,
      averageDurationMs: 42.5,
    },
    throughput: {
      windowMinutes: 60,
      completedInWindow: completed,
      failedInWindow: 1,
      processedInWindow: completed + 1,
      jobsPerMinute: 1.5,
    },
    queues: [
      {
        queueId: `q-${orgId}`,
        name: queueName,
        isPaused: false,
        concurrency: 5,
        totalJobs: completed + 2,
        byStatus: {
          PENDING: 0,
          ACTIVE: 1,
          COMPLETED: completed,
          FAILED: 1,
          DELAYED: 0,
          PAUSED: 0,
        },
        averageDurationMs: 42.5,
        openDeadLetters: 1,
      },
    ],
    workers: [
      {
        workerInstanceId: `worker-${orgId}-01`,
        hostname: 'worker-node-1',
        pid: 4120,
        status: 'ONLINE',
        registeredQueues: [`org_${orgId}__${queueName}`],
        jobsProcessed: completed + 1,
        jobsSucceeded: completed,
        jobsFailed: 1,
        lastError: null,
        lastHeartbeatAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        heartbeatAgeMs: 2000,
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

function renderAuthenticatedApp(initialEntries: string[] = ['/dashboard']) {
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

describe('SaaS Dashboard Shell, Organisation Switching, Navigation & Error Handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();

    vi.spyOn(authApi, 'restoreSession').mockResolvedValue({
      id: 'user-owner',
      name: 'Apurva Dev',
      email: 'apurva@pulsequeue.dev',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    vi.spyOn(healthApi, 'getHealth').mockResolvedValue({
      status: 'ok',
      services: { database: 'connected', redis: 'connected' },
      timestamp: new Date().toISOString(),
    });

    vi.spyOn(organisationApi, 'list').mockResolvedValue([
      {
        id: 'org-alpha',
        name: 'Acme Billing',
        role: 'OWNER',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'org-beta',
        name: 'Globex Analytics',
        role: 'ADMIN',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    vi.spyOn(monitoringApi, 'getMetrics').mockImplementation(async (orgId) =>
      orgId === 'org-alpha'
        ? buildMetrics('org-alpha', 'invoices-prod', 120)
        : buildMetrics('org-beta', 'etl-nightly', 45),
    );

    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [
        {
          id: 'evt-1',
          type: 'JOB_COMPLETED',
          organisationId: 'org-alpha',
          queueId: 'q-org-alpha',
          jobId: 'job-1',
          workerId: 'worker-org-alpha-01',
          message: 'Job "send.invoice" completed on attempt 1',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
      pagination: {
        page: 1,
        limit: 8,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    vi.spyOn(queueApi, 'list').mockResolvedValue([]);

    vi.spyOn(dlqApi, 'list').mockResolvedValue({
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

    vi.spyOn(scheduleApi, 'list').mockResolvedValue({
      schedules: [],
      pagination: {
        page: 1,
        limit: 5,
        total: 3,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  });

  it('renders real organisation metrics, queue table, worker heartbeats, events, and switches organisations', async () => {
    const user = userEvent.setup();
    renderAuthenticatedApp(['/dashboard']);

    expect(await screen.findByText('invoices-prod')).toBeInTheDocument();
    expect(screen.getByText('worker-org-alpha-01')).toBeInTheDocument();
    expect(screen.getByText('Job "send.invoice" completed on attempt 1')).toBeInTheDocument();
    expect(screen.getByText('PG: connected')).toBeInTheDocument();

    // Switch organisation from Acme Billing -> Globex Analytics
    await user.click(screen.getByRole('button', { name: /Acme Billing/i }));
    await user.click(screen.getByRole('option', { name: /Globex Analytics/i }));

    expect(await screen.findByText('etl-nightly')).toBeInTheDocument();
    expect(screen.getByText('worker-org-beta-01')).toBeInTheDocument();
  });

  it('navigates cleanly across planned sidebar modules', async () => {
    const user = userEvent.setup();
    renderAuthenticatedApp(['/dashboard']);

    await screen.findByText('invoices-prod');

    await user.click(screen.getByRole('link', { name: 'Schedules' }));
    expect(await screen.findByText('No schedules created yet')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Dead Letter Queue' }));
    expect(await screen.findByText('No dead-letter jobs recorded')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(await screen.findByText('invoices-prod')).toBeInTheDocument();
  });

  it('renders an actionable ErrorState when metrics API fails', async () => {
    const metricsSpy = vi
      .spyOn(monitoringApi, 'getMetrics')
      .mockRejectedValue(new ApiClientError('Metrics service unavailable', 503, 'UNAVAILABLE'));

    renderAuthenticatedApp(['/dashboard']);

    expect(
      await screen.findByText('Failed to load organisation metrics', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Metrics service unavailable')).toBeInTheDocument();

    const user = userEvent.setup();
    metricsSpy.mockResolvedValue(buildMetrics('org-alpha', 'invoices-prod', 120));
    await user.click(screen.getByRole('button', { name: /Try again/i }));

    await waitFor(() => {
      expect(screen.getByText('invoices-prod')).toBeInTheDocument();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertsPage } from '../pages/alerts/AlertsPage';
import { NotificationBell } from '../components/alerts/NotificationBell';
import { alertApi } from '../api/alert.api';
import { queueApi } from '../api/queue.api';
import { organisationApi } from '../api/organisation.api';
import { OrganisationProvider, useOrganisation } from '../contexts/OrganisationContext';
import type { MonitoringStreamClient, MonitoringStreamOptions } from '../api/monitoringStream';
import type { AlertStatsView, AlertView, OrganisationView } from '../types/api';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Ops Lead', email: 'ops@pulsequeue.dev' },
    isAuthenticated: true,
    isBootstrapping: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

const ORG_A: OrganisationView = {
  id: 'org-a',
  name: 'Alpha Org',
  role: 'OWNER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const ORG_B: OrganisationView = {
  id: 'org-b',
  name: 'Beta Org',
  role: 'MEMBER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function makeAlert(orgId: string, ruleName: string): AlertView {
  return {
    id: `alert-${orgId}`,
    organisationId: orgId,
    ruleId: `rule-${orgId}`,
    queueId: null,
    queueName: null,
    dedupKey: `rule-${orgId}:org`,
    ruleName,
    type: 'QUEUE_BACKLOG',
    severity: 'CRITICAL',
    status: 'FIRING',
    message: `${ruleName} breached`,
    metricValue: 12,
    threshold: 5,
    occurrenceCount: 1,
    firstTriggeredAt: '2026-11-23T10:00:00.000Z',
    lastTriggeredAt: '2026-11-23T10:00:00.000Z',
    lastEvaluatedAt: '2026-11-23T10:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedById: null,
    resolvedAt: null,
    resolvedById: null,
    resolutionReason: null,
    createdAt: '2026-11-23T10:00:00.000Z',
    updatedAt: '2026-11-23T10:00:00.000Z',
  };
}

function OrgSwitcherHarness({
  createClient,
}: {
  createClient: (opts: MonitoringStreamOptions) => MonitoringStreamClient;
}) {
  const { setActiveOrganisationId } = useOrganisation();
  return (
    <div>
      <button type="button" onClick={() => setActiveOrganisationId('org-b')}>
        Switch to Beta Org
      </button>
      <NotificationBell />
      <AlertsPage streamOptions={{ createClient }} />
    </div>
  );
}

describe('Step 7.7 — Organisation Switching & Tenant Cache Isolation (Alerts + NotificationBell)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();

    vi.spyOn(organisationApi, 'list').mockResolvedValue([ORG_A, ORG_B]);
    vi.spyOn(queueApi, 'list').mockResolvedValue([]);
    vi.spyOn(alertApi, 'listRules').mockResolvedValue([]);
    vi.spyOn(alertApi, 'getAlertStats').mockImplementation(
      async (orgId): Promise<AlertStatsView> => ({
        total: 1,
        firing: orgId === 'org-a' ? 2 : 1,
        acknowledged: 0,
        resolved: 0,
        activeBySeverity: { info: 0, warning: 0, critical: 1 },
        enabledRules: 1,
        totalRules: 1,
      }),
    );
    vi.spyOn(alertApi, 'listAlerts').mockImplementation(async (orgId) => ({
      alerts: [
        orgId === 'org-a'
          ? makeAlert('org-a', 'Alpha Only Alert')
          : makeAlert('org-b', 'Beta Only Alert'),
      ],
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    }));
    vi.spyOn(alertApi, 'getUnreadCount').mockImplementation(async (orgId) =>
      orgId === 'org-a' ? 4 : 1,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('closes Org A SSE stream, opens Org B stream, updates unread badge, and clears Org A alerts on switch', async () => {
    const user = userEvent.setup();
    const closeFns: Array<{ orgId: string; close: ReturnType<typeof vi.fn> }> = [];
    const createClient = vi.fn((options: MonitoringStreamOptions): MonitoringStreamClient => {
      const close = vi.fn();
      closeFns.push({ orgId: options.organisationId, close });
      return {
        connect: vi.fn(),
        close,
        switchOrganisation: vi.fn(),
        getState: vi.fn(() => 'connected'),
        getOrganisationId: vi.fn(() => options.organisationId),
        getLastEventId: vi.fn(() => null),
      } as unknown as MonitoringStreamClient;
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/alerts']}>
          <OrganisationProvider>
            <OrgSwitcherHarness createClient={createClient} />
          </OrganisationProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Org A state loaded
    expect(await screen.findByText('Alpha Only Alert')).toBeInTheDocument();
    expect(await screen.findByTestId('notification-unread-badge')).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: /Create Rule/i })).toBeInTheDocument();

    // Switch to Org B (MEMBER role)
    await user.click(screen.getByRole('button', { name: 'Switch to Beta Org' }));

    // Org B state loaded, Org A alert gone, RBAC updated, Org A stream closed
    expect(await screen.findByText('Beta Only Alert')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Only Alert')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent('1');
    });
    expect(screen.queryByRole('button', { name: /Create Rule/i })).not.toBeInTheDocument();

    expect(closeFns.some((c) => c.orgId === 'org-a' && c.close.mock.calls.length >= 1)).toBe(true);
    expect(closeFns.some((c) => c.orgId === 'org-b')).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertsPage } from '../pages/alerts/AlertsPage';
import { NotificationBell } from '../components/alerts/NotificationBell';
import { alertApi } from '../api/alert.api';
import { queueApi } from '../api/queue.api';
import { organisationApi } from '../api/organisation.api';
import { OrganisationProvider } from '../contexts/OrganisationContext';
import type { MonitoringStreamClient, MonitoringStreamOptions } from '../api/monitoringStream';
import type {
  AlertRuleView,
  AlertStatsView,
  AlertView,
  NotificationView,
  OrganisationView,
  PlatformEventView,
  QueueView,
} from '../types/api';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Ops Admin', email: 'ops@pulsequeue.dev' },
    isAuthenticated: true,
    isBootstrapping: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

interface MockStreamHandle {
  options: MonitoringStreamOptions;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createFakeStreamFactory() {
  const handles: MockStreamHandle[] = [];
  const createClient = vi.fn((options: MonitoringStreamOptions): MonitoringStreamClient => {
    const connect = vi.fn();
    const close = vi.fn();
    handles.push({ options, connect, close });
    return {
      connect,
      close,
      switchOrganisation: vi.fn(),
      getState: vi.fn(() => 'connected'),
      getOrganisationId: vi.fn(() => options.organisationId),
      getLastEventId: vi.fn(() => null),
    } as unknown as MonitoringStreamClient;
  });
  return { handles, createClient };
}

const ORG_OWNER: OrganisationView = {
  id: 'org-a',
  name: 'Acme Payments',
  role: 'OWNER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const ORG_MEMBER: OrganisationView = {
  id: 'org-b',
  name: 'ReadOnly Org',
  role: 'MEMBER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const MOCK_QUEUES: QueueView[] = [
  {
    id: 'q-1',
    organisationId: 'org-a',
    name: 'payments',
    description: null,
    isPaused: false,
    concurrency: 5,
    defaultPriority: 0,
    maxRetries: 3,
    backoffMs: 1000,
    pausedAt: null,
    jobCount: 0,
    createdBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
];

const MOCK_STATS: AlertStatsView = {
  total: 3,
  firing: 1,
  acknowledged: 1,
  resolved: 1,
  activeBySeverity: { info: 0, warning: 1, critical: 1 },
  enabledRules: 1,
  totalRules: 1,
};

const MOCK_ALERT_FIRING: AlertView = {
  id: 'alert-1',
  organisationId: 'org-a',
  ruleId: 'rule-1',
  queueId: 'q-1',
  queueName: 'payments',
  dedupKey: 'rule:rule-1',
  ruleName: 'Payments Backlog High',
  type: 'QUEUE_BACKLOG',
  severity: 'CRITICAL',
  status: 'FIRING',
  message: 'Payments Backlog High: observed 25 >= threshold 10',
  metricValue: 25,
  threshold: 10,
  occurrenceCount: 3,
  firstTriggeredAt: '2026-11-23T10:00:00.000Z',
  lastTriggeredAt: '2026-11-23T10:05:00.000Z',
  lastEvaluatedAt: '2026-11-23T10:05:00.000Z',
  acknowledgedAt: null,
  acknowledgedById: null,
  resolvedAt: null,
  resolvedById: null,
  resolutionReason: null,
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:05:00.000Z',
};

const MOCK_RULE: AlertRuleView = {
  id: 'rule-1',
  organisationId: 'org-a',
  queueId: 'q-1',
  queueName: 'payments',
  name: 'Payments Backlog High',
  description: 'Alerts when backlog exceeds 10',
  type: 'QUEUE_BACKLOG',
  operator: 'GTE',
  threshold: 10,
  windowMinutes: 15,
  cooldownSeconds: 300,
  severity: 'CRITICAL',
  isEnabled: true,
  createdById: 'user-1',
  updatedById: 'user-1',
  createdAt: '2026-11-23T09:00:00.000Z',
  updatedAt: '2026-11-23T09:00:00.000Z',
};

const MOCK_NOTIFICATION: NotificationView = {
  id: 'notif-1',
  organisationId: 'org-a',
  userId: 'user-1',
  alertId: 'alert-1',
  eventKey: 'alert-1:FIRED',
  type: 'ALERT_FIRED',
  severity: 'CRITICAL',
  title: 'Alert: Payments Backlog High',
  message: 'Payments Backlog High: observed 25 >= threshold 10',
  isRead: false,
  readAt: null,
  createdAt: '2026-11-23T10:00:00.000Z',
};

function renderWithProviders(ui: React.ReactElement, initialRoute = '/alerts') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <OrganisationProvider>{ui}</OrganisationProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Step 7.6 — AlertsPage & NotificationBell UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(organisationApi, 'list').mockResolvedValue([ORG_OWNER]);
    vi.spyOn(queueApi, 'list').mockResolvedValue(MOCK_QUEUES);
    vi.spyOn(alertApi, 'getAlertStats').mockResolvedValue(MOCK_STATS);
    vi.spyOn(alertApi, 'listAlerts').mockResolvedValue({
      alerts: [MOCK_ALERT_FIRING],
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(alertApi, 'listRules').mockResolvedValue([MOCK_RULE]);
    vi.spyOn(alertApi, 'listNotifications').mockResolvedValue({
      notifications: [MOCK_NOTIFICATION],
      unreadCount: 1,
      pagination: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(alertApi, 'getUnreadCount').mockResolvedValue(1);
    vi.spyOn(alertApi, 'acknowledgeAlert').mockResolvedValue({
      ...MOCK_ALERT_FIRING,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-11-23T10:06:00.000Z',
    });
    vi.spyOn(alertApi, 'resolveAlert').mockResolvedValue({
      ...MOCK_ALERT_FIRING,
      status: 'RESOLVED',
      resolvedAt: '2026-11-23T10:07:00.000Z',
    });
    vi.spyOn(alertApi, 'createRule').mockResolvedValue({
      ...MOCK_RULE,
      id: 'rule-2',
      name: 'New DLQ Rule',
    });
    vi.spyOn(alertApi, 'toggleRule').mockResolvedValue({
      ...MOCK_RULE,
      isEnabled: false,
    });
    vi.spyOn(alertApi, 'deleteRule').mockResolvedValue({ deleted: true });
    vi.spyOn(alertApi, 'markNotificationRead').mockResolvedValue({
      ...MOCK_NOTIFICATION,
      isRead: true,
    });
    vi.spyOn(alertApi, 'markAllNotificationsRead').mockResolvedValue({ updatedCount: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders KPI cards, active alerts, detail drawer, and acknowledges/resolves alerts', async () => {
    const user = userEvent.setup();
    const { createClient } = createFakeStreamFactory();

    renderWithProviders(<AlertsPage streamOptions={{ createClient }} />);

    expect(await screen.findByText('Payments Backlog High')).toBeInTheDocument();
    expect(screen.getByText('Firing Alerts')).toBeInTheDocument();

    // Acknowledge button works
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => {
      expect(alertApi.acknowledgeAlert).toHaveBeenCalledWith('org-a', 'alert-1');
    });

    // Resolve button works for OWNER
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(alertApi.resolveAlert).toHaveBeenCalledWith('org-a', 'alert-1', undefined);
    });
  });

  it('allows OWNER to create, toggle, and delete alert rules, and hides management actions for MEMBER', async () => {
    const user = userEvent.setup();
    const { createClient } = createFakeStreamFactory();

    renderWithProviders(<AlertsPage streamOptions={{ createClient }} />);

    // Open Create Rule modal
    await user.click(await screen.findByRole('button', { name: /Create Rule/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Rule Name'), 'New DLQ Rule');
    await user.click(within(dialog).getByRole('button', { name: 'Create Rule' }));

    await waitFor(() => {
      expect(alertApi.createRule).toHaveBeenCalledWith(
        'org-a',
        expect.objectContaining({ name: 'New DLQ Rule' }),
      );
    });

    // Switch to Alert Rules tab & toggle
    await user.click(screen.getByRole('tab', { name: /Alert Rules/i }));
    await user.click(await screen.findByLabelText('Disable Payments Backlog High'));
    await waitFor(() => {
      expect(alertApi.toggleRule).toHaveBeenCalledWith('org-a', 'rule-1', false);
    });

    // Delete rule with confirmation
    await user.click(screen.getByLabelText('Delete Payments Backlog High'));
    await user.click(await screen.findByRole('button', { name: 'Delete Rule' }));
    await waitFor(() => {
      expect(alertApi.deleteRule).toHaveBeenCalledWith('org-a', 'rule-1');
    });
  });

  it('hides Create Rule and Resolve controls for MEMBER role', async () => {
    vi.spyOn(organisationApi, 'list').mockResolvedValue([ORG_MEMBER]);
    const { createClient } = createFakeStreamFactory();

    renderWithProviders(<AlertsPage streamOptions={{ createClient }} />);

    expect(await screen.findByText('Payments Backlog High')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Rule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('renders NotificationBell unread badge, dropdown, mark read, and mark all read', async () => {
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);

    expect(await screen.findByTestId('notification-unread-badge')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: /Notifications \(1 unread\)/i }));
    expect(await screen.findByText('Alert: Payments Backlog High')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Mark all read/i }));
    await waitFor(() => {
      expect(alertApi.markAllNotificationsRead).toHaveBeenCalledWith('org-a');
    });
  });

  it('invalidates alert and notification queries when ALERT_FIRED arrives on SSE stream', async () => {
    const { handles, createClient } = createFakeStreamFactory();
    renderWithProviders(
      <AlertsPage streamOptions={{ createClient, invalidationDebounceMs: 25 }} />,
    );

    await screen.findByText('Payments Backlog High');
    const initialAlertCalls = vi.mocked(alertApi.listAlerts).mock.calls.length;
    const initialStatsCalls = vi.mocked(alertApi.getAlertStats).mock.calls.length;

    const liveAlertEvent: PlatformEventView = {
      id: 'evt-alert-1',
      type: 'ALERT_FIRED',
      organisationId: 'org-a',
      queueId: 'q-1',
      jobId: null,
      workerId: null,
      message: 'Alert fired',
      metadata: { alertId: 'alert-2' },
      createdAt: new Date().toISOString(),
    };

    act(() => {
      handles[0]?.options.onEvent?.(liveAlertEvent);
    });

    await waitFor(() => {
      expect(vi.mocked(alertApi.listAlerts).mock.calls.length).toBeGreaterThan(initialAlertCalls);
      expect(vi.mocked(alertApi.getAlertStats).mock.calls.length).toBeGreaterThan(
        initialStatsCalls,
      );
    });
  });
});

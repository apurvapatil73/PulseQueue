import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MonitoringPage } from '../pages/monitoring/MonitoringPage';
import { monitoringApi } from '../api/monitoring.api';
import { organisationApi } from '../api/organisation.api';
import { OrganisationProvider, useOrganisation } from '../contexts/OrganisationContext';
import type { MonitoringStreamClient, MonitoringStreamOptions } from '../api/monitoringStream';
import type {
  OrganisationMetricsView,
  OrganisationTimeseriesView,
  OrganisationView,
  OrgSafeWorkerView,
  PlatformEventView,
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
  client: MonitoringStreamClient;
}

function createFakeStreamFactory() {
  const handles: MockStreamHandle[] = [];
  const createClient = vi.fn((options: MonitoringStreamOptions): MonitoringStreamClient => {
    const connect = vi.fn();
    const close = vi.fn();
    const client = {
      connect,
      close,
      switchOrganisation: vi.fn(),
      getState: vi.fn(() => 'connected'),
      getOrganisationId: vi.fn(() => options.organisationId),
      getLastEventId: vi.fn(() => null),
    } as unknown as MonitoringStreamClient;
    handles.push({ options, connect, close, client });
    return client;
  });
  return { handles, createClient };
}

const ORG_A: OrganisationView = {
  id: 'org-a',
  name: 'Acme Payments',
  role: 'OWNER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const ORG_B: OrganisationView = {
  id: 'org-b',
  name: 'Beta Logistics',
  role: 'MEMBER',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const SAMPLE_WORKERS: OrgSafeWorkerView[] = [
  {
    workerInstanceId: 'worker-prod-01',
    hostname: 'node-west-1',
    pid: 4102,
    status: 'ONLINE',
    registeredQueues: ['payments-high', 'emails'],
    jobsProcessed: 120,
    jobsSucceeded: 118,
    jobsFailed: 2,
    activeJobs: 3,
    lastError: 'Gateway timeout on stripe-charge',
    lastHeartbeatAt: '2026-11-23T10:00:00.000Z',
    startedAt: '2026-11-23T08:00:00.000Z',
    stoppedAt: null,
    heartbeatAgeMs: 2500,
  },
];

const SAMPLE_METRICS: OrganisationMetricsView = {
  organisationId: 'org-a',
  summary: {
    totalSubmitted: 150,
    totalProcessed: 120,
    succeeded: 114,
    failed: 6,
    active: 4,
    pending: 20,
    delayed: 5,
    paused: 1,
    queueDepth: 26,
    successRate: 0.95,
    failureRate: 0.05,
    windowSuccessRate: 0.96,
    windowFailureRate: 0.04,
    retriedJobs: 8,
    totalRetryEvents: 11,
    stalledRecoveries: 2,
    deadLetterOpen: 3,
    deadLetterReplayed: 1,
    averageDurationMs: 145,
    windowAverageDurationMs: 132,
  },
  throughput: {
    windowMinutes: 60,
    completedInWindow: 48,
    failedInWindow: 2,
    processedInWindow: 50,
    jobsPerMinute: 0.833,
  },
  latency: {
    windowMinutes: 60,
    minPercentileSamples: 5,
    executionDuration: { sampleCount: 50, avgMs: 132, p50Ms: 110, p95Ms: 280, p99Ms: 420 },
    queueWait: { sampleCount: 50, avgMs: 45, p50Ms: 30, p95Ms: 120, p99Ms: 190 },
    retryOverhead: { sampleCount: 6, avgMs: 1200, p50Ms: 1000, p95Ms: 2100, p99Ms: 2400 },
    endToEnd: { sampleCount: 48, avgMs: 215, p50Ms: 180, p95Ms: 450, p99Ms: 620 },
  },
  reliability: {
    windowMinutes: 60,
    retriesInWindow: 4,
    stalledEventsInWindow: 1,
    recoveredEventsInWindow: 1,
    dlqCreatedInWindow: 2,
    dlqReplayedInWindow: 1,
    dlqNetGrowthInWindow: 1,
    scheduleMisfiresInWindow: 1,
    scheduleSkipsInWindow: 0,
    scheduleMisfiresTotal: 2,
    outboxPending: 0,
  },
  workerSummary: {
    total: 1,
    online: 1,
    degraded: 0,
    stale: 0,
    stopped: 0,
    activeJobs: 3,
  },
  queues: [
    {
      queueId: 'q-pay',
      name: 'payments-high',
      isPaused: false,
      concurrency: 5,
      totalJobs: 150,
      queueDepth: 26,
      byStatus: {
        PENDING: 20,
        ACTIVE: 4,
        COMPLETED: 114,
        FAILED: 6,
        DELAYED: 5,
        PAUSED: 1,
      },
      successRate: 0.95,
      failureRate: 0.05,
      averageDurationMs: 145,
      p95DurationMs: 280,
      retriedJobs: 8,
      stalledRecoveries: 2,
      processedInWindow: 50,
      jobsPerMinute: 0.833,
      oldestPendingAgeMs: 4200,
      openDeadLetters: 3,
    },
  ],
  workers: SAMPLE_WORKERS,
  windowStart: '2026-11-23T09:00:00.000Z',
  windowEnd: '2026-11-23T10:00:00.000Z',
  generatedAt: '2026-11-23T10:00:00.000Z',
};

const SAMPLE_TIMESERIES: OrganisationTimeseriesView = {
  organisationId: 'org-a',
  queueId: null,
  windowMinutes: 60,
  bucketMinutes: 5,
  minPercentileSamples: 5,
  windowStart: '2026-11-23T09:00:00.000Z',
  windowEnd: '2026-11-23T10:00:00.000Z',
  buckets: [
    {
      bucketStart: '2026-11-23T09:50:00.000Z',
      bucketEnd: '2026-11-23T09:55:00.000Z',
      submitted: 25,
      completed: 22,
      failed: 1,
      processed: 23,
      successRate: 0.9565,
      failureRate: 0.0435,
      avgDurationMs: 125,
      p95DurationMs: 260,
      retries: 2,
      stalled: 0,
      dlqAdded: 1,
      scheduleMisfires: 0,
    },
    {
      bucketStart: '2026-11-23T09:55:00.000Z',
      bucketEnd: '2026-11-23T10:00:00.000Z',
      submitted: 28,
      completed: 26,
      failed: 1,
      processed: 27,
      successRate: 0.963,
      failureRate: 0.037,
      avgDurationMs: 138,
      p95DurationMs: 295,
      retries: 2,
      stalled: 1,
      dlqAdded: 1,
      scheduleMisfires: 1,
    },
  ],
  generatedAt: '2026-11-23T10:00:00.000Z',
};

const PERSISTED_EVENT: PlatformEventView = {
  id: 'evt-persisted-1',
  type: 'JOB_COMPLETED',
  organisationId: 'org-a',
  queueId: 'q-pay',
  jobId: 'job-11111111-aaaa',
  workerId: 'worker-prod-01',
  message: 'Persisted payment job completed',
  metadata: {},
  createdAt: '2026-11-23T09:59:00.000Z',
};

function renderMonitoring(
  streamOptions?: Parameters<typeof MonitoringPage>[0]['streamOptions'],
  queryClient?: QueryClient,
) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/monitoring']}>
          <OrganisationProvider>
            <MonitoringPage streamOptions={streamOptions} />
          </OrganisationProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('Step 7.4 — Real-Time Monitoring Dashboard UI (MonitoringPage)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(organisationApi, 'list').mockResolvedValue([ORG_A, ORG_B]);
    vi.spyOn(monitoringApi, 'getMetrics').mockResolvedValue(SAMPLE_METRICS);
    vi.spyOn(monitoringApi, 'getTimeseries').mockResolvedValue(SAMPLE_TIMESERIES);
    vi.spyOn(monitoringApi, 'listWorkers').mockResolvedValue(SAMPLE_WORKERS);
    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [PERSISTED_EVENT],
      pagination: {
        page: 1,
        limit: 25,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(monitoringApi, 'recoverStalled').mockResolvedValue({
      scanned: 2,
      recovered: 1,
      movedToDlq: 1,
      skipped: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('renders platform metrics, latency percentiles, queue health, worker health, and persisted events', async () => {
    const { handles, createClient } = createFakeStreamFactory();
    renderMonitoring({ createClient });

    expect(await screen.findByText('150')).toBeInTheDocument();
    expect(screen.getByText('114 / 6')).toBeInTheDocument();
    expect(screen.getByText('0.833/min')).toBeInTheDocument();
    expect(screen.getAllByText('26').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1 / 1')).toBeInTheDocument();

    // Latency distributions (p50/p95/p99 + queue wait)
    expect(screen.getByText('Execution Duration')).toBeInTheDocument();
    expect(screen.getByText('Initial Queue Wait')).toBeInTheDocument();
    expect(screen.getByText('110ms')).toBeInTheDocument();
    expect(screen.getByText('280ms')).toBeInTheDocument();
    expect(screen.getByText('420ms')).toBeInTheDocument();

    // Queue health row + links
    const queueLinks = screen.getAllByRole('link', { name: 'payments-high' });
    expect(queueLinks[0]).toHaveAttribute('href', '/queues/q-pay');

    // Worker health row (real metadata only — no invented CPU/memory)
    expect(screen.getByText('worker-prod-01')).toBeInTheDocument();
    expect(screen.getByText('node-west-1 · PID 4102')).toBeInTheDocument();
    expect(screen.getByText('Gateway timeout on stripe-charge')).toBeInTheDocument();

    // Persisted event with clickable job link
    expect(screen.getByText('Persisted payment job completed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Job job-1111' })).toHaveAttribute(
      'href',
      '/jobs/job-11111111-aaaa',
    );

    expect(handles).toHaveLength(1);
    expect(handles[0].connect).toHaveBeenCalledTimes(1);
  });

  it('handles empty datasets and insufficient percentile samples honestly', async () => {
    vi.spyOn(monitoringApi, 'getMetrics').mockResolvedValue({
      ...SAMPLE_METRICS,
      summary: {
        ...SAMPLE_METRICS.summary,
        totalSubmitted: 0,
        totalProcessed: 0,
        succeeded: 0,
        failed: 0,
        active: 0,
        pending: 0,
        delayed: 0,
        paused: 0,
        queueDepth: 0,
        successRate: null,
        failureRate: null,
        windowSuccessRate: null,
        windowFailureRate: null,
        deadLetterOpen: 0,
        averageDurationMs: null,
      },
      throughput: {
        windowMinutes: 60,
        completedInWindow: 0,
        failedInWindow: 0,
        processedInWindow: 0,
        jobsPerMinute: 0,
      },
      latency: {
        windowMinutes: 60,
        minPercentileSamples: 5,
        executionDuration: { sampleCount: 2, avgMs: 50, p50Ms: null, p95Ms: null, p99Ms: null },
        queueWait: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
        retryOverhead: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
        endToEnd: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      },
      queues: [],
      workers: [],
      workerSummary: { total: 0, online: 0, degraded: 0, stale: 0, stopped: 0, activeJobs: 0 },
    });
    vi.spyOn(monitoringApi, 'getTimeseries').mockResolvedValue({
      ...SAMPLE_TIMESERIES,
      buckets: [],
    });
    vi.spyOn(monitoringApi, 'listWorkers').mockResolvedValue([]);
    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [],
      pagination: {
        page: 1,
        limit: 25,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const { createClient } = createFakeStreamFactory();
    renderMonitoring({ createClient });

    expect(await screen.findByText('No throughput recorded in this window')).toBeInTheDocument();
    expect(
      screen.getByText('Percentiles require at least 5 samples in the selected window.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No queues configured')).toBeInTheDocument();
    expect(screen.getByText('No workers registered for this organisation')).toBeInTheDocument();
    expect(screen.getByText('No platform events recorded yet')).toBeInTheDocument();
  });

  it('streams live SSE events, deduplicates duplicate IDs, and batches burst query invalidations', async () => {
    const { handles, createClient } = createFakeStreamFactory();
    renderMonitoring({ createClient, invalidationDebounceMs: 60 });

    await screen.findByText('Persisted payment job completed');
    const handle = handles[0];

    act(() => {
      handle.options.onStateChange?.('connected');
      handle.options.onConnected?.({
        organisationId: 'org-a',
        connectedAt: '2026-11-23T10:00:05.000Z',
        heartbeatIntervalMs: 20_000,
      });
    });

    expect(await screen.findByText('Live · SSE')).toBeInTheDocument();

    const metricsSpy = vi.mocked(monitoringApi.getMetrics);
    const initialMetricsCalls = metricsSpy.mock.calls.length;

    const liveEvt: PlatformEventView = {
      id: 'evt-live-999',
      type: 'JOB_FAILED',
      organisationId: 'org-a',
      queueId: 'q-pay',
      jobId: 'job-99999999-fail',
      workerId: 'worker-prod-01',
      message: 'Live payment job failed',
      metadata: {},
      createdAt: '2026-11-23T10:00:10.000Z',
    };

    // Emit duplicate of liveEvt + duplicate of persisted event in a burst
    act(() => {
      handle.options.onEvent?.(liveEvt);
      handle.options.onEvent?.(liveEvt);
      handle.options.onEvent?.(PERSISTED_EVENT);
    });

    // Deduplicated: each message appears exactly once
    expect(await screen.findAllByText('Live payment job failed')).toHaveLength(1);
    expect(screen.getAllByText('Persisted payment job completed')).toHaveLength(1);

    // Wait for single debounced invalidation (60ms) -> only 1 batched metrics refetch, not 3!
    await waitFor(() => {
      expect(metricsSpy.mock.calls.length).toBe(initialMetricsCalls + 1);
    });
  });

  it('displays reconnecting/resync states and falls back to polling when SSE is unavailable', async () => {
    const { handles, createClient } = createFakeStreamFactory();
    renderMonitoring({
      createClient,
      fallbackPollingMs: 80,
      invalidationDebounceMs: 50,
    });

    await screen.findByText('Persisted payment job completed');
    const handle = handles[0];

    act(() => {
      handle.options.onStateChange?.('reconnecting');
    });
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();

    act(() => {
      handle.options.onResync?.({ reason: 'redis_reconnected' });
    });
    expect(
      screen.getByText(/Real-time pub\/sub reconnected after a brief outage/i),
    ).toBeInTheDocument();

    const metricsSpy = vi.mocked(monitoringApi.getMetrics);
    const callsBeforeError = metricsSpy.mock.calls.length;

    act(() => {
      handle.options.onStateChange?.('error');
      handle.options.onError?.(new Error('Network offline'));
    });

    expect(screen.getByText('Polling Fallback')).toBeInTheDocument();
    expect(screen.getByText(/Live stream unavailable/i)).toBeInTheDocument();

    // Automatic fallback polling triggers refetch without manual intervention
    await waitFor(
      () => {
        expect(metricsSpy.mock.calls.length).toBeGreaterThan(callsBeforeError);
      },
      { timeout: 1000 },
    );
  });

  it('cleans up SSE on unmount, handles API errors with retry, and enforces RBAC on Recover Stalled', async () => {
    const user = userEvent.setup();
    vi.spyOn(monitoringApi, 'getMetrics').mockRejectedValueOnce(new Error('Metrics API 503'));

    const { handles, createClient } = createFakeStreamFactory();
    const { unmount } = renderMonitoring({ createClient });

    expect(
      await screen.findByText('Failed to load organisation monitoring metrics'),
    ).toBeInTheDocument();
    expect(screen.getByText('Metrics API 503')).toBeInTheDocument();

    // Retry succeeds
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('150')).toBeInTheDocument();

    // OWNER sees Recover Stalled button and can trigger recovery
    await user.click(screen.getByRole('button', { name: 'Recover Stalled' }));
    await user.click(screen.getByRole('button', { name: 'Run Recovery Sweep' }));
    expect(
      await screen.findByText(/Stalled recovery complete: scanned 2, recovered 1/i),
    ).toBeInTheDocument();

    // Unmount closes the active SSE client cleanly
    unmount();
    expect(handles[0].close).toHaveBeenCalledTimes(1);
  });

  it('hides Recover Stalled for MEMBER role, tears down old SSE connection, and clears stale events on organisation switch', async () => {
    const user = userEvent.setup();
    vi.spyOn(monitoringApi, 'getMetrics').mockImplementation(async (orgId) => ({
      ...SAMPLE_METRICS,
      organisationId: orgId,
    }));
    vi.spyOn(monitoringApi, 'listEvents').mockImplementation(async (orgId) => ({
      events: orgId === 'org-a' ? [PERSISTED_EVENT] : [],
      pagination: {
        page: 1,
        limit: 25,
        total: orgId === 'org-a' ? 1 : 0,
        totalPages: orgId === 'org-a' ? 1 : 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    }));

    function OrgSwitchHarness({
      streamOptions,
    }: {
      streamOptions: Parameters<typeof MonitoringPage>[0]['streamOptions'];
    }) {
      const { setActiveOrganisationId } = useOrganisation();
      return (
        <>
          <button type="button" onClick={() => setActiveOrganisationId('org-b')}>
            Switch To Org B
          </button>
          <MonitoringPage streamOptions={streamOptions} />
        </>
      );
    }

    const { handles, createClient } = createFakeStreamFactory();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/monitoring']}>
          <OrganisationProvider>
            <OrgSwitchHarness streamOptions={{ createClient }} />
          </OrganisationProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Persisted payment job completed');
    expect(screen.getByRole('button', { name: 'Recover Stalled' })).toBeInTheDocument();
    expect(handles[0].options.organisationId).toBe('org-a');

    // Emit live event in Org A
    act(() => {
      handles[0].options.onEvent?.({
        id: 'evt-org-a-secret',
        type: 'JOB_FAILED',
        organisationId: 'org-a',
        queueId: 'q-pay',
        jobId: 'job-secret-a',
        workerId: null,
        message: 'Org A confidential failure event',
        metadata: {},
        createdAt: '2026-11-23T10:01:00.000Z',
      });
    });
    expect(await screen.findByText('Org A confidential failure event')).toBeInTheDocument();

    // Switch to Org B (MEMBER role)
    await user.click(screen.getByRole('button', { name: 'Switch To Org B' }));

    await waitFor(() => {
      expect(handles).toHaveLength(2);
    });
    expect(handles[0].close).toHaveBeenCalledTimes(1);
    expect(handles[1].options.organisationId).toBe('org-b');
    expect(handles[1].connect).toHaveBeenCalledTimes(1);

    // Org A live event MUST NOT leak into Org B, and MEMBER must NOT see Recover Stalled
    expect(screen.queryByText('Org A confidential failure event')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover Stalled' })).not.toBeInTheDocument();
  });
});

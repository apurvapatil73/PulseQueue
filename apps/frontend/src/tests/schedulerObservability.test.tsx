import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SchedulerObservabilitySection } from '../components/monitoring/SchedulerObservabilitySection';
import type { OrganisationSchedulerMetricsView } from '../types/api';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const SAMPLE_METRICS: OrganisationSchedulerMetricsView = {
  organisationId: 'org-1',
  windowMinutes: 60,
  generatedAt: '2026-11-24T00:00:00.000Z',
  policyDistribution: [
    { policy: 'LEGACY_BULLMQ', queueCount: 1, eligibleQueuedJobs: 0, delayedJobs: 0 },
    { policy: 'FIFO', queueCount: 1, eligibleQueuedJobs: 4, delayedJobs: 1 },
    { policy: 'STRICT_PRIORITY', queueCount: 0, eligibleQueuedJobs: 0, delayedJobs: 0 },
    { policy: 'PRIORITY_AGING', queueCount: 2, eligibleQueuedJobs: 12, delayedJobs: 3 },
  ],
  backlog: {
    eligibleQueued: 16,
    dispatching: 2,
    dispatchedPending: 1,
    delayed: 4,
    paused: 0,
    oldestEligibleAgeMs: 4200,
    maxWaitingMs: 4200,
    starvedEligibleCount: 1,
    staleReservationsActive: 0,
  },
  backlogByPriority: {
    byTier: { critical: 5, high: 4, medium: 4, low: 3 },
    byPriority: [
      { priority: 20, count: 5 },
      { priority: 2, count: 3 },
    ],
  },
  waitTimeByPriorityTier: [
    { tier: 'critical', sampleCount: 10, avgMs: 25, p50Ms: 20, p95Ms: 45, p99Ms: 55, maxMs: 60 },
    { tier: 'high', sampleCount: 8, avgMs: 60, p50Ms: 55, p95Ms: 90, p99Ms: 110, maxMs: 120 },
    { tier: 'medium', sampleCount: 6, avgMs: 120, p50Ms: 110, p95Ms: 180, p99Ms: 200, maxMs: 220 },
    { tier: 'low', sampleCount: 5, avgMs: 450, p50Ms: 420, p95Ms: 800, p99Ms: 900, maxMs: 950 },
  ],
  dispatchLatency: { sampleCount: 29, avgMs: 18, p50Ms: 14, p95Ms: 42, p99Ms: 58 },
  tenantCapacity: {
    maxActiveJobs: 10,
    activeJobs: 5,
    dispatchedPendingJobs: 1,
    dispatchingJobs: 2,
    reservedTotal: 8,
    availableCapacity: 2,
    utilizationPercent: 80,
  },
  workerCapacity: {
    onlineWorkers: 2,
    configuredConcurrency: 10,
    activeJobs: 5,
    availableWorkerCapacity: 5,
    workerUtilizationPercent: 50,
    jobsPerSecond: 14.5,
    avgExecutionDurationMs: 32,
  },
  schedulerHealth: {
    status: 'degraded',
    isLoopRunning: true,
    lastTickDurationMs: 12,
    staleReservationsActive: 0,
    processCounters: {
      claimsTotal: 100,
      dispatchesTotal: 98,
      dispatchFailuresTotal: 2,
      dispatchRetriesTotal: 4,
      starvationPromotionsTotal: 3,
      priorityInversionsTotal: 0,
      reservationRecoveriesTotal: 1,
      tenantCapacityDenialsTotal: 5,
    },
  },
};

describe('Phase 8.3.3 — SchedulerObservabilitySection UI states', () => {
  it('renders loading skeleton state cleanly', () => {
    renderWithQuery(
      <SchedulerObservabilitySection
        organisationId="org-1"
        windowMinutes={60}
        overrideState={{ isLoading: true }}
      />,
    );
    expect(screen.getByText(/Loading scheduler telemetry/i)).toBeInTheDocument();
  });

  it('renders actionable error state cleanly', () => {
    renderWithQuery(
      <SchedulerObservabilitySection
        organisationId="org-1"
        windowMinutes={60}
        overrideState={{ isError: true, errorMessage: 'Scheduler API timeout' }}
      />,
    );
    expect(screen.getByText(/Scheduler telemetry unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Scheduler API timeout/i)).toBeInTheDocument();
  });

  it('renders empty states when organisation has no queues or pending backlog', () => {
    const emptyData: OrganisationSchedulerMetricsView = {
      ...SAMPLE_METRICS,
      policyDistribution: SAMPLE_METRICS.policyDistribution.map((p) => ({
        ...p,
        queueCount: 0,
        eligibleQueuedJobs: 0,
        delayedJobs: 0,
      })),
      backlogByPriority: {
        byTier: { critical: 0, high: 0, medium: 0, low: 0 },
        byPriority: [],
      },
      schedulerHealth: { ...SAMPLE_METRICS.schedulerHealth, status: 'idle' },
    };
    renderWithQuery(
      <SchedulerObservabilitySection
        organisationId="org-1"
        windowMinutes={60}
        overrideState={{ data: emptyData }}
      />,
    );
    expect(screen.getByText(/No queues configured/i)).toBeInTheDocument();
    expect(screen.getByText(/No pending backlog/i)).toBeInTheDocument();
  });

  it('renders populated scheduler policy distribution, latency, starvation, and tenant capacity', () => {
    renderWithQuery(
      <SchedulerObservabilitySection
        organisationId="org-1"
        windowMinutes={60}
        overrideState={{ data: SAMPLE_METRICS }}
      />,
    );
    expect(screen.getByText(/Priority Scheduler & Capacity/i)).toBeInTheDocument();
    expect(screen.getByText(/Scheduler: degraded/i)).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/Priority Aging/i)).toBeInTheDocument();
    expect(screen.getByText(/14.5 jobs\/s/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Scheduler auto-refresh interval/i)).toBeInTheDocument();
  });
});

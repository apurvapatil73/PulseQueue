import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertOctagon,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  Cpu,
  Layers,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { monitoringApi } from '../../api/monitoring.api';
import { scheduleApi } from '../../api/schedule.api';
import { useOrganisation } from '../../contexts/OrganisationContext';
import type { HealthReport, PlatformEventView, QueueMetricsItem } from '../../types/api';
import { JobStatusChart } from '../../components/charts/JobStatusChart';
import { QueueLoadChart } from '../../components/charts/QueueLoadChart';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

interface ShellOutletContext {
  openCreateOrgModal: () => void;
  health?: HealthReport;
}

const WINDOW_OPTIONS = [
  { label: 'Last 15 minutes', value: '15' },
  { label: 'Last 60 minutes', value: '60' },
  { label: 'Last 24 hours', value: '1440' },
];

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function DashboardOverviewPage() {
  const outlet = useOutletContext<ShellOutletContext | undefined>();
  const {
    activeOrganisation,
    activeOrganisationId,
    isLoading: orgsLoading,
    error: orgsError,
    refetch: refetchOrgs,
  } = useOrganisation();

  const [windowMinutes, setWindowMinutes] = useState(60);

  const metricsQuery = useQuery({
    queryKey: ['org-metrics', activeOrganisationId, windowMinutes],
    queryFn: () => monitoringApi.getMetrics(activeOrganisationId!, windowMinutes),
    enabled: Boolean(activeOrganisationId),
    refetchInterval: 30_000,
  });

  const eventsQuery = useQuery({
    queryKey: ['org-events', activeOrganisationId],
    queryFn: () => monitoringApi.listEvents(activeOrganisationId!, { page: 1, limit: 8 }),
    enabled: Boolean(activeOrganisationId),
    refetchInterval: 30_000,
  });

  const schedulesQuery = useQuery({
    queryKey: ['org-schedules-summary', activeOrganisationId],
    queryFn: () => scheduleApi.list(activeOrganisationId!, { page: 1, limit: 5 }),
    enabled: Boolean(activeOrganisationId),
    refetchInterval: 30_000,
  });

  const handleRefreshAll = () => {
    void metricsQuery.refetch();
    void eventsQuery.refetch();
    void schedulesQuery.refetch();
  };

  if (orgsError) {
    return (
      <PageContainer title="Dashboard Overview">
        <ErrorState
          title="Unable to load organisations"
          message={orgsError.message}
          onRetry={() => void refetchOrgs()}
        />
      </PageContainer>
    );
  }

  if (!orgsLoading && !activeOrganisation) {
    return (
      <PageContainer
        title="Welcome to PulseQueue"
        description="Create your first organisation to start managing queues, jobs, and schedules."
      >
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="No organisation workspace yet"
          description="PulseQueue isolates all queues, workers, schedules, and audit metrics per organisation. Create a workspace to get started."
          action={
            <Button
              size="md"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => outlet?.openCreateOrgModal()}
            >
              Create Organisation
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const metrics = metricsQuery.data;
  const summary = metrics?.summary;
  const workers = metrics?.workers ?? [];
  const onlineWorkers = workers.filter((w) => w.status === 'ONLINE').length;
  const inFlightAndQueued = summary ? summary.active + summary.pending + summary.delayed : 0;
  const activeSchedulesCount = (schedulesQuery.data?.schedules ?? []).filter(
    (s) => s.status === 'ACTIVE',
  ).length;
  const totalSchedulesCount = schedulesQuery.data?.pagination.total ?? 0;

  const isLoadingOverview = orgsLoading || metricsQuery.isLoading;

  const queueColumns: DataTableColumn<QueueMetricsItem>[] = [
    {
      key: 'name',
      header: 'Queue',
      render: (q) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-slate-100">{q.name}</span>
          <StatusBadge status={q.isPaused ? 'PAUSED' : 'ACTIVE'} />
        </div>
      ),
    },
    {
      key: 'concurrency',
      header: 'Concurrency',
      align: 'right',
      render: (q) => <span className="font-mono text-xs tabular-nums">{q.concurrency}</span>,
    },
    {
      key: 'queued',
      header: 'Queued / Active',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {q.byStatus.PENDING + q.byStatus.DELAYED} / {q.byStatus.ACTIVE}
        </span>
      ),
    },
    {
      key: 'completed',
      header: 'Completed',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums text-emerald-300">
          {q.byStatus.COMPLETED}
        </span>
      ),
    },
    {
      key: 'failed',
      header: 'Failed / DLQ',
      align: 'right',
      render: (q) => (
        <span
          className={`font-mono text-xs tabular-nums ${
            q.byStatus.FAILED > 0 || q.openDeadLetters > 0 ? 'text-rose-300' : 'text-slate-400'
          }`}
        >
          {q.byStatus.FAILED} / {q.openDeadLetters}
        </span>
      ),
    },
    {
      key: 'latency',
      header: 'Avg Latency',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {formatDuration(q.averageDurationMs)}
        </span>
      ),
    },
  ];

  const eventColumns: DataTableColumn<PlatformEventView>[] = [
    {
      key: 'type',
      header: 'Event',
      render: (e) => <StatusBadge status={e.type} />,
    },
    {
      key: 'message',
      header: 'Details',
      render: (e) => <span className="text-xs text-slate-200">{e.message}</span>,
    },
    {
      key: 'time',
      header: 'Time',
      align: 'right',
      render: (e) => (
        <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
          {formatRelativeTime(e.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer
      title="Overview"
      description={
        activeOrganisation
          ? `Real-time operational telemetry for ${activeOrganisation.name}`
          : 'Loading organisation overview…'
      }
      actions={
        <>
          <div className="w-40">
            <Select
              aria-label="Throughput window"
              value={String(windowMinutes)}
              onChange={(e) => setWindowMinutes(Number(e.target.value))}
              options={WINDOW_OPTIONS}
            />
          </div>
          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${metricsQuery.isFetching ? 'animate-spin' : ''}`}
              />
            }
            onClick={handleRefreshAll}
          >
            Refresh
          </Button>
        </>
      }
    >
      {metricsQuery.error && (
        <div className="mb-6">
          <ErrorState
            title="Failed to load organisation metrics"
            message={
              metricsQuery.error instanceof Error
                ? metricsQuery.error.message
                : 'Unexpected metrics error'
            }
            onRetry={() => void metricsQuery.refetch()}
          />
        </div>
      )}

      {/* KPI Metrics Row */}
      <section
        aria-label="Key platform metrics"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
      >
        <MetricCard
          label="Total Processed"
          value={summary ? summary.totalProcessed.toLocaleString() : '—'}
          subtext={
            metrics
              ? `${metrics.throughput.jobsPerMinute} jobs/min (${metrics.throughput.windowMinutes}m window)`
              : undefined
          }
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
          isLoading={isLoadingOverview}
        />

        <MetricCard
          label="Queued & Active"
          value={summary ? inFlightAndQueued.toLocaleString() : '—'}
          subtext={
            summary
              ? `${summary.active} active · ${summary.pending} pending · ${summary.delayed} delayed`
              : undefined
          }
          icon={<Layers className="h-4 w-4" />}
          tone="default"
          isLoading={isLoadingOverview}
        />

        <MetricCard
          label="Worker Fleet"
          value={metrics ? `${onlineWorkers} / ${workers.length}` : '—'}
          subtext={
            workers.length === 0
              ? 'No active workers registered'
              : `${onlineWorkers} online across ${metrics?.queues.length ?? 0} queues`
          }
          icon={<Cpu className="h-4 w-4" />}
          tone={workers.length > 0 && onlineWorkers === 0 ? 'warning' : 'default'}
          isLoading={isLoadingOverview}
        />

        <MetricCard
          label="Open Dead Letters"
          value={summary ? summary.deadLetterOpen.toLocaleString() : '—'}
          subtext={
            summary
              ? `Avg duration ${formatDuration(summary.averageDurationMs)} · ${summary.retriedJobs} retried`
              : undefined
          }
          icon={<AlertOctagon className="h-4 w-4" />}
          tone={summary && summary.deadLetterOpen > 0 ? 'danger' : 'default'}
          isLoading={isLoadingOverview}
        />

        <MetricCard
          label="Schedules"
          value={schedulesQuery.data ? totalSchedulesCount.toLocaleString() : '—'}
          subtext={
            schedulesQuery.data ? `${activeSchedulesCount} active in latest view` : undefined
          }
          icon={<CalendarClock className="h-4 w-4" />}
          tone="default"
          isLoading={orgsLoading || schedulesQuery.isLoading}
        />
      </section>

      {/* Charts Row */}
      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Job Status Distribution"
            description="Persisted PostgreSQL job counts across all organisation queues"
          />
          <CardContent>
            <JobStatusChart summary={summary} isLoading={isLoadingOverview} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Queue Load Breakdown"
            description="Per-queue completion, in-flight, queued, and failed volumes"
          />
          <CardContent>
            <QueueLoadChart queues={metrics?.queues} isLoading={isLoadingOverview} />
          </CardContent>
        </Card>
      </section>

      {/* Queues & Workers Row */}
      <section className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Organisation Queues"
            description="Live status, concurrency, latency, and dead-letter counts"
          />
          <DataTable
            columns={queueColumns}
            data={metrics?.queues ?? []}
            rowKey={(q) => q.queueId}
            isLoading={isLoadingOverview}
            skeletonRows={4}
            emptyState={
              <EmptyState
                icon={<Layers className="h-5 w-5" />}
                title="No queues in this organisation"
                description="Once queues are created via API or the Queues module, live metrics will appear here."
              />
            }
          />
        </Card>

        <Card>
          <CardHeader
            title="Worker Heartbeats"
            description="Registered worker processes serving this organisation"
          />
          <CardContent>
            {isLoadingOverview ? (
              <div className="space-y-3">
                <div className="h-14 animate-pulse rounded-lg bg-slate-800/70" />
                <div className="h-14 animate-pulse rounded-lg bg-slate-800/70" />
              </div>
            ) : workers.length === 0 ? (
              <EmptyState
                icon={<Activity className="h-5 w-5" />}
                title="No workers connected"
                description="Start the PulseQueue worker runtime to process jobs and publish heartbeats."
              />
            ) : (
              <ul className="space-y-2.5">
                {workers.slice(0, 6).map((w) => (
                  <li
                    key={w.workerInstanceId}
                    className="rounded-lg border border-border-subtle bg-canvas/60 px-3.5 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs font-medium text-slate-100">
                        {w.workerInstanceId}
                      </span>
                      <StatusBadge status={w.status} showDot />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                      <span>
                        {w.jobsSucceeded} ok · {w.jobsFailed} failed
                      </span>
                      <span>{Math.round(w.heartbeatAgeMs / 1000)}s ago</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Recent Audit Events */}
      <section className="mt-6">
        <Card>
          <CardHeader
            title="Recent Platform Activity"
            description="Latest persisted job, worker, and reliability events"
            action={
              metrics?.generatedAt ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                  <Clock className="h-3 w-3" />
                  Synced {formatRelativeTime(metrics.generatedAt)}
                </span>
              ) : null
            }
          />
          {eventsQuery.error ? (
            <div className="p-5">
              <ErrorState
                compact
                message={
                  eventsQuery.error instanceof Error
                    ? eventsQuery.error.message
                    : 'Failed to load activity events'
                }
                onRetry={() => void eventsQuery.refetch()}
              />
            </div>
          ) : (
            <DataTable
              columns={eventColumns}
              data={eventsQuery.data?.events ?? []}
              rowKey={(e) => e.id}
              isLoading={orgsLoading || eventsQuery.isLoading}
              skeletonRows={4}
              emptyState={
                <EmptyState
                  icon={<Activity className="h-5 w-5" />}
                  title="No platform events yet"
                  description="Job submissions, completions, retries, and worker lifecycle events will appear here."
                />
              }
            />
          )}
        </Card>
      </section>
    </PageContainer>
  );
}

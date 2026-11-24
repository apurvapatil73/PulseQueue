import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  Clock,
  Cpu,
  Layers,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TrendingUp,
  WifiOff,
} from 'lucide-react';
import { useOrganisation } from '../../contexts/OrganisationContext';
import {
  useMonitoringStream,
  useOrganisationEvents,
  useOrganisationMetrics,
  useOrganisationTimeseries,
  useOrganisationWorkers,
  useRecoverStalled,
  type UseMonitoringStreamOptions,
} from '../../hooks/useMonitoring';
import type {
  OrgSafeWorkerView,
  PlatformEventType,
  PlatformEventView,
  QueueMetricsItem,
  StalledRecoverySummary,
} from '../../types/api';
import { LatencyPercentilesChart } from '../../components/charts/LatencyPercentilesChart';
import { ThroughputChart } from '../../components/charts/ThroughputChart';
import { SchedulerObservabilitySection } from '../../components/monitoring/SchedulerObservabilitySection';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

export interface MonitoringPageProps {
  /** Optional stream hook overrides (used by tests to inject a deterministic SSE client). */
  streamOptions?: UseMonitoringStreamOptions;
}

const WINDOW_OPTIONS = [
  { label: 'Last 15 minutes', value: '15' },
  { label: 'Last 60 minutes', value: '60' },
  { label: 'Last 6 hours', value: '360' },
  { label: 'Last 24 hours', value: '1440' },
  { label: 'Last 7 days', value: '10080' },
];

const ALL_BUCKET_OPTIONS = [
  { label: 'Auto bucket', value: 'auto', minutes: null },
  { label: '1m buckets', value: '1', minutes: 1 },
  { label: '5m buckets', value: '5', minutes: 5 },
  { label: '15m buckets', value: '15', minutes: 15 },
  { label: '60m buckets', value: '60', minutes: 60 },
] as const;

const EVENT_TYPE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'All event types', value: '' },
  { label: 'Job Submitted', value: 'JOB_SUBMITTED' },
  { label: 'Job Started', value: 'JOB_STARTED' },
  { label: 'Job Completed', value: 'JOB_COMPLETED' },
  { label: 'Job Failed', value: 'JOB_FAILED' },
  { label: 'Job Retried', value: 'JOB_RETRIED' },
  { label: 'Job Stalled', value: 'JOB_STALLED' },
  { label: 'Job Recovered', value: 'JOB_RECOVERED' },
  { label: 'Moved to DLQ', value: 'JOB_MOVED_TO_DLQ' },
  { label: 'Job Replayed', value: 'JOB_REPLAYED' },
  { label: 'Worker Started', value: 'WORKER_STARTED' },
  { label: 'Worker Stopped', value: 'WORKER_STOPPED' },
  { label: 'Worker Stale', value: 'WORKER_HEARTBEAT_STALE' },
];

const MAX_DISPLAY_ACTIVITY_EVENTS = 100;

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatRatePercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatHeartbeatAge(ageMs: number): string {
  if (ageMs < 1000) return '<1s ago';
  const sec = Math.round(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

function formatUtcTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatResyncReason(reason: string): string {
  switch (reason) {
    case 'redis_reconnected':
      return 'Real-time pub/sub reconnected after a brief outage. Metrics and activity have been refreshed.';
    case 'cursor_expired':
      return 'Your previous event cursor exceeded the 30-day retention window. Showing the latest snapshot.';
    case 'replay_limit_exceeded':
      return 'More events occurred while disconnected than could be replayed inline. Snapshots have been refreshed.';
    case 'backpressure_dropped':
      return 'Some high-frequency stream frames were skipped to protect browser responsiveness. Snapshots refreshed.';
    default:
      return `Stream resynchronized (${reason}). Latest organisation snapshots loaded.`;
  }
}

export function MonitoringPage({ streamOptions }: MonitoringPageProps) {
  const {
    activeOrganisation,
    activeOrganisationId,
    isLoading: orgsLoading,
    error: orgsError,
    refetch: refetchOrgs,
  } = useOrganisation();

  const [windowMinutes, setWindowMinutes] = useState(60);
  const [bucketSelection, setBucketSelection] = useState<string>('auto');
  const [selectedQueueId, setSelectedQueueId] = useState<string>('');
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('');
  const [eventsPage, setEventsPage] = useState(1);
  const [confirmRecoverOpen, setConfirmRecoverOpen] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState<StalledRecoverySummary | null>(null);

  const canRecoverStalled =
    activeOrganisation?.role === 'OWNER' || activeOrganisation?.role === 'ADMIN';

  // Filter bucket options to combinations allowed by the backend validator (bucket <= window, <= 360 buckets)
  const validBucketOptions = useMemo(
    () =>
      ALL_BUCKET_OPTIONS.filter(
        (opt) =>
          opt.minutes === null ||
          (opt.minutes <= windowMinutes && Math.ceil(windowMinutes / opt.minutes) <= 360),
      ).map((opt) => ({ label: opt.label, value: opt.value })),
    [windowMinutes],
  );

  const resolvedBucketMinutes = useMemo(() => {
    if (bucketSelection === 'auto') return undefined;
    const numeric = Number(bucketSelection);
    if (
      !Number.isFinite(numeric) ||
      numeric > windowMinutes ||
      Math.ceil(windowMinutes / numeric) > 360
    ) {
      return undefined;
    }
    return numeric;
  }, [bucketSelection, windowMinutes]);

  const {
    streamState,
    isLive,
    fallbackRefetchInterval,
    liveEvents,
    lastEventAt,
    lastHeartbeatAt,
    resyncNotice,
    streamError,
    clearResyncNotice,
    reconnect,
  } = useMonitoringStream(activeOrganisationId, streamOptions);

  const metricsQuery = useOrganisationMetrics(activeOrganisationId, windowMinutes, {
    refetchInterval: fallbackRefetchInterval,
  });

  const timeseriesQuery = useOrganisationTimeseries(
    activeOrganisationId,
    {
      windowMinutes,
      bucketMinutes: resolvedBucketMinutes,
      queueId: selectedQueueId || undefined,
    },
    { refetchInterval: fallbackRefetchInterval },
  );

  const workersQuery = useOrganisationWorkers(activeOrganisationId, {
    refetchInterval: fallbackRefetchInterval,
  });

  const eventsQuery = useOrganisationEvents(
    activeOrganisationId,
    {
      page: eventsPage,
      limit: 25,
      type: eventTypeFilter || undefined,
      queueId: selectedQueueId || undefined,
    },
    { refetchInterval: fallbackRefetchInterval },
  );

  const recoverMutation = useRecoverStalled(activeOrganisationId);

  const handleWindowChange = (nextWindow: number) => {
    setWindowMinutes(nextWindow);
    if (bucketSelection !== 'auto') {
      const b = Number(bucketSelection);
      if (b > nextWindow || Math.ceil(nextWindow / b) > 360) {
        setBucketSelection('auto');
      }
    }
  };

  const handleRefreshAll = () => {
    void metricsQuery.refetch();
    void timeseriesQuery.refetch();
    void workersQuery.refetch();
    void eventsQuery.refetch();
  };

  const handleConfirmRecover = async () => {
    setRecoveryResult(null);
    try {
      const summary = await recoverMutation.mutateAsync({});
      setRecoveryResult(summary);
      setConfirmRecoverOpen(false);
    } catch {
      // Error surfaced via recoverMutation.error
    }
  };

  // Merge live SSE events (page 1 only) with persisted API events, strictly deduplicated by event.id
  const mergedEvents = useMemo<PlatformEventView[]>(() => {
    const persisted = eventsQuery.data?.events ?? [];
    if (eventsPage > 1) {
      return persisted;
    }

    const filteredLive = liveEvents.filter((evt) => {
      if (evt.organisationId !== activeOrganisationId) return false;
      if (eventTypeFilter && evt.type !== (eventTypeFilter as PlatformEventType)) return false;
      if (selectedQueueId && evt.queueId !== selectedQueueId) return false;
      return true;
    });

    const seen = new Set<string>();
    const combined: PlatformEventView[] = [];
    for (const evt of [...filteredLive, ...persisted]) {
      if (seen.has(evt.id)) continue;
      seen.add(evt.id);
      combined.push(evt);
    }

    combined.sort((a, b) => {
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return diff !== 0 ? diff : b.id.localeCompare(a.id);
    });

    return combined.slice(0, MAX_DISPLAY_ACTIVITY_EVENTS);
  }, [
    activeOrganisationId,
    eventTypeFilter,
    eventsPage,
    eventsQuery.data?.events,
    liveEvents,
    selectedQueueId,
  ]);

  if (orgsError) {
    return (
      <PageContainer title="Workers & Monitoring">
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
        title="Workers & Monitoring"
        description="Select or create an organisation to inspect real-time metrics, workers, and live platform events."
      >
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="No active organisation selected"
          description="Choose an organisation from the workspace switcher to view its monitoring dashboard."
        />
      </PageContainer>
    );
  }

  const metrics = metricsQuery.data;
  const summary = metrics?.summary;
  const workers = workersQuery.data ?? metrics?.workers ?? [];
  const queues = metrics?.queues ?? [];

  const queueFilterOptions = [
    { label: 'All queues', value: '' },
    ...queues.map((q) => ({ label: q.name, value: q.queueId })),
  ];

  const queueDepth =
    summary?.queueDepth ?? (summary ? summary.pending + summary.delayed + summary.paused : 0);
  const onlineWorkers =
    metrics?.workerSummary?.online ?? workers.filter((w) => w.status === 'ONLINE').length;
  const degradedWorkers =
    metrics?.workerSummary?.degraded ?? workers.filter((w) => w.status === 'DEGRADED').length;
  const staleWorkers =
    metrics?.workerSummary?.stale ?? workers.filter((w) => w.status === 'STALE').length;
  const totalWorkers = metrics?.workerSummary?.total ?? workers.length;
  const activeWorkerJobs =
    metrics?.workerSummary?.activeJobs ?? workers.reduce((acc, w) => acc + (w.activeJobs ?? 0), 0);

  const isLoadingMetrics = orgsLoading || metricsQuery.isLoading;
  const isFetchingAny =
    metricsQuery.isFetching ||
    timeseriesQuery.isFetching ||
    workersQuery.isFetching ||
    eventsQuery.isFetching;

  const streamBadge = (() => {
    if (isLive) {
      return <StatusBadge status="CONNECTED" label="Live · SSE" tone="emerald" showDot />;
    }
    if (streamState === 'connecting' || streamState === 'reconnecting') {
      return (
        <StatusBadge
          status="RECONNECTING"
          label={streamState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          tone="amber"
          showDot
        />
      );
    }
    return <StatusBadge status="DISCONNECTED" label="Polling Fallback" tone="rose" showDot />;
  })();

  const queueColumns: DataTableColumn<QueueMetricsItem>[] = [
    {
      key: 'name',
      header: 'Queue',
      render: (q) => (
        <div className="flex items-center gap-2">
          <Link
            to={`/queues/${q.queueId}`}
            className="font-mono text-xs font-medium text-sky-300 hover:text-sky-200 hover:underline"
          >
            {q.name}
          </Link>
          <StatusBadge status={q.isPaused ? 'PAUSED' : 'ACTIVE'} />
        </div>
      ),
    },
    {
      key: 'depth',
      header: 'Depth (Wait / Delay / Pause)',
      align: 'right',
      render: (q) => {
        const depth = q.queueDepth ?? q.byStatus.PENDING + q.byStatus.DELAYED + q.byStatus.PAUSED;
        return (
          <span className="font-mono text-xs tabular-nums text-slate-200">
            {depth}{' '}
            <span className="text-slate-500">
              ({q.byStatus.PENDING}/{q.byStatus.DELAYED}/{q.byStatus.PAUSED})
            </span>
          </span>
        );
      },
    },
    {
      key: 'active',
      header: 'Active',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums text-sky-300">{q.byStatus.ACTIVE}</span>
      ),
    },
    {
      key: 'outcomes',
      header: 'Completed / Failed',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums">
          <span className="text-emerald-300">{q.byStatus.COMPLETED}</span>
          <span className="text-slate-500"> / </span>
          <span className={q.byStatus.FAILED > 0 ? 'text-rose-300' : 'text-slate-400'}>
            {q.byStatus.FAILED}
          </span>
          {q.failureRate !== null && q.failureRate !== undefined && (
            <span className="ml-1.5 text-[11px] text-slate-500">
              ({formatRatePercent(q.failureRate)} fail)
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'throughput',
      header: 'Rate (Window)',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {q.jobsPerMinute !== undefined ? `${q.jobsPerMinute}/m` : '—'}
        </span>
      ),
    },
    {
      key: 'latency',
      header: 'Exec (Avg / p50 / p95 / p99)',
      align: 'right',
      render: (q) => (
        <span
          className="font-mono text-xs tabular-nums text-slate-300"
          title="Execution duration: processing start to completion/failure (percentiles require >= 5 samples)"
        >
          {formatDuration(q.averageDurationMs)} / {formatDuration(q.p50DurationMs)} /{' '}
          {formatDuration(q.p95DurationMs)} / {formatDuration(q.p99DurationMs)}
        </span>
      ),
    },
    {
      key: 'queueWait',
      header: 'Queue Wait (Avg / p95)',
      align: 'right',
      render: (q) => (
        <span
          className="font-mono text-xs tabular-nums text-slate-300"
          title="Queue wait time: submission to first processing start (excluding configured delay)"
        >
          {formatDuration(q.avgQueueWaitMs)} / {formatDuration(q.p95QueueWaitMs)}
        </span>
      ),
    },
    {
      key: 'dlq',
      header: 'Retries / DLQ',
      align: 'right',
      render: (q) => (
        <span
          className="font-mono text-xs tabular-nums"
          title="Retried jobs (attempts > 1) and retry rate vs open Dead Letter Queue records"
        >
          <span className="text-amber-300">{q.retriedJobs ?? 0}</span>
          {q.retryRate !== null && q.retryRate !== undefined && (
            <span className="ml-1 text-[11px] text-slate-500">
              ({formatRatePercent(q.retryRate)})
            </span>
          )}
          <span className="text-slate-500"> / </span>
          {q.openDeadLetters > 0 ? (
            <Link
              to={`/dlq?queueId=${q.queueId}`}
              className="text-rose-300 hover:text-rose-200 hover:underline"
            >
              {q.openDeadLetters}
            </Link>
          ) : (
            <span className="text-slate-400">0</span>
          )}
        </span>
      ),
    },
  ];

  const workerColumns: DataTableColumn<OrgSafeWorkerView>[] = [
    {
      key: 'worker',
      header: 'Worker Instance',
      render: (w) => (
        <div>
          <div className="font-mono text-xs font-medium text-slate-100">{w.workerInstanceId}</div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-500">
            {w.hostname} · PID {w.pid}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Health',
      render: (w) => <StatusBadge status={w.status} showDot />,
    },
    {
      key: 'queues',
      header: 'Org Queues',
      render: (w) =>
        w.registeredQueues.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {w.registeredQueues.map((qName) => (
              <span
                key={qName}
                className="rounded border border-border-subtle bg-canvas/80 px-1.5 py-0.5 font-mono text-[11px] text-slate-300"
              >
                {qName}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-500">None</span>
        ),
    },
    {
      key: 'active',
      header: 'Active / Concurrency',
      align: 'right',
      render: (w) => (
        <span
          className="font-mono text-xs tabular-nums text-sky-300"
          title="Currently active jobs for this organisation / configured concurrency across this organisation's queues"
        >
          {w.activeJobs !== undefined ? w.activeJobs : '—'}
          <span className="text-slate-500"> / </span>
          <span className="text-slate-300">
            {w.orgConfiguredConcurrency !== undefined ? w.orgConfiguredConcurrency : '—'}
          </span>
        </span>
      ),
    },
    {
      key: 'resources',
      header: 'CPU / RSS / Uptime',
      align: 'right',
      render: (w) => (
        <div
          className="text-right font-mono text-xs tabular-nums"
          title="Process-level worker CPU %, Resident Set Size (MB), and uptime (shows — when unavailable)"
        >
          <span className="text-slate-200">
            {w.cpuUsagePercent !== null && w.cpuUsagePercent !== undefined
              ? `${w.cpuUsagePercent.toFixed(1)}%`
              : '—'}
          </span>
          <span className="text-slate-500"> · </span>
          <span className="text-slate-300">
            {w.memoryRssMb !== null && w.memoryRssMb !== undefined
              ? `${w.memoryRssMb.toFixed(1)} MB`
              : '—'}
          </span>
          <div className="text-[11px] text-slate-500">{formatUptime(w.uptimeSeconds)}</div>
        </div>
      ),
    },
    {
      key: 'counts',
      header: 'Org Succeeded / Failed',
      align: 'right',
      render: (w) => (
        <span className="font-mono text-xs tabular-nums">
          <span className="text-emerald-300">{w.jobsSucceeded}</span>
          <span className="text-slate-500"> / </span>
          <span className={w.jobsFailed > 0 ? 'text-rose-300' : 'text-slate-400'}>
            {w.jobsFailed}
          </span>
        </span>
      ),
    },
    {
      key: 'heartbeat',
      header: 'Last Heartbeat',
      align: 'right',
      render: (w) => (
        <div className="text-right font-mono text-xs">
          <div className="text-slate-200">{formatHeartbeatAge(w.heartbeatAgeMs)}</div>
          <div className="text-[11px] text-slate-500">{formatUtcTimestamp(w.lastHeartbeatAt)}</div>
        </div>
      ),
    },
    {
      key: 'error',
      header: 'Latest Org Error',
      render: (w) =>
        w.lastError ? (
          <span className="block max-w-xs truncate text-xs text-rose-300" title={w.lastError}>
            {w.lastError}
          </span>
        ) : (
          <span className="text-xs text-slate-500">—</span>
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
      header: 'Description',
      render: (e) => (
        <div>
          <div className="text-xs text-slate-200">{e.message}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-500">
            {e.jobId && (
              <Link
                to={`/jobs/${e.jobId}`}
                className="text-sky-400 hover:text-sky-300 hover:underline"
              >
                Job {e.jobId.slice(0, 8)}
              </Link>
            )}
            {e.queueId && (
              <Link
                to={`/queues/${e.queueId}`}
                className="text-indigo-300 hover:text-indigo-200 hover:underline"
              >
                Queue {e.queueId.slice(0, 8)}
              </Link>
            )}
            {e.workerId && <span>Worker {e.workerId}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Timestamp (UTC)',
      align: 'right',
      render: (e) => (
        <span className="whitespace-nowrap font-mono text-xs text-slate-400">
          {formatUtcTimestamp(e.createdAt)}
        </span>
      ),
    },
  ];

  const eventsPagination = eventsQuery.data?.pagination;

  return (
    <PageContainer
      title="Workers & Monitoring"
      description={
        activeOrganisation
          ? `Real-time operational telemetry and event stream for ${activeOrganisation.name}`
          : 'Loading organisation monitoring…'
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2" aria-live="polite">
            {streamBadge}
            {!isLive && streamState !== 'connecting' && (
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Radio className="h-3.5 w-3.5" />}
                onClick={reconnect}
              >
                Reconnect
              </Button>
            )}
          </div>

          <div className="w-36">
            <Select
              aria-label="Time window"
              value={String(windowMinutes)}
              onChange={(e) => handleWindowChange(Number(e.target.value))}
              options={WINDOW_OPTIONS}
            />
          </div>

          <div className="w-32">
            <Select
              aria-label="Bucket size"
              value={bucketSelection}
              onChange={(e) => setBucketSelection(e.target.value)}
              options={validBucketOptions}
            />
          </div>

          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw className={`h-3.5 w-3.5 ${isFetchingAny ? 'animate-spin' : ''}`} />
            }
            onClick={handleRefreshAll}
          >
            Refresh
          </Button>

          {canRecoverStalled && (
            <Button
              variant="secondary"
              size="md"
              leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => setConfirmRecoverOpen(true)}
            >
              Recover Stalled
            </Button>
          )}
        </div>
      }
    >
      {/* Stream Resync / Fallback Banners */}
      {resyncNotice && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
            <span>{formatResyncReason(resyncNotice.reason)}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={clearResyncNotice}>
            Dismiss
          </Button>
        </div>
      )}

      {streamError && !isLive && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200"
        >
          <div className="flex items-center gap-2">
            <WifiOff className="h-4 w-4 shrink-0 text-rose-400" />
            <span>
              Live stream unavailable ({streamError}). Polling automatically every 15s until
              reconnected.
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={reconnect}>
            Retry Stream
          </Button>
        </div>
      )}

      {recoveryResult && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200"
        >
          <span>
            Stalled recovery complete: scanned {recoveryResult.scanned}, recovered{' '}
            {recoveryResult.recovered}, moved to DLQ {recoveryResult.movedToDlq}, skipped{' '}
            {recoveryResult.skipped}.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setRecoveryResult(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {recoverMutation.error && (
        <div className="mb-4">
          <ErrorState
            compact
            message={
              recoverMutation.error instanceof Error
                ? recoverMutation.error.message
                : 'Failed to run stalled-job recovery'
            }
          />
        </div>
      )}

      {metricsQuery.error && (
        <div className="mb-6">
          <ErrorState
            title="Failed to load organisation monitoring metrics"
            message={
              metricsQuery.error instanceof Error
                ? metricsQuery.error.message
                : 'Unexpected metrics error'
            }
            onRetry={() => void metricsQuery.refetch()}
          />
        </div>
      )}

      {/* 1. Platform Metrics KPI Grid (Current / All-Time vs Windowed Rates) */}
      <section
        aria-label="Platform monitoring metrics"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
      >
        <MetricCard
          label="Total Jobs (All-Time)"
          value={summary ? summary.totalSubmitted.toLocaleString() : '—'}
          subtext={
            summary
              ? `${summary.active} active · ${summary.pending} pending · ${summary.delayed} delayed`
              : undefined
          }
          icon={<Layers className="h-4 w-4" />}
          isLoading={isLoadingMetrics}
        />

        <MetricCard
          label="Completed / Failed"
          value={
            summary
              ? `${summary.succeeded.toLocaleString()} / ${summary.failed.toLocaleString()}`
              : '—'
          }
          subtext={
            summary
              ? `All-time success ${formatRatePercent(summary.successRate)} · fail ${formatRatePercent(summary.failureRate)}`
              : undefined
          }
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone={summary && summary.failed > 0 ? 'warning' : 'success'}
          isLoading={isLoadingMetrics}
        />

        <MetricCard
          label={`Throughput (${windowMinutes}m)`}
          value={metrics ? `${metrics.throughput.jobsPerMinute}/min` : '—'}
          subtext={
            metrics
              ? `${metrics.throughput.completedInWindow} ok · ${metrics.throughput.failedInWindow} fail (${formatRatePercent(summary?.windowSuccessRate)})`
              : undefined
          }
          icon={<TrendingUp className="h-4 w-4" />}
          tone="default"
          isLoading={isLoadingMetrics}
        />

        <MetricCard
          label="Queue Depth (Current)"
          value={summary ? queueDepth.toLocaleString() : '—'}
          subtext={
            summary
              ? `${metrics?.reliability?.retriesInWindow ?? summary.retriedJobs} retries (${windowMinutes}m) · ${summary.stalledRecoveries} stalled`
              : undefined
          }
          icon={<Activity className="h-4 w-4" />}
          tone={queueDepth > 100 ? 'warning' : 'default'}
          isLoading={isLoadingMetrics}
        />

        <MetricCard
          label="Open DLQ (Current)"
          value={summary ? summary.deadLetterOpen.toLocaleString() : '—'}
          subtext={
            metrics?.reliability
              ? `${metrics.reliability.dlqNetGrowthInWindow >= 0 ? '+' : ''}${metrics.reliability.dlqNetGrowthInWindow} net (${windowMinutes}m) · ${metrics.reliability.scheduleMisfiresInWindow} misfires`
              : summary
                ? `${summary.deadLetterReplayed} replayed`
                : undefined
          }
          icon={<AlertOctagon className="h-4 w-4" />}
          tone={summary && summary.deadLetterOpen > 0 ? 'danger' : 'default'}
          isLoading={isLoadingMetrics}
        />

        <MetricCard
          label="Worker Fleet"
          value={metrics ? `${onlineWorkers} / ${totalWorkers}` : '—'}
          subtext={
            totalWorkers === 0
              ? 'No workers registered'
              : `${activeWorkerJobs} active · ${degradedWorkers} degraded · ${staleWorkers} stale`
          }
          icon={<Cpu className="h-4 w-4" />}
          tone={
            staleWorkers > 0 || (totalWorkers > 0 && onlineWorkers === 0) ? 'warning' : 'default'
          }
          isLoading={isLoadingMetrics}
        />
      </section>

      {/* 2. Performance Charts Row */}
      <section aria-label="Performance charts" className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Job Throughput & Outcomes Over Time"
            description={
              timeseriesQuery.data
                ? `${timeseriesQuery.data.bucketMinutes}m UTC buckets across the last ${timeseriesQuery.data.windowMinutes}m`
                : 'Chronological completed, failed, and submitted volumes'
            }
            action={
              queues.length > 0 ? (
                <div className="w-40">
                  <Select
                    aria-label="Filter charts by queue"
                    value={selectedQueueId}
                    onChange={(e) => {
                      setSelectedQueueId(e.target.value);
                      setEventsPage(1);
                    }}
                    options={queueFilterOptions}
                  />
                </div>
              ) : null
            }
          />
          <CardContent>
            {timeseriesQuery.error ? (
              <ErrorState
                compact
                message={
                  timeseriesQuery.error instanceof Error
                    ? timeseriesQuery.error.message
                    : 'Failed to load throughput time series'
                }
                onRetry={() => void timeseriesQuery.refetch()}
              />
            ) : (
              <ThroughputChart
                timeseries={timeseriesQuery.data}
                isLoading={orgsLoading || timeseriesQuery.isLoading}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Latency Percentiles & Queue Wait"
            description="Windowed execution duration (p50/p95/p99), initial queue wait, and retry overhead"
          />
          <CardContent>
            <LatencyPercentilesChart
              latency={metrics?.latency}
              timeseries={timeseriesQuery.data}
              isLoading={isLoadingMetrics || timeseriesQuery.isLoading}
            />
          </CardContent>
        </Card>
      </section>

      {/* 3. Queue Health Table */}
      <section aria-label="Queue health" className="mt-6">
        <Card>
          <CardHeader
            title="Queue Health"
            description="Organisation-scoped queue depth, active load, windowed throughput, latency, and DLQ counts"
          />
          <DataTable
            columns={queueColumns}
            data={queues}
            rowKey={(q) => q.queueId}
            isLoading={isLoadingMetrics}
            skeletonRows={4}
            emptyState={
              <EmptyState
                icon={<Layers className="h-5 w-5" />}
                title="No queues configured"
                description="Create a queue to monitor queue depth, throughput, latency, and dead letters."
              />
            }
          />
        </Card>
      </section>

      {/* 4. Worker Health Fleet Table */}
      <section aria-label="Worker health" className="mt-6">
        <Card>
          <CardHeader
            title="Worker Fleet Health"
            description="Heartbeat freshness, registered organisation queues, and organisation-scoped processing counts"
          />
          {workersQuery.error ? (
            <div className="p-5">
              <ErrorState
                compact
                message={
                  workersQuery.error instanceof Error
                    ? workersQuery.error.message
                    : 'Failed to load worker fleet'
                }
                onRetry={() => void workersQuery.refetch()}
              />
            </div>
          ) : (
            <DataTable
              columns={workerColumns}
              data={workers}
              rowKey={(w) => w.workerInstanceId}
              isLoading={orgsLoading || (workersQuery.isLoading && workers.length === 0)}
              skeletonRows={3}
              emptyState={
                <EmptyState
                  icon={<Cpu className="h-5 w-5" />}
                  title="No workers registered for this organisation"
                  description="Start a PulseQueue worker runtime serving this organisation's queues to view live heartbeats."
                />
              }
            />
          )}
        </Card>
      </section>

      {/* 5. Real-Time Activity Feed */}
      <section aria-label="Real-time activity feed" className="mt-6">
        <Card>
          <CardHeader
            title="Real-Time Activity Feed"
            description="Live SSE stream merged with persisted job, DLQ, recovery, and worker lifecycle events"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-44">
                  <Select
                    aria-label="Filter events by type"
                    value={eventTypeFilter}
                    onChange={(e) => {
                      setEventTypeFilter(e.target.value);
                      setEventsPage(1);
                    }}
                    options={EVENT_TYPE_OPTIONS}
                  />
                </div>
                {(lastEventAt || lastHeartbeatAt || metrics?.generatedAt) && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                    <Clock className="h-3 w-3" />
                    {lastEventAt
                      ? `Last event ${formatUtcTimestamp(lastEventAt)}`
                      : lastHeartbeatAt
                        ? `Heartbeat ${formatUtcTimestamp(lastHeartbeatAt)}`
                        : `Synced ${formatUtcTimestamp(metrics!.generatedAt)}`}
                  </span>
                )}
              </div>
            }
          />
          {eventsQuery.error ? (
            <div className="p-5">
              <ErrorState
                compact
                message={
                  eventsQuery.error instanceof Error
                    ? eventsQuery.error.message
                    : 'Failed to load platform activity events'
                }
                onRetry={() => void eventsQuery.refetch()}
              />
            </div>
          ) : (
            <>
              <DataTable
                columns={eventColumns}
                data={mergedEvents}
                rowKey={(e) => e.id}
                isLoading={orgsLoading || (eventsQuery.isLoading && mergedEvents.length === 0)}
                skeletonRows={5}
                emptyState={
                  <EmptyState
                    icon={<Activity className="h-5 w-5" />}
                    title="No platform events recorded yet"
                    description="Job submissions, completions, retries, DLQ actions, and worker transitions will stream here in real time."
                  />
                }
              />
              {eventsPagination && eventsPagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-xs text-slate-400">
                  <span>
                    Page {eventsPagination.page} of {eventsPagination.totalPages} (
                    {eventsPagination.total.toLocaleString()} persisted events)
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!eventsPagination.hasPreviousPage}
                      onClick={() => setEventsPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!eventsPagination.hasNextPage}
                      onClick={() => setEventsPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </section>

      <SchedulerObservabilitySection
        organisationId={activeOrganisationId}
        windowMinutes={windowMinutes}
      />

      <ConfirmDialog
        isOpen={confirmRecoverOpen}
        onClose={() => setConfirmRecoverOpen(false)}
        onConfirm={() => void handleConfirmRecover()}
        title="Trigger Stalled-Job Recovery?"
        description="This scans jobs stuck in ACTIVE beyond the stale threshold for this organisation, re-enqueues recoverable jobs, and routes exhausted stalls to the Dead Letter Queue."
        confirmLabel="Run Recovery Sweep"
        isLoading={recoverMutation.isPending}
      />
    </PageContainer>
  );
}

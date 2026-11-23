import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useQueuesList } from '../../hooks/useQueues';
import {
  useCancelSchedule,
  useDeleteSchedule,
  usePauseSchedule,
  useResumeSchedule,
  useScheduleDetail,
  useScheduleExecutions,
  useScheduleNextRun,
  useScheduleStats,
  useUpdateSchedule,
} from '../../hooks/useSchedules';
import type { ScheduleExecutionStatus, ScheduleExecutionView } from '../../types/api';
import { PageContainer } from '../../components/layout/PageContainer';
import { ScheduleFormModal } from '../../components/schedules/ScheduleFormModal';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { Select } from '../../components/ui/Select';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { isTerminalScheduleStatus } from './SchedulesPage';

const EXECUTION_STATUS_OPTIONS = [
  { label: 'All Execution Statuses', value: 'all' },
  { label: 'Dispatched', value: 'DISPATCHED' },
  { label: 'Scheduled (Pre-Execution)', value: 'SCHEDULED' },
  { label: 'Missed', value: 'MISSED' },
  { label: 'Skipped (Overlap)', value: 'SKIPPED_OVERLAP' },
  { label: 'Skipped (Concurrency Cap)', value: 'SKIPPED_CONCURRENCY' },
  { label: 'Skipped (Min Interval)', value: 'SKIPPED_MIN_INTERVAL' },
  { label: 'Skipped (Max Runs Cap)', value: 'SKIPPED_MAX_RUNS' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

const EXECUTIONS_PAGE_SIZE = 10;

function formatUtcTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function ScheduleDetailPage() {
  const { scheduleId } = useParams<{ scheduleId: string }>();
  const navigate = useNavigate();
  const { activeOrganisation, activeOrganisationId } = useOrganisation();

  const role = activeOrganisation?.role ?? 'MEMBER';
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canDelete = role === 'OWNER';

  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [execStatusFilter, setExecStatusFilter] = useState<string>('all');
  const [execPage, setExecPage] = useState(1);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const detailQuery = useScheduleDetail(activeOrganisationId, scheduleId ?? null);
  const statsQuery = useScheduleStats(activeOrganisationId, scheduleId ?? null);
  const nextRunQuery = useScheduleNextRun(activeOrganisationId, scheduleId ?? null);
  const executionsQuery = useScheduleExecutions(activeOrganisationId, scheduleId ?? null, {
    status: execStatusFilter !== 'all' ? (execStatusFilter as ScheduleExecutionStatus) : undefined,
    page: execPage,
    limit: EXECUTIONS_PAGE_SIZE,
  });
  const queuesQuery = useQueuesList(activeOrganisationId);

  const updateMutation = useUpdateSchedule(activeOrganisationId);
  const pauseMutation = usePauseSchedule(activeOrganisationId);
  const resumeMutation = useResumeSchedule(activeOrganisationId);
  const cancelMutation = useCancelSchedule(activeOrganisationId);
  const deleteMutation = useDeleteSchedule(activeOrganisationId);

  const schedule = detailQuery.data;
  const stats = statsQuery.data;
  const nextRun = nextRunQuery.data;
  const executions = executionsQuery.data?.executions ?? [];
  const execPagination = executionsQuery.data?.pagination;

  if (detailQuery.error) {
    return (
      <PageContainer
        title="Schedule Details"
        actions={
          <Link to="/schedules">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Back to Schedules
            </Button>
          </Link>
        }
      >
        <ErrorState
          title="Unable to load schedule details"
          message={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : 'Schedule could not be loaded'
          }
          onRetry={() => {
            void detailQuery.refetch();
            void statsQuery.refetch();
            void nextRunQuery.refetch();
            void executionsQuery.refetch();
          }}
        />
      </PageContainer>
    );
  }

  const handleRefreshAll = () => {
    void detailQuery.refetch();
    void statsQuery.refetch();
    void nextRunQuery.refetch();
    void executionsQuery.refetch();
  };

  const handlePause = async () => {
    if (!schedule) return;
    setFeedback(null);
    try {
      const updated = await pauseMutation.mutateAsync(schedule.id);
      setFeedback({ type: 'success', message: `Schedule "${updated.name}" paused.` });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to pause schedule.',
      });
    }
  };

  const handleResume = async () => {
    if (!schedule) return;
    setFeedback(null);
    try {
      const updated = await resumeMutation.mutateAsync(schedule.id);
      setFeedback({ type: 'success', message: `Schedule "${updated.name}" resumed.` });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to resume schedule.',
      });
    }
  };

  const handleConfirmCancel = async () => {
    if (!schedule) return;
    setFeedback(null);
    try {
      const updated = await cancelMutation.mutateAsync(schedule.id);
      setFeedback({
        type: 'success',
        message: `Schedule "${updated.name}" cancelled permanently.`,
      });
      setCancelOpen(false);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to cancel schedule.',
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!schedule) return;
    setFeedback(null);
    try {
      await deleteMutation.mutateAsync(schedule.id);
      navigate('/schedules', { replace: true });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to delete schedule.',
      });
    }
  };

  const handleCopyPayload = async () => {
    if (!schedule) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(schedule.payload ?? {}, null, 2));
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const isLoading = detailQuery.isLoading || statsQuery.isLoading;
  const isTerminal = schedule ? isTerminalScheduleStatus(schedule.status) : false;

  const skippedCount = stats
    ? stats.byStatus.missed +
      stats.byStatus.skippedOverlap +
      stats.byStatus.skippedConcurrency +
      stats.byStatus.skippedMinInterval +
      stats.byStatus.skippedMaxRuns
    : 0;

  const executionColumns: DataTableColumn<ScheduleExecutionView>[] = [
    {
      key: 'scheduledFor',
      header: 'Scheduled Slot (UTC)',
      render: (exec) => (
        <div className="space-y-0.5">
          <span className="font-mono text-xs text-slate-200 whitespace-nowrap">
            {formatUtcTimestamp(exec.scheduledFor)}
          </span>
          {exec.isCatchUp && (
            <div>
              <StatusBadge status="CATCH_UP" label="Catch-Up" />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Execution Status & Reason',
      render: (exec) => (
        <div className="space-y-1 max-w-xs">
          <StatusBadge status={exec.status} showDot />
          {exec.reason && <p className="text-[11px] text-slate-400 break-words">{exec.reason}</p>}
        </div>
      ),
    },
    {
      key: 'job',
      header: 'Spawned Job',
      render: (exec) => {
        if (!exec.jobId) {
          return (
            <span className="text-xs text-slate-500 italic">No job spawned (skipped/missed)</span>
          );
        }
        return (
          <Link
            to={`/jobs/${exec.jobId}`}
            className="font-mono text-xs font-semibold text-sky-300 hover:text-sky-200 hover:underline"
          >
            {exec.jobId.slice(0, 8)}…{exec.jobId.slice(-4)}
          </Link>
        );
      },
    },
    {
      key: 'finalJobStatus',
      header: 'Final Job Status',
      render: (exec) => {
        const finalStatus = exec.finalJobStatus ?? exec.job?.status;
        if (!finalStatus) {
          return <span className="font-mono text-xs text-slate-500">—</span>;
        }
        return (
          <div className="space-y-1 max-w-xs">
            <StatusBadge status={finalStatus} showDot />
            {exec.job?.errorMessage && (
              <p
                className="font-mono text-[11px] text-rose-300 truncate"
                title={exec.job.errorMessage}
              >
                {exec.job.errorMessage}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'retries',
      header: 'Retries',
      align: 'right',
      render: (exec) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">{exec.retryCount}</span>
      ),
    },
    {
      key: 'timestamps',
      header: 'Dispatched / Completed',
      render: (exec) => (
        <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
          <div>Disp: {formatUtcTimestamp(exec.dispatchedAt)}</div>
          <div>Done: {formatUtcTimestamp(exec.completedAt)}</div>
        </div>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (exec) => (
        <span className="font-mono text-xs tabular-nums text-slate-200">
          {formatDuration(exec.durationMs ?? exec.job?.durationMs ?? null)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer
      title={schedule ? schedule.name : 'Loading schedule…'}
      description={
        schedule?.description ??
        (schedule
          ? `${schedule.type} schedule on queue "${schedule.queueName}" (${schedule.timezone})`
          : 'Fetching schedule configuration and telemetry…')
      }
      actions={
        <>
          <Link to="/schedules">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Schedules
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  detailQuery.isFetching ||
                  statsQuery.isFetching ||
                  nextRunQuery.isFetching ||
                  executionsQuery.isFetching
                    ? 'animate-spin'
                    : ''
                }`}
              />
            }
            onClick={handleRefreshAll}
          >
            Refresh
          </Button>

          {canManage && schedule && !isTerminal && (
            <>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
              {schedule.status === 'PAUSED' ? (
                <Button
                  size="sm"
                  isLoading={resumeMutation.isPending}
                  leftIcon={<Play className="h-3.5 w-3.5" />}
                  onClick={() => void handleResume()}
                >
                  Resume Schedule
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={pauseMutation.isPending}
                  leftIcon={<Pause className="h-3.5 w-3.5 text-amber-400" />}
                  onClick={() => void handlePause()}
                >
                  Pause Schedule
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Ban className="h-3.5 w-3.5 text-amber-400" />}
                onClick={() => setCancelOpen(true)}
              >
                Cancel
              </Button>
            </>
          )}

          {canDelete && schedule && (
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          )}
        </>
      }
    >
      {feedback && (
        <div className="mb-5">
          {feedback.type === 'error' ? (
            <ErrorState compact message={feedback.message} />
          ) : (
            <div
              role="status"
              className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span>{feedback.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-xs text-emerald-300 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* KPI Metrics Row from GET /schedules/:scheduleId/stats */}
      <section
        aria-label="Schedule execution statistics"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <MetricCard
          label="Status & Policy"
          value={schedule ? schedule.status : '—'}
          subtext={schedule ? `${schedule.type} · ${schedule.misfirePolicy}` : undefined}
          icon={<CalendarClock className="h-4 w-4" />}
          tone={
            schedule?.status === 'ACTIVE'
              ? 'success'
              : schedule?.status === 'PAUSED'
                ? 'warning'
                : schedule?.status === 'CANCELLED'
                  ? 'danger'
                  : 'default'
          }
          isLoading={isLoading}
        />

        <MetricCard
          label="Total Runs"
          value={
            stats
              ? stats.maxTotalRuns !== null
                ? `${stats.runCount} / ${stats.maxTotalRuns}`
                : stats.runCount.toLocaleString()
              : '—'
          }
          subtext={
            stats
              ? `${stats.currentInFlight} in flight · ${
                  stats.remainingRuns !== null
                    ? `${stats.remainingRuns} remaining`
                    : 'Unlimited cap'
                }`
              : undefined
          }
          icon={<Activity className="h-4 w-4" />}
          isLoading={isLoading}
        />

        <MetricCard
          label="Completed / Failed"
          value={
            stats ? `${stats.byFinalJobStatus.completed} / ${stats.byFinalJobStatus.failed}` : '—'
          }
          subtext={stats ? `${stats.totalRetries} total job retries` : undefined}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone={stats && stats.byFinalJobStatus.failed > 0 ? 'danger' : 'success'}
          isLoading={isLoading}
        />

        <MetricCard
          label="Skipped & Misfired"
          value={stats ? skippedCount.toLocaleString() : '—'}
          subtext={
            stats
              ? `${stats.byStatus.missed} missed · ${stats.byStatus.skippedOverlap} overlap · ${stats.catchUpExecutions} catch-up`
              : undefined
          }
          icon={<RotateCcw className="h-4 w-4" />}
          tone={skippedCount > 0 ? 'warning' : 'default'}
          isLoading={isLoading}
        />

        <MetricCard
          label="Duration (Avg / Min / Max)"
          value={stats ? formatDuration(stats.durationMs.avg) : '—'}
          subtext={
            stats
              ? `Min: ${formatDuration(stats.durationMs.min)} · Max: ${formatDuration(stats.durationMs.max)}`
              : undefined
          }
          icon={<Clock className="h-4 w-4" />}
          isLoading={isLoading}
        />
      </section>

      {/* Configuration, Upcoming Runs & Payload Grid */}
      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Schedule Configuration Card */}
        <Card>
          <CardHeader
            title="Schedule Configuration"
            description="Persisted recurrence, misfire, and concurrency rules"
            action={schedule ? <StatusBadge status={schedule.status} showDot /> : null}
          />
          <CardContent>
            {isLoading || !schedule ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : (
              <dl className="divide-y divide-border-subtle text-xs">
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Schedule ID</dt>
                  <dd className="font-mono text-slate-200 truncate">{schedule.id}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Target Queue</dt>
                  <dd>
                    <Link
                      to={`/queues/${schedule.queueId}`}
                      className="font-mono font-semibold text-sky-300 hover:underline"
                    >
                      {schedule.queueName}
                    </Link>
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Job Processor</dt>
                  <dd className="font-mono font-semibold text-slate-100">{schedule.jobName}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Schedule Type</dt>
                  <dd>
                    <StatusBadge status={schedule.type} />
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">
                    {schedule.type === 'RECURRING' ? 'Cron Expression' : 'Scheduled Run At'}
                  </dt>
                  <dd className="font-mono text-slate-100">
                    {schedule.type === 'RECURRING'
                      ? schedule.cronExpression
                      : formatUtcTimestamp(schedule.runAt)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">IANA Timezone</dt>
                  <dd className="font-mono text-slate-200">{schedule.timezone}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Misfire Policy</dt>
                  <dd>
                    <StatusBadge status={schedule.misfirePolicy} />
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Catch-Up Limit / Grace</dt>
                  <dd className="font-mono text-slate-200">
                    {schedule.maxCatchUpRuns} runs / {schedule.misfireGraceMs} ms
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Overlap / Concurrency Cap</dt>
                  <dd className="font-mono text-slate-200">
                    {schedule.preventOverlap
                      ? 'Prevent Overlap (1)'
                      : schedule.maxConcurrentRuns !== null
                        ? `Max ${schedule.maxConcurrentRuns} concurrent`
                        : 'Unlimited'}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Max Duration / Min Interval</dt>
                  <dd className="font-mono text-slate-200">
                    {schedule.maxDurationMs !== null ? `${schedule.maxDurationMs}ms` : 'None'} /{' '}
                    {schedule.minIntervalMs !== null ? `${schedule.minIntervalMs}ms` : 'None'}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Job Overrides (Prio / Retry / Backoff)</dt>
                  <dd className="font-mono text-slate-200">
                    {schedule.priority !== null ? `p${schedule.priority}` : 'Default'} ·{' '}
                    {schedule.maxRetries !== null ? `${schedule.maxRetries}r` : 'Default'} ·{' '}
                    {schedule.backoffMs !== null ? `${schedule.backoffMs}ms` : 'Default'}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Last Run / Dispatched</dt>
                  <dd className="font-mono text-slate-300">
                    {formatUtcTimestamp(schedule.lastRunAt)}
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          {/* Next Run & Up to 5 Upcoming Runs Card */}
          <Card>
            <CardHeader
              title="Next Scheduled Run & Upcoming Preview"
              description={
                schedule
                  ? `Computed in schedule timezone (${schedule.timezone}) and canonical UTC`
                  : 'Upcoming run preview'
              }
            />
            <CardContent>
              {nextRunQuery.isLoading ? (
                <div className="space-y-2.5">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : !nextRun || !nextRun.nextRunAt ? (
                <div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-canvas/50 p-3.5 text-xs text-slate-400">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                  <span>
                    No upcoming execution scheduled while schedule is in{' '}
                    <span className="font-mono font-semibold text-slate-200">
                      {schedule?.status ?? 'inactive'}
                    </span>{' '}
                    state.
                  </span>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 rounded-lg border border-sky-400/25 bg-sky-400/10 p-3.5 text-xs">
                    <div>
                      <span className="block text-[11px] font-medium text-sky-300">
                        Next Run ({nextRun.timezone})
                      </span>
                      <span className="mt-0.5 block font-mono font-semibold text-slate-100">
                        {nextRun.nextRunAtLocal}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] font-medium text-sky-300">
                        Next Run (Canonical UTC)
                      </span>
                      <span className="mt-0.5 block font-mono font-semibold text-slate-100">
                        {formatUtcTimestamp(nextRun.nextRunAt)}
                      </span>
                    </div>
                  </div>

                  {nextRun.upcomingRuns.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Upcoming Execution Slots (Up to 5)
                      </h3>
                      <div className="overflow-x-auto rounded-lg border border-border-subtle">
                        <table className="w-full text-left text-xs font-mono">
                          <thead className="border-b border-border-subtle bg-surface-subtle/60 text-[11px] text-slate-400">
                            <tr>
                              <th className="px-3.5 py-2">#</th>
                              <th className="px-3.5 py-2">Local ({nextRun.timezone})</th>
                              <th className="px-3.5 py-2">Canonical UTC</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-subtle">
                            {nextRun.upcomingRuns.map((slot, idx) => (
                              <tr key={slot.utc} className="text-slate-200">
                                <td className="px-3.5 py-2 text-slate-400">{idx + 1}</td>
                                <td className="px-3.5 py-2">{slot.local}</td>
                                <td className="px-3.5 py-2 text-slate-300">
                                  {formatUtcTimestamp(slot.utc)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Job Template JSON Payload Card */}
          <Card>
            <CardHeader
              title="Job Template JSON Payload"
              description="Payload passed to each job dispatched by this schedule"
              action={
                schedule ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCopyPayload()}
                    leftIcon={
                      copiedPayload ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )
                    }
                  >
                    {copiedPayload ? 'Copied' : 'Copy JSON'}
                  </Button>
                ) : null
              }
            />
            <CardContent>
              {isLoading || !schedule ? (
                <Skeleton className="h-28 w-full" />
              ) : (
                <pre className="max-h-56 overflow-auto rounded-lg border border-border-subtle bg-canvas p-4 font-mono text-xs text-slate-200">
                  {JSON.stringify(schedule.payload ?? {}, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Immutable Execution History Table */}
      <section className="mt-6">
        <Card>
          <CardHeader
            title="Immutable Execution History"
            description="Persisted ScheduleExecution ledger including dispatched jobs, catch-up runs, and skipped/missed slots"
            action={
              <div className="w-56">
                <Select
                  aria-label="Filter execution history by status"
                  value={execStatusFilter}
                  onChange={(e) => {
                    setExecStatusFilter(e.target.value);
                    setExecPage(1);
                  }}
                  options={EXECUTION_STATUS_OPTIONS}
                />
              </div>
            }
          />
          <DataTable
            columns={executionColumns}
            data={executions}
            rowKey={(e) => e.id}
            isLoading={executionsQuery.isLoading}
            skeletonRows={4}
            emptyState={
              <EmptyState
                icon={<CalendarClock className="h-5 w-5" />}
                title={
                  execStatusFilter !== 'all'
                    ? 'No executions match this status filter'
                    : 'No schedule executions recorded yet'
                }
                description={
                  execStatusFilter !== 'all'
                    ? 'Try selecting "All Execution Statuses" to see all dispatched and skipped occurrences.'
                    : 'Execution records will appear here automatically as due occurrences are evaluated by the dispatcher.'
                }
                action={
                  execStatusFilter !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setExecStatusFilter('all');
                        setExecPage(1);
                      }}
                    >
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            }
          />

          {!executionsQuery.isLoading && execPagination && execPagination.total > 0 && (
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-xs text-slate-400">
              <span>
                Showing page <span className="font-mono text-slate-200">{execPagination.page}</span>{' '}
                of{' '}
                <span className="font-mono text-slate-200">
                  {Math.max(1, execPagination.totalPages)}
                </span>{' '}
                (<span className="font-mono text-slate-200">{execPagination.total}</span> total
                execution record(s))
              </span>
              {execPagination.totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!execPagination.hasPreviousPage}
                    onClick={() => setExecPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="font-mono">
                    Page {execPagination.page} of {execPagination.totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!execPagination.hasNextPage}
                    onClick={() => setExecPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </section>

      <ScheduleFormModal
        isOpen={editOpen}
        mode="edit"
        queues={queuesQuery.data ?? []}
        initialSchedule={schedule}
        onClose={() => setEditOpen(false)}
        onSubmitEdit={(sId, payload) => updateMutation.mutateAsync({ scheduleId: sId, payload })}
        onSuccess={(_s, message) => setFeedback({ type: 'success', message })}
      />

      <ConfirmDialog
        isOpen={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={handleConfirmCancel}
        title={`Cancel Schedule "${schedule?.name ?? ''}"?`}
        description="Cancelling permanently transitions this schedule to CANCELLED state and removes any pre-execution pending one-time job."
        confirmLabel="Cancel Schedule"
        destructive
        isLoading={cancelMutation.isPending}
      />

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleConfirmDelete}
        title={`Delete Schedule "${schedule?.name ?? ''}"?`}
        description="Deleting permanently removes this schedule and its execution history records."
        confirmLabel="Delete Schedule"
        destructive
        isLoading={deleteMutation.isPending}
      />
    </PageContainer>
  );
}

import { useMemo, useState } from 'react';
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
  Cpu,
  Layers,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { isCancellableJobStatus } from '../../api/job.api';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useCancelJob, useJobDetail, useJobEvents } from '../../hooks/useJobs';
import type { JobView, PlatformEventView } from '../../types/api';
import { CancelJobModal } from '../../components/jobs/CancelJobModal';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

interface TimelineEntry {
  id: string;
  timestamp: string;
  status: string;
  title: string;
  detail?: string;
}

function buildPersistedTimeline(job: JobView, events: PlatformEventView[]): TimelineEntry[] {
  if (events.length > 0) {
    return [...events]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((evt) => ({
        id: evt.id,
        timestamp: evt.createdAt,
        status: evt.type,
        title: evt.message,
        detail: evt.workerId ? `Worker: ${evt.workerId}` : undefined,
      }));
  }

  // Fallback to persisted Job timestamps if no event rows exist yet
  const items: TimelineEntry[] = [
    {
      id: 'created',
      timestamp: job.createdAt,
      status: 'JOB_SUBMITTED',
      title: `Job "${job.name}" created in queue "${job.queueName}"`,
      detail: job.delayMs > 0 ? `Initial delay: ${job.delayMs} ms` : undefined,
    },
  ];

  if (job.startedAt) {
    items.push({
      id: 'started',
      timestamp: job.startedAt,
      status: 'JOB_STARTED',
      title: `Execution started (attempt ${job.attemptsMade})`,
      detail: job.lastWorkerId ? `Worker: ${job.lastWorkerId}` : undefined,
    });
  }

  if (job.lastRecoveredAt) {
    items.push({
      id: 'recovered',
      timestamp: job.lastRecoveredAt,
      status: 'JOB_RECOVERED',
      title: `Recovered from stalled state (${job.stalledCount} recovery event(s))`,
    });
  }

  if (job.completedAt) {
    items.push({
      id: 'completed',
      timestamp: job.completedAt,
      status: 'JOB_COMPLETED',
      title: `Job completed in ${formatDuration(job.durationMs)}`,
    });
  } else if (job.failedAt) {
    items.push({
      id: 'failed',
      timestamp: job.failedAt,
      status: 'JOB_FAILED',
      title: job.errorMessage ?? 'Job permanently failed',
    });
  }

  return items;
}

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { activeOrganisation, activeOrganisationId } = useOrganisation();

  const role = activeOrganisation?.role ?? 'MEMBER';
  const canCancel = role === 'OWNER' || role === 'ADMIN';

  const [cancelOpen, setCancelOpen] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const jobQuery = useJobDetail(activeOrganisationId, jobId ?? null);
  const eventsQuery = useJobEvents(activeOrganisationId, jobId ?? null);
  const cancelMutation = useCancelJob(activeOrganisationId);

  const job = jobQuery.data;
  const events = eventsQuery.data?.events ?? [];

  const scheduleMeta = useMemo(() => {
    for (const evt of events) {
      if (evt.metadata && typeof evt.metadata.scheduleId === 'string') {
        return {
          scheduleId: evt.metadata.scheduleId,
          scheduleName:
            typeof evt.metadata.scheduleName === 'string' ? evt.metadata.scheduleName : null,
          scheduledFor:
            typeof evt.metadata.scheduledFor === 'string'
              ? evt.metadata.scheduledFor
              : typeof evt.metadata.runAt === 'string'
                ? evt.metadata.runAt
                : null,
          isCatchUp: evt.metadata.isCatchUp === true,
        };
      }
    }
    return null;
  }, [events]);

  const timeline = useMemo(() => (job ? buildPersistedTimeline(job, events) : []), [job, events]);

  if (jobQuery.error) {
    return (
      <PageContainer
        title="Job Details"
        actions={
          <Link to="/jobs">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Back to Jobs
            </Button>
          </Link>
        }
      >
        <ErrorState
          title="Unable to load job details"
          message={
            jobQuery.error instanceof Error ? jobQuery.error.message : 'Job could not be loaded'
          }
          onRetry={() => void jobQuery.refetch()}
        />
      </PageContainer>
    );
  }

  const handleCopyPayload = async () => {
    if (!job) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(job.payload ?? {}, null, 2));
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const isLoading = jobQuery.isLoading;
  const cancellable = job ? isCancellableJobStatus(job.status) : false;

  return (
    <PageContainer
      title={job ? `${job.name}` : 'Loading job…'}
      description={job ? `Job ID: ${job.id}` : 'Fetching persisted job state…'}
      actions={
        <>
          <Link to="/jobs">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Jobs
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  jobQuery.isFetching || eventsQuery.isFetching ? 'animate-spin' : ''
                }`}
              />
            }
            onClick={() => {
              void jobQuery.refetch();
              void eventsQuery.refetch();
            }}
          >
            Refresh
          </Button>
          {canCancel && job && cancellable && (
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Ban className="h-3.5 w-3.5" />}
              onClick={() => setCancelOpen(true)}
            >
              Cancel Job
            </Button>
          )}
        </>
      }
    >
      {/* Schedule Association Banner (when job was spawned by a schedule) */}
      {scheduleMeta && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/25 bg-sky-400/10 px-4 py-3 text-xs text-sky-200">
          <div className="flex items-center gap-2.5">
            <CalendarClock className="h-4 w-4 shrink-0 text-sky-400" />
            <span>
              Spawned by schedule{' '}
              <Link
                to={`/schedules/${scheduleMeta.scheduleId}`}
                className="font-mono font-semibold text-sky-100 underline hover:text-white"
              >
                {scheduleMeta.scheduleName ?? scheduleMeta.scheduleId}
              </Link>
              {scheduleMeta.scheduledFor && (
                <>
                  {' '}
                  for slot{' '}
                  <span className="font-mono">{formatDateTime(scheduleMeta.scheduledFor)}</span>
                </>
              )}
            </span>
          </div>
          {scheduleMeta.isCatchUp && <StatusBadge status="ACTIVE" tone="amber" label="Catch-Up" />}
        </div>
      )}

      {/* KPI Metrics Row */}
      <section
        aria-label="Job execution summary"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <MetricCard
          label="Status"
          value={job ? job.status : '—'}
          subtext={job ? `Queue: ${job.queueName}` : undefined}
          icon={<Activity className="h-4 w-4" />}
          tone={
            job?.status === 'COMPLETED'
              ? 'success'
              : job?.status === 'FAILED'
                ? 'danger'
                : job?.status === 'PENDING' || job?.status === 'DELAYED'
                  ? 'warning'
                  : 'default'
          }
          isLoading={isLoading}
        />

        <MetricCard
          label="Priority"
          value={job ? `p${job.priority}` : '—'}
          subtext="Scale 1 (highest) – 20"
          icon={<Layers className="h-4 w-4" />}
          isLoading={isLoading}
        />

        <MetricCard
          label="Attempts"
          value={job ? `${job.attemptsMade} / ${job.maxRetries + 1}` : '—'}
          subtext={
            job
              ? `${job.maxRetries} max retries · ${job.stalledCount} stalled recoveries`
              : undefined
          }
          icon={<RotateCcw className="h-4 w-4" />}
          isLoading={isLoading}
        />

        <MetricCard
          label="Execution Duration"
          value={job ? formatDuration(job.durationMs) : '—'}
          subtext={job?.lastWorkerId ? `Worker: ${job.lastWorkerId}` : 'Not yet executed'}
          icon={<Cpu className="h-4 w-4" />}
          isLoading={isLoading}
        />

        <MetricCard
          label="Delay & Backoff"
          value={job ? `${job.delayMs}ms / ${job.backoffMs}ms` : '—'}
          subtext="Initial delay / retry backoff"
          icon={<Clock className="h-4 w-4" />}
          isLoading={isLoading}
        />
      </section>

      {/* Metadata & JSON Payload / Result Row */}
      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Job Configuration & Metadata"
            description="Persisted PostgreSQL record details"
            action={job ? <StatusBadge status={job.status} showDot /> : null}
          />
          <CardContent>
            {isLoading || !job ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : (
              <dl className="divide-y divide-border-subtle text-xs">
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Job ID</dt>
                  <dd className="font-mono text-slate-200 truncate">{job.id}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Queue</dt>
                  <dd>
                    <Link
                      to={`/queues/${job.queueId}`}
                      className="font-mono font-medium text-sky-300 hover:underline"
                    >
                      {job.queueName}
                    </Link>
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Organisation ID</dt>
                  <dd className="font-mono text-slate-300 truncate">{job.organisationId}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Submitted By</dt>
                  <dd className="text-slate-200 truncate">
                    {job.createdBy
                      ? `${job.createdBy.name} (${job.createdBy.email})`
                      : 'Scheduler / System'}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Created At</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(job.createdAt)}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Started At</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(job.startedAt)}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Completed At</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(job.completedAt)}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5 gap-2">
                  <dt className="text-slate-400">Failed At</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(job.failedAt)}</dd>
                </div>
                {job.replayedFromDlqId && (
                  <div className="flex items-center justify-between py-2.5 gap-2">
                    <dt className="text-sky-300">Replayed From DLQ</dt>
                    <dd className="font-mono text-sky-200 truncate">
                      <Link
                        to={`/dlq?queueId=${job.queueId}`}
                        className="underline hover:text-sky-100"
                      >
                        {job.replayedFromDlqId}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          {/* Payload Card */}
          <Card>
            <CardHeader
              title="Input Payload"
              description="JSON payload persisted at submission"
              action={
                job ? (
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
              {isLoading || !job ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <pre className="max-h-60 overflow-auto rounded-lg border border-border-subtle bg-canvas p-4 font-mono text-xs text-slate-200">
                  {JSON.stringify(job.payload ?? {}, null, 2)}
                </pre>
              )}
            </CardContent>
          </Card>

          {/* Execution Result OR Failure Reason Card */}
          <Card>
            <CardHeader
              title="Execution Outcome"
              description="Persisted processor output or failure diagnostics"
            />
            <CardContent>
              {isLoading || !job ? (
                <Skeleton className="h-28 w-full" />
              ) : job.status === 'COMPLETED' ? (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Completed successfully in {formatDuration(job.durationMs)}
                  </div>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4 font-mono text-xs text-emerald-100">
                    {JSON.stringify(job.result ?? {}, null, 2)}
                  </pre>
                </div>
              ) : job.errorMessage ? (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-200"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <div className="space-y-1 min-w-0">
                      <p className="font-semibold text-rose-100">
                        {job.status === 'FAILED'
                          ? 'Job permanently failed'
                          : 'Last attempt failure (retry scheduled)'}
                      </p>
                      <p className="font-mono break-words text-rose-200">{job.errorMessage}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Job is currently in <span className="font-mono text-slate-200">{job.status}</span>{' '}
                  state. Output or error details will appear once a worker executes it.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Persisted Execution Lifecycle Timeline */}
      <section className="mt-6">
        <Card>
          <CardHeader
            title="Execution Lifecycle Timeline"
            description="Chronological audit trail derived strictly from persisted PostgreSQL timestamps and platform events"
          />
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <ol className="relative border-l border-border-strong ml-3 space-y-5 pl-6">
                {timeline.map((item) => (
                  <li key={item.id} className="relative">
                    <span className="absolute -left-[29px] top-1 h-2.5 w-2.5 rounded-full border border-sky-400 bg-canvas" />
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2.5">
                        <StatusBadge status={item.status} />
                        <span className="text-xs font-medium text-slate-100">{item.title}</span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-400">
                        {formatDateTime(item.timestamp)}
                      </span>
                    </div>
                    {item.detail && (
                      <p className="mt-1 font-mono text-[11px] text-slate-400">{item.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </section>

      <CancelJobModal
        isOpen={cancelOpen}
        job={job ?? null}
        onClose={() => setCancelOpen(false)}
        onConfirmCancel={(id) => cancelMutation.mutateAsync({ jobId: id, queueId: job?.queueId })}
        onSuccess={() => navigate('/jobs', { replace: true })}
      />
    </PageContainer>
  );
}

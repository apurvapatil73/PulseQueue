import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertOctagon,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Layers,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { useOrganisation } from '../../contexts/OrganisationContext';
import {
  useDeleteQueue,
  usePauseQueue,
  useQueueDetail,
  useQueueStats,
  useResumeQueue,
  useUpdateQueue,
} from '../../hooks/useQueues';
import { JobStatusChart } from '../../components/charts/JobStatusChart';
import { PageContainer } from '../../components/layout/PageContainer';
import { DeleteQueueModal } from '../../components/queues/DeleteQueueModal';
import { QueueFormModal } from '../../components/queues/QueueFormModal';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function QueueDetailPage() {
  const { queueId } = useParams<{ queueId: string }>();
  const navigate = useNavigate();
  const { activeOrganisation, activeOrganisationId } = useOrganisation();

  const role = activeOrganisation?.role ?? 'MEMBER';
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canDelete = role === 'OWNER';

  const [editOpen, setEditOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const detailQuery = useQueueDetail(activeOrganisationId, queueId ?? null);
  const statsQuery = useQueueStats(activeOrganisationId, queueId ?? null);

  const updateMutation = useUpdateQueue(activeOrganisationId);
  const pauseMutation = usePauseQueue(activeOrganisationId);
  const resumeMutation = useResumeQueue(activeOrganisationId);
  const deleteMutation = useDeleteQueue(activeOrganisationId);

  const queue = detailQuery.data;
  const stats = statsQuery.data;
  const isLoading = detailQuery.isLoading || statsQuery.isLoading;

  if (detailQuery.error || statsQuery.error) {
    const err = detailQuery.error ?? statsQuery.error;
    return (
      <PageContainer
        title="Queue Details"
        actions={
          <Link to="/queues">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Back to Queues
            </Button>
          </Link>
        }
      >
        <ErrorState
          title="Unable to load queue details"
          message={err instanceof Error ? err.message : 'Queue could not be loaded'}
          onRetry={() => {
            void detailQuery.refetch();
            void statsQuery.refetch();
          }}
        />
      </PageContainer>
    );
  }

  const handleConfirmPause = async () => {
    if (!queue) return;
    setFeedback(null);
    try {
      const updated = await pauseMutation.mutateAsync(queue.id);
      setFeedback({ type: 'success', message: `Queue "${updated.name}" paused.` });
      setPauseConfirmOpen(false);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to pause queue.',
      });
    }
  };

  const handleResume = async () => {
    if (!queue) return;
    setFeedback(null);
    try {
      const updated = await resumeMutation.mutateAsync(queue.id);
      setFeedback({ type: 'success', message: `Queue "${updated.name}" resumed.` });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to resume queue.',
      });
    }
  };

  const byStatus = stats?.jobs.byStatus;
  const chartSummary = byStatus
    ? {
        totalSubmitted: stats.jobs.total,
        totalProcessed: byStatus.COMPLETED + byStatus.FAILED,
        succeeded: byStatus.COMPLETED,
        failed: byStatus.FAILED,
        active: byStatus.ACTIVE,
        pending: byStatus.PENDING,
        delayed: byStatus.DELAYED,
        paused: byStatus.PAUSED,
        retriedJobs: 0,
        totalRetryEvents: 0,
        stalledRecoveries: 0,
        deadLetterOpen: 0,
        deadLetterReplayed: 0,
        averageDurationMs: null,
      }
    : undefined;

  return (
    <PageContainer
      title={queue ? queue.name : 'Loading queue…'}
      description={queue?.description ?? 'Queue configuration and real-time job status breakdown'}
      actions={
        <>
          <Link to="/queues">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}>
              Queues
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  detailQuery.isFetching || statsQuery.isFetching ? 'animate-spin' : ''
                }`}
              />
            }
            onClick={() => {
              void detailQuery.refetch();
              void statsQuery.refetch();
            }}
          >
            Refresh
          </Button>
          {canManage && queue && (
            <>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
              {queue.isPaused ? (
                <Button
                  size="sm"
                  isLoading={resumeMutation.isPending}
                  leftIcon={<Play className="h-3.5 w-3.5" />}
                  onClick={() => void handleResume()}
                >
                  Resume Queue
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Pause className="h-3.5 w-3.5 text-amber-400" />}
                  onClick={() => setPauseConfirmOpen(true)}
                >
                  Pause Queue
                </Button>
              )}
            </>
          )}
          {canDelete && queue && (
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

      {/* Real Job Status Counts from GET /queues/:queueId/stats */}
      <section
        aria-label="Queue job statistics"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6"
      >
        <MetricCard
          label="Total Jobs"
          value={stats ? stats.jobs.total.toLocaleString() : '—'}
          icon={<Layers className="h-4 w-4" />}
          isLoading={isLoading}
        />
        <MetricCard
          label="Pending"
          value={byStatus ? byStatus.PENDING.toLocaleString() : '—'}
          icon={<Clock className="h-4 w-4" />}
          tone="warning"
          isLoading={isLoading}
        />
        <MetricCard
          label="Active"
          value={byStatus ? byStatus.ACTIVE.toLocaleString() : '—'}
          icon={<Play className="h-4 w-4" />}
          tone="default"
          isLoading={isLoading}
        />
        <MetricCard
          label="Completed"
          value={byStatus ? byStatus.COMPLETED.toLocaleString() : '—'}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
          isLoading={isLoading}
        />
        <MetricCard
          label="Failed"
          value={byStatus ? byStatus.FAILED.toLocaleString() : '—'}
          icon={<AlertOctagon className="h-4 w-4" />}
          tone={byStatus && byStatus.FAILED > 0 ? 'danger' : 'default'}
          isLoading={isLoading}
        />
        <MetricCard
          label="Delayed / Paused"
          value={byStatus ? `${byStatus.DELAYED} / ${byStatus.PAUSED}` : '—'}
          icon={<Pause className="h-4 w-4" />}
          isLoading={isLoading}
        />
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Queue Configuration Card */}
        <Card>
          <CardHeader
            title="Queue Configuration"
            description="Persisted execution parameters & metadata"
            action={
              queue ? (
                <StatusBadge
                  status={queue.isPaused ? 'PAUSED' : 'ACTIVE'}
                  label={queue.isPaused ? 'Paused' : 'Active'}
                  showDot
                />
              ) : null
            }
          />
          <CardContent>
            {isLoading || !queue ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : (
              <dl className="divide-y divide-border-subtle text-xs">
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Queue ID</dt>
                  <dd className="font-mono text-slate-200">{queue.id}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Worker Concurrency</dt>
                  <dd className="font-mono font-semibold text-slate-100">{queue.concurrency}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Default Priority</dt>
                  <dd className="font-mono font-semibold text-slate-100">
                    {queue.defaultPriority} (1–20)
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Maximum Retries</dt>
                  <dd className="font-mono font-semibold text-slate-100">{queue.maxRetries}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Exponential Backoff</dt>
                  <dd className="font-mono font-semibold text-slate-100">{queue.backoffMs} ms</dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Created By</dt>
                  <dd className="text-slate-200">
                    {queue.createdBy ? `${queue.createdBy.name} (${queue.createdBy.email})` : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Created At</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(queue.createdAt)}</dd>
                </div>
                <div className="flex items-center justify-between py-2.5">
                  <dt className="text-slate-400">Last Updated</dt>
                  <dd className="font-mono text-slate-300">{formatDateTime(queue.updatedAt)}</dd>
                </div>
                {queue.isPaused && (
                  <div className="flex items-center justify-between py-2.5">
                    <dt className="text-amber-300">Paused At</dt>
                    <dd className="font-mono text-amber-200">{formatDateTime(queue.pausedAt)}</dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* Status Distribution Chart */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Job Status Breakdown"
            description="Live job distribution from GET /queues/:queueId/stats"
          />
          <CardContent>
            <JobStatusChart summary={chartSummary} isLoading={isLoading} />
          </CardContent>
        </Card>
      </section>

      <QueueFormModal
        isOpen={editOpen}
        mode="edit"
        initialQueue={queue}
        onClose={() => setEditOpen(false)}
        onSubmitEdit={(qId, payload) => updateMutation.mutateAsync({ queueId: qId, payload })}
        onSuccess={(_q, message) => setFeedback({ type: 'success', message })}
      />

      <ConfirmDialog
        isOpen={pauseConfirmOpen}
        onClose={() => setPauseConfirmOpen(false)}
        onConfirm={handleConfirmPause}
        title={`Pause Queue "${queue?.name ?? ''}"?`}
        description="Pausing stops workers from picking up new jobs on this queue until it is resumed."
        confirmLabel="Pause Queue"
        isLoading={pauseMutation.isPending}
      />

      <DeleteQueueModal
        isOpen={deleteOpen}
        queue={queue ?? null}
        onClose={() => setDeleteOpen(false)}
        onConfirmDelete={(qId) => deleteMutation.mutateAsync(qId)}
        onSuccess={() => navigate('/queues', { replace: true })}
      />
    </PageContainer>
  );
}

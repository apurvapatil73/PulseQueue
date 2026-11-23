import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  Eye,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useQueuesList } from '../../hooks/useQueues';
import {
  useCancelSchedule,
  useCreateSchedule,
  useDeleteSchedule,
  usePauseSchedule,
  useReconcileSchedules,
  useResumeSchedule,
  useSchedulesList,
  useUpdateSchedule,
} from '../../hooks/useSchedules';
import type { ScheduleStatus, ScheduleType, ScheduleView } from '../../types/api';
import { PageContainer } from '../../components/layout/PageContainer';
import { ScheduleFormModal } from '../../components/schedules/ScheduleFormModal';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

const STATUS_FILTER_OPTIONS = [
  { label: 'All Statuses', value: 'all' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Paused', value: 'PAUSED' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

const TYPE_FILTER_OPTIONS = [
  { label: 'All Types', value: 'all' },
  { label: 'Recurring (Cron)', value: 'RECURRING' },
  { label: 'One-Time', value: 'ONE_TIME' },
];

const PAGE_SIZE = 10;

export function isTerminalScheduleStatus(status: ScheduleStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

function formatUtcTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return iso;
  }
}

export function SchedulesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQueueParam = searchParams.get('queueId') ?? 'all';

  const { activeOrganisation, activeOrganisationId, isLoading: orgLoading } = useOrganisation();
  const role = activeOrganisation?.role ?? 'MEMBER';
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canDelete = role === 'OWNER';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedQueueId, setSelectedQueueId] = useState<string>(initialQueueParam);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleView | null>(null);
  const [cancellingSchedule, setCancellingSchedule] = useState<ScheduleView | null>(null);
  const [deletingSchedule, setDeletingSchedule] = useState<ScheduleView | null>(null);
  const [actionScheduleId, setActionScheduleId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const queuesQuery = useQueuesList(activeOrganisationId);
  const queues = queuesQuery.data ?? [];

  const effectiveQueueId =
    selectedQueueId !== 'all' && queues.some((q) => q.id === selectedQueueId)
      ? selectedQueueId
      : 'all';

  const schedulesQuery = useSchedulesList(activeOrganisationId, {
    status: statusFilter !== 'all' ? (statusFilter as ScheduleStatus) : undefined,
    type: typeFilter !== 'all' ? (typeFilter as ScheduleType) : undefined,
    queueId: effectiveQueueId !== 'all' ? effectiveQueueId : undefined,
    page,
    limit: PAGE_SIZE,
  });

  const createMutation = useCreateSchedule(activeOrganisationId);
  const updateMutation = useUpdateSchedule(activeOrganisationId);
  const pauseMutation = usePauseSchedule(activeOrganisationId);
  const resumeMutation = useResumeSchedule(activeOrganisationId);
  const cancelMutation = useCancelSchedule(activeOrganisationId);
  const deleteMutation = useDeleteSchedule(activeOrganisationId);
  const reconcileMutation = useReconcileSchedules(activeOrganisationId);

  const schedules = schedulesQuery.data?.schedules ?? [];
  const pagination = schedulesQuery.data?.pagination;

  const filteredSchedules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return schedules;
    return schedules.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        s.jobName.toLowerCase().includes(q) ||
        s.queueName.toLowerCase().includes(q) ||
        (s.cronExpression ?? '').toLowerCase().includes(q) ||
        s.timezone.toLowerCase().includes(q),
    );
  }, [schedules, searchQuery]);

  const handleQueueFilterChange = (val: string) => {
    setSelectedQueueId(val);
    setPage(1);
    if (val === 'all') {
      searchParams.delete('queueId');
    } else {
      searchParams.set('queueId', val);
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handlePause = async (schedule: ScheduleView) => {
    setFeedback(null);
    setActionScheduleId(schedule.id);
    try {
      const updated = await pauseMutation.mutateAsync(schedule.id);
      setFeedback({
        type: 'success',
        message: `Schedule "${updated.name}" paused.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to pause schedule.',
      });
    } finally {
      setActionScheduleId(null);
    }
  };

  const handleResume = async (schedule: ScheduleView) => {
    setFeedback(null);
    setActionScheduleId(schedule.id);
    try {
      const updated = await resumeMutation.mutateAsync(schedule.id);
      setFeedback({
        type: 'success',
        message: `Schedule "${updated.name}" resumed. Next run: ${updated.nextRunAtLocal ?? formatUtcTimestamp(updated.nextRunAt)}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to resume schedule.',
      });
    } finally {
      setActionScheduleId(null);
    }
  };

  const handleConfirmCancel = async () => {
    if (!cancellingSchedule) return;
    setFeedback(null);
    setActionScheduleId(cancellingSchedule.id);
    try {
      const updated = await cancelMutation.mutateAsync(cancellingSchedule.id);
      setFeedback({
        type: 'success',
        message: `Schedule "${updated.name}" cancelled permanently.`,
      });
      setCancellingSchedule(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to cancel schedule.',
      });
    } finally {
      setActionScheduleId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingSchedule) return;
    setFeedback(null);
    setActionScheduleId(deletingSchedule.id);
    try {
      const name = deletingSchedule.name;
      await deleteMutation.mutateAsync(deletingSchedule.id);
      setFeedback({
        type: 'success',
        message: `Schedule "${name}" deleted.`,
      });
      setDeletingSchedule(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to delete schedule.',
      });
    } finally {
      setActionScheduleId(null);
    }
  };

  const handleReconcile = async () => {
    setFeedback(null);
    try {
      const result = await reconcileMutation.mutateAsync();
      setFeedback({
        type: 'success',
        message: `Schedule reconciliation finished: ${result.tick.dispatched} dispatched (${result.tick.catchUpDispatched} catch-up), ${result.bullmq.reEnqueued} re-enqueued to BullMQ.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to reconcile schedules.',
      });
    }
  };

  const queueFilterOptions = useMemo(
    () => [
      { label: 'All Queues', value: 'all' },
      ...queues.map((q) => ({ label: q.name, value: q.id })),
    ],
    [queues],
  );

  const columns: DataTableColumn<ScheduleView>[] = [
    {
      key: 'name',
      header: 'Schedule',
      render: (s) => (
        <div className="min-w-[180px]">
          <Link
            to={`/schedules/${s.id}`}
            className="font-mono text-xs font-semibold text-sky-300 hover:text-sky-200 hover:underline"
          >
            {s.name}
          </Link>
          {s.description && (
            <p className="mt-0.5 max-w-xs truncate text-[11px] text-slate-400">{s.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'queueAndJob',
      header: 'Queue & Processor',
      render: (s) => (
        <div className="space-y-0.5">
          <Link
            to={`/queues/${s.queueId}`}
            className="block font-mono text-xs text-slate-200 hover:text-sky-300 hover:underline"
          >
            {s.queueName}
          </Link>
          <span className="inline-block rounded border border-border-subtle bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
            {s.jobName}
          </span>
        </div>
      ),
    },
    {
      key: 'typeAndCadence',
      header: 'Type & Cadence',
      render: (s) => (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <StatusBadge status={s.type} />
            <span className="font-mono text-[11px] text-slate-400">{s.timezone}</span>
          </div>
          <div className="font-mono text-xs text-slate-200">
            {s.type === 'RECURRING' ? s.cronExpression : formatUtcTimestamp(s.runAt)}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <StatusBadge status={s.status} showDot />,
    },
    {
      key: 'nextRun',
      header: 'Next Run (Local / UTC)',
      render: (s) => {
        if (!s.nextRunAt) {
          return <span className="font-mono text-xs text-slate-500">—</span>;
        }
        return (
          <div className="font-mono text-[11px] whitespace-nowrap">
            <div className="text-slate-200" title={`Local time in ${s.timezone}`}>
              Local: {s.nextRunAtLocal ?? s.nextRunAt}
            </div>
            <div className="text-slate-400">UTC: {formatUtcTimestamp(s.nextRunAt)}</div>
          </div>
        );
      },
    },
    {
      key: 'runsAndPolicy',
      header: 'Runs & Misfire Policy',
      render: (s) => (
        <div className="space-y-1">
          <div className="font-mono text-xs tabular-nums text-slate-200">
            {s.maxTotalRuns !== null ? `${s.runCount} / ${s.maxTotalRuns}` : `${s.runCount} runs`}
          </div>
          <div className="flex items-center gap-1.5">
            <StatusBadge status={s.misfirePolicy} />
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (s) => {
        const isTerminal = isTerminalScheduleStatus(s.status);
        const isBusy = actionScheduleId === s.id;
        return (
          <div className="flex items-center justify-end gap-1">
            <Link to={`/schedules/${s.id}`} aria-label={`View schedule ${s.name}`}>
              <Button variant="ghost" size="sm" leftIcon={<Eye className="h-3.5 w-3.5" />}>
                View
              </Button>
            </Link>

            {canManage && !isTerminal && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit schedule ${s.name}`}
                  onClick={() => setEditingSchedule(s)}
                  leftIcon={<Pencil className="h-3.5 w-3.5" />}
                >
                  Edit
                </Button>

                {s.status === 'PAUSED' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Resume schedule ${s.name}`}
                    disabled={isBusy}
                    isLoading={isBusy && resumeMutation.isPending}
                    onClick={() => void handleResume(s)}
                    leftIcon={<Play className="h-3.5 w-3.5 text-emerald-400" />}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Pause schedule ${s.name}`}
                    disabled={isBusy}
                    isLoading={isBusy && pauseMutation.isPending}
                    onClick={() => void handlePause(s)}
                    leftIcon={<Pause className="h-3.5 w-3.5 text-amber-400" />}
                  >
                    Pause
                  </Button>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Cancel schedule ${s.name}`}
                  disabled={isBusy}
                  onClick={() => setCancellingSchedule(s)}
                  className="text-amber-300 hover:text-amber-200"
                  leftIcon={<Ban className="h-3.5 w-3.5" />}
                >
                  Cancel
                </Button>
              </>
            )}

            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete schedule ${s.name}`}
                disabled={isBusy}
                onClick={() => setDeletingSchedule(s)}
                className="text-rose-300 hover:text-rose-200"
                leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              >
                Delete
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const isLoading = orgLoading || schedulesQuery.isLoading;

  return (
    <PageContainer
      title="Schedules"
      description={
        activeOrganisation
          ? `Orchestrate one-time and timezone-aware recurring cron schedules for ${activeOrganisation.name}`
          : 'Loading organisation schedules…'
      }
      actions={
        <>
          {!canManage && <StatusBadge status="MEMBER" label={`${role} · Read-only`} tone="slate" />}
          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${schedulesQuery.isFetching ? 'animate-spin' : ''}`}
              />
            }
            onClick={() => {
              void schedulesQuery.refetch();
              void queuesQuery.refetch();
            }}
          >
            Refresh
          </Button>
          {canManage && (
            <>
              <Button
                variant="secondary"
                size="md"
                isLoading={reconcileMutation.isPending}
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={() => void handleReconcile()}
              >
                Reconcile Schedules
              </Button>
              <Button
                size="md"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setCreateOpen(true)}
                disabled={queues.length === 0}
              >
                Create Schedule
              </Button>
            </>
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
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
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

      {/* Search & Filters */}
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="search"
              aria-label="Search schedules"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search current page by name, processor, cron, or timezone…"
              className="w-full h-9 rounded-lg border border-border-subtle bg-canvas pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-44">
              <Select
                aria-label="Filter schedules by queue"
                value={effectiveQueueId}
                onChange={(e) => handleQueueFilterChange(e.target.value)}
                options={queueFilterOptions}
              />
            </div>

            <div className="w-44">
              <Select
                aria-label="Filter schedules by type"
                value={typeFilter}
                onChange={(e) => {
                  setTypeFilter(e.target.value);
                  setPage(1);
                }}
                options={TYPE_FILTER_OPTIONS}
              />
            </div>

            <div className="w-40">
              <Select
                aria-label="Filter schedules by status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                options={STATUS_FILTER_OPTIONS}
              />
            </div>
          </div>
        </div>
      </Card>

      {schedulesQuery.error ? (
        <ErrorState
          title="Unable to load schedules"
          message={
            schedulesQuery.error instanceof Error
              ? schedulesQuery.error.message
              : 'Failed to fetch organisation schedules'
          }
          onRetry={() => void schedulesQuery.refetch()}
        />
      ) : (
        <Card>
          <DataTable
            columns={columns}
            data={filteredSchedules}
            rowKey={(s) => s.id}
            isLoading={isLoading}
            skeletonRows={5}
            emptyState={
              <EmptyState
                icon={<CalendarClock className="h-5 w-5" />}
                title={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  typeFilter !== 'all' ||
                  effectiveQueueId !== 'all'
                    ? 'No matching schedules found'
                    : 'No schedules created yet'
                }
                description={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  typeFilter !== 'all' ||
                  effectiveQueueId !== 'all'
                    ? 'Try clearing your search or adjusting the queue, type, or status filters.'
                    : 'Create a one-time or recurring cron schedule to dispatch jobs automatically.'
                }
                action={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  typeFilter !== 'all' ||
                  effectiveQueueId !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                        setTypeFilter('all');
                        handleQueueFilterChange('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : canManage && queues.length > 0 ? (
                    <Button
                      size="sm"
                      leftIcon={<Plus className="h-4 w-4" />}
                      onClick={() => setCreateOpen(true)}
                    >
                      Create Schedule
                    </Button>
                  ) : undefined
                }
              />
            }
          />

          {/* Server-Side Pagination Footer */}
          {!isLoading && pagination && pagination.total > 0 && (
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-xs text-slate-400">
              <span>
                Showing page <span className="font-mono text-slate-200">{pagination.page}</span> of{' '}
                <span className="font-mono text-slate-200">
                  {Math.max(1, pagination.totalPages)}
                </span>{' '}
                (<span className="font-mono text-slate-200">{pagination.total}</span> total
                schedule(s))
              </span>
              {pagination.totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!pagination.hasPreviousPage}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="font-mono">
                    Page {pagination.page} of {pagination.totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!pagination.hasNextPage}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Create Schedule Modal */}
      <ScheduleFormModal
        isOpen={createOpen}
        mode="create"
        queues={queues}
        defaultQueueId={effectiveQueueId !== 'all' ? effectiveQueueId : null}
        onClose={() => setCreateOpen(false)}
        onSubmitCreate={(payload) => createMutation.mutateAsync(payload)}
        onSuccess={(_schedule, message) => setFeedback({ type: 'success', message })}
      />

      {/* Edit Schedule Modal */}
      <ScheduleFormModal
        isOpen={Boolean(editingSchedule)}
        mode="edit"
        queues={queues}
        initialSchedule={editingSchedule}
        onClose={() => setEditingSchedule(null)}
        onSubmitEdit={(scheduleId, payload) => updateMutation.mutateAsync({ scheduleId, payload })}
        onSuccess={(_schedule, message) => setFeedback({ type: 'success', message })}
      />

      {/* Cancel Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(cancellingSchedule)}
        onClose={() => setCancellingSchedule(null)}
        onConfirm={handleConfirmCancel}
        title={`Cancel Schedule "${cancellingSchedule?.name ?? ''}"?`}
        description="Cancelling permanently transitions this schedule to CANCELLED state and removes any pre-execution pending one-time job. In-flight active jobs will finish normally."
        confirmLabel="Cancel Schedule"
        destructive
        isLoading={cancelMutation.isPending}
      />

      {/* Delete Confirmation Dialog (OWNER only) */}
      <ConfirmDialog
        isOpen={Boolean(deletingSchedule)}
        onClose={() => setDeletingSchedule(null)}
        onConfirm={handleConfirmDelete}
        title={`Delete Schedule "${deletingSchedule?.name ?? ''}"?`}
        description="Deleting permanently removes this schedule and its execution history records while allowing any already in-flight jobs to complete."
        confirmLabel="Delete Schedule"
        destructive
        isLoading={deleteMutation.isPending}
      />
    </PageContainer>
  );
}

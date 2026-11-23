import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  Eye,
  Layers,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { monitoringApi } from '../../api/monitoring.api';
import { useOrganisation } from '../../contexts/OrganisationContext';
import {
  useCreateQueue,
  useDeleteQueue,
  usePauseQueue,
  useQueuesList,
  useResumeQueue,
  useUpdateQueue,
} from '../../hooks/useQueues';
import type { QueueMetricsItem, QueueView } from '../../types/api';
import { PageContainer } from '../../components/layout/PageContainer';
import { DeleteQueueModal } from '../../components/queues/DeleteQueueModal';
import { QueueFormModal } from '../../components/queues/QueueFormModal';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

type StatusFilter = 'all' | 'active' | 'paused';
type SortOption = 'created_asc' | 'created_desc' | 'name_asc' | 'jobs_desc' | 'concurrency_desc';

const STATUS_FILTER_OPTIONS = [
  { label: 'All Statuses', value: 'all' },
  { label: 'Active Only', value: 'active' },
  { label: 'Paused Only', value: 'paused' },
];

const SORT_OPTIONS = [
  { label: 'Created (Oldest)', value: 'created_asc' },
  { label: 'Created (Newest)', value: 'created_desc' },
  { label: 'Name (A–Z)', value: 'name_asc' },
  { label: 'Most Jobs', value: 'jobs_desc' },
  { label: 'Highest Concurrency', value: 'concurrency_desc' },
];

const PAGE_SIZE = 10;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function QueuesPage() {
  const { activeOrganisation, activeOrganisationId, isLoading: orgLoading } = useOrganisation();
  const role = activeOrganisation?.role ?? 'MEMBER';
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canDelete = role === 'OWNER';

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('created_asc');
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingQueue, setEditingQueue] = useState<QueueView | null>(null);
  const [pausingQueue, setPausingQueue] = useState<QueueView | null>(null);
  const [deletingQueue, setDeletingQueue] = useState<QueueView | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [actionQueueId, setActionQueueId] = useState<string | null>(null);

  const apiFilter = useMemo(() => {
    if (statusFilter === 'active') return { isPaused: false };
    if (statusFilter === 'paused') return { isPaused: true };
    return undefined;
  }, [statusFilter]);

  const queuesQuery = useQueuesList(activeOrganisationId, apiFilter);

  // Fetch organisation metrics in parallel so per-queue PENDING/ACTIVE/COMPLETED/FAILED counts are real
  const metricsQuery = useQuery({
    queryKey: ['org-metrics', activeOrganisationId, 60],
    queryFn: () => monitoringApi.getMetrics(activeOrganisationId!, 60),
    enabled: Boolean(activeOrganisationId),
  });

  const createMutation = useCreateQueue(activeOrganisationId);
  const updateMutation = useUpdateQueue(activeOrganisationId);
  const pauseMutation = usePauseQueue(activeOrganisationId);
  const resumeMutation = useResumeQueue(activeOrganisationId);
  const deleteMutation = useDeleteQueue(activeOrganisationId);

  const metricsByQueueId = useMemo(() => {
    const map = new Map<string, QueueMetricsItem>();
    for (const item of metricsQuery.data?.queues ?? []) {
      map.set(item.queueId, item);
    }
    return map;
  }, [metricsQuery.data]);

  const filteredAndSortedQueues = useMemo(() => {
    const list = queuesQuery.data ?? [];
    const normalizedSearch = searchQuery.trim().toLowerCase();

    const filtered = normalizedSearch
      ? list.filter(
          (q) =>
            q.name.toLowerCase().includes(normalizedSearch) ||
            (q.description ?? '').toLowerCase().includes(normalizedSearch),
        )
      : list;

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'name_asc':
          return a.name.localeCompare(b.name);
        case 'created_desc':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'jobs_desc':
          return b.jobCount - a.jobCount;
        case 'concurrency_desc':
          return b.concurrency - a.concurrency;
        case 'created_asc':
        default:
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
    });
  }, [queuesQuery.data, searchQuery, sortBy]);

  const totalItems = filteredAndSortedQueues.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedQueues = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredAndSortedQueues.slice(start, start + PAGE_SIZE);
  }, [filteredAndSortedQueues, safePage]);

  const handleConfirmPause = async () => {
    if (!pausingQueue) return;
    setFeedback(null);
    setActionQueueId(pausingQueue.id);
    try {
      const updated = await pauseMutation.mutateAsync(pausingQueue.id);
      setFeedback({
        type: 'success',
        message: `Queue "${updated.name}" paused. Workers will not start new jobs until resumed.`,
      });
      setPausingQueue(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to pause queue.',
      });
    } finally {
      setActionQueueId(null);
    }
  };

  const handleResume = async (queue: QueueView) => {
    setFeedback(null);
    setActionQueueId(queue.id);
    try {
      const updated = await resumeMutation.mutateAsync(queue.id);
      setFeedback({
        type: 'success',
        message: `Queue "${updated.name}" resumed and ready for processing.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to resume queue.',
      });
    } finally {
      setActionQueueId(null);
    }
  };

  const columns: DataTableColumn<QueueView>[] = [
    {
      key: 'name',
      header: 'Queue',
      render: (q) => (
        <div className="min-w-[160px]">
          <Link
            to={`/queues/${q.id}`}
            className="font-mono text-xs font-semibold text-sky-300 hover:text-sky-200 hover:underline"
          >
            {q.name}
          </Link>
          {q.description && (
            <p className="mt-0.5 max-w-xs truncate text-[11px] text-slate-400">{q.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (q) => (
        <StatusBadge
          status={q.isPaused ? 'PAUSED' : 'ACTIVE'}
          label={q.isPaused ? 'Paused' : 'Active'}
          showDot
        />
      ),
    },
    {
      key: 'config',
      header: 'Config (Conc / Prio / Retry / Backoff)',
      render: (q) => (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-slate-300 tabular-nums">
          <span title="Concurrency">{q.concurrency}c</span>
          <span className="text-slate-600">·</span>
          <span title="Default Priority">p{q.defaultPriority}</span>
          <span className="text-slate-600">·</span>
          <span title="Max Retries">{q.maxRetries}r</span>
          <span className="text-slate-600">·</span>
          <span title="Backoff Duration">{q.backoffMs}ms</span>
        </div>
      ),
    },
    {
      key: 'pending',
      header: 'Pending',
      align: 'right',
      render: (q) => {
        const count = metricsByQueueId.get(q.id)?.byStatus.PENDING ?? 0;
        return <span className="font-mono text-xs tabular-nums text-amber-300">{count}</span>;
      },
    },
    {
      key: 'active',
      header: 'Active',
      align: 'right',
      render: (q) => {
        const count = metricsByQueueId.get(q.id)?.byStatus.ACTIVE ?? 0;
        return <span className="font-mono text-xs tabular-nums text-sky-300">{count}</span>;
      },
    },
    {
      key: 'completed',
      header: 'Completed',
      align: 'right',
      render: (q) => {
        const count = metricsByQueueId.get(q.id)?.byStatus.COMPLETED ?? 0;
        return <span className="font-mono text-xs tabular-nums text-emerald-300">{count}</span>;
      },
    },
    {
      key: 'failed',
      header: 'Failed',
      align: 'right',
      render: (q) => {
        const count = metricsByQueueId.get(q.id)?.byStatus.FAILED ?? 0;
        return (
          <span
            className={`font-mono text-xs tabular-nums ${
              count > 0 ? 'text-rose-300 font-semibold' : 'text-slate-400'
            }`}
          >
            {count}
          </span>
        );
      },
    },
    {
      key: 'createdAt',
      header: 'Created',
      align: 'right',
      render: (q) => (
        <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
          {formatDate(q.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (q) => {
        const isBusy = actionQueueId === q.id;
        return (
          <div className="flex items-center justify-end gap-1">
            <Link to={`/queues/${q.id}`} aria-label={`View ${q.name}`}>
              <Button variant="ghost" size="sm" leftIcon={<Eye className="h-3.5 w-3.5" />}>
                View
              </Button>
            </Link>

            {canManage && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${q.name}`}
                  onClick={() => setEditingQueue(q)}
                  leftIcon={<Pencil className="h-3.5 w-3.5" />}
                >
                  Edit
                </Button>

                {q.isPaused ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Resume ${q.name}`}
                    disabled={isBusy}
                    isLoading={isBusy && resumeMutation.isPending}
                    onClick={() => void handleResume(q)}
                    leftIcon={<Play className="h-3.5 w-3.5 text-emerald-400" />}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Pause ${q.name}`}
                    disabled={isBusy}
                    onClick={() => setPausingQueue(q)}
                    leftIcon={<Pause className="h-3.5 w-3.5 text-amber-400" />}
                  >
                    Pause
                  </Button>
                )}
              </>
            )}

            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${q.name}`}
                onClick={() => setDeletingQueue(q)}
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

  const isLoading = orgLoading || queuesQuery.isLoading;

  return (
    <PageContainer
      title="Queues"
      description={
        activeOrganisation
          ? `Manage job queues, concurrency, retry policies, and execution state for ${activeOrganisation.name}`
          : 'Loading organisation queues…'
      }
      actions={
        <>
          {!canManage && <StatusBadge status="MEMBER" label={`${role} · Read-only`} tone="slate" />}
          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${queuesQuery.isFetching ? 'animate-spin' : ''}`}
              />
            }
            onClick={() => {
              void queuesQuery.refetch();
              void metricsQuery.refetch();
            }}
          >
            Refresh
          </Button>
          {canManage && (
            <Button
              size="md"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setCreateOpen(true)}
            >
              Create Queue
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
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
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

      {/* Search, Status Filter & Sort Bar */}
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="search"
              aria-label="Search queues by name"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search queues by name or description…"
              className="w-full h-9 rounded-lg border border-border-subtle bg-canvas pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-40">
              <Select
                aria-label="Filter by queue status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as StatusFilter);
                  setPage(1);
                }}
                options={STATUS_FILTER_OPTIONS}
              />
            </div>

            <div className="w-48">
              <Select
                aria-label="Sort queues"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                options={SORT_OPTIONS}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Main Queue Table / Error / Empty States */}
      {queuesQuery.error ? (
        <ErrorState
          title="Unable to load queues"
          message={
            queuesQuery.error instanceof Error
              ? queuesQuery.error.message
              : 'Failed to fetch organisation queues'
          }
          onRetry={() => void queuesQuery.refetch()}
        />
      ) : (
        <Card>
          <DataTable
            columns={columns}
            data={paginatedQueues}
            rowKey={(q) => q.id}
            isLoading={isLoading}
            skeletonRows={5}
            emptyState={
              <EmptyState
                icon={<Layers className="h-5 w-5" />}
                title={
                  searchQuery || statusFilter !== 'all'
                    ? 'No matching queues found'
                    : 'No queues created yet'
                }
                description={
                  searchQuery || statusFilter !== 'all'
                    ? 'Try clearing your search filter or changing the status filter.'
                    : 'Create your first queue to configure concurrency, retry backoff, and start processing jobs.'
                }
                action={
                  searchQuery || statusFilter !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : canManage ? (
                    <Button
                      size="sm"
                      leftIcon={<Plus className="h-4 w-4" />}
                      onClick={() => setCreateOpen(true)}
                    >
                      Create Queue
                    </Button>
                  ) : undefined
                }
              />
            }
          />

          {/* Pagination Footer */}
          {!isLoading && totalItems > 0 && (
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-xs text-slate-400">
              <span>
                Showing{' '}
                <span className="font-mono text-slate-200">
                  {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, totalItems)}
                </span>{' '}
                of <span className="font-mono text-slate-200">{totalItems}</span> queue(s)
              </span>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="font-mono">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Create Queue Modal */}
      <QueueFormModal
        isOpen={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSubmitCreate={(payload) => createMutation.mutateAsync(payload)}
        onSuccess={(_queue, message) => setFeedback({ type: 'success', message })}
      />

      {/* Edit Queue Modal */}
      <QueueFormModal
        isOpen={Boolean(editingQueue)}
        mode="edit"
        initialQueue={editingQueue}
        onClose={() => setEditingQueue(null)}
        onSubmitEdit={(queueId, payload) => updateMutation.mutateAsync({ queueId, payload })}
        onSuccess={(_queue, message) => setFeedback({ type: 'success', message })}
      />

      {/* Pause Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(pausingQueue)}
        onClose={() => setPausingQueue(null)}
        onConfirm={handleConfirmPause}
        title={`Pause Queue "${pausingQueue?.name ?? ''}"?`}
        description="Pausing stops workers from starting new jobs on this queue. Newly submitted jobs will be held in PAUSED state until the queue is resumed."
        confirmLabel="Pause Queue"
        isLoading={pauseMutation.isPending}
      />

      {/* Delete Queue Modal */}
      <DeleteQueueModal
        isOpen={Boolean(deletingQueue)}
        queue={deletingQueue}
        onClose={() => setDeletingQueue(null)}
        onConfirmDelete={(queueId) => deleteMutation.mutateAsync(queueId)}
        onSuccess={(message) => setFeedback({ type: 'success', message })}
      />
    </PageContainer>
  );
}

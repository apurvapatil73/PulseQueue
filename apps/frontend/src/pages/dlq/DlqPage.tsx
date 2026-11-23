import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertOctagon, CheckCircle2, Eye, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useDlqList, useReplayDlqJob } from '../../hooks/useDlq';
import { useQueuesList } from '../../hooks/useQueues';
import type { DeadLetterJobView, DeadLetterStatus } from '../../types/api';
import { DlqDetailModal, extractPayloadSummary } from '../../components/dlq/DlqDetailModal';
import { ReplayDlqModal } from '../../components/dlq/ReplayDlqModal';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

const STATUS_FILTER_OPTIONS = [
  { label: 'All Statuses', value: 'all' },
  { label: 'Open (Unresolved)', value: 'OPEN' },
  { label: 'Replayed', value: 'REPLAYED' },
];

const PAGE_SIZE = 15;

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function DlqPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQueueParam = searchParams.get('queueId') ?? 'all';

  const { activeOrganisation, activeOrganisationId, isLoading: orgLoading } = useOrganisation();
  const role = activeOrganisation?.role ?? 'MEMBER';
  const canReplay = role === 'OWNER' || role === 'ADMIN';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedQueueId, setSelectedQueueId] = useState<string>(initialQueueParam);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [processorFilter, setProcessorFilter] = useState<string>('all');
  const [page, setPage] = useState(1);

  const [inspectingItem, setInspectingItem] = useState<DeadLetterJobView | null>(null);
  const [replayingItem, setReplayingItem] = useState<DeadLetterJobView | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
    replayedJobId?: string;
  } | null>(null);

  const queuesQuery = useQueuesList(activeOrganisationId);
  const queues = queuesQuery.data ?? [];

  const effectiveQueueId =
    selectedQueueId !== 'all' && queues.some((q) => q.id === selectedQueueId)
      ? selectedQueueId
      : 'all';

  const dlqQuery = useDlqList(activeOrganisationId, {
    status: statusFilter !== 'all' ? (statusFilter as DeadLetterStatus) : undefined,
    queueId: effectiveQueueId !== 'all' ? effectiveQueueId : undefined,
    page,
    limit: PAGE_SIZE,
  });

  const replayMutation = useReplayDlqJob(activeOrganisationId);

  const items = dlqQuery.data?.items ?? [];
  const pagination = dlqQuery.data?.pagination;

  const processorOptions = useMemo(() => {
    const names = Array.from(new Set(items.map((item) => item.jobName))).sort();
    return [
      { label: 'All Processors', value: 'all' },
      ...names.map((name) => ({ label: name, value: name })),
    ];
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (processorFilter !== 'all' && item.jobName !== processorFilter) {
        return false;
      }
      if (!q) return true;
      return (
        item.id.toLowerCase().includes(q) ||
        item.originalJobId.toLowerCase().includes(q) ||
        (item.replayedJobId ?? '').toLowerCase().includes(q) ||
        item.jobName.toLowerCase().includes(q) ||
        item.queueName.toLowerCase().includes(q) ||
        item.failureReason.toLowerCase().includes(q)
      );
    });
  }, [items, processorFilter, searchQuery]);

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

  const queueFilterOptions = useMemo(
    () => [
      { label: 'All Queues', value: 'all' },
      ...queues.map((q) => ({ label: q.name, value: q.id })),
    ],
    [queues],
  );

  const columns: DataTableColumn<DeadLetterJobView>[] = [
    {
      key: 'job',
      header: 'Failed Job & Processor',
      render: (item) => (
        <div className="min-w-[175px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-slate-100">{item.jobName}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
            <span>Job:</span>
            <Link
              to={`/jobs/${item.originalJobId}`}
              className="text-sky-300 hover:text-sky-200 hover:underline"
              title={`Inspect original job ${item.originalJobId}`}
            >
              {item.originalJobId.slice(0, 8)}…{item.originalJobId.slice(-4)}
            </Link>
          </div>
        </div>
      ),
    },
    {
      key: 'queue',
      header: 'Queue',
      render: (item) => (
        <Link
          to={`/queues/${item.queueId}`}
          className="font-mono text-xs text-slate-300 hover:text-sky-300 hover:underline"
        >
          {item.queueName}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item) => <StatusBadge status={item.status} showDot />,
    },
    {
      key: 'failureReason',
      header: 'Failure Reason',
      render: (item) => (
        <p className="max-w-xs truncate font-mono text-xs text-rose-200" title={item.failureReason}>
          {item.failureReason}
        </p>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      render: (item) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {item.attemptsMade} / {item.maxRetries + 1}
        </span>
      ),
    },
    {
      key: 'payloadSummary',
      header: 'Payload Summary',
      render: (item) => {
        const summary = extractPayloadSummary(item.payloadSummary);
        return (
          <div className="font-mono text-[11px] text-slate-400">
            <span>
              {summary.keyCount} key(s) · {summary.byteLength} B
            </span>
            {summary.keys.length > 0 && (
              <p className="max-w-[160px] truncate text-[10px] text-slate-500">
                {summary.keys.join(', ')}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: 'timestamps',
      header: 'Failed / Replayed At',
      render: (item) => (
        <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
          <div>Failed: {formatTimestamp(item.failedAt)}</div>
          {item.status === 'REPLAYED' && (
            <div className="text-sky-300">
              Replayed: {formatTimestamp(item.replayedAt)}
              {item.replayedJobId && (
                <>
                  {' '}
                  (
                  <Link to={`/jobs/${item.replayedJobId}`} className="underline hover:text-sky-200">
                    {item.replayedJobId.slice(0, 8)}
                  </Link>
                  )
                </>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (item) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Inspect DLQ job ${item.jobName}`}
            onClick={() => setInspectingItem(item)}
            leftIcon={<Eye className="h-3.5 w-3.5" />}
          >
            Inspect
          </Button>

          {canReplay && item.status === 'OPEN' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Replay DLQ job ${item.jobName}`}
              onClick={() => setReplayingItem(item)}
              className="text-sky-300 hover:text-sky-200"
              leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
            >
              Replay
            </Button>
          )}
        </div>
      ),
    },
  ];

  const isLoading = orgLoading || dlqQuery.isLoading;

  return (
    <PageContainer
      title="Dead Letter Queue"
      description={
        activeOrganisation
          ? `Inspect permanently failed jobs after exhausted retries and safely replay them in ${activeOrganisation.name}`
          : 'Loading organisation dead-letter queue…'
      }
      actions={
        <>
          {!canReplay && <StatusBadge status="MEMBER" label={`${role} · Read-only`} tone="slate" />}
          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw className={`h-3.5 w-3.5 ${dlqQuery.isFetching ? 'animate-spin' : ''}`} />
            }
            onClick={() => {
              void dlqQuery.refetch();
              void queuesQuery.refetch();
            }}
          >
            Refresh
          </Button>
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
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{feedback.message}</span>
                {feedback.replayedJobId && (
                  <Link
                    to={`/jobs/${feedback.replayedJobId}`}
                    className="font-mono font-semibold text-emerald-100 underline hover:text-white"
                  >
                    View Replayed Job
                  </Link>
                )}
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

      {/* Search & Multi-Filter Bar */}
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="search"
              aria-label="Search dead-letter jobs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by job ID, processor, queue, or failure reason…"
              className="w-full h-9 rounded-lg border border-border-subtle bg-canvas pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-44">
              <Select
                aria-label="Filter DLQ by queue"
                value={effectiveQueueId}
                onChange={(e) => handleQueueFilterChange(e.target.value)}
                options={queueFilterOptions}
              />
            </div>

            <div className="w-44">
              <Select
                aria-label="Filter DLQ by status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                options={STATUS_FILTER_OPTIONS}
              />
            </div>

            <div className="w-44">
              <Select
                aria-label="Filter DLQ by processor"
                value={processorFilter}
                onChange={(e) => setProcessorFilter(e.target.value)}
                options={processorOptions}
              />
            </div>
          </div>
        </div>
      </Card>

      {dlqQuery.error ? (
        <ErrorState
          title="Unable to load dead-letter queue"
          message={
            dlqQuery.error instanceof Error
              ? dlqQuery.error.message
              : 'Failed to fetch organisation dead-letter records'
          }
          onRetry={() => void dlqQuery.refetch()}
        />
      ) : (
        <Card>
          <DataTable
            columns={columns}
            data={filteredItems}
            rowKey={(item) => item.id}
            isLoading={isLoading}
            skeletonRows={5}
            emptyState={
              <EmptyState
                icon={<AlertOctagon className="h-5 w-5" />}
                title={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  processorFilter !== 'all' ||
                  effectiveQueueId !== 'all'
                    ? 'No matching dead-letter records found'
                    : 'No dead-letter jobs recorded'
                }
                description={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  processorFilter !== 'all' ||
                  effectiveQueueId !== 'all'
                    ? 'Try clearing your search or resetting the queue, status, and processor filters.'
                    : 'Jobs that permanently exhaust all retry attempts are automatically routed here for inspection and safe replay.'
                }
                action={
                  searchQuery ||
                  statusFilter !== 'all' ||
                  processorFilter !== 'all' ||
                  effectiveQueueId !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                        setProcessorFilter('all');
                        handleQueueFilterChange('all');
                      }}
                    >
                      Clear filters
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
                (<span className="font-mono text-slate-200">{pagination.total}</span> total DLQ
                record(s))
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

      {/* Inspect DLQ Details Modal */}
      <DlqDetailModal
        isOpen={Boolean(inspectingItem)}
        organisationId={activeOrganisationId}
        dlqItem={inspectingItem}
        canReplay={canReplay}
        onClose={() => setInspectingItem(null)}
        onOpenReplay={(item) => setReplayingItem(item)}
      />

      {/* Replay Confirmation & Overrides Modal */}
      <ReplayDlqModal
        isOpen={Boolean(replayingItem)}
        organisationId={activeOrganisationId}
        dlqItem={replayingItem}
        onClose={() => setReplayingItem(null)}
        onConfirmReplay={(dlqId, overrides) => replayMutation.mutateAsync({ dlqId, overrides })}
        onSuccess={(result, message) =>
          setFeedback({
            type: 'success',
            message,
            replayedJobId: result.replayedJob.id,
          })
        }
      />
    </PageContainer>
  );
}

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Ban, CheckCircle2, Eye, ListChecks, Plus, RefreshCw, Search } from 'lucide-react';
import { isCancellableJobStatus } from '../../api/job.api';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useCancelJob, useOrganisationJobs, useQueueJobs, useSubmitJob } from '../../hooks/useJobs';
import { useQueuesList } from '../../hooks/useQueues';
import type { JobStatus, JobView } from '../../types/api';
import { CancelJobModal } from '../../components/jobs/CancelJobModal';
import { SubmitJobModal } from '../../components/jobs/SubmitJobModal';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';

type PriorityBand = 'all' | 'high' | 'standard' | 'low';
type SortMode = 'created_desc' | 'created_asc' | 'priority_asc' | 'duration_desc';

const STATUS_OPTIONS = [
  { label: 'All Statuses', value: 'all' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Delayed', value: 'DELAYED' },
  { label: 'Paused', value: 'PAUSED' },
];

const PRIORITY_OPTIONS = [
  { label: 'All Priorities', value: 'all' },
  { label: 'High (1–5)', value: 'high' },
  { label: 'Standard (6–12)', value: 'standard' },
  { label: 'Low (13–20)', value: 'low' },
];

const SORT_OPTIONS = [
  { label: 'Created (Newest)', value: 'created_desc' },
  { label: 'Created (Oldest)', value: 'created_asc' },
  { label: 'Priority (1 → 20)', value: 'priority_asc' },
  { label: 'Duration (Longest)', value: 'duration_desc' },
];

const PAGE_SIZE = 12;

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

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQueueParam = searchParams.get('queueId') ?? 'all';

  const { activeOrganisation, activeOrganisationId, isLoading: orgLoading } = useOrganisation();
  const role = activeOrganisation?.role ?? 'MEMBER';
  const canCancel = role === 'OWNER' || role === 'ADMIN';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedQueueId, setSelectedQueueId] = useState<string>(initialQueueParam);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityBand, setPriorityBand] = useState<PriorityBand>('all');
  const [sortMode, setSortMode] = useState<SortMode>('created_desc');
  const [page, setPage] = useState(1);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [cancellingJob, setCancellingJob] = useState<JobView | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );

  const queuesQuery = useQueuesList(activeOrganisationId);
  const queues = queuesQuery.data ?? [];
  const allQueueIds = useMemo(() => queues.map((q) => q.id), [queues]);

  const effectiveQueueId =
    selectedQueueId !== 'all' && queues.some((q) => q.id === selectedQueueId)
      ? selectedQueueId
      : 'all';

  const apiStatus = statusFilter !== 'all' ? (statusFilter as JobStatus) : undefined;
  const apiSortOrder = sortMode === 'created_asc' ? 'asc' : 'desc';

  const singleQueueJobsQuery = useQueueJobs(
    activeOrganisationId,
    effectiveQueueId !== 'all' ? effectiveQueueId : null,
    {
      status: apiStatus,
      page: 1,
      limit: 100,
      sortOrder: apiSortOrder,
    },
  );

  const allQueuesJobsQuery = useOrganisationJobs(
    activeOrganisationId,
    allQueueIds,
    {
      status: apiStatus,
      sortOrder: apiSortOrder,
    },
    effectiveQueueId === 'all' && !queuesQuery.isLoading,
  );

  const submitMutation = useSubmitJob(activeOrganisationId);
  const cancelMutation = useCancelJob(activeOrganisationId);

  const rawJobs = useMemo(() => {
    if (effectiveQueueId !== 'all') {
      return singleQueueJobsQuery.data?.jobs ?? [];
    }
    return allQueuesJobsQuery.data ?? [];
  }, [effectiveQueueId, singleQueueJobsQuery.data, allQueuesJobsQuery.data]);

  const filteredAndSortedJobs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const filtered = rawJobs.filter((job) => {
      if (q) {
        const matchesId = job.id.toLowerCase().includes(q);
        const matchesName = job.name.toLowerCase().includes(q);
        const matchesQueue = job.queueName.toLowerCase().includes(q);
        if (!matchesId && !matchesName && !matchesQueue) return false;
      }

      if (priorityBand === 'high' && job.priority > 5) return false;
      if (priorityBand === 'standard' && (job.priority < 6 || job.priority > 12)) return false;
      if (priorityBand === 'low' && job.priority < 13) return false;

      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (sortMode) {
        case 'created_asc':
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case 'priority_asc':
          return a.priority - b.priority;
        case 'duration_desc':
          return (b.durationMs ?? -1) - (a.durationMs ?? -1);
        case 'created_desc':
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });
  }, [rawJobs, searchQuery, priorityBand, sortMode]);

  const totalItems = filteredAndSortedJobs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedJobs = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredAndSortedJobs.slice(start, start + PAGE_SIZE);
  }, [filteredAndSortedJobs, safePage]);

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

  const handleRefresh = () => {
    void queuesQuery.refetch();
    if (effectiveQueueId !== 'all') {
      void singleQueueJobsQuery.refetch();
    } else {
      void allQueuesJobsQuery.refetch();
    }
  };

  const queueFilterOptions = useMemo(
    () => [
      { label: 'All Queues', value: 'all' },
      ...queues.map((q) => ({ label: q.name, value: q.id })),
    ],
    [queues],
  );

  const columns: DataTableColumn<JobView>[] = [
    {
      key: 'id',
      header: 'Job ID & Type',
      render: (job) => (
        <div className="min-w-[170px]">
          <Link
            to={`/jobs/${job.id}`}
            className="font-mono text-xs font-semibold text-sky-300 hover:text-sky-200 hover:underline"
          >
            {job.name}
          </Link>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500" title={job.id}>
            {job.id.slice(0, 8)}…{job.id.slice(-4)}
          </p>
        </div>
      ),
    },
    {
      key: 'queue',
      header: 'Queue',
      render: (job) => (
        <Link
          to={`/queues/${job.queueId}`}
          className="font-mono text-xs text-slate-300 hover:text-sky-300 hover:underline"
        >
          {job.queueName}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (job) => <StatusBadge status={job.status} showDot />,
    },
    {
      key: 'priority',
      header: 'Priority',
      align: 'right',
      render: (job) => (
        <span className="font-mono text-xs tabular-nums text-slate-200">p{job.priority}</span>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      render: (job) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {job.attemptsMade} / {job.maxRetries + 1}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      render: (job) => (
        <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
          {formatTimestamp(job.createdAt)}
        </span>
      ),
    },
    {
      key: 'execution',
      header: 'Started / Finished',
      render: (job) => {
        const finished = job.completedAt ?? job.failedAt;
        return (
          <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
            <div>Start: {formatTimestamp(job.startedAt)}</div>
            <div>End: {formatTimestamp(finished)}</div>
          </div>
        );
      },
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (job) => (
        <span className="font-mono text-xs tabular-nums text-slate-300">
          {formatDuration(job.durationMs)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (job) => {
        const cancellable = isCancellableJobStatus(job.status);
        return (
          <div className="flex items-center justify-end gap-1">
            <Link to={`/jobs/${job.id}`} aria-label={`View job ${job.name}`}>
              <Button variant="ghost" size="sm" leftIcon={<Eye className="h-3.5 w-3.5" />}>
                View
              </Button>
            </Link>

            {canCancel && cancellable && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Cancel job ${job.name}`}
                onClick={() => setCancellingJob(job)}
                className="text-rose-300 hover:text-rose-200"
                leftIcon={<Ban className="h-3.5 w-3.5" />}
              >
                Cancel
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const isLoading =
    orgLoading ||
    queuesQuery.isLoading ||
    (effectiveQueueId !== 'all' ? singleQueueJobsQuery.isLoading : allQueuesJobsQuery.isLoading);

  const isFetching =
    queuesQuery.isFetching || singleQueueJobsQuery.isFetching || allQueuesJobsQuery.isFetching;

  const activeError =
    queuesQuery.error ??
    (effectiveQueueId !== 'all' ? singleQueueJobsQuery.error : allQueuesJobsQuery.error);

  return (
    <PageContainer
      title="Jobs"
      description={
        activeOrganisation
          ? `Submit, monitor, and control distributed jobs across queues in ${activeOrganisation.name}`
          : 'Loading organisation jobs…'
      }
      actions={
        <>
          <Button
            variant="secondary"
            size="md"
            leftIcon={<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
          <Button
            size="md"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setSubmitOpen(true)}
            disabled={queues.length === 0}
          >
            Submit Job
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

      {/* Search & Multi-Filter Bar */}
      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              type="search"
              aria-label="Search jobs by ID or name"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search by job ID, processor name, or queue…"
              className="w-full h-9 rounded-lg border border-border-subtle bg-canvas pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-44">
              <Select
                aria-label="Filter by queue"
                value={effectiveQueueId}
                onChange={(e) => handleQueueFilterChange(e.target.value)}
                options={queueFilterOptions}
              />
            </div>

            <div className="w-36">
              <Select
                aria-label="Filter by job status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
              />
            </div>

            <div className="w-40">
              <Select
                aria-label="Filter by priority"
                value={priorityBand}
                onChange={(e) => {
                  setPriorityBand(e.target.value as PriorityBand);
                  setPage(1);
                }}
                options={PRIORITY_OPTIONS}
              />
            </div>

            <div className="w-44">
              <Select
                aria-label="Sort jobs"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                options={SORT_OPTIONS}
              />
            </div>
          </div>
        </div>
      </Card>

      {activeError ? (
        <ErrorState
          title="Unable to load jobs"
          message={
            activeError instanceof Error ? activeError.message : 'Failed to fetch organisation jobs'
          }
          onRetry={handleRefresh}
        />
      ) : (
        <Card>
          <DataTable
            columns={columns}
            data={paginatedJobs}
            rowKey={(j) => j.id}
            isLoading={isLoading}
            skeletonRows={6}
            emptyState={
              <EmptyState
                icon={<ListChecks className="h-5 w-5" />}
                title={
                  queues.length === 0
                    ? 'Create a queue before submitting jobs'
                    : searchQuery ||
                        statusFilter !== 'all' ||
                        priorityBand !== 'all' ||
                        effectiveQueueId !== 'all'
                      ? 'No matching jobs found'
                      : 'No jobs submitted yet'
                }
                description={
                  queues.length === 0
                    ? 'Every job belongs to an organisation queue. Create a queue first in the Queues module.'
                    : searchQuery ||
                        statusFilter !== 'all' ||
                        priorityBand !== 'all' ||
                        effectiveQueueId !== 'all'
                      ? 'Try adjusting or clearing your search, queue, status, or priority filters.'
                      : 'Submit a job to test echo, math.sum, transform.json, or custom worker processors.'
                }
                action={
                  queues.length === 0 ? (
                    <Link to="/queues">
                      <Button size="sm">Go to Queues</Button>
                    </Link>
                  ) : searchQuery ||
                    statusFilter !== 'all' ||
                    priorityBand !== 'all' ||
                    effectiveQueueId !== 'all' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery('');
                        setStatusFilter('all');
                        setPriorityBand('all');
                        handleQueueFilterChange('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      leftIcon={<Plus className="h-4 w-4" />}
                      onClick={() => setSubmitOpen(true)}
                    >
                      Submit Job
                    </Button>
                  )
                }
              />
            }
          />

          {!isLoading && totalItems > 0 && (
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3 text-xs text-slate-400">
              <span>
                Showing{' '}
                <span className="font-mono text-slate-200">
                  {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, totalItems)}
                </span>{' '}
                of <span className="font-mono text-slate-200">{totalItems}</span> job(s)
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

      <SubmitJobModal
        isOpen={submitOpen}
        queues={queues}
        defaultQueueId={effectiveQueueId !== 'all' ? effectiveQueueId : null}
        onClose={() => setSubmitOpen(false)}
        onSubmitJob={(queueId, payload) => submitMutation.mutateAsync({ queueId, payload })}
        onSuccess={(_res, message) => setFeedback({ type: 'success', message })}
      />

      <CancelJobModal
        isOpen={Boolean(cancellingJob)}
        job={cancellingJob}
        onClose={() => setCancellingJob(null)}
        onConfirmCancel={(jobId) => cancelMutation.mutateAsync({ jobId })}
        onSuccess={(message) => setFeedback({ type: 'success', message })}
      />
    </PageContainer>
  );
}

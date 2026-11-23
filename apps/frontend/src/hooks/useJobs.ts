import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jobApi, type CreateJobPayload, type ListQueueJobsParams } from '../api/job.api';
import { monitoringApi } from '../api/monitoring.api';
import type { JobStatus } from '../types/api';

export function useQueueJobs(
  organisationId: string | null,
  queueId: string | null,
  params: ListQueueJobsParams = {},
) {
  return useQuery({
    queryKey: [
      'jobs',
      organisationId,
      'queue',
      queueId,
      params.status ?? 'all',
      params.page ?? 1,
      params.limit ?? 20,
      params.sortOrder ?? 'desc',
    ],
    queryFn: () => jobApi.listByQueue(organisationId!, queueId!, params),
    enabled: Boolean(organisationId && queueId),
  });
}

export function useOrganisationJobs(
  organisationId: string | null,
  queueIds: string[],
  params: { status?: JobStatus; sortOrder?: 'asc' | 'desc' } = {},
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: [
      'jobs',
      organisationId,
      'all-queues',
      queueIds.join(','),
      params.status ?? 'all',
      params.sortOrder ?? 'desc',
    ],
    queryFn: () => jobApi.listAcrossQueues(organisationId!, queueIds, params),
    enabled: Boolean(organisationId) && enabled,
  });
}

export function useJobDetail(organisationId: string | null, jobId: string | null) {
  return useQuery({
    queryKey: ['job', organisationId, jobId],
    queryFn: () => jobApi.getById(organisationId!, jobId!),
    enabled: Boolean(organisationId && jobId),
  });
}

export function useJobEvents(organisationId: string | null, jobId: string | null) {
  return useQuery({
    queryKey: ['job-events', organisationId, jobId],
    queryFn: () => monitoringApi.listEvents(organisationId!, { jobId: jobId!, page: 1, limit: 50 }),
    enabled: Boolean(organisationId && jobId),
  });
}

function invalidateJobAndQueueQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organisationId: string | null,
  queueId?: string,
  jobId?: string,
) {
  if (!organisationId) return;
  void queryClient.invalidateQueries({ queryKey: ['jobs', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['queues', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-metrics', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-events', organisationId] });
  if (queueId) {
    void queryClient.invalidateQueries({ queryKey: ['queue', organisationId, queueId] });
    void queryClient.invalidateQueries({ queryKey: ['queue-stats', organisationId, queueId] });
  }
  if (jobId) {
    void queryClient.invalidateQueries({ queryKey: ['job', organisationId, jobId] });
    void queryClient.invalidateQueries({ queryKey: ['job-events', organisationId, jobId] });
  }
}

export function useSubmitJob(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ queueId, payload }: { queueId: string; payload: CreateJobPayload }) =>
      jobApi.submit(organisationId!, queueId, payload),
    onSuccess: (result) => {
      invalidateJobAndQueueQueries(queryClient, organisationId, result.job.queueId, result.job.id);
    },
  });
}

export function useCancelJob(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId }: { jobId: string; queueId?: string }) =>
      jobApi.cancel(organisationId!, jobId),
    onSuccess: (result) => {
      invalidateJobAndQueueQueries(queryClient, organisationId, result.queueId, result.jobId);
    },
  });
}

import type {
  ApiEnvelope,
  CancelJobResult,
  JobStatus,
  JobSubmissionResult,
  JobView,
  PaginationMeta,
} from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export interface CreateJobPayload {
  name: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  backoffMs?: number;
  delayMs?: number;
}

export interface ListQueueJobsParams {
  status?: JobStatus;
  page?: number;
  limit?: number;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedJobsResponse {
  jobs: JobView[];
  pagination: PaginationMeta;
}

export const CANCELLABLE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'PENDING',
  'DELAYED',
  'PAUSED',
]);

export function isCancellableJobStatus(status: JobStatus): boolean {
  return CANCELLABLE_JOB_STATUSES.has(status);
}

export const jobApi = {
  async listByQueue(
    organisationId: string,
    queueId: string,
    params: ListQueueJobsParams = {},
  ): Promise<PaginatedJobsResponse> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedJobsResponse>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}/jobs`,
      { params },
    );
    return unwrapApiData(data);
  },

  async listAcrossQueues(
    organisationId: string,
    queueIds: string[],
    params: { status?: JobStatus; sortOrder?: 'asc' | 'desc'; perQueueLimit?: number } = {},
  ): Promise<JobView[]> {
    if (queueIds.length === 0) {
      return [];
    }

    const limit = params.perQueueLimit ?? 100;
    const sortOrder = params.sortOrder ?? 'desc';

    const results = await Promise.all(
      queueIds.map((qId) =>
        jobApi.listByQueue(organisationId, qId, {
          status: params.status,
          page: 1,
          limit,
          sortOrder,
        }),
      ),
    );

    const combined = results.flatMap((r) => r.jobs);
    return combined.sort((a, b) => {
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === 'asc' ? diff : -diff;
    });
  },

  async getById(organisationId: string, jobId: string): Promise<JobView> {
    const { data } = await apiClient.get<ApiEnvelope<{ job: JobView }>>(
      `/api/v1/organisations/${organisationId}/jobs/${jobId}`,
    );
    return unwrapApiData(data).job;
  },

  async submit(
    organisationId: string,
    queueId: string,
    payload: CreateJobPayload,
  ): Promise<JobSubmissionResult> {
    const { data } = await apiClient.post<ApiEnvelope<JobSubmissionResult>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}/jobs`,
      payload,
    );
    return unwrapApiData(data);
  },

  async cancel(organisationId: string, jobId: string): Promise<CancelJobResult> {
    const { data } = await apiClient.post<ApiEnvelope<CancelJobResult>>(
      `/api/v1/organisations/${organisationId}/jobs/${jobId}/cancel`,
      {},
    );
    return unwrapApiData(data);
  },
};

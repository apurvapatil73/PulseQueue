import type { ApiEnvelope, QueueStatsView, QueueView } from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export interface CreateQueuePayload {
  name: string;
  description?: string | null;
  concurrency: number;
  defaultPriority: number;
  maxRetries: number;
  backoffMs: number;
}

export interface UpdateQueuePayload {
  name?: string;
  description?: string | null;
  concurrency?: number;
  defaultPriority?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface ListQueuesFilters {
  isPaused?: boolean;
}

export const queueApi = {
  async list(organisationId: string, filters?: ListQueuesFilters): Promise<QueueView[]> {
    const params: Record<string, string> = {};
    if (filters?.isPaused !== undefined) {
      params.isPaused = String(filters.isPaused);
    }
    const { data } = await apiClient.get<ApiEnvelope<{ queues: QueueView[] }>>(
      `/api/v1/organisations/${organisationId}/queues`,
      { params },
    );
    return unwrapApiData(data).queues;
  },

  async getById(organisationId: string, queueId: string): Promise<QueueView> {
    const { data } = await apiClient.get<ApiEnvelope<{ queue: QueueView }>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}`,
    );
    return unwrapApiData(data).queue;
  },

  async getStats(organisationId: string, queueId: string): Promise<QueueStatsView> {
    const { data } = await apiClient.get<ApiEnvelope<{ stats: QueueStatsView }>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}/stats`,
    );
    return unwrapApiData(data).stats;
  },

  async create(organisationId: string, payload: CreateQueuePayload): Promise<QueueView> {
    const { data } = await apiClient.post<ApiEnvelope<{ queue: QueueView }>>(
      `/api/v1/organisations/${organisationId}/queues`,
      payload,
    );
    return unwrapApiData(data).queue;
  },

  async update(
    organisationId: string,
    queueId: string,
    payload: UpdateQueuePayload,
  ): Promise<QueueView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ queue: QueueView }>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}`,
      payload,
    );
    return unwrapApiData(data).queue;
  },

  async pause(organisationId: string, queueId: string): Promise<QueueView> {
    const { data } = await apiClient.post<ApiEnvelope<{ queue: QueueView }>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}/pause`,
      {},
    );
    return unwrapApiData(data).queue;
  },

  async resume(organisationId: string, queueId: string): Promise<QueueView> {
    const { data } = await apiClient.post<ApiEnvelope<{ queue: QueueView }>>(
      `/api/v1/organisations/${organisationId}/queues/${queueId}/resume`,
      {},
    );
    return unwrapApiData(data).queue;
  },

  async delete(organisationId: string, queueId: string): Promise<void> {
    await apiClient.delete(`/api/v1/organisations/${organisationId}/queues/${queueId}`);
  },
};

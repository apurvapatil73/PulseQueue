import type {
  ApiEnvelope,
  DeadLetterJobView,
  DeadLetterStatus,
  PaginatedDlqView,
  ReplayDlqPayload,
  ReplayDlqResult,
} from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export interface ListDlqParams {
  status?: DeadLetterStatus;
  queueId?: string;
  page?: number;
  limit?: number;
}

export const dlqApi = {
  async list(
    organisationId: string,
    params: ListDlqParams = { page: 1, limit: 20 },
  ): Promise<PaginatedDlqView> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedDlqView>>(
      `/api/v1/organisations/${organisationId}/dlq`,
      { params },
    );
    return unwrapApiData(data);
  },

  async getById(organisationId: string, dlqId: string): Promise<DeadLetterJobView> {
    const { data } = await apiClient.get<ApiEnvelope<{ deadLetterJob: DeadLetterJobView }>>(
      `/api/v1/organisations/${organisationId}/dlq/${dlqId}`,
    );
    return unwrapApiData(data).deadLetterJob;
  },

  async replay(
    organisationId: string,
    dlqId: string,
    overrides: ReplayDlqPayload = {},
  ): Promise<ReplayDlqResult> {
    const { data } = await apiClient.post<ApiEnvelope<ReplayDlqResult>>(
      `/api/v1/organisations/${organisationId}/dlq/${dlqId}/replay`,
      overrides,
    );
    return unwrapApiData(data);
  },
};

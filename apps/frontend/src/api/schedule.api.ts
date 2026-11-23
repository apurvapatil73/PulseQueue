import type { ApiEnvelope, PaginationMeta, ScheduleSummaryView } from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export const scheduleApi = {
  async list(
    organisationId: string,
    params: { status?: string; page?: number; limit?: number } = { page: 1, limit: 10 },
  ): Promise<{ schedules: ScheduleSummaryView[]; pagination: PaginationMeta }> {
    const { data } = await apiClient.get<
      ApiEnvelope<{ schedules: ScheduleSummaryView[]; pagination: PaginationMeta }>
    >(`/api/v1/organisations/${organisationId}/schedules`, { params });
    return unwrapApiData(data);
  },
};

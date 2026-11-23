import type {
  ApiEnvelope,
  OrganisationMetricsView,
  OrgSafeWorkerView,
  PaginationMeta,
  PlatformEventView,
} from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export const monitoringApi = {
  async getMetrics(
    organisationId: string,
    windowMinutes: number = 60,
  ): Promise<OrganisationMetricsView> {
    const { data } = await apiClient.get<ApiEnvelope<{ metrics: OrganisationMetricsView }>>(
      `/api/v1/organisations/${organisationId}/monitoring/metrics`,
      { params: { windowMinutes } },
    );
    return unwrapApiData(data).metrics;
  },

  async listWorkers(organisationId: string): Promise<OrgSafeWorkerView[]> {
    const { data } = await apiClient.get<ApiEnvelope<{ workers: OrgSafeWorkerView[] }>>(
      `/api/v1/organisations/${organisationId}/monitoring/workers`,
    );
    return unwrapApiData(data).workers;
  },

  async listEvents(
    organisationId: string,
    params: {
      page?: number;
      limit?: number;
      queueId?: string;
      jobId?: string;
      type?: string;
    } = { page: 1, limit: 10 },
  ): Promise<{ events: PlatformEventView[]; pagination: PaginationMeta }> {
    const { data } = await apiClient.get<
      ApiEnvelope<{ events: PlatformEventView[]; pagination: PaginationMeta }>
    >(`/api/v1/organisations/${organisationId}/monitoring/events`, { params });
    return unwrapApiData(data);
  },
};

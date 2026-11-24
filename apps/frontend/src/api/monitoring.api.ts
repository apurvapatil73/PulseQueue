import type {
  ApiEnvelope,
  OrganisationMetricsView,
  OrganisationSchedulerMetricsView,
  OrganisationTimeseriesView,
  OrgSafeWorkerView,
  PaginationMeta,
  PlatformEventView,
  StalledRecoverySummary,
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

  async getTimeseries(
    organisationId: string,
    params: {
      windowMinutes?: number;
      bucketMinutes?: number;
      queueId?: string;
    } = {},
  ): Promise<OrganisationTimeseriesView> {
    const { data } = await apiClient.get<ApiEnvelope<{ timeseries: OrganisationTimeseriesView }>>(
      `/api/v1/organisations/${organisationId}/monitoring/metrics/timeseries`,
      { params },
    );
    return unwrapApiData(data).timeseries;
  },

  async getSchedulerMetrics(
    organisationId: string,
    windowMinutes: number = 60,
  ): Promise<OrganisationSchedulerMetricsView> {
    const { data } = await apiClient.get<
      ApiEnvelope<{ scheduler: OrganisationSchedulerMetricsView }>
    >(`/api/v1/organisations/${organisationId}/monitoring/scheduler`, {
      params: { windowMinutes },
    });
    return unwrapApiData(data).scheduler;
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

  async recoverStalled(
    organisationId: string,
    options?: {
      staleActiveThresholdMs?: number;
      maxStalledRecoveries?: number;
    },
  ): Promise<StalledRecoverySummary> {
    const { data } = await apiClient.post<ApiEnvelope<{ summary: StalledRecoverySummary }>>(
      `/api/v1/organisations/${organisationId}/monitoring/recover-stalled`,
      options ?? {},
    );
    return unwrapApiData(data).summary;
  },
};

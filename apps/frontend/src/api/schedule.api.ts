import type {
  ApiEnvelope,
  CreateSchedulePayload,
  CreateScheduleResult,
  NextRunPreviewView,
  PaginatedScheduleExecutionsView,
  PaginatedSchedulesView,
  ReconcileSchedulesResult,
  ScheduleExecutionStatus,
  ScheduleStatsView,
  ScheduleStatus,
  ScheduleType,
  ScheduleView,
  UpdateSchedulePayload,
} from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export interface ListSchedulesParams {
  status?: ScheduleStatus;
  type?: ScheduleType;
  queueId?: string;
  page?: number;
  limit?: number;
}

export interface ListScheduleExecutionsParams {
  status?: ScheduleExecutionStatus;
  page?: number;
  limit?: number;
}

export const scheduleApi = {
  async list(
    organisationId: string,
    params: ListSchedulesParams = { page: 1, limit: 20 },
  ): Promise<PaginatedSchedulesView> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedSchedulesView>>(
      `/api/v1/organisations/${organisationId}/schedules`,
      { params },
    );
    return unwrapApiData(data);
  },

  async getById(organisationId: string, scheduleId: string): Promise<ScheduleView> {
    const { data } = await apiClient.get<ApiEnvelope<{ schedule: ScheduleView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}`,
    );
    return unwrapApiData(data).schedule;
  },

  async create(
    organisationId: string,
    payload: CreateSchedulePayload,
  ): Promise<CreateScheduleResult> {
    const { data } = await apiClient.post<ApiEnvelope<CreateScheduleResult>>(
      `/api/v1/organisations/${organisationId}/schedules`,
      payload,
    );
    return unwrapApiData(data);
  },

  async update(
    organisationId: string,
    scheduleId: string,
    payload: UpdateSchedulePayload,
  ): Promise<ScheduleView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ schedule: ScheduleView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}`,
      payload,
    );
    return unwrapApiData(data).schedule;
  },

  async pause(organisationId: string, scheduleId: string): Promise<ScheduleView> {
    const { data } = await apiClient.post<ApiEnvelope<{ schedule: ScheduleView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/pause`,
      {},
    );
    return unwrapApiData(data).schedule;
  },

  async resume(organisationId: string, scheduleId: string): Promise<ScheduleView> {
    const { data } = await apiClient.post<ApiEnvelope<{ schedule: ScheduleView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/resume`,
      {},
    );
    return unwrapApiData(data).schedule;
  },

  async cancel(organisationId: string, scheduleId: string): Promise<ScheduleView> {
    const { data } = await apiClient.post<ApiEnvelope<{ schedule: ScheduleView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/cancel`,
      {},
    );
    return unwrapApiData(data).schedule;
  },

  async delete(organisationId: string, scheduleId: string): Promise<void> {
    await apiClient.delete(`/api/v1/organisations/${organisationId}/schedules/${scheduleId}`);
  },

  async listExecutions(
    organisationId: string,
    scheduleId: string,
    params: ListScheduleExecutionsParams = { page: 1, limit: 20 },
  ): Promise<PaginatedScheduleExecutionsView> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedScheduleExecutionsView>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/executions`,
      { params },
    );
    return unwrapApiData(data);
  },

  async getNextRun(organisationId: string, scheduleId: string): Promise<NextRunPreviewView> {
    const { data } = await apiClient.get<ApiEnvelope<{ nextRun: NextRunPreviewView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/next-run`,
    );
    return unwrapApiData(data).nextRun;
  },

  async getStats(organisationId: string, scheduleId: string): Promise<ScheduleStatsView> {
    const { data } = await apiClient.get<ApiEnvelope<{ stats: ScheduleStatsView }>>(
      `/api/v1/organisations/${organisationId}/schedules/${scheduleId}/stats`,
    );
    return unwrapApiData(data).stats;
  },

  async reconcile(organisationId: string): Promise<ReconcileSchedulesResult> {
    const { data } = await apiClient.post<
      ApiEnvelope<{ reconciliation: ReconcileSchedulesResult }>
    >(`/api/v1/organisations/${organisationId}/schedules/reconcile`, {});
    return unwrapApiData(data).reconciliation;
  },
};

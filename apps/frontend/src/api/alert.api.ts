import { apiClient, unwrapApiData } from './apiClient';
import type {
  AlertRuleView,
  AlertSeverity,
  AlertStatsView,
  AlertStatus,
  AlertType,
  AlertView,
  ApiEnvelope,
  CreateAlertRulePayload,
  NotificationView,
  PaginatedAlertsView,
  PaginatedNotificationsView,
  UpdateAlertRulePayload,
} from '../types/api';

export const alertApi = {
  // ─── Alert Rules ────────────────────────────────────────────────────────────

  async listRules(organisationId: string): Promise<AlertRuleView[]> {
    const { data } = await apiClient.get<ApiEnvelope<{ rules: AlertRuleView[] }>>(
      `/api/v1/organisations/${organisationId}/alert-rules`,
    );
    return unwrapApiData(data).rules;
  },

  async createRule(
    organisationId: string,
    payload: CreateAlertRulePayload,
  ): Promise<AlertRuleView> {
    const { data } = await apiClient.post<ApiEnvelope<{ rule: AlertRuleView }>>(
      `/api/v1/organisations/${organisationId}/alert-rules`,
      payload,
    );
    return unwrapApiData(data).rule;
  },

  async updateRule(
    organisationId: string,
    ruleId: string,
    payload: UpdateAlertRulePayload,
  ): Promise<AlertRuleView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ rule: AlertRuleView }>>(
      `/api/v1/organisations/${organisationId}/alert-rules/${ruleId}`,
      payload,
    );
    return unwrapApiData(data).rule;
  },

  async toggleRule(
    organisationId: string,
    ruleId: string,
    isEnabled: boolean,
  ): Promise<AlertRuleView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ rule: AlertRuleView }>>(
      `/api/v1/organisations/${organisationId}/alert-rules/${ruleId}/toggle`,
      { isEnabled },
    );
    return unwrapApiData(data).rule;
  },

  async deleteRule(organisationId: string, ruleId: string): Promise<{ deleted: true }> {
    const { data } = await apiClient.delete<ApiEnvelope<{ deleted: true }>>(
      `/api/v1/organisations/${organisationId}/alert-rules/${ruleId}`,
    );
    return unwrapApiData(data);
  },

  // ─── Alerts ─────────────────────────────────────────────────────────────────

  async listAlerts(
    organisationId: string,
    params?: {
      page?: number;
      limit?: number;
      status?: AlertStatus;
      severity?: AlertSeverity;
      type?: AlertType;
      queueId?: string;
    },
  ): Promise<PaginatedAlertsView> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedAlertsView>>(
      `/api/v1/organisations/${organisationId}/alerts`,
      { params },
    );
    return unwrapApiData(data);
  },

  async getAlertStats(organisationId: string): Promise<AlertStatsView> {
    const { data } = await apiClient.get<ApiEnvelope<{ stats: AlertStatsView }>>(
      `/api/v1/organisations/${organisationId}/alerts/stats`,
    );
    return unwrapApiData(data).stats;
  },

  async getAlert(organisationId: string, alertId: string): Promise<AlertView> {
    const { data } = await apiClient.get<ApiEnvelope<{ alert: AlertView }>>(
      `/api/v1/organisations/${organisationId}/alerts/${alertId}`,
    );
    return unwrapApiData(data).alert;
  },

  async acknowledgeAlert(organisationId: string, alertId: string): Promise<AlertView> {
    const { data } = await apiClient.post<ApiEnvelope<{ alert: AlertView }>>(
      `/api/v1/organisations/${organisationId}/alerts/${alertId}/acknowledge`,
    );
    return unwrapApiData(data).alert;
  },

  async resolveAlert(organisationId: string, alertId: string, reason?: string): Promise<AlertView> {
    const { data } = await apiClient.post<ApiEnvelope<{ alert: AlertView }>>(
      `/api/v1/organisations/${organisationId}/alerts/${alertId}/resolve`,
      reason ? { reason } : {},
    );
    return unwrapApiData(data).alert;
  },

  // ─── Notifications ──────────────────────────────────────────────────────────

  async listNotifications(
    organisationId: string,
    params?: {
      page?: number;
      limit?: number;
      unreadOnly?: boolean;
    },
  ): Promise<PaginatedNotificationsView> {
    const { data } = await apiClient.get<ApiEnvelope<PaginatedNotificationsView>>(
      `/api/v1/organisations/${organisationId}/notifications`,
      { params },
    );
    return unwrapApiData(data);
  },

  async getUnreadCount(organisationId: string): Promise<number> {
    const { data } = await apiClient.get<ApiEnvelope<{ unreadCount: number }>>(
      `/api/v1/organisations/${organisationId}/notifications/unread-count`,
    );
    return unwrapApiData(data).unreadCount;
  },

  async markNotificationRead(
    organisationId: string,
    notificationId: string,
  ): Promise<NotificationView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ notification: NotificationView }>>(
      `/api/v1/organisations/${organisationId}/notifications/${notificationId}/read`,
    );
    return unwrapApiData(data).notification;
  },

  async markAllNotificationsRead(organisationId: string): Promise<{ updatedCount: number }> {
    const { data } = await apiClient.post<ApiEnvelope<{ updatedCount: number }>>(
      `/api/v1/organisations/${organisationId}/notifications/read-all`,
    );
    return unwrapApiData(data);
  },
};

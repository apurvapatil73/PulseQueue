import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alertApi } from '../api/alert.api';
import type {
  AlertSeverity,
  AlertStatus,
  AlertType,
  CreateAlertRulePayload,
  UpdateAlertRulePayload,
} from '../types/api';

export function useAlertRules(organisationId: string | null) {
  return useQuery({
    queryKey: ['alert-rules', organisationId],
    queryFn: () => alertApi.listRules(organisationId!),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
  });
}

export function useCreateAlertRule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAlertRulePayload) => alertApi.createRule(organisationId!, payload),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alert-rules', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
    },
  });
}

export function useUpdateAlertRule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, payload }: { ruleId: string; payload: UpdateAlertRulePayload }) =>
      alertApi.updateRule(organisationId!, ruleId, payload),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alert-rules', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
    },
  });
}

export function useToggleAlertRule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, isEnabled }: { ruleId: string; isEnabled: boolean }) =>
      alertApi.toggleRule(organisationId!, ruleId, isEnabled),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alert-rules', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
    },
  });
}

export function useDeleteAlertRule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) => alertApi.deleteRule(organisationId!, ruleId),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alert-rules', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
    },
  });
}

export function useAlerts(
  organisationId: string | null,
  params: {
    page?: number;
    limit?: number;
    status?: AlertStatus;
    severity?: AlertSeverity;
    type?: AlertType;
    queueId?: string;
  } = { page: 1, limit: 20 },
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [
      'alerts',
      organisationId,
      params.page ?? 1,
      params.limit ?? 20,
      params.status ?? 'all',
      params.severity ?? 'all',
      params.type ?? 'all',
      params.queueId ?? 'all',
    ],
    queryFn: () => alertApi.listAlerts(organisationId!, params),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useAlertStats(
  organisationId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['alert-stats', organisationId],
    queryFn: () => alertApi.getAlertStats(organisationId!),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useAcknowledgeAlert(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => alertApi.acknowledgeAlert(organisationId!, alertId),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alerts', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications-unread', organisationId] });
    },
  });
}

export function useResolveAlert(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, reason }: { alertId: string; reason?: string }) =>
      alertApi.resolveAlert(organisationId!, alertId, reason),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['alerts', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['alert-stats', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications-unread', organisationId] });
    },
  });
}

export function useNotifications(
  organisationId: string | null,
  params: { page?: number; limit?: number; unreadOnly?: boolean } = { page: 1, limit: 20 },
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [
      'notifications',
      organisationId,
      params.page ?? 1,
      params.limit ?? 20,
      params.unreadOnly ?? false,
    ],
    queryFn: () => alertApi.listNotifications(organisationId!, params),
    enabled: Boolean(organisationId) && (options?.enabled ?? true),
    staleTime: 10_000,
    retry: false,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useUnreadNotificationCount(
  organisationId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['notifications-unread', organisationId],
    queryFn: () => alertApi.getUnreadCount(organisationId!),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    retry: false,
    refetchInterval: options?.refetchInterval ?? 30_000,
  });
}

export function useMarkNotificationRead(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      alertApi.markNotificationRead(organisationId!, notificationId),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['notifications', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications-unread', organisationId] });
    },
  });
}

export function useMarkAllNotificationsRead(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => alertApi.markAllNotificationsRead(organisationId!),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['notifications', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['notifications-unread', organisationId] });
    },
  });
}

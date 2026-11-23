import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  scheduleApi,
  type ListScheduleExecutionsParams,
  type ListSchedulesParams,
} from '../api/schedule.api';
import type { CreateSchedulePayload, UpdateSchedulePayload } from '../types/api';

export function useSchedulesList(organisationId: string | null, params: ListSchedulesParams = {}) {
  return useQuery({
    queryKey: [
      'schedules',
      organisationId,
      params.status ?? 'all',
      params.type ?? 'all',
      params.queueId ?? 'all',
      params.page ?? 1,
      params.limit ?? 20,
    ],
    queryFn: () => scheduleApi.list(organisationId!, params),
    enabled: Boolean(organisationId),
  });
}

export function useScheduleDetail(organisationId: string | null, scheduleId: string | null) {
  return useQuery({
    queryKey: ['schedule', organisationId, scheduleId],
    queryFn: () => scheduleApi.getById(organisationId!, scheduleId!),
    enabled: Boolean(organisationId && scheduleId),
  });
}

export function useScheduleStats(organisationId: string | null, scheduleId: string | null) {
  return useQuery({
    queryKey: ['schedule-stats', organisationId, scheduleId],
    queryFn: () => scheduleApi.getStats(organisationId!, scheduleId!),
    enabled: Boolean(organisationId && scheduleId),
  });
}

export function useScheduleNextRun(organisationId: string | null, scheduleId: string | null) {
  return useQuery({
    queryKey: ['schedule-next-run', organisationId, scheduleId],
    queryFn: () => scheduleApi.getNextRun(organisationId!, scheduleId!),
    enabled: Boolean(organisationId && scheduleId),
  });
}

export function useScheduleExecutions(
  organisationId: string | null,
  scheduleId: string | null,
  params: ListScheduleExecutionsParams = {},
) {
  return useQuery({
    queryKey: [
      'schedule-executions',
      organisationId,
      scheduleId,
      params.status ?? 'all',
      params.page ?? 1,
      params.limit ?? 20,
    ],
    queryFn: () => scheduleApi.listExecutions(organisationId!, scheduleId!, params),
    enabled: Boolean(organisationId && scheduleId),
  });
}

function invalidateScheduleQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organisationId: string | null,
  scheduleId?: string,
  queueId?: string,
  jobId?: string,
) {
  if (!organisationId) return;
  void queryClient.invalidateQueries({ queryKey: ['schedules', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-schedules-summary', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['jobs', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['queues', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-metrics', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-events', organisationId] });

  if (scheduleId) {
    void queryClient.invalidateQueries({ queryKey: ['schedule', organisationId, scheduleId] });
    void queryClient.invalidateQueries({
      queryKey: ['schedule-stats', organisationId, scheduleId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['schedule-next-run', organisationId, scheduleId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['schedule-executions', organisationId, scheduleId],
    });
  }

  if (queueId) {
    void queryClient.invalidateQueries({ queryKey: ['queue', organisationId, queueId] });
    void queryClient.invalidateQueries({ queryKey: ['queue-stats', organisationId, queueId] });
  }

  if (jobId) {
    void queryClient.invalidateQueries({ queryKey: ['job', organisationId, jobId] });
    void queryClient.invalidateQueries({ queryKey: ['job-events', organisationId, jobId] });
  }
}

export function useCreateSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSchedulePayload) => scheduleApi.create(organisationId!, payload),
    onSuccess: (result) => {
      invalidateScheduleQueries(
        queryClient,
        organisationId,
        result.schedule.id,
        result.schedule.queueId,
        result.initialJobId,
      );
    },
  });
}

export function useUpdateSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, payload }: { scheduleId: string; payload: UpdateSchedulePayload }) =>
      scheduleApi.update(organisationId!, scheduleId, payload),
    onSuccess: (updated) => {
      invalidateScheduleQueries(queryClient, organisationId, updated.id, updated.queueId);
    },
  });
}

export function usePauseSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => scheduleApi.pause(organisationId!, scheduleId),
    onSuccess: (updated) => {
      invalidateScheduleQueries(queryClient, organisationId, updated.id, updated.queueId);
    },
  });
}

export function useResumeSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => scheduleApi.resume(organisationId!, scheduleId),
    onSuccess: (updated) => {
      invalidateScheduleQueries(queryClient, organisationId, updated.id, updated.queueId);
    },
  });
}

export function useCancelSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => scheduleApi.cancel(organisationId!, scheduleId),
    onSuccess: (updated) => {
      invalidateScheduleQueries(queryClient, organisationId, updated.id, updated.queueId);
    },
  });
}

export function useDeleteSchedule(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: string) => scheduleApi.delete(organisationId!, scheduleId),
    onSuccess: (_data, scheduleId) => {
      invalidateScheduleQueries(queryClient, organisationId, scheduleId);
    },
  });
}

export function useReconcileSchedules(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => scheduleApi.reconcile(organisationId!),
    onSuccess: () => {
      invalidateScheduleQueries(queryClient, organisationId);
    },
  });
}

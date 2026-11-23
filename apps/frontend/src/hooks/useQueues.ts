import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  queueApi,
  type CreateQueuePayload,
  type ListQueuesFilters,
  type UpdateQueuePayload,
} from '../api/queue.api';

export function useQueuesList(organisationId: string | null, filters?: ListQueuesFilters) {
  return useQuery({
    queryKey: ['queues', organisationId, filters?.isPaused ?? 'all'],
    queryFn: () => queueApi.list(organisationId!, filters),
    enabled: Boolean(organisationId),
  });
}

export function useQueueDetail(organisationId: string | null, queueId: string | null) {
  return useQuery({
    queryKey: ['queue', organisationId, queueId],
    queryFn: () => queueApi.getById(organisationId!, queueId!),
    enabled: Boolean(organisationId && queueId),
  });
}

export function useQueueStats(organisationId: string | null, queueId: string | null) {
  return useQuery({
    queryKey: ['queue-stats', organisationId, queueId],
    queryFn: () => queueApi.getStats(organisationId!, queueId!),
    enabled: Boolean(organisationId && queueId),
  });
}

function invalidateQueueQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organisationId: string | null,
  queueId?: string,
) {
  if (!organisationId) return;
  void queryClient.invalidateQueries({ queryKey: ['queues', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['jobs', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['schedules', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['dlq', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-metrics', organisationId] });
  if (queueId) {
    void queryClient.invalidateQueries({ queryKey: ['queue', organisationId, queueId] });
    void queryClient.invalidateQueries({ queryKey: ['queue-stats', organisationId, queueId] });
  }
}

export function useCreateQueue(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateQueuePayload) => queueApi.create(organisationId!, payload),
    onSuccess: (created) => {
      invalidateQueueQueries(queryClient, organisationId, created.id);
    },
  });
}

export function useUpdateQueue(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ queueId, payload }: { queueId: string; payload: UpdateQueuePayload }) =>
      queueApi.update(organisationId!, queueId, payload),
    onSuccess: (updated) => {
      invalidateQueueQueries(queryClient, organisationId, updated.id);
    },
  });
}

export function usePauseQueue(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (queueId: string) => queueApi.pause(organisationId!, queueId),
    onSuccess: (updated) => {
      invalidateQueueQueries(queryClient, organisationId, updated.id);
    },
  });
}

export function useResumeQueue(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (queueId: string) => queueApi.resume(organisationId!, queueId),
    onSuccess: (updated) => {
      invalidateQueueQueries(queryClient, organisationId, updated.id);
    },
  });
}

export function useDeleteQueue(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (queueId: string) => queueApi.delete(organisationId!, queueId),
    onSuccess: (_data, queueId) => {
      invalidateQueueQueries(queryClient, organisationId, queueId);
    },
  });
}

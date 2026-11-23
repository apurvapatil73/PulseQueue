import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dlqApi, type ListDlqParams } from '../api/dlq.api';
import type { ReplayDlqPayload } from '../types/api';

export function useDlqList(organisationId: string | null, params: ListDlqParams = {}) {
  return useQuery({
    queryKey: [
      'dlq',
      organisationId,
      params.status ?? 'all',
      params.queueId ?? 'all',
      params.page ?? 1,
      params.limit ?? 20,
    ],
    queryFn: () => dlqApi.list(organisationId!, params),
    enabled: Boolean(organisationId),
  });
}

export function useDlqDetail(organisationId: string | null, dlqId: string | null) {
  return useQuery({
    queryKey: ['dlq-item', organisationId, dlqId],
    queryFn: () => dlqApi.getById(organisationId!, dlqId!),
    enabled: Boolean(organisationId && dlqId),
  });
}

function invalidateDlqAndJobQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organisationId: string | null,
  dlqId?: string,
  queueId?: string,
  replayedJobId?: string,
) {
  if (!organisationId) return;
  void queryClient.invalidateQueries({ queryKey: ['dlq', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['jobs', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['queues', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-metrics', organisationId] });
  void queryClient.invalidateQueries({ queryKey: ['org-events', organisationId] });

  if (dlqId) {
    void queryClient.invalidateQueries({ queryKey: ['dlq-item', organisationId, dlqId] });
  }

  if (queueId) {
    void queryClient.invalidateQueries({ queryKey: ['queue', organisationId, queueId] });
    void queryClient.invalidateQueries({ queryKey: ['queue-stats', organisationId, queueId] });
  }

  if (replayedJobId) {
    void queryClient.invalidateQueries({ queryKey: ['job', organisationId, replayedJobId] });
    void queryClient.invalidateQueries({ queryKey: ['job-events', organisationId, replayedJobId] });
  }
}

export function useReplayDlqJob(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ dlqId, overrides }: { dlqId: string; overrides?: ReplayDlqPayload }) =>
      dlqApi.replay(organisationId!, dlqId, overrides ?? {}),
    onSuccess: (result) => {
      invalidateDlqAndJobQueries(
        queryClient,
        organisationId,
        result.deadLetterJob.id,
        result.replayedJob.queueId,
        result.replayedJob.id,
      );
    },
  });
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { monitoringApi } from '../api/monitoring.api';
import {
  createMonitoringStreamClient,
  type MonitoringStreamClient,
  type MonitoringStreamOptions,
  type MonitoringStreamState,
  type SseResyncPayload,
} from '../api/monitoringStream';
import type { PlatformEventView } from '../types/api';

export const DEFAULT_MAX_LIVE_EVENTS = 100;
export const DEFAULT_INVALIDATION_DEBOUNCE_MS = 1_500;
export const FALLBACK_POLLING_INTERVAL_MS = 15_000;

export function useOrganisationMetrics(
  organisationId: string | null,
  windowMinutes: number = 60,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['org-metrics', organisationId, windowMinutes],
    queryFn: () => monitoringApi.getMetrics(organisationId!, windowMinutes),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useOrganisationTimeseries(
  organisationId: string | null,
  params: {
    windowMinutes: number;
    bucketMinutes?: number;
    queueId?: string;
  },
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [
      'org-metrics-timeseries',
      organisationId,
      params.windowMinutes,
      params.bucketMinutes ?? 'auto',
      params.queueId ?? 'all',
    ],
    queryFn: () => monitoringApi.getTimeseries(organisationId!, params),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useOrganisationWorkers(
  organisationId: string | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['org-workers', organisationId],
    queryFn: () => monitoringApi.listWorkers(organisationId!),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useOrganisationEvents(
  organisationId: string | null,
  params: {
    page?: number;
    limit?: number;
    type?: string;
    queueId?: string;
    jobId?: string;
  } = { page: 1, limit: 25 },
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [
      'org-events',
      organisationId,
      params.page ?? 1,
      params.limit ?? 25,
      params.type ?? 'all',
      params.queueId ?? 'all',
      params.jobId ?? 'all',
    ],
    queryFn: () => monitoringApi.listEvents(organisationId!, params),
    enabled: Boolean(organisationId),
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useRecoverStalled(organisationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (options?: { staleActiveThresholdMs?: number; maxStalledRecoveries?: number }) =>
      monitoringApi.recoverStalled(organisationId!, options),
    onSuccess: () => {
      if (!organisationId) return;
      void queryClient.invalidateQueries({ queryKey: ['org-metrics', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['org-metrics-timeseries', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['org-events', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['jobs', organisationId] });
      void queryClient.invalidateQueries({ queryKey: ['dlq', organisationId] });
    },
  });
}

export interface UseMonitoringStreamOptions {
  enabled?: boolean;
  maxEvents?: number;
  invalidationDebounceMs?: number;
  fallbackPollingMs?: number;
  /** Optional injectable factory for deterministic testing. */
  createClient?: (opts: MonitoringStreamOptions) => MonitoringStreamClient;
}

export interface UseMonitoringStreamResult {
  streamState: MonitoringStreamState;
  isLive: boolean;
  fallbackRefetchInterval: number | false;
  liveEvents: PlatformEventView[];
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
  resyncNotice: SseResyncPayload | null;
  streamError: string | null;
  clearResyncNotice: () => void;
  reconnect: () => void;
}

/**
 * Integrates the Step 7.3 `MonitoringStreamClient` with React lifecycle and TanStack Query:
 * - Connects with Bearer auth for the active organisation only.
 * - Cleans up & resets state immediately on organisation switch or unmount.
 * - Deduplicates live events by ID and bounds memory to `maxEvents`.
 * - Debounces/batches TanStack Query invalidations during event bursts.
 * - Automatically enables fallback polling when the SSE stream is unavailable.
 */
export function useMonitoringStream(
  organisationId: string | null,
  options: UseMonitoringStreamOptions = {},
): UseMonitoringStreamResult {
  const {
    enabled = true,
    maxEvents = DEFAULT_MAX_LIVE_EVENTS,
    invalidationDebounceMs = DEFAULT_INVALIDATION_DEBOUNCE_MS,
    fallbackPollingMs = FALLBACK_POLLING_INTERVAL_MS,
    createClient = createMonitoringStreamClient,
  } = options;

  const queryClient = useQueryClient();

  const [streamState, setStreamState] = useState<MonitoringStreamState>('idle');
  const [liveEvents, setLiveEvents] = useState<PlatformEventView[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [resyncNotice, setResyncNotice] = useState<SseResyncPayload | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const clientRef = useRef<MonitoringStreamClient | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWorkerInvalidationRef = useRef(false);
  const pendingAlertInvalidationRef = useRef(false);

  const flushInvalidations = useCallback(
    (orgId: string, includeWorkers: boolean, includeAlerts: boolean) => {
      void queryClient.invalidateQueries({ queryKey: ['org-metrics', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['org-metrics-timeseries', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['org-events', orgId] });
      if (includeWorkers) {
        void queryClient.invalidateQueries({ queryKey: ['org-workers', orgId] });
      }
      if (includeAlerts) {
        void queryClient.invalidateQueries({ queryKey: ['alerts', orgId] });
        void queryClient.invalidateQueries({ queryKey: ['alert-stats', orgId] });
        void queryClient.invalidateQueries({ queryKey: ['notifications', orgId] });
        void queryClient.invalidateQueries({ queryKey: ['notifications-unread', orgId] });
      }
    },
    [queryClient],
  );

  const scheduleBatchedInvalidation = useCallback(
    (orgId: string, isWorkerEvent: boolean, isAlertEvent: boolean) => {
      if (isWorkerEvent) {
        pendingWorkerInvalidationRef.current = true;
      }
      if (isAlertEvent) {
        pendingAlertInvalidationRef.current = true;
      }
      if (debounceTimerRef.current !== null) {
        return;
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const includeWorkers = pendingWorkerInvalidationRef.current;
        const includeAlerts = pendingAlertInvalidationRef.current;
        pendingWorkerInvalidationRef.current = false;
        pendingAlertInvalidationRef.current = false;
        flushInvalidations(orgId, includeWorkers, includeAlerts);
      }, invalidationDebounceMs);
    },
    [flushInvalidations, invalidationDebounceMs],
  );

  useEffect(() => {
    // Reset tenant-scoped stream state immediately whenever orgId changes
    setLiveEvents([]);
    setLastEventAt(null);
    setLastHeartbeatAt(null);
    setResyncNotice(null);
    setStreamError(null);
    pendingWorkerInvalidationRef.current = false;
    pendingAlertInvalidationRef.current = false;

    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (!enabled || !organisationId) {
      setStreamState('idle');
      return;
    }

    const activeOrgId = organisationId;

    const client = createClient({
      organisationId: activeOrgId,
      onStateChange: (next) => {
        setStreamState(next);
        if (next === 'connected') {
          setStreamError(null);
        }
      },
      onConnected: (payload) => {
        setLastHeartbeatAt(payload.connectedAt);
        setStreamError(null);
      },
      onHeartbeat: () => {
        setLastHeartbeatAt(new Date().toISOString());
      },
      onResync: (payload) => {
        setResyncNotice(payload);
        flushInvalidations(activeOrgId, true, true);
      },
      onError: (err) => {
        setStreamError(err.message);
      },
      onEvent: (event) => {
        if (event.organisationId !== activeOrgId) {
          return;
        }
        setLastEventAt(event.createdAt);
        setLiveEvents((prev) => {
          if (prev.some((existing) => existing.id === event.id)) {
            return prev;
          }
          const merged = [event, ...prev];
          merged.sort((a, b) => {
            const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            return diff !== 0 ? diff : b.id.localeCompare(a.id);
          });
          return merged.slice(0, maxEvents);
        });

        const isWorkerEvent = event.type.startsWith('WORKER_');
        const isAlertEvent = event.type.startsWith('ALERT_');
        scheduleBatchedInvalidation(activeOrgId, isWorkerEvent, isAlertEvent);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      client.close();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, [
    createClient,
    enabled,
    flushInvalidations,
    maxEvents,
    organisationId,
    scheduleBatchedInvalidation,
  ]);

  const clearResyncNotice = useCallback(() => {
    setResyncNotice(null);
  }, []);

  const reconnect = useCallback(() => {
    setStreamError(null);
    setResyncNotice(null);
    clientRef.current?.connect();
  }, []);

  const isLive = streamState === 'connected';
  const fallbackRefetchInterval = !isLive && enabled && organisationId ? fallbackPollingMs : false;

  return {
    streamState,
    isLive,
    fallbackRefetchInterval,
    liveEvents,
    lastEventAt,
    lastHeartbeatAt,
    resyncNotice,
    streamError,
    clearResyncNotice,
    reconnect,
  };
}

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../config/queryClient';
import { apiClient } from '../api/apiClient';
import { scheduleApi } from '../api/schedule.api';
import { dlqApi } from '../api/dlq.api';
import { organisationApi } from '../api/organisation.api';
import {
  useCancelSchedule,
  useCreateSchedule,
  useDeleteSchedule,
  usePauseSchedule,
  useReconcileSchedules,
  useResumeSchedule,
  useScheduleDetail,
  useScheduleExecutions,
  useScheduleNextRun,
  useSchedulesList,
  useScheduleStats,
  useUpdateSchedule,
} from '../hooks/useSchedules';
import { useDlqDetail, useDlqList, useReplayDlqJob } from '../hooks/useDlq';
import {
  canManageOrganisationInvitations,
  useAcceptInvitation,
  useCreateInvitation,
  useDeleteOrganisation,
  useOrganisationDetail,
  useOrganisationInvitations,
  useOrganisationMembers,
  useRemoveMember,
  useRevokeInvitation,
  useTransferOwnership,
  useUpdateMemberRole,
  useUpdateOrganisation,
} from '../hooks/useOrganisationManagement';
import { inferStatusTone } from '../components/ui/StatusBadge';
import type {
  DeadLetterJobView,
  InvitationView,
  MemberView,
  NextRunPreviewView,
  OrganisationView,
  ReconcileSchedulesResult,
  ScheduleExecutionView,
  ScheduleStatsView,
  ScheduleView,
} from '../types/api';

function makeWrapper(qc = createQueryClient()) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

function makeSchedule(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: overrides.id ?? 'sched-11111111-1111-4111-8111-111111111111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    name: overrides.name ?? 'Hourly-Invoice-Sync',
    description: overrides.description ?? 'Sync customer invoices every hour',
    type: overrides.type ?? 'RECURRING',
    status: overrides.status ?? 'ACTIVE',
    jobName: overrides.jobName ?? 'echo',
    payload: overrides.payload ?? { message: 'scheduled-sync' },
    priority: overrides.priority ?? 5,
    maxRetries: overrides.maxRetries ?? 3,
    backoffMs: overrides.backoffMs ?? 1000,
    cronExpression: overrides.cronExpression !== undefined ? overrides.cronExpression : '0 * * * *',
    timezone: overrides.timezone ?? 'Asia/Kolkata',
    runAt: overrides.runAt ?? null,
    nextRunAt: overrides.nextRunAt ?? '2026-11-23T08:00:00.000Z',
    nextRunAtLocal: overrides.nextRunAtLocal ?? '2026-11-23T13:30:00.000+05:30',
    lastRunAt: overrides.lastRunAt ?? '2026-11-23T07:00:00.000Z',
    lastDispatchedAt: overrides.lastDispatchedAt ?? '2026-11-23T07:00:00.120Z',
    runCount: overrides.runCount ?? 12,
    preventOverlap: overrides.preventOverlap ?? true,
    misfirePolicy: overrides.misfirePolicy ?? 'SKIP_MISSED',
    maxCatchUpRuns: overrides.maxCatchUpRuns ?? 5,
    misfireGraceMs: overrides.misfireGraceMs ?? 60000,
    maxConcurrentRuns: overrides.maxConcurrentRuns ?? null,
    maxTotalRuns: overrides.maxTotalRuns ?? 100,
    maxDurationMs: overrides.maxDurationMs ?? 30000,
    minIntervalMs: overrides.minIntervalMs ?? 5000,
    createdBy: {
      id: 'user-owner',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-23T07:00:00.120Z',
  };
}

function makeDlqItem(overrides: Partial<DeadLetterJobView> = {}): DeadLetterJobView {
  return {
    id: overrides.id ?? 'dlq-11111111-1111-4111-8111-111111111111',
    originalJobId: overrides.originalJobId ?? 'job-orig-1111',
    organisationId: overrides.organisationId ?? 'org-alpha',
    queueId: overrides.queueId ?? 'q-11111111-1111-4111-8111-111111111111',
    queueName: overrides.queueName ?? 'billing-invoices',
    jobName: overrides.jobName ?? 'test.fail',
    payloadSummary: overrides.payloadSummary ?? {
      keyCount: 2,
      keys: ['failUntilAttempt', 'reason'],
      byteLength: 64,
    },
    failureReason: overrides.failureReason ?? 'Simulated downstream failure (attempt 3/3)',
    attemptsMade: overrides.attemptsMade ?? 3,
    maxRetries: overrides.maxRetries ?? 2,
    status: overrides.status ?? 'OPEN',
    failedAt: overrides.failedAt ?? '2026-11-23T06:00:00.000Z',
    replayedAt: overrides.replayedAt ?? null,
    replayedById: overrides.replayedById ?? null,
    replayedJobId: overrides.replayedJobId ?? null,
    createdAt: '2026-11-23T06:00:00.000Z',
    updatedAt: '2026-11-23T06:00:00.000Z',
  };
}

describe('Step 6.4.1 — API Clients, TanStack Query Hooks, RBAC Guards & StatusBadge Tones', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('StatusBadge tone inference for Step 6.4 statuses', () => {
    it('maps schedule execution, DLQ, and invitation statuses to semantic tones without breaking existing statuses', () => {
      expect(inferStatusTone('DISPATCHED')).toBe('emerald');
      expect(inferStatusTone('ACCEPTED')).toBe('emerald');
      expect(inferStatusTone('COMPLETED')).toBe('emerald');

      expect(inferStatusTone('SCHEDULED')).toBe('amber');
      expect(inferStatusTone('MISSED')).toBe('amber');
      expect(inferStatusTone('SKIPPED_OVERLAP')).toBe('amber');
      expect(inferStatusTone('SKIPPED_CONCURRENCY')).toBe('amber');
      expect(inferStatusTone('SKIPPED_MIN_INTERVAL')).toBe('amber');
      expect(inferStatusTone('SKIPPED_MAX_RUNS')).toBe('amber');
      expect(inferStatusTone('PENDING')).toBe('amber');

      expect(inferStatusTone('OPEN')).toBe('rose');
      expect(inferStatusTone('CANCELLED')).toBe('rose');
      expect(inferStatusTone('REVOKED')).toBe('rose');
      expect(inferStatusTone('EXPIRED')).toBe('rose');
      expect(inferStatusTone('FAILED')).toBe('rose');

      expect(inferStatusTone('REPLAYED')).toBe('sky');
      expect(inferStatusTone('CATCH_UP')).toBe('sky');
      expect(inferStatusTone('FIRE_ONCE')).toBe('sky');
      expect(inferStatusTone('OWNER')).toBe('sky');
      expect(inferStatusTone('RECURRING')).toBe('sky');

      expect(inferStatusTone('ADMIN')).toBe('indigo');
      expect(inferStatusTone('ONE_TIME')).toBe('indigo');

      expect(inferStatusTone('SKIP_MISSED')).toBe('slate');
      expect(inferStatusTone('MEMBER')).toBe('slate');
    });
  });

  describe('scheduleApi and useSchedules hooks', () => {
    it('calls exact backend schedule endpoints and unwraps response envelopes', async () => {
      const schedule = makeSchedule();
      const execution: ScheduleExecutionView = {
        id: 'exec-1',
        scheduleId: schedule.id,
        jobId: 'job-1',
        scheduledFor: '2026-11-23T07:00:00.000Z',
        dispatchedAt: '2026-11-23T07:00:00.120Z',
        startedAt: '2026-11-23T07:00:00.200Z',
        completedAt: '2026-11-23T07:00:00.250Z',
        finalJobStatus: 'COMPLETED',
        retryCount: 0,
        durationMs: 50,
        isCatchUp: false,
        status: 'DISPATCHED',
        reason: null,
        job: {
          id: 'job-1',
          status: 'COMPLETED',
          priority: 5,
          attemptsMade: 1,
          durationMs: 50,
          errorMessage: null,
          startedAt: '2026-11-23T07:00:00.200Z',
          completedAt: '2026-11-23T07:00:00.250Z',
          failedAt: null,
        },
        createdAt: '2026-11-23T07:00:00.000Z',
      };

      const nextRun: NextRunPreviewView = {
        scheduleId: schedule.id,
        type: 'RECURRING',
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
        cronExpression: '0 * * * *',
        nextRunAt: '2026-11-23T08:00:00.000Z',
        nextRunAtLocal: '2026-11-23T13:30:00.000+05:30',
        upcomingRuns: [{ utc: '2026-11-23T08:00:00.000Z', local: '2026-11-23T13:30:00.000+05:30' }],
      };

      const stats: ScheduleStatsView = {
        scheduleId: schedule.id,
        name: schedule.name,
        type: 'RECURRING',
        status: 'ACTIVE',
        misfirePolicy: 'SKIP_MISSED',
        runCount: 12,
        maxTotalRuns: 100,
        remainingRuns: 88,
        currentInFlight: 0,
        totalExecutions: 13,
        catchUpExecutions: 1,
        byStatus: {
          scheduled: 0,
          dispatched: 12,
          missed: 1,
          skippedOverlap: 0,
          skippedConcurrency: 0,
          skippedMinInterval: 0,
          skippedMaxRuns: 0,
          cancelled: 0,
        },
        byFinalJobStatus: { completed: 12, failed: 0, inFlight: 0 },
        totalRetries: 0,
        durationMs: { avg: 48, min: 35, max: 72 },
        lastRunAt: '2026-11-23T07:00:00.000Z',
        lastDispatchedAt: '2026-11-23T07:00:00.120Z',
        nextRunAt: '2026-11-23T08:00:00.000Z',
      };

      const reconciliation: ReconcileSchedulesResult = {
        bullmq: { scanned: 2, reEnqueued: 0, alreadyPresent: 2, failed: 0 },
        tick: {
          scanned: 1,
          dispatched: 0,
          catchUpDispatched: 0,
          missedRecorded: 0,
          skippedOverlap: 0,
          skippedConcurrency: 0,
          skippedMinInterval: 0,
          skippedMaxRuns: 0,
          skippedContention: 0,
          completedOneTime: 0,
          completedMaxRuns: 0,
          outboxDeferred: 0,
        },
      };

      const getSpy = vi.spyOn(apiClient, 'get');
      const postSpy = vi.spyOn(apiClient, 'post');
      const patchSpy = vi.spyOn(apiClient, 'patch');
      const deleteSpy = vi.spyOn(apiClient, 'delete');

      // 1. list
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            schedules: [schedule],
            pagination: {
              page: 1,
              limit: 20,
              total: 1,
              totalPages: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          },
          timestamp: new Date().toISOString(),
        },
      });
      const listed = await scheduleApi.list('org-alpha', {
        status: 'ACTIVE',
        type: 'RECURRING',
        queueId: schedule.queueId,
        page: 1,
        limit: 20,
      });
      expect(getSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/schedules', {
        params: {
          status: 'ACTIVE',
          type: 'RECURRING',
          queueId: schedule.queueId,
          page: 1,
          limit: 20,
        },
      });
      expect(listed.schedules).toEqual([schedule]);

      // 2. getById
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await scheduleApi.getById('org-alpha', schedule.id)).toEqual(schedule);
      expect(getSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}`,
      );

      // 3. create
      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule },
          timestamp: new Date().toISOString(),
        },
      });
      const created = await scheduleApi.create('org-alpha', {
        queueId: schedule.queueId,
        name: schedule.name,
        type: 'RECURRING',
        jobName: 'echo',
        cronExpression: '0 * * * *',
        timezone: 'Asia/Kolkata',
      });
      expect(postSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/schedules', {
        queueId: schedule.queueId,
        name: schedule.name,
        type: 'RECURRING',
        jobName: 'echo',
        cronExpression: '0 * * * *',
        timezone: 'Asia/Kolkata',
      });
      expect(created.schedule.id).toBe(schedule.id);

      // 4. update
      patchSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule: { ...schedule, misfirePolicy: 'CATCH_UP' } },
          timestamp: new Date().toISOString(),
        },
      });
      const updated = await scheduleApi.update('org-alpha', schedule.id, {
        misfirePolicy: 'CATCH_UP',
        maxCatchUpRuns: 10,
      });
      expect(patchSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}`,
        { misfirePolicy: 'CATCH_UP', maxCatchUpRuns: 10 },
      );
      expect(updated.misfirePolicy).toBe('CATCH_UP');

      // 5. pause, resume, cancel, delete
      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule: { ...schedule, status: 'PAUSED', nextRunAt: null } },
          timestamp: new Date().toISOString(),
        },
      });
      expect((await scheduleApi.pause('org-alpha', schedule.id)).status).toBe('PAUSED');
      expect(postSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/pause`,
        {},
      );

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule },
          timestamp: new Date().toISOString(),
        },
      });
      expect((await scheduleApi.resume('org-alpha', schedule.id)).status).toBe('ACTIVE');
      expect(postSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/resume`,
        {},
      );

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { schedule: { ...schedule, status: 'CANCELLED', nextRunAt: null } },
          timestamp: new Date().toISOString(),
        },
      });
      expect((await scheduleApi.cancel('org-alpha', schedule.id)).status).toBe('CANCELLED');
      expect(postSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/cancel`,
        {},
      );

      deleteSpy.mockResolvedValueOnce({ data: { success: true } });
      await scheduleApi.delete('org-alpha', schedule.id);
      expect(deleteSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}`,
      );

      // 6. listExecutions, getNextRun, getStats, reconcile
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            executions: [execution],
            pagination: {
              page: 1,
              limit: 20,
              total: 1,
              totalPages: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          },
          timestamp: new Date().toISOString(),
        },
      });
      const execs = await scheduleApi.listExecutions('org-alpha', schedule.id, {
        status: 'DISPATCHED',
        page: 1,
        limit: 20,
      });
      expect(getSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/executions`,
        { params: { status: 'DISPATCHED', page: 1, limit: 20 } },
      );
      expect(execs.executions[0].id).toBe('exec-1');

      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { nextRun },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await scheduleApi.getNextRun('org-alpha', schedule.id)).toEqual(nextRun);
      expect(getSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/next-run`,
      );

      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { stats },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await scheduleApi.getStats('org-alpha', schedule.id)).toEqual(stats);
      expect(getSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/schedules/${schedule.id}/stats`,
      );

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { reconciliation },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await scheduleApi.reconcile('org-alpha')).toEqual(reconciliation);
      expect(postSpy).toHaveBeenLastCalledWith(
        '/api/v1/organisations/org-alpha/schedules/reconcile',
        {},
      );
    });

    it('executes schedule queries with enabled guards and invalidates dependent caches on mutations', async () => {
      const schedule = makeSchedule();
      const { qc, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      vi.spyOn(scheduleApi, 'list').mockResolvedValue({
        schedules: [schedule],
        pagination: {
          page: 1,
          limit: 20,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
      vi.spyOn(scheduleApi, 'getById').mockResolvedValue(schedule);
      vi.spyOn(scheduleApi, 'getStats').mockResolvedValue({} as ScheduleStatsView);
      vi.spyOn(scheduleApi, 'getNextRun').mockResolvedValue({} as NextRunPreviewView);
      vi.spyOn(scheduleApi, 'listExecutions').mockResolvedValue({
        executions: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });

      // Disabled when organisationId or scheduleId is null
      const { result: disabledList } = renderHook(() => useSchedulesList(null), {
        wrapper: Wrapper,
      });
      expect(disabledList.current.fetchStatus).toBe('idle');

      const { result: disabledDetail } = renderHook(() => useScheduleDetail('org-alpha', null), {
        wrapper: Wrapper,
      });
      expect(disabledDetail.current.fetchStatus).toBe('idle');

      // Enabled when IDs provided
      const { result: listHook } = renderHook(
        () => useSchedulesList('org-alpha', { status: 'ACTIVE' }),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(listHook.current.isSuccess).toBe(true));
      expect(listHook.current.data?.schedules).toEqual([schedule]);

      const { result: detailHook } = renderHook(() => useScheduleDetail('org-alpha', schedule.id), {
        wrapper: Wrapper,
      });
      const { result: statsHook } = renderHook(() => useScheduleStats('org-alpha', schedule.id), {
        wrapper: Wrapper,
      });
      const { result: nextRunHook } = renderHook(
        () => useScheduleNextRun('org-alpha', schedule.id),
        { wrapper: Wrapper },
      );
      const { result: execsHook } = renderHook(
        () => useScheduleExecutions('org-alpha', schedule.id),
        { wrapper: Wrapper },
      );
      await waitFor(() => {
        expect(detailHook.current.isSuccess).toBe(true);
        expect(statsHook.current.isSuccess).toBe(true);
        expect(nextRunHook.current.isSuccess).toBe(true);
        expect(execsHook.current.isSuccess).toBe(true);
      });

      // Mutations invalidate schedule, queue, job, and dashboard summary queries
      vi.spyOn(scheduleApi, 'create').mockResolvedValue({
        schedule,
        initialJobId: 'job-init-1',
      });
      vi.spyOn(scheduleApi, 'update').mockResolvedValue(schedule);
      vi.spyOn(scheduleApi, 'pause').mockResolvedValue({ ...schedule, status: 'PAUSED' });
      vi.spyOn(scheduleApi, 'resume').mockResolvedValue(schedule);
      vi.spyOn(scheduleApi, 'cancel').mockResolvedValue({ ...schedule, status: 'CANCELLED' });
      vi.spyOn(scheduleApi, 'delete').mockResolvedValue(undefined);
      vi.spyOn(scheduleApi, 'reconcile').mockResolvedValue({} as ReconcileSchedulesResult);

      const { result: createMut } = renderHook(() => useCreateSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await createMut.current.mutateAsync({
        queueId: schedule.queueId,
        name: schedule.name,
        type: 'ONE_TIME',
        jobName: 'echo',
        runAt: '2026-12-01T10:00:00Z',
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['schedules', 'org-alpha'] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['org-schedules-summary', 'org-alpha'],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['job', 'org-alpha', 'job-init-1'],
      });

      const { result: updateMut } = renderHook(() => useUpdateSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await updateMut.current.mutateAsync({
        scheduleId: schedule.id,
        payload: { name: 'Renamed-Schedule' },
      });

      const { result: pauseMut } = renderHook(() => usePauseSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await pauseMut.current.mutateAsync(schedule.id);

      const { result: resumeMut } = renderHook(() => useResumeSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await resumeMut.current.mutateAsync(schedule.id);

      const { result: cancelMut } = renderHook(() => useCancelSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await cancelMut.current.mutateAsync(schedule.id);

      const { result: deleteMut } = renderHook(() => useDeleteSchedule('org-alpha'), {
        wrapper: Wrapper,
      });
      await deleteMut.current.mutateAsync(schedule.id);

      const { result: reconcileMut } = renderHook(() => useReconcileSchedules('org-alpha'), {
        wrapper: Wrapper,
      });
      await reconcileMut.current.mutateAsync();
    });
  });

  describe('dlqApi and useDlq hooks', () => {
    it('calls exact backend DLQ endpoints and invalidates DLQ, job, queue, and metrics caches on replay', async () => {
      const dlqItem = makeDlqItem();
      const getSpy = vi.spyOn(apiClient, 'get');
      const postSpy = vi.spyOn(apiClient, 'post');

      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            items: [dlqItem],
            pagination: {
              page: 1,
              limit: 20,
              total: 1,
              totalPages: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          },
          timestamp: new Date().toISOString(),
        },
      });

      const listRes = await dlqApi.list('org-alpha', {
        status: 'OPEN',
        queueId: dlqItem.queueId,
        page: 1,
        limit: 20,
      });
      expect(getSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/dlq', {
        params: { status: 'OPEN', queueId: dlqItem.queueId, page: 1, limit: 20 },
      });
      expect(listRes.items).toEqual([dlqItem]);

      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { deadLetterJob: dlqItem },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await dlqApi.getById('org-alpha', dlqItem.id)).toEqual(dlqItem);
      expect(getSpy).toHaveBeenLastCalledWith(`/api/v1/organisations/org-alpha/dlq/${dlqItem.id}`);

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            deadLetterJob: {
              ...dlqItem,
              status: 'REPLAYED',
              replayedJobId: 'job-replayed-2222',
              replayedAt: '2026-11-23T06:30:00.000Z',
            },
            replayedJob: {
              id: 'job-replayed-2222',
              queueId: dlqItem.queueId,
              organisationId: 'org-alpha',
              name: dlqItem.jobName,
              status: 'PENDING',
              priority: 2,
              replayedFromDlqId: dlqItem.id,
              createdAt: '2026-11-23T06:30:00.000Z',
            },
            dispatch: {
              enqueued: true,
              deduplicated: false,
              bullmqJobId: 'job-replayed-2222',
              bullmqQueueName: 'org_org-alpha__billing-invoices',
            },
          },
          timestamp: new Date().toISOString(),
        },
      });

      const { qc, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      const { result: disabledDetail } = renderHook(() => useDlqDetail('org-alpha', null), {
        wrapper: Wrapper,
      });
      expect(disabledDetail.current.fetchStatus).toBe('idle');

      vi.spyOn(dlqApi, 'list').mockResolvedValueOnce(listRes);
      const { result: listHook } = renderHook(() => useDlqList('org-alpha', { status: 'OPEN' }), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(listHook.current.isSuccess).toBe(true));

      const { result: replayMut } = renderHook(() => useReplayDlqJob('org-alpha'), {
        wrapper: Wrapper,
      });
      const replayRes = await replayMut.current.mutateAsync({
        dlqId: dlqItem.id,
        overrides: { priority: 2, maxRetries: 4 },
      });

      expect(postSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/dlq/${dlqItem.id}/replay`,
        { priority: 2, maxRetries: 4 },
      );
      expect(replayRes.replayedJob.id).toBe('job-replayed-2222');
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dlq', 'org-alpha'] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dlq-item', 'org-alpha', dlqItem.id],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['jobs', 'org-alpha'] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['queue-stats', 'org-alpha', dlqItem.queueId],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['org-metrics', 'org-alpha'] });
    });
  });

  describe('organisationApi, useOrganisationManagement hooks & RBAC invitation guard', () => {
    const sampleOrg: OrganisationView = {
      id: 'org-alpha',
      name: 'Acme Production',
      role: 'OWNER',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };

    const sampleMember: MemberView = {
      id: 'membership-uuid-999',
      role: 'MEMBER',
      createdAt: '2026-11-10T00:00:00.000Z',
      user: {
        id: 'user-target-uuid-123',
        name: 'Priya Engineer',
        email: 'priya@pulsequeue.dev',
      },
    };

    const sampleInvitation: InvitationView = {
      id: 'inv-1111',
      organisationId: 'org-alpha',
      invitedEmail: 'newdev@pulsequeue.dev',
      role: 'MEMBER',
      status: 'PENDING',
      expiresAt: '2026-11-30T00:00:00.000Z',
      createdAt: '2026-11-23T00:00:00.000Z',
      invitedBy: {
        id: 'user-owner',
        name: 'Apurva Owner',
        email: 'owner@pulsequeue.dev',
      },
    };

    it('calls exact backend organisation, member, invitation, ownership transfer, and standalone accept routes', async () => {
      const getSpy = vi.spyOn(apiClient, 'get');
      const postSpy = vi.spyOn(apiClient, 'post');
      const patchSpy = vi.spyOn(apiClient, 'patch');
      const deleteSpy = vi.spyOn(apiClient, 'delete');

      // getById & update & delete
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { organisation: sampleOrg },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await organisationApi.getById('org-alpha')).toEqual(sampleOrg);
      expect(getSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha');

      patchSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { organisation: { ...sampleOrg, name: 'Acme Global' } },
          timestamp: new Date().toISOString(),
        },
      });
      expect((await organisationApi.update('org-alpha', 'Acme Global')).name).toBe('Acme Global');
      expect(patchSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha', {
        name: 'Acme Global',
      });

      deleteSpy.mockResolvedValueOnce({ data: { success: true } });
      await organisationApi.delete('org-alpha');
      expect(deleteSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha');

      // transferOwnership uses member.user.id
      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            organisationId: 'org-alpha',
            newOwnerId: sampleMember.user.id,
            previousOwnerId: 'user-owner',
          },
          timestamp: new Date().toISOString(),
        },
      });
      const transferRes = await organisationApi.transferOwnership(
        'org-alpha',
        sampleMember.user.id,
      );
      expect(postSpy).toHaveBeenLastCalledWith(
        '/api/v1/organisations/org-alpha/transfer-ownership',
        { targetUserId: 'user-target-uuid-123' },
      );
      expect(transferRes.newOwnerId).toBe('user-target-uuid-123');

      // listMembers, updateMemberRole (using member.user.id), removeMember (using member.user.id)
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { members: [sampleMember] },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await organisationApi.listMembers('org-alpha')).toEqual([sampleMember]);
      expect(getSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/members');

      patchSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { member: { ...sampleMember, role: 'ADMIN' } },
          timestamp: new Date().toISOString(),
        },
      });
      const updatedMember = await organisationApi.updateMemberRole(
        'org-alpha',
        sampleMember.user.id,
        'ADMIN',
      );
      expect(patchSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/members/${sampleMember.user.id}/role`,
        { role: 'ADMIN' },
      );
      expect(updatedMember.role).toBe('ADMIN');

      deleteSpy.mockResolvedValueOnce({ data: { success: true } });
      await organisationApi.removeMember('org-alpha', sampleMember.user.id);
      expect(deleteSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/members/${sampleMember.user.id}`,
      );

      // listInvitations, createInvitation, revokeInvitation, acceptInvitation (standalone)
      getSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { invitations: [sampleInvitation] },
          timestamp: new Date().toISOString(),
        },
      });
      expect(await organisationApi.listInvitations('org-alpha')).toEqual([sampleInvitation]);
      expect(getSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/invitations');

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: { invitation: sampleInvitation, token: 'dev-raw-token-123' },
          timestamp: new Date().toISOString(),
        },
      });
      const createdInv = await organisationApi.createInvitation('org-alpha', {
        email: 'newdev@pulsequeue.dev',
        role: 'MEMBER',
      });
      expect(postSpy).toHaveBeenLastCalledWith('/api/v1/organisations/org-alpha/invitations', {
        email: 'newdev@pulsequeue.dev',
        role: 'MEMBER',
      });
      expect(createdInv.token).toBe('dev-raw-token-123');

      deleteSpy.mockResolvedValueOnce({ data: { success: true } });
      await organisationApi.revokeInvitation('org-alpha', sampleInvitation.id);
      expect(deleteSpy).toHaveBeenLastCalledWith(
        `/api/v1/organisations/org-alpha/invitations/${sampleInvitation.id}`,
      );

      postSpy.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            membership: {
              organisationId: 'org-alpha',
              role: 'MEMBER',
              membershipId: 'membership-new-1',
            },
          },
          timestamp: new Date().toISOString(),
        },
      });
      const accepted = await organisationApi.acceptInvitation('dev-raw-token-123');
      expect(postSpy).toHaveBeenLastCalledWith('/api/v1/invitations/accept', {
        token: 'dev-raw-token-123',
      });
      expect(accepted.organisationId).toBe('org-alpha');
    });

    it('enforces RBAC on useOrganisationInvitations (disabled for MEMBER, enabled for ADMIN/OWNER) and invalidates caches on mutations', async () => {
      expect(canManageOrganisationInvitations('OWNER')).toBe(true);
      expect(canManageOrganisationInvitations('ADMIN')).toBe(true);
      expect(canManageOrganisationInvitations('MEMBER')).toBe(false);
      expect(canManageOrganisationInvitations(null)).toBe(false);
      expect(canManageOrganisationInvitations(undefined)).toBe(false);

      const listInvSpy = vi
        .spyOn(organisationApi, 'listInvitations')
        .mockResolvedValue([sampleInvitation]);

      const { qc, Wrapper } = makeWrapper();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      // 1. MEMBER role MUST NOT trigger GET /invitations
      const { result: memberInvHook } = renderHook(
        () => useOrganisationInvitations('org-alpha', 'MEMBER'),
        { wrapper: Wrapper },
      );
      expect(memberInvHook.current.fetchStatus).toBe('idle');
      expect(listInvSpy).not.toHaveBeenCalled();

      // 2. ADMIN role executes GET /invitations
      const { result: adminInvHook } = renderHook(
        () => useOrganisationInvitations('org-alpha', 'ADMIN'),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(adminInvHook.current.isSuccess).toBe(true));
      expect(listInvSpy).toHaveBeenCalledTimes(1);

      // 3. Organisation detail & members hooks
      vi.spyOn(organisationApi, 'getById').mockResolvedValue(sampleOrg);
      vi.spyOn(organisationApi, 'listMembers').mockResolvedValue([sampleMember]);

      const { result: detailHook } = renderHook(() => useOrganisationDetail('org-alpha'), {
        wrapper: Wrapper,
      });
      const { result: membersHook } = renderHook(() => useOrganisationMembers('org-alpha'), {
        wrapper: Wrapper,
      });
      await waitFor(() => {
        expect(detailHook.current.isSuccess).toBe(true);
        expect(membersHook.current.isSuccess).toBe(true);
      });

      // 4. Mutations & cache invalidations
      vi.spyOn(organisationApi, 'update').mockResolvedValue({ ...sampleOrg, name: 'Acme Renamed' });
      vi.spyOn(organisationApi, 'updateMemberRole').mockResolvedValue({
        ...sampleMember,
        role: 'ADMIN',
      });
      vi.spyOn(organisationApi, 'removeMember').mockResolvedValue(undefined);
      vi.spyOn(organisationApi, 'transferOwnership').mockResolvedValue({
        organisationId: 'org-alpha',
        newOwnerId: sampleMember.user.id,
        previousOwnerId: 'user-owner',
      });
      vi.spyOn(organisationApi, 'createInvitation').mockResolvedValue({
        invitation: sampleInvitation,
        token: 'tok-1',
      });
      vi.spyOn(organisationApi, 'revokeInvitation').mockResolvedValue(undefined);
      vi.spyOn(organisationApi, 'acceptInvitation').mockResolvedValue({
        organisationId: 'org-beta',
        role: 'MEMBER',
        membershipId: 'mem-beta-1',
      });
      vi.spyOn(organisationApi, 'delete').mockResolvedValue(undefined);

      const { result: updateOrgMut } = renderHook(() => useUpdateOrganisation('org-alpha'), {
        wrapper: Wrapper,
      });
      await updateOrgMut.current.mutateAsync({ name: 'Acme Renamed' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisations'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisation', 'org-alpha'] });

      const { result: updateRoleMut } = renderHook(() => useUpdateMemberRole('org-alpha'), {
        wrapper: Wrapper,
      });
      await updateRoleMut.current.mutateAsync({ userId: sampleMember.user.id, role: 'ADMIN' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['org-members', 'org-alpha'] });

      const { result: removeMemberMut } = renderHook(() => useRemoveMember('org-alpha'), {
        wrapper: Wrapper,
      });
      await removeMemberMut.current.mutateAsync({ userId: sampleMember.user.id });

      const { result: transferMut } = renderHook(() => useTransferOwnership('org-alpha'), {
        wrapper: Wrapper,
      });
      await transferMut.current.mutateAsync({ targetUserId: sampleMember.user.id });

      const { result: createInvMut } = renderHook(() => useCreateInvitation('org-alpha'), {
        wrapper: Wrapper,
      });
      await createInvMut.current.mutateAsync({ email: 'newdev@pulsequeue.dev', role: 'MEMBER' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['org-invitations', 'org-alpha'] });

      const { result: revokeInvMut } = renderHook(() => useRevokeInvitation('org-alpha'), {
        wrapper: Wrapper,
      });
      await revokeInvMut.current.mutateAsync(sampleInvitation.id);

      const { result: acceptInvMut } = renderHook(() => useAcceptInvitation(), {
        wrapper: Wrapper,
      });
      await acceptInvMut.current.mutateAsync({ token: 'tok-1' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisation', 'org-beta'] });

      const { result: deleteOrgMut } = renderHook(() => useDeleteOrganisation(), {
        wrapper: Wrapper,
      });
      await deleteOrgMut.current.mutateAsync('org-alpha');
    });
  });
});

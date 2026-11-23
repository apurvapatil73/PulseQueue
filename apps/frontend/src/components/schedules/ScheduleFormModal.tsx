import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Braces, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { ApiClientError } from '../../api/error';
import type {
  CreateSchedulePayload,
  CreateScheduleResult,
  MisfirePolicy,
  QueueView,
  ScheduleType,
  ScheduleView,
  UpdateSchedulePayload,
} from '../../types/api';
import {
  BUILTIN_PROCESSOR_PRESETS,
  JOB_LIMITS,
  type ProcessorPreset,
} from '../jobs/SubmitJobModal';
import { QUEUE_LIMITS } from '../queues/QueueFormModal';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

export const SCHEDULE_LIMITS = {
  MIN_NAME_LENGTH: 2,
  MAX_NAME_LENGTH: 100,
  MAX_DESCRIPTION_LENGTH: 500,
  MIN_CATCH_UP_RUNS: 1,
  MAX_CATCH_UP_RUNS: 50,
  DEFAULT_CATCH_UP_RUNS: 5,
  MIN_MISFIRE_GRACE_MS: 1_000,
  MAX_MISFIRE_GRACE_MS: 3_600_000,
  DEFAULT_MISFIRE_GRACE_MS: 60_000,
  MIN_CONCURRENT_RUNS: 1,
  MAX_CONCURRENT_RUNS: 100,
  MIN_TOTAL_RUNS: 1,
  MAX_TOTAL_RUNS: 1_000_000,
  MIN_DURATION_MS: 100,
  MAX_DURATION_MS: 86_400_000,
  MIN_INTERVAL_MS: 500,
  MAX_INTERVAL_MS: 86_400_000,
} as const;

export const COMMON_IANA_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export interface CronPreset {
  label: string;
  expression: string;
  description: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { label: 'Every 5m', expression: '*/5 * * * *', description: 'Every 5 minutes' },
  { label: 'Every 15m', expression: '*/15 * * * *', description: 'Every 15 minutes' },
  { label: 'Hourly', expression: '0 * * * *', description: 'At minute 0 of every hour' },
  { label: 'Daily 09:00', expression: '0 9 * * *', description: 'Every day at 09:00 local time' },
  {
    label: 'Weekdays 09:00',
    expression: '0 9 * * 1-5',
    description: 'Monday–Friday at 09:00 local time',
  },
];

export const MISFIRE_POLICY_OPTIONS = [
  {
    label: 'SKIP_MISSED — Skip missed slots and wait for next occurrence',
    value: 'SKIP_MISSED',
  },
  {
    label: 'FIRE_ONCE — Coalesce missed slots into a single catch-up run',
    value: 'FIRE_ONCE',
  },
  {
    label: 'CATCH_UP — Replay missed occurrences up to Max Catch-Up Runs',
    value: 'CATCH_UP',
  },
];

export function isValidIanaTimezone(tz: string): boolean {
  const trimmed = tz.trim();
  if (!trimmed || trimmed.length > 100) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Payload must be a JSON object (e.g. { "key": "value" })' };
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(parsed)).length;
    if (byteLength > JOB_LIMITS.MAX_PAYLOAD_BYTES) {
      return {
        ok: false,
        error: `Payload must not exceed ${JOB_LIMITS.MAX_PAYLOAD_BYTES} bytes when serialized`,
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON syntax: ${err instanceof Error ? err.message : 'Unable to parse JSON'}`,
    };
  }
}

function parseOptionalInt(
  raw: string,
  fieldLabel: string,
  min: number,
  max: number,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  const num = Number(trimmed);
  if (!Number.isInteger(num)) {
    return { ok: false, error: `${fieldLabel} must be a whole integer` };
  }
  if (num < min || num > max) {
    return {
      ok: false,
      error: `${fieldLabel} must be between ${min.toLocaleString()} and ${max.toLocaleString()}`,
    };
  }
  return { ok: true, value: num };
}

function defaultFutureRunAtIso(): string {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  future.setSeconds(0, 0);
  return future.toISOString().slice(0, 19);
}

function formatRunAtForInput(iso: string | null): string {
  if (!iso) return defaultFutureRunAtIso();
  try {
    return new Date(iso).toISOString().slice(0, 19) + 'Z';
  } catch {
    return iso;
  }
}

export const scheduleFormSchema = z
  .object({
    queueId: z.string().min(1, 'Target queue is required'),
    name: z
      .string({ required_error: 'Schedule name is required' })
      .trim()
      .min(
        SCHEDULE_LIMITS.MIN_NAME_LENGTH,
        `Schedule name must be at least ${SCHEDULE_LIMITS.MIN_NAME_LENGTH} characters`,
      )
      .max(
        SCHEDULE_LIMITS.MAX_NAME_LENGTH,
        `Schedule name must not exceed ${SCHEDULE_LIMITS.MAX_NAME_LENGTH} characters`,
      ),
    description: z
      .string()
      .max(
        SCHEDULE_LIMITS.MAX_DESCRIPTION_LENGTH,
        `Description must not exceed ${SCHEDULE_LIMITS.MAX_DESCRIPTION_LENGTH} characters`,
      )
      .optional(),
    type: z.enum(['ONE_TIME', 'RECURRING']),
    timezone: z
      .string()
      .trim()
      .min(1, 'Timezone is required')
      .max(100, 'Timezone must not exceed 100 characters')
      .refine((tz) => isValidIanaTimezone(tz), {
        message: 'Invalid IANA timezone identifier (e.g. UTC, Asia/Kolkata, America/New_York)',
      }),
    runAt: z.string().optional(),
    cronExpression: z.string().optional(),
    jobName: z
      .string({ required_error: 'Job processor name is required' })
      .trim()
      .min(
        JOB_LIMITS.MIN_NAME_LENGTH,
        `Job name must be at least ${JOB_LIMITS.MIN_NAME_LENGTH} characters`,
      )
      .max(
        JOB_LIMITS.MAX_NAME_LENGTH,
        `Job name must not exceed ${JOB_LIMITS.MAX_NAME_LENGTH} characters`,
      ),
    payloadText: z.string().superRefine((val, ctx) => {
      const res = parseJsonObject(val);
      if (!res.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: res.error,
        });
      }
    }),
    priorityText: z.string(),
    maxRetriesText: z.string(),
    backoffMsText: z.string(),
    misfirePolicy: z.enum(['SKIP_MISSED', 'FIRE_ONCE', 'CATCH_UP']),
    maxCatchUpRuns: z.coerce
      .number({ invalid_type_error: 'Max catch-up runs must be an integer' })
      .int('Max catch-up runs must be an integer')
      .min(
        SCHEDULE_LIMITS.MIN_CATCH_UP_RUNS,
        `Max catch-up runs must be at least ${SCHEDULE_LIMITS.MIN_CATCH_UP_RUNS}`,
      )
      .max(
        SCHEDULE_LIMITS.MAX_CATCH_UP_RUNS,
        `Max catch-up runs must not exceed ${SCHEDULE_LIMITS.MAX_CATCH_UP_RUNS}`,
      ),
    misfireGraceMs: z.coerce
      .number({ invalid_type_error: 'Misfire grace window must be an integer' })
      .int('Misfire grace window must be an integer')
      .min(
        SCHEDULE_LIMITS.MIN_MISFIRE_GRACE_MS,
        `Misfire grace window must be at least ${SCHEDULE_LIMITS.MIN_MISFIRE_GRACE_MS} ms`,
      )
      .max(
        SCHEDULE_LIMITS.MAX_MISFIRE_GRACE_MS,
        `Misfire grace window must not exceed ${SCHEDULE_LIMITS.MAX_MISFIRE_GRACE_MS} ms`,
      ),
    preventOverlap: z.boolean(),
    maxConcurrentRunsText: z.string(),
    maxTotalRunsText: z.string(),
    maxDurationMsText: z.string(),
    minIntervalMsText: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'ONE_TIME') {
      if (!data.runAt || !data.runAt.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAt'],
          message: 'runAt timestamp is required for ONE_TIME schedules',
        });
      }
    } else {
      if (!data.cronExpression || !data.cronExpression.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'cronExpression is required for RECURRING schedules',
        });
      } else if (data.cronExpression.trim().length > 120) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'cronExpression must not exceed 120 characters',
        });
      }
    }

    const prio = parseOptionalInt(
      data.priorityText,
      'Priority',
      QUEUE_LIMITS.MIN_PRIORITY,
      QUEUE_LIMITS.MAX_PRIORITY,
    );
    if (!prio.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priorityText'], message: prio.error });
    }

    const retries = parseOptionalInt(
      data.maxRetriesText,
      'Max retries',
      QUEUE_LIMITS.MIN_MAX_RETRIES,
      QUEUE_LIMITS.MAX_MAX_RETRIES,
    );
    if (!retries.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxRetriesText'],
        message: retries.error,
      });
    }

    const backoff = parseOptionalInt(
      data.backoffMsText,
      'Backoff duration',
      QUEUE_LIMITS.MIN_BACKOFF_MS,
      QUEUE_LIMITS.MAX_BACKOFF_MS,
    );
    if (!backoff.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backoffMsText'],
        message: backoff.error,
      });
    }

    const maxConcurrent = parseOptionalInt(
      data.maxConcurrentRunsText,
      'Max concurrent runs',
      SCHEDULE_LIMITS.MIN_CONCURRENT_RUNS,
      SCHEDULE_LIMITS.MAX_CONCURRENT_RUNS,
    );
    if (!maxConcurrent.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxConcurrentRunsText'],
        message: maxConcurrent.error,
      });
    } else if (data.preventOverlap && maxConcurrent.value !== null && maxConcurrent.value > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxConcurrentRunsText'],
        message: 'preventOverlap: true cannot be combined with maxConcurrentRuns > 1',
      });
    }

    const maxTotal = parseOptionalInt(
      data.maxTotalRunsText,
      'Max total runs',
      SCHEDULE_LIMITS.MIN_TOTAL_RUNS,
      SCHEDULE_LIMITS.MAX_TOTAL_RUNS,
    );
    if (!maxTotal.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxTotalRunsText'],
        message: maxTotal.error,
      });
    }

    const maxDur = parseOptionalInt(
      data.maxDurationMsText,
      'Max duration',
      SCHEDULE_LIMITS.MIN_DURATION_MS,
      SCHEDULE_LIMITS.MAX_DURATION_MS,
    );
    if (!maxDur.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDurationMsText'],
        message: maxDur.error,
      });
    }

    const minInt = parseOptionalInt(
      data.minIntervalMsText,
      'Minimum interval',
      SCHEDULE_LIMITS.MIN_INTERVAL_MS,
      SCHEDULE_LIMITS.MAX_INTERVAL_MS,
    );
    if (!minInt.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minIntervalMsText'],
        message: minInt.error,
      });
    }
  });

export type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

export interface ScheduleFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  queues: QueueView[];
  defaultQueueId?: string | null;
  initialSchedule?: ScheduleView | null;
  onClose: () => void;
  onSubmitCreate?: (payload: CreateSchedulePayload) => Promise<CreateScheduleResult>;
  onSubmitEdit?: (scheduleId: string, payload: UpdateSchedulePayload) => Promise<ScheduleView>;
  onSuccess?: (schedule: ScheduleView, message: string) => void;
}

export function ScheduleFormModal({
  isOpen,
  mode,
  queues,
  defaultQueueId,
  initialSchedule,
  onClose,
  onSubmitCreate,
  onSubmitEdit,
  onSuccess,
}: ScheduleFormModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const initialQueue = useMemo(() => {
    if (mode === 'edit' && initialSchedule) {
      return queues.find((q) => q.id === initialSchedule.queueId) ?? null;
    }
    if (defaultQueueId) {
      const found = queues.find((q) => q.id === defaultQueueId);
      if (found) return found;
    }
    return queues[0] ?? null;
  }, [mode, initialSchedule, defaultQueueId, queues]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      queueId: initialQueue?.id ?? '',
      name: '',
      description: '',
      type: 'RECURRING',
      timezone: 'UTC',
      runAt: defaultFutureRunAtIso(),
      cronExpression: '0 * * * *',
      jobName: 'echo',
      payloadText: JSON.stringify(BUILTIN_PROCESSOR_PRESETS[0].samplePayload, null, 2),
      priorityText: '',
      maxRetriesText: '',
      backoffMsText: '',
      misfirePolicy: 'SKIP_MISSED',
      maxCatchUpRuns: SCHEDULE_LIMITS.DEFAULT_CATCH_UP_RUNS,
      misfireGraceMs: SCHEDULE_LIMITS.DEFAULT_MISFIRE_GRACE_MS,
      preventOverlap: true,
      maxConcurrentRunsText: '',
      maxTotalRunsText: '',
      maxDurationMsText: '',
      minIntervalMsText: '',
    },
  });

  const watchedType = watch('type');
  const watchedJobName = watch('jobName');
  const watchedPayloadText = watch('payloadText');
  const watchedCron = watch('cronExpression');
  const watchedTimezone = watch('timezone');
  const watchedPreventOverlap = watch('preventOverlap');

  const activePreset = useMemo(
    () => BUILTIN_PROCESSOR_PRESETS.find((p) => p.name === watchedJobName?.trim()),
    [watchedJobName],
  );

  const payloadBytes = useMemo(
    () => new TextEncoder().encode(watchedPayloadText ?? '').length,
    [watchedPayloadText],
  );

  useEffect(() => {
    if (!isOpen) return;
    setServerError(null);

    if (mode === 'edit' && initialSchedule) {
      const hasCustomAdvanced =
        initialSchedule.misfirePolicy !== 'SKIP_MISSED' ||
        initialSchedule.maxConcurrentRuns !== null ||
        initialSchedule.maxTotalRuns !== null ||
        initialSchedule.maxDurationMs !== null ||
        initialSchedule.minIntervalMs !== null ||
        initialSchedule.priority !== null ||
        initialSchedule.maxRetries !== null ||
        initialSchedule.backoffMs !== null;
      setAdvancedOpen(hasCustomAdvanced);

      reset({
        queueId: initialSchedule.queueId,
        name: initialSchedule.name,
        description: initialSchedule.description ?? '',
        type: initialSchedule.type,
        timezone: initialSchedule.timezone,
        runAt: formatRunAtForInput(initialSchedule.runAt),
        cronExpression: initialSchedule.cronExpression ?? '0 * * * *',
        jobName: initialSchedule.jobName,
        payloadText: JSON.stringify(initialSchedule.payload ?? {}, null, 2),
        priorityText: initialSchedule.priority !== null ? String(initialSchedule.priority) : '',
        maxRetriesText:
          initialSchedule.maxRetries !== null ? String(initialSchedule.maxRetries) : '',
        backoffMsText: initialSchedule.backoffMs !== null ? String(initialSchedule.backoffMs) : '',
        misfirePolicy: initialSchedule.misfirePolicy,
        maxCatchUpRuns: initialSchedule.maxCatchUpRuns,
        misfireGraceMs: initialSchedule.misfireGraceMs,
        preventOverlap: initialSchedule.preventOverlap,
        maxConcurrentRunsText:
          initialSchedule.maxConcurrentRuns !== null
            ? String(initialSchedule.maxConcurrentRuns)
            : '',
        maxTotalRunsText:
          initialSchedule.maxTotalRuns !== null ? String(initialSchedule.maxTotalRuns) : '',
        maxDurationMsText:
          initialSchedule.maxDurationMs !== null ? String(initialSchedule.maxDurationMs) : '',
        minIntervalMsText:
          initialSchedule.minIntervalMs !== null ? String(initialSchedule.minIntervalMs) : '',
      });
    } else {
      setAdvancedOpen(false);
      const target =
        (defaultQueueId ? queues.find((q) => q.id === defaultQueueId) : undefined) ??
        queues[0] ??
        null;

      reset({
        queueId: target?.id ?? '',
        name: '',
        description: '',
        type: 'RECURRING',
        timezone: 'UTC',
        runAt: defaultFutureRunAtIso(),
        cronExpression: '0 * * * *',
        jobName: 'echo',
        payloadText: JSON.stringify(BUILTIN_PROCESSOR_PRESETS[0].samplePayload, null, 2),
        priorityText: '',
        maxRetriesText: '',
        backoffMsText: '',
        misfirePolicy: 'SKIP_MISSED',
        maxCatchUpRuns: SCHEDULE_LIMITS.DEFAULT_CATCH_UP_RUNS,
        misfireGraceMs: SCHEDULE_LIMITS.DEFAULT_MISFIRE_GRACE_MS,
        preventOverlap: true,
        maxConcurrentRunsText: '',
        maxTotalRunsText: '',
        maxDurationMsText: '',
        minIntervalMsText: '',
      });
    }
  }, [isOpen, mode, initialSchedule, defaultQueueId, queues, reset]);

  const applyProcessorPreset = (preset: ProcessorPreset) => {
    setValue('jobName', preset.name, { shouldValidate: true });
    setValue('payloadText', JSON.stringify(preset.samplePayload, null, 2), {
      shouldValidate: true,
    });
  };

  const applyCronPreset = (expression: string) => {
    setValue('cronExpression', expression, { shouldValidate: true });
  };

  const handleFormatJson = () => {
    const parsed = parseJsonObject(watchedPayloadText ?? '');
    if (parsed.ok) {
      setValue('payloadText', JSON.stringify(parsed.value, null, 2), { shouldValidate: true });
    } else {
      void trigger('payloadText');
    }
  };

  const onSubmit = async (values: ScheduleFormValues) => {
    setServerError(null);
    const parsedPayload = parseJsonObject(values.payloadText);
    if (!parsedPayload.ok) {
      setServerError(parsedPayload.error);
      return;
    }

    const priorityRes = parseOptionalInt(
      values.priorityText,
      'Priority',
      QUEUE_LIMITS.MIN_PRIORITY,
      QUEUE_LIMITS.MAX_PRIORITY,
    );
    const retriesRes = parseOptionalInt(
      values.maxRetriesText,
      'Max retries',
      QUEUE_LIMITS.MIN_MAX_RETRIES,
      QUEUE_LIMITS.MAX_MAX_RETRIES,
    );
    const backoffRes = parseOptionalInt(
      values.backoffMsText,
      'Backoff',
      QUEUE_LIMITS.MIN_BACKOFF_MS,
      QUEUE_LIMITS.MAX_BACKOFF_MS,
    );
    const maxConcurrentRes = parseOptionalInt(
      values.maxConcurrentRunsText,
      'Max concurrent runs',
      SCHEDULE_LIMITS.MIN_CONCURRENT_RUNS,
      SCHEDULE_LIMITS.MAX_CONCURRENT_RUNS,
    );
    const maxTotalRes = parseOptionalInt(
      values.maxTotalRunsText,
      'Max total runs',
      SCHEDULE_LIMITS.MIN_TOTAL_RUNS,
      SCHEDULE_LIMITS.MAX_TOTAL_RUNS,
    );
    const maxDurationRes = parseOptionalInt(
      values.maxDurationMsText,
      'Max duration',
      SCHEDULE_LIMITS.MIN_DURATION_MS,
      SCHEDULE_LIMITS.MAX_DURATION_MS,
    );
    const minIntervalRes = parseOptionalInt(
      values.minIntervalMsText,
      'Minimum interval',
      SCHEDULE_LIMITS.MIN_INTERVAL_MS,
      SCHEDULE_LIMITS.MAX_INTERVAL_MS,
    );

    if (
      !priorityRes.ok ||
      !retriesRes.ok ||
      !backoffRes.ok ||
      !maxConcurrentRes.ok ||
      !maxTotalRes.ok ||
      !maxDurationRes.ok ||
      !minIntervalRes.ok
    ) {
      return;
    }

    const descriptionValue = values.description?.trim() ? values.description.trim() : null;

    try {
      if (mode === 'create' && onSubmitCreate) {
        const createPayload: CreateSchedulePayload = {
          queueId: values.queueId,
          name: values.name.trim(),
          description: descriptionValue,
          type: values.type,
          jobName: values.jobName.trim(),
          payload: parsedPayload.value,
          timezone: values.timezone.trim(),
          ...(values.type === 'ONE_TIME'
            ? { runAt: values.runAt!.trim() }
            : { cronExpression: values.cronExpression!.trim() }),
          ...(priorityRes.value !== null ? { priority: priorityRes.value } : {}),
          ...(retriesRes.value !== null ? { maxRetries: retriesRes.value } : {}),
          ...(backoffRes.value !== null ? { backoffMs: backoffRes.value } : {}),
          preventOverlap: values.preventOverlap,
          misfirePolicy: values.misfirePolicy as MisfirePolicy,
          maxCatchUpRuns: values.maxCatchUpRuns,
          misfireGraceMs: values.misfireGraceMs,
          maxConcurrentRuns: maxConcurrentRes.value,
          maxTotalRuns: maxTotalRes.value,
          maxDurationMs: maxDurationRes.value,
          minIntervalMs: minIntervalRes.value,
        };

        const result = await onSubmitCreate(createPayload);
        onSuccess?.(
          result.schedule,
          `Schedule "${result.schedule.name}" created (${result.schedule.type}).`,
        );
        onClose();
      } else if (mode === 'edit' && initialSchedule && onSubmitEdit) {
        // Strict update payload: NEVER send queueId, type, or unsupported timing field
        const updatePayload: UpdateSchedulePayload = {
          name: values.name.trim(),
          description: descriptionValue,
          jobName: values.jobName.trim(),
          payload: parsedPayload.value,
          priority: priorityRes.value,
          maxRetries: retriesRes.value,
          backoffMs: backoffRes.value,
          timezone: values.timezone.trim(),
          ...(initialSchedule.type === 'ONE_TIME'
            ? { runAt: values.runAt!.trim() }
            : { cronExpression: values.cronExpression!.trim() }),
          preventOverlap: values.preventOverlap,
          misfirePolicy: values.misfirePolicy as MisfirePolicy,
          maxCatchUpRuns: values.maxCatchUpRuns,
          misfireGraceMs: values.misfireGraceMs,
          maxConcurrentRuns: maxConcurrentRes.value,
          maxTotalRuns: maxTotalRes.value,
          maxDurationMs: maxDurationRes.value,
          minIntervalMs: minIntervalRes.value,
        };

        const updated = await onSubmitEdit(initialSchedule.id, updatePayload);
        onSuccess?.(updated, `Schedule "${updated.name}" updated.`);
        onClose();
      }
    } catch (err) {
      setServerError(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to save schedule. Please check your configuration and try again.',
      );
    }
  };

  const queueOptions = useMemo(() => {
    if (mode === 'edit' && initialSchedule) {
      const existingInList = queues.some((q) => q.id === initialSchedule.queueId);
      if (!existingInList) {
        return [
          { label: initialSchedule.queueName, value: initialSchedule.queueId },
          ...queues.map((q) => ({ label: q.name, value: q.id })),
        ];
      }
    }
    return queues.map((q) => ({
      label: `${q.name}${q.isPaused ? ' (Paused)' : ''}`,
      value: q.id,
    }));
  }, [mode, initialSchedule, queues]);

  const hasAdvancedError = Boolean(
    errors.priorityText ||
    errors.maxRetriesText ||
    errors.backoffMsText ||
    errors.maxCatchUpRuns ||
    errors.misfireGraceMs ||
    errors.maxConcurrentRunsText ||
    errors.maxTotalRunsText ||
    errors.maxDurationMsText ||
    errors.minIntervalMsText,
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        mode === 'create' ? 'Create Schedule' : `Edit Schedule "${initialSchedule?.name ?? ''}"`
      }
      description={
        mode === 'create'
          ? 'Configure a one-time or timezone-aware recurring cron job schedule.'
          : 'Update schedule cadence, payload, misfire handling, and execution limits.'
      }
    >
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="max-h-[78vh] space-y-4 overflow-y-auto pr-1"
        noValidate
      >
        {serverError && <ErrorState compact message={serverError} />}

        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Select
            id="scheduleQueueId"
            label="Target Queue"
            disabled={mode === 'edit'}
            options={
              queueOptions.length > 0 ? queueOptions : [{ label: 'No queues available', value: '' }]
            }
            error={errors.queueId?.message}
            value={watch('queueId')}
            onChange={(e) => setValue('queueId', e.target.value, { shouldValidate: true })}
          />

          <Select
            id="scheduleType"
            label="Schedule Type"
            disabled={mode === 'edit'}
            options={[
              { label: 'RECURRING (Cron)', value: 'RECURRING' },
              { label: 'ONE_TIME (Timestamp)', value: 'ONE_TIME' },
            ]}
            error={errors.type?.message}
            value={watchedType}
            onChange={(e) =>
              setValue('type', e.target.value as ScheduleType, { shouldValidate: true })
            }
          />
        </div>

        <Input
          label="Schedule Name"
          placeholder="e.g. Hourly-Billing-Reconciliation"
          error={errors.name?.message}
          {...register('name')}
        />

        <Input
          label="Description (Optional)"
          placeholder="Brief summary of what this schedule orchestrates"
          error={errors.description?.message}
          {...register('description')}
        />

        {/* Timezone & Cadence Section */}
        <div className="rounded-lg border border-border-subtle bg-canvas/50 p-3.5 space-y-3">
          <div className="space-y-1.5">
            <Input
              label="IANA Timezone"
              placeholder="e.g. UTC, Asia/Kolkata, America/New_York"
              hint="Used for cron evaluation, DST transitions, and local wall-clock timestamps"
              error={errors.timezone?.message}
              {...register('timezone')}
            />
            <div className="flex flex-wrap gap-1 pt-0.5">
              {COMMON_IANA_TIMEZONES.slice(0, 6).map((tz) => (
                <button
                  key={tz}
                  type="button"
                  onClick={() => setValue('timezone', tz, { shouldValidate: true })}
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                    watchedTimezone?.trim() === tz
                      ? 'border-sky-400/50 bg-sky-400/15 text-sky-200'
                      : 'border-border-subtle bg-surface text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tz}
                </button>
              ))}
            </div>
          </div>

          {watchedType === 'RECURRING' ? (
            <div className="space-y-2">
              <Input
                label="Cron Expression"
                placeholder="e.g. */15 * * * * or 0 9 * * 1-5"
                hint="5-field, 6-field, or macro (@hourly, @daily, @weekly)"
                error={errors.cronExpression?.message}
                {...register('cronExpression')}
              />
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                  <button
                    key={preset.expression}
                    type="button"
                    title={preset.description}
                    onClick={() => applyCronPreset(preset.expression)}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                      watchedCron?.trim() === preset.expression
                        ? 'border-sky-400/50 bg-sky-400/15 text-sky-200'
                        : 'border-border-subtle bg-surface text-slate-300 hover:border-border-strong'
                    }`}
                  >
                    {preset.label} ({preset.expression})
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Input
              label="Scheduled Execution Timestamp (runAt)"
              placeholder="e.g. 2026-12-01T16:00:00 or 2026-12-01T10:30:00Z"
              hint={`ISO-8601 timestamp in the future. Wall-clock times without offset are interpreted in ${watchedTimezone || 'UTC'}.`}
              error={errors.runAt?.message}
              {...register('runAt')}
            />
          )}
        </div>

        {/* Job Processor & Payload Section */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">Processor Templates</span>
              <span className="text-[11px] text-slate-500">Click to prefill</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BUILTIN_PROCESSOR_PRESETS.map((preset) => {
                const isSelected = watchedJobName?.trim() === preset.name;
                return (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => applyProcessorPreset(preset)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                      isSelected
                        ? 'border-sky-400/50 bg-sky-400/15 text-sky-200'
                        : 'border-border-subtle bg-canvas text-slate-300 hover:border-border-strong'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <Input
            label="Job Processor Name"
            placeholder="e.g. echo, math.sum, transform.json"
            hint={
              activePreset
                ? activePreset.schemaHint
                : '2–128 characters matching a registered worker processor.'
            }
            error={errors.jobName?.message}
            {...register('jobName')}
          />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="schedulePayloadText"
                className="block text-xs font-medium text-slate-300"
              >
                JSON Payload
              </label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-500">
                  {payloadBytes.toLocaleString()} / {JOB_LIMITS.MAX_PAYLOAD_BYTES.toLocaleString()}{' '}
                  B
                </span>
                <button
                  type="button"
                  onClick={handleFormatJson}
                  className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-elevated px-2 py-0.5 text-[11px] text-slate-300 hover:border-border-strong hover:text-slate-100"
                >
                  <Braces className="h-3 w-3 text-sky-400" />
                  Format JSON
                </button>
              </div>
            </div>
            <textarea
              id="schedulePayloadText"
              rows={4}
              aria-invalid={Boolean(errors.payloadText)}
              placeholder='{ "message": "hello" }'
              className={`w-full rounded-lg bg-canvas p-3 font-mono text-xs text-slate-100 placeholder:text-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400/30 ${
                errors.payloadText
                  ? 'border-rose-500/60 focus:border-rose-400'
                  : 'border-border-subtle hover:border-border-strong focus:border-sky-400/70'
              }`}
              {...register('payloadText')}
            />
            {errors.payloadText && (
              <p role="alert" className="text-xs text-rose-400">
                {errors.payloadText.message}
              </p>
            )}
          </div>
        </div>

        {/* Misfire Policy & Overlap Quick Controls */}
        <div className="space-y-3 rounded-lg border border-border-subtle bg-canvas/50 p-3.5">
          <Select
            label="Misfire Policy"
            options={MISFIRE_POLICY_OPTIONS}
            error={errors.misfirePolicy?.message}
            {...register('misfirePolicy')}
          />

          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong bg-canvas text-sky-400 focus:ring-sky-400/40"
              {...register('preventOverlap')}
            />
            <span className="text-xs text-slate-200">
              <span className="font-medium">Prevent Overlapping Runs</span>
              <span className="block text-[11px] text-slate-400">
                Skip a due occurrence if a previous execution from this schedule is still in flight
                (cannot be combined with Max Concurrent Runs &gt; 1).
              </span>
            </span>
          </label>
        </div>

        {/* Collapsible Advanced Reliability & Execution Controls */}
        <div className="rounded-lg border border-border-subtle bg-surface-subtle/40">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            aria-expanded={advancedOpen || hasAdvancedError}
            className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-200 hover:bg-surface-elevated/50 rounded-lg"
          >
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 text-sky-400" />
              Advanced Reliability, Concurrency &amp; Job Overrides
            </span>
            {advancedOpen || hasAdvancedError ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )}
          </button>

          {(advancedOpen || hasAdvancedError) && (
            <div className="space-y-3.5 border-t border-border-subtle p-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Max Catch-Up Runs (1–50)"
                  type="number"
                  min={SCHEDULE_LIMITS.MIN_CATCH_UP_RUNS}
                  max={SCHEDULE_LIMITS.MAX_CATCH_UP_RUNS}
                  error={errors.maxCatchUpRuns?.message}
                  {...register('maxCatchUpRuns')}
                />
                <Input
                  label="Misfire Grace Window (ms)"
                  type="number"
                  min={SCHEDULE_LIMITS.MIN_MISFIRE_GRACE_MS}
                  max={SCHEDULE_LIMITS.MAX_MISFIRE_GRACE_MS}
                  hint="1,000–3,600,000 ms (default 60,000)"
                  error={errors.misfireGraceMs?.message}
                  {...register('misfireGraceMs')}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Max Concurrent Runs (1–100)"
                  type="number"
                  placeholder={watchedPreventOverlap ? '1 (locked by preventOverlap)' : 'Unlimited'}
                  error={errors.maxConcurrentRunsText?.message}
                  {...register('maxConcurrentRunsText')}
                />
                <Input
                  label="Max Total Runs (Optional)"
                  type="number"
                  placeholder="Unlimited"
                  error={errors.maxTotalRunsText?.message}
                  {...register('maxTotalRunsText')}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Max Duration Timeout (ms)"
                  type="number"
                  placeholder="None (100–86,400,000)"
                  error={errors.maxDurationMsText?.message}
                  {...register('maxDurationMsText')}
                />
                <Input
                  label="Min Interval Cooldown (ms)"
                  type="number"
                  placeholder="None (500–86,400,000)"
                  error={errors.minIntervalMsText?.message}
                  {...register('minIntervalMsText')}
                />
              </div>

              <div className="grid grid-cols-3 gap-2.5 pt-1">
                <Input
                  label="Priority (1–20)"
                  type="number"
                  placeholder="Queue default"
                  error={errors.priorityText?.message}
                  {...register('priorityText')}
                />
                <Input
                  label="Max Retries (0–20)"
                  type="number"
                  placeholder="Queue default"
                  error={errors.maxRetriesText?.message}
                  {...register('maxRetriesText')}
                />
                <Input
                  label="Backoff (ms)"
                  type="number"
                  placeholder="Queue default"
                  error={errors.backoffMsText?.message}
                  {...register('backoffMsText')}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            isLoading={isSubmitting}
            disabled={mode === 'create' && queues.length === 0}
          >
            {mode === 'create' ? 'Create Schedule' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

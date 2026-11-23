import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Braces } from 'lucide-react';
import { ApiClientError } from '../../api/error';
import type { CreateJobPayload } from '../../api/job.api';
import type { JobSubmissionResult, QueueView } from '../../types/api';
import { QUEUE_LIMITS } from '../queues/QueueFormModal';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';

export const JOB_LIMITS = {
  MIN_NAME_LENGTH: 2,
  MAX_NAME_LENGTH: 128,
  MAX_PAYLOAD_BYTES: 65_536,
  MIN_DELAY_MS: 0,
  MAX_DELAY_MS: 86_400_000,
} as const;

export interface ProcessorPreset {
  name: string;
  label: string;
  schemaHint: string;
  samplePayload: Record<string, unknown>;
}

export const BUILTIN_PROCESSOR_PRESETS: readonly ProcessorPreset[] = [
  {
    name: 'echo',
    label: 'echo',
    schemaHint: 'Requires { "message": string (1–4096 chars), "metadata"?: object }',
    samplePayload: {
      message: 'Hello from PulseQueue job control plane',
      metadata: { source: 'dashboard', environment: 'development' },
    },
  },
  {
    name: 'math.sum',
    label: 'math.sum',
    schemaHint: 'Requires { "numbers": number[] (1–10,000 finite numbers) }',
    samplePayload: {
      numbers: [12, 28, 40, 120],
    },
  },
  {
    name: 'transform.json',
    label: 'transform.json',
    schemaHint: 'Requires { "records": Record<string, primitive>, "uppercaseKeys"?: boolean }',
    samplePayload: {
      records: { tenant: 'acme', region: 'ap-south-1', active: true },
      uppercaseKeys: true,
    },
  },
  {
    name: 'test.fail',
    label: 'test.fail',
    schemaHint: 'Optional { "reason"?: string, "failUntilAttempt"?: number (1–20) }',
    samplePayload: {
      reason: 'Simulated transient downstream timeout',
      failUntilAttempt: 1,
    },
  },
];

function parseJsonObject(raw: string):
  | {
      ok: true;
      value: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    } {
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

export const submitJobFormSchema = z.object({
  queueId: z.string().min(1, 'Target queue is required'),
  name: z
    .string({ required_error: 'Job name is required' })
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
  priority: z.coerce
    .number({ invalid_type_error: 'Priority must be an integer' })
    .int('Priority must be an integer')
    .min(QUEUE_LIMITS.MIN_PRIORITY, `Priority must be at least ${QUEUE_LIMITS.MIN_PRIORITY}`)
    .max(QUEUE_LIMITS.MAX_PRIORITY, `Priority must not exceed ${QUEUE_LIMITS.MAX_PRIORITY}`),
  maxRetries: z.coerce
    .number({ invalid_type_error: 'Maximum retries must be an integer' })
    .int('Maximum retries must be an integer')
    .min(
      QUEUE_LIMITS.MIN_MAX_RETRIES,
      `Maximum retries must be at least ${QUEUE_LIMITS.MIN_MAX_RETRIES}`,
    )
    .max(
      QUEUE_LIMITS.MAX_MAX_RETRIES,
      `Maximum retries must not exceed ${QUEUE_LIMITS.MAX_MAX_RETRIES}`,
    ),
  backoffMs: z.coerce
    .number({ invalid_type_error: 'Backoff duration must be an integer' })
    .int('Backoff duration must be an integer')
    .min(QUEUE_LIMITS.MIN_BACKOFF_MS, `Backoff must be at least ${QUEUE_LIMITS.MIN_BACKOFF_MS}`)
    .max(QUEUE_LIMITS.MAX_BACKOFF_MS, `Backoff must not exceed ${QUEUE_LIMITS.MAX_BACKOFF_MS}`),
  delayMs: z.coerce
    .number({ invalid_type_error: 'Delay duration must be an integer' })
    .int('Delay duration must be an integer')
    .min(JOB_LIMITS.MIN_DELAY_MS, `Delay must be at least ${JOB_LIMITS.MIN_DELAY_MS}`)
    .max(JOB_LIMITS.MAX_DELAY_MS, `Delay must not exceed ${JOB_LIMITS.MAX_DELAY_MS}`),
});

export type SubmitJobFormValues = z.infer<typeof submitJobFormSchema>;

export interface SubmitJobModalProps {
  isOpen: boolean;
  queues: QueueView[];
  defaultQueueId?: string | null;
  onClose: () => void;
  onSubmitJob: (queueId: string, payload: CreateJobPayload) => Promise<JobSubmissionResult>;
  onSuccess?: (result: JobSubmissionResult, message: string) => void;
}

export function SubmitJobModal({
  isOpen,
  queues,
  defaultQueueId,
  onClose,
  onSubmitJob,
  onSuccess,
}: SubmitJobModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  const initialQueue = useMemo(() => {
    if (defaultQueueId) {
      const found = queues.find((q) => q.id === defaultQueueId);
      if (found) return found;
    }
    return queues[0] ?? null;
  }, [queues, defaultQueueId]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<SubmitJobFormValues>({
    resolver: zodResolver(submitJobFormSchema),
    defaultValues: {
      queueId: initialQueue?.id ?? '',
      name: 'echo',
      payloadText: JSON.stringify(BUILTIN_PROCESSOR_PRESETS[0].samplePayload, null, 2),
      priority: initialQueue?.defaultPriority ?? QUEUE_LIMITS.DEFAULT_PRIORITY,
      maxRetries: initialQueue?.maxRetries ?? QUEUE_LIMITS.DEFAULT_MAX_RETRIES,
      backoffMs: initialQueue?.backoffMs ?? QUEUE_LIMITS.DEFAULT_BACKOFF_MS,
      delayMs: 0,
    },
  });

  const watchedName = watch('name');
  const watchedPayloadText = watch('payloadText');

  const activePreset = useMemo(
    () => BUILTIN_PROCESSOR_PRESETS.find((p) => p.name === watchedName?.trim()),
    [watchedName],
  );

  const payloadBytes = useMemo(
    () => new TextEncoder().encode(watchedPayloadText ?? '').length,
    [watchedPayloadText],
  );

  useEffect(() => {
    if (!isOpen) return;
    setServerError(null);
    const target =
      (defaultQueueId ? queues.find((q) => q.id === defaultQueueId) : undefined) ??
      queues[0] ??
      null;

    reset({
      queueId: target?.id ?? '',
      name: 'echo',
      payloadText: JSON.stringify(BUILTIN_PROCESSOR_PRESETS[0].samplePayload, null, 2),
      priority: target?.defaultPriority ?? QUEUE_LIMITS.DEFAULT_PRIORITY,
      maxRetries: target?.maxRetries ?? QUEUE_LIMITS.DEFAULT_MAX_RETRIES,
      backoffMs: target?.backoffMs ?? QUEUE_LIMITS.DEFAULT_BACKOFF_MS,
      delayMs: 0,
    });
  }, [isOpen, defaultQueueId, queues, reset]);

  const handleQueueChange = (newQueueId: string) => {
    setValue('queueId', newQueueId, { shouldValidate: true });
    const q = queues.find((item) => item.id === newQueueId);
    if (q) {
      setValue('priority', q.defaultPriority);
      setValue('maxRetries', q.maxRetries);
      setValue('backoffMs', q.backoffMs);
    }
  };

  const applyPreset = (preset: ProcessorPreset) => {
    setValue('name', preset.name, { shouldValidate: true });
    setValue('payloadText', JSON.stringify(preset.samplePayload, null, 2), {
      shouldValidate: true,
    });
  };

  const handleFormatJson = () => {
    const parsed = parseJsonObject(watchedPayloadText ?? '');
    if (parsed.ok) {
      setValue('payloadText', JSON.stringify(parsed.value, null, 2), { shouldValidate: true });
    } else {
      void trigger('payloadText');
    }
  };

  const onSubmit = async (values: SubmitJobFormValues) => {
    setServerError(null);
    const parsedPayload = parseJsonObject(values.payloadText);
    if (!parsedPayload.ok) {
      setServerError(parsedPayload.error);
      return;
    }

    try {
      const result = await onSubmitJob(values.queueId, {
        name: values.name.trim(),
        payload: parsedPayload.value,
        priority: values.priority,
        maxRetries: values.maxRetries,
        backoffMs: values.backoffMs,
        delayMs: values.delayMs,
      });
      onSuccess?.(
        result,
        `Job "${result.job.name}" (${result.job.id.slice(0, 8)}) submitted with status ${result.job.status}.`,
      );
      onClose();
    } catch (err) {
      setServerError(
        err instanceof ApiClientError ? err.message : 'Unable to submit job. Please try again.',
      );
    }
  };

  const queueOptions = queues.map((q) => ({
    label: `${q.name}${q.isPaused ? ' (Paused)' : ''}`,
    value: q.id,
  }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Submit Job"
      description="Persist a new job to PostgreSQL and enqueue it to BullMQ."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {serverError && <ErrorState compact message={serverError} />}

        <Select
          label="Target Queue"
          options={
            queueOptions.length > 0 ? queueOptions : [{ label: 'No queues available', value: '' }]
          }
          error={errors.queueId?.message}
          value={watch('queueId')}
          onChange={(e) => handleQueueChange(e.target.value)}
        />

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Built-in Processor Templates</span>
            <span className="text-[11px] text-slate-500">Click to prefill</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_PROCESSOR_PRESETS.map((preset) => {
              const isSelected = watchedName?.trim() === preset.name;
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                    isSelected
                      ? 'border-sky-400/50 bg-sky-400/15 text-sky-200'
                      : 'border-border-subtle bg-canvas text-slate-300 hover:border-border-strong hover:text-slate-100'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <Input
          label="Job Name / Processor Type"
          placeholder="e.g. echo, math.sum, transform.json"
          hint={
            activePreset
              ? activePreset.schemaHint
              : '2–128 characters matching a registered worker processor.'
          }
          error={errors.name?.message}
          {...register('name')}
        />

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="payloadText" className="block text-xs font-medium text-slate-300">
              JSON Payload
            </label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-slate-500">
                {payloadBytes.toLocaleString()} / {JOB_LIMITS.MAX_PAYLOAD_BYTES.toLocaleString()} B
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
            id="payloadText"
            rows={5}
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

        <div className="grid grid-cols-2 gap-3.5">
          <Input
            label="Priority (1–20)"
            type="number"
            min={QUEUE_LIMITS.MIN_PRIORITY}
            max={QUEUE_LIMITS.MAX_PRIORITY}
            error={errors.priority?.message}
            {...register('priority')}
          />

          <Input
            label="Max Retries (0–20)"
            type="number"
            min={QUEUE_LIMITS.MIN_MAX_RETRIES}
            max={QUEUE_LIMITS.MAX_MAX_RETRIES}
            error={errors.maxRetries?.message}
            {...register('maxRetries')}
          />
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <Input
            label="Backoff Duration (ms)"
            type="number"
            min={QUEUE_LIMITS.MIN_BACKOFF_MS}
            max={QUEUE_LIMITS.MAX_BACKOFF_MS}
            error={errors.backoffMs?.message}
            {...register('backoffMs')}
          />

          <Input
            label="Delay Duration (ms)"
            type="number"
            min={JOB_LIMITS.MIN_DELAY_MS}
            max={JOB_LIMITS.MAX_DELAY_MS}
            hint="0 for immediate execution (max 24h)"
            error={errors.delayMs?.message}
            {...register('delayMs')}
          />
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" isLoading={isSubmitting} disabled={queues.length === 0}>
            Submit Job
          </Button>
        </div>
      </form>
    </Modal>
  );
}

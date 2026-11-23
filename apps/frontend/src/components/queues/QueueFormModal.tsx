import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiClientError } from '../../api/error';
import type { CreateQueuePayload, UpdateQueuePayload } from '../../api/queue.api';
import type { QueueView } from '../../types/api';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

export const QUEUE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const QUEUE_LIMITS = {
  MIN_CONCURRENCY: 1,
  MAX_CONCURRENCY: 100,
  DEFAULT_CONCURRENCY: 5,
  MIN_PRIORITY: 1,
  MAX_PRIORITY: 20,
  DEFAULT_PRIORITY: 5,
  MIN_MAX_RETRIES: 0,
  MAX_MAX_RETRIES: 20,
  DEFAULT_MAX_RETRIES: 3,
  MIN_BACKOFF_MS: 0,
  MAX_BACKOFF_MS: 300_000,
  DEFAULT_BACKOFF_MS: 1000,
} as const;

export const queueFormSchema = z.object({
  name: z
    .string({ required_error: 'Queue name is required' })
    .trim()
    .toLowerCase()
    .min(2, 'Queue name must be at least 2 characters')
    .max(64, 'Queue name must not exceed 64 characters')
    .regex(
      QUEUE_NAME_REGEX,
      'Queue name must start with a letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens (no colons or spaces)',
    ),
  description: z.string().trim().max(500, 'Description must not exceed 500 characters').optional(),
  concurrency: z.coerce
    .number({ invalid_type_error: 'Concurrency must be an integer' })
    .int('Concurrency must be an integer')
    .min(
      QUEUE_LIMITS.MIN_CONCURRENCY,
      `Concurrency must be at least ${QUEUE_LIMITS.MIN_CONCURRENCY}`,
    )
    .max(
      QUEUE_LIMITS.MAX_CONCURRENCY,
      `Concurrency must not exceed ${QUEUE_LIMITS.MAX_CONCURRENCY}`,
    ),
  defaultPriority: z.coerce
    .number({ invalid_type_error: 'Default priority must be an integer' })
    .int('Default priority must be an integer')
    .min(
      QUEUE_LIMITS.MIN_PRIORITY,
      `Default priority must be at least ${QUEUE_LIMITS.MIN_PRIORITY}`,
    )
    .max(
      QUEUE_LIMITS.MAX_PRIORITY,
      `Default priority must not exceed ${QUEUE_LIMITS.MAX_PRIORITY}`,
    ),
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
    .min(
      QUEUE_LIMITS.MIN_BACKOFF_MS,
      `Backoff duration must be at least ${QUEUE_LIMITS.MIN_BACKOFF_MS}`,
    )
    .max(
      QUEUE_LIMITS.MAX_BACKOFF_MS,
      `Backoff duration must not exceed ${QUEUE_LIMITS.MAX_BACKOFF_MS}`,
    ),
});

export type QueueFormValues = z.infer<typeof queueFormSchema>;

export interface QueueFormModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  initialQueue?: QueueView | null;
  onClose: () => void;
  onSubmitCreate?: (payload: CreateQueuePayload) => Promise<QueueView>;
  onSubmitEdit?: (queueId: string, payload: UpdateQueuePayload) => Promise<QueueView>;
  onSuccess?: (queue: QueueView, message: string) => void;
}

export function QueueFormModal({
  isOpen,
  mode,
  initialQueue,
  onClose,
  onSubmitCreate,
  onSubmitEdit,
  onSuccess,
}: QueueFormModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<QueueFormValues>({
    resolver: zodResolver(queueFormSchema),
    defaultValues: {
      name: '',
      description: '',
      concurrency: QUEUE_LIMITS.DEFAULT_CONCURRENCY,
      defaultPriority: QUEUE_LIMITS.DEFAULT_PRIORITY,
      maxRetries: QUEUE_LIMITS.DEFAULT_MAX_RETRIES,
      backoffMs: QUEUE_LIMITS.DEFAULT_BACKOFF_MS,
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    setServerError(null);

    if (mode === 'edit' && initialQueue) {
      reset({
        name: initialQueue.name,
        description: initialQueue.description ?? '',
        concurrency: initialQueue.concurrency,
        defaultPriority: initialQueue.defaultPriority,
        maxRetries: initialQueue.maxRetries,
        backoffMs: initialQueue.backoffMs,
      });
    } else {
      reset({
        name: '',
        description: '',
        concurrency: QUEUE_LIMITS.DEFAULT_CONCURRENCY,
        defaultPriority: QUEUE_LIMITS.DEFAULT_PRIORITY,
        maxRetries: QUEUE_LIMITS.DEFAULT_MAX_RETRIES,
        backoffMs: QUEUE_LIMITS.DEFAULT_BACKOFF_MS,
      });
    }
  }, [isOpen, mode, initialQueue, reset]);

  const onSubmit = async (values: QueueFormValues) => {
    setServerError(null);
    const normalizedDescription =
      values.description && values.description.trim().length > 0 ? values.description.trim() : null;

    try {
      if (mode === 'create' && onSubmitCreate) {
        const created = await onSubmitCreate({
          name: values.name,
          description: normalizedDescription,
          concurrency: values.concurrency,
          defaultPriority: values.defaultPriority,
          maxRetries: values.maxRetries,
          backoffMs: values.backoffMs,
        });
        onSuccess?.(created, `Queue "${created.name}" created successfully.`);
        onClose();
      } else if (mode === 'edit' && initialQueue && onSubmitEdit) {
        const updated = await onSubmitEdit(initialQueue.id, {
          name: values.name,
          description: normalizedDescription,
          concurrency: values.concurrency,
          defaultPriority: values.defaultPriority,
          maxRetries: values.maxRetries,
          backoffMs: values.backoffMs,
        });
        onSuccess?.(updated, `Queue "${updated.name}" configuration updated.`);
        onClose();
      }
    } catch (err) {
      setServerError(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to save queue configuration. Please try again.',
      );
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Create Queue' : `Edit Queue — ${initialQueue?.name ?? ''}`}
      description={
        mode === 'create'
          ? 'Configure worker concurrency, default priority, and exponential retry backoff.'
          : 'Update queue configuration. Changes synchronize with PostgreSQL and BullMQ workers.'
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {serverError && <ErrorState compact message={serverError} />}

        <Input
          label="Queue Name"
          placeholder="e.g. billing-invoices"
          hint="2–64 lowercase chars: letters, digits, dots, underscores, or hyphens."
          error={errors.name?.message}
          {...register('name')}
        />

        <Input
          label="Description (optional)"
          placeholder="e.g. Processes outbound customer invoice PDFs and webhooks"
          error={errors.description?.message}
          {...register('description')}
        />

        <div className="grid grid-cols-2 gap-3.5">
          <Input
            label="Concurrency (1–100)"
            type="number"
            min={QUEUE_LIMITS.MIN_CONCURRENCY}
            max={QUEUE_LIMITS.MAX_CONCURRENCY}
            error={errors.concurrency?.message}
            {...register('concurrency')}
          />

          <Input
            label="Default Priority (1–20)"
            type="number"
            min={QUEUE_LIMITS.MIN_PRIORITY}
            max={QUEUE_LIMITS.MAX_PRIORITY}
            error={errors.defaultPriority?.message}
            {...register('defaultPriority')}
          />
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <Input
            label="Max Retries (0–20)"
            type="number"
            min={QUEUE_LIMITS.MIN_MAX_RETRIES}
            max={QUEUE_LIMITS.MAX_MAX_RETRIES}
            error={errors.maxRetries?.message}
            {...register('maxRetries')}
          />

          <Input
            label="Backoff Duration (ms)"
            type="number"
            min={QUEUE_LIMITS.MIN_BACKOFF_MS}
            max={QUEUE_LIMITS.MAX_BACKOFF_MS}
            hint="0–300,000 ms base delay"
            error={errors.backoffMs?.message}
            {...register('backoffMs')}
          />
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" isLoading={isSubmitting}>
            {mode === 'create' ? 'Create Queue' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

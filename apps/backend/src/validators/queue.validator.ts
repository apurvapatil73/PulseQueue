import { SchedulingPolicy } from '@prisma/client';
import { z } from 'zod';

/**
 * BullMQ forbids ':' in queue names (used as Redis key delimiter).
 * Restrict queue names to clean lowercase slugs: 2-64 chars, starting with
 * alphanumeric, allowing letters, digits, dots, underscores, and hyphens.
 */
const QUEUE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{1,63}$/;

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

const queueNameSchema = z
  .string({ required_error: 'Queue name is required' })
  .trim()
  .toLowerCase()
  .min(2, 'Queue name must be at least 2 characters')
  .max(64, 'Queue name must not exceed 64 characters')
  .regex(
    QUEUE_NAME_REGEX,
    'Queue name must start with a letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens (no colons or spaces)',
  );

const queueDescriptionSchema = z
  .string()
  .trim()
  .max(500, 'Description must not exceed 500 characters')
  .nullable();

const concurrencySchema = z
  .number({ invalid_type_error: 'concurrency must be an integer' })
  .int('concurrency must be an integer')
  .min(QUEUE_LIMITS.MIN_CONCURRENCY, `concurrency must be at least ${QUEUE_LIMITS.MIN_CONCURRENCY}`)
  .max(QUEUE_LIMITS.MAX_CONCURRENCY, `concurrency must not exceed ${QUEUE_LIMITS.MAX_CONCURRENCY}`);

const defaultPrioritySchema = z
  .number({ invalid_type_error: 'defaultPriority must be an integer' })
  .int('defaultPriority must be an integer')
  .min(QUEUE_LIMITS.MIN_PRIORITY, `defaultPriority must be at least ${QUEUE_LIMITS.MIN_PRIORITY}`)
  .max(QUEUE_LIMITS.MAX_PRIORITY, `defaultPriority must not exceed ${QUEUE_LIMITS.MAX_PRIORITY}`);

const maxRetriesSchema = z
  .number({ invalid_type_error: 'maxRetries must be an integer' })
  .int('maxRetries must be an integer')
  .min(QUEUE_LIMITS.MIN_MAX_RETRIES, `maxRetries must be at least ${QUEUE_LIMITS.MIN_MAX_RETRIES}`)
  .max(QUEUE_LIMITS.MAX_MAX_RETRIES, `maxRetries must not exceed ${QUEUE_LIMITS.MAX_MAX_RETRIES}`);

const backoffMsSchema = z
  .number({ invalid_type_error: 'backoffMs must be an integer' })
  .int('backoffMs must be an integer')
  .min(QUEUE_LIMITS.MIN_BACKOFF_MS, `backoffMs must be at least ${QUEUE_LIMITS.MIN_BACKOFF_MS}`)
  .max(QUEUE_LIMITS.MAX_BACKOFF_MS, `backoffMs must not exceed ${QUEUE_LIMITS.MAX_BACKOFF_MS}`);

export const createQueueSchema = z.object({
  name: queueNameSchema,
  description: queueDescriptionSchema.optional(),
  concurrency: concurrencySchema.optional().default(QUEUE_LIMITS.DEFAULT_CONCURRENCY),
  defaultPriority: defaultPrioritySchema.optional().default(QUEUE_LIMITS.DEFAULT_PRIORITY),
  maxRetries: maxRetriesSchema.optional().default(QUEUE_LIMITS.DEFAULT_MAX_RETRIES),
  backoffMs: backoffMsSchema.optional().default(QUEUE_LIMITS.DEFAULT_BACKOFF_MS),
  maxQueueDepth: z.number().int().min(1).max(1_000_000).nullable().optional(),
  backpressureMaxAgeMs: z.number().int().min(100).max(86_400_000).nullable().optional(),
  retryBudgetMaxRetries: z.number().int().min(0).max(100_000).nullable().optional(),
  retryBudgetWindowSeconds: z.number().int().min(10).max(86_400).optional(),
  poisonFailureThreshold: z.number().int().min(2).max(20).optional(),
  schedulingPolicy: z.nativeEnum(SchedulingPolicy).optional(),
  agingRatePerSec: z.number().min(0.001).max(10.0).optional(),
  maxEffectivePriority: z.number().min(QUEUE_LIMITS.MAX_PRIORITY).max(100.0).optional(),
  starvationThresholdSec: z.number().int().min(10).max(86_400).nullable().optional(),
});

export const updateQueueSchema = z
  .object({
    name: queueNameSchema.optional(),
    description: queueDescriptionSchema.optional(),
    concurrency: concurrencySchema.optional(),
    defaultPriority: defaultPrioritySchema.optional(),
    maxRetries: maxRetriesSchema.optional(),
    backoffMs: backoffMsSchema.optional(),
    maxQueueDepth: z.number().int().min(1).max(1_000_000).nullable().optional(),
    backpressureMaxAgeMs: z.number().int().min(100).max(86_400_000).nullable().optional(),
    retryBudgetMaxRetries: z.number().int().min(0).max(100_000).nullable().optional(),
    retryBudgetWindowSeconds: z.number().int().min(10).max(86_400).optional(),
    poisonFailureThreshold: z.number().int().min(2).max(20).optional(),
    schedulingPolicy: z.nativeEnum(SchedulingPolicy).optional(),
    agingRatePerSec: z.number().min(0.001).max(10.0).optional(),
    maxEffectivePriority: z.number().min(QUEUE_LIMITS.MAX_PRIORITY).max(100.0).optional(),
    starvationThresholdSec: z.number().int().min(10).max(86_400).nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.concurrency !== undefined ||
      data.defaultPriority !== undefined ||
      data.maxRetries !== undefined ||
      data.backoffMs !== undefined ||
      data.maxQueueDepth !== undefined ||
      data.backpressureMaxAgeMs !== undefined ||
      data.retryBudgetMaxRetries !== undefined ||
      data.retryBudgetWindowSeconds !== undefined ||
      data.poisonFailureThreshold !== undefined ||
      data.schedulingPolicy !== undefined ||
      data.agingRatePerSec !== undefined ||
      data.maxEffectivePriority !== undefined ||
      data.starvationThresholdSec !== undefined,
    { message: 'At least one updatable field must be provided' },
  );

export const listQueuesQuerySchema = z.object({
  isPaused: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export type CreateQueueInput = z.infer<typeof createQueueSchema>;
export type UpdateQueueInput = z.infer<typeof updateQueueSchema>;
export type ListQueuesQuery = z.infer<typeof listQueuesQuerySchema>;

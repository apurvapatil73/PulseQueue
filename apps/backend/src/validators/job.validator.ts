import { z } from 'zod';
import { JobStatus } from '@prisma/client';
import { QUEUE_LIMITS } from './queue.validator.js';

export const JOB_LIMITS = {
  MIN_NAME_LENGTH: 2,
  MAX_NAME_LENGTH: 128,
  MAX_PAYLOAD_BYTES: 65_536, // 64 KiB serialized JSON limit
  MIN_DELAY_MS: 0,
  MAX_DELAY_MS: 86_400_000, // 24 hours
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

const payloadSchema = z
  .record(z.string(), z.unknown(), {
    invalid_type_error: 'payload must be a JSON object',
  })
  .refine(
    (obj) => {
      try {
        return Buffer.byteLength(JSON.stringify(obj), 'utf8') <= JOB_LIMITS.MAX_PAYLOAD_BYTES;
      } catch {
        return false;
      }
    },
    { message: `payload must not exceed ${JOB_LIMITS.MAX_PAYLOAD_BYTES} bytes when serialized` },
  );

export const createJobSchema = z.object({
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
  payload: payloadSchema.optional().default({}),
  priority: z
    .number({ invalid_type_error: 'priority must be an integer' })
    .int('priority must be an integer')
    .min(QUEUE_LIMITS.MIN_PRIORITY, `priority must be at least ${QUEUE_LIMITS.MIN_PRIORITY}`)
    .max(QUEUE_LIMITS.MAX_PRIORITY, `priority must not exceed ${QUEUE_LIMITS.MAX_PRIORITY}`)
    .optional(),
  maxRetries: z
    .number({ invalid_type_error: 'maxRetries must be an integer' })
    .int('maxRetries must be an integer')
    .min(
      QUEUE_LIMITS.MIN_MAX_RETRIES,
      `maxRetries must be at least ${QUEUE_LIMITS.MIN_MAX_RETRIES}`,
    )
    .max(QUEUE_LIMITS.MAX_MAX_RETRIES, `maxRetries must not exceed ${QUEUE_LIMITS.MAX_MAX_RETRIES}`)
    .optional(),
  backoffMs: z
    .number({ invalid_type_error: 'backoffMs must be an integer' })
    .int('backoffMs must be an integer')
    .min(QUEUE_LIMITS.MIN_BACKOFF_MS, `backoffMs must be at least ${QUEUE_LIMITS.MIN_BACKOFF_MS}`)
    .max(QUEUE_LIMITS.MAX_BACKOFF_MS, `backoffMs must not exceed ${QUEUE_LIMITS.MAX_BACKOFF_MS}`)
    .optional(),
  delayMs: z
    .number({ invalid_type_error: 'delayMs must be an integer' })
    .int('delayMs must be an integer')
    .min(JOB_LIMITS.MIN_DELAY_MS, `delayMs must be at least ${JOB_LIMITS.MIN_DELAY_MS}`)
    .max(JOB_LIMITS.MAX_DELAY_MS, `delayMs must not exceed ${JOB_LIMITS.MAX_DELAY_MS}`)
    .optional()
    .default(0),
});

export const listJobsQuerySchema = z.object({
  status: z.nativeEnum(JobStatus).optional(),
  page: z.coerce
    .number({ invalid_type_error: 'page must be a positive integer' })
    .int('page must be a positive integer')
    .min(1, 'page must be at least 1')
    .optional()
    .default(JOB_LIMITS.DEFAULT_PAGE),
  limit: z.coerce
    .number({ invalid_type_error: 'limit must be a positive integer' })
    .int('limit must be a positive integer')
    .min(1, 'limit must be at least 1')
    .max(JOB_LIMITS.MAX_LIMIT, `limit must not exceed ${JOB_LIMITS.MAX_LIMIT}`)
    .optional()
    .default(JOB_LIMITS.DEFAULT_LIMIT),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

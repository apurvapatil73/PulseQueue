import { z } from 'zod';
import { DeadLetterStatus, PlatformEventType } from '@prisma/client';
import { QUEUE_LIMITS } from './queue.validator.js';
import { JOB_LIMITS } from './job.validator.js';

export const listDlqQuerySchema = z.object({
  status: z.nativeEnum(DeadLetterStatus).optional(),
  queueId: z.string().uuid('queueId must be a valid UUID').optional(),
  page: z.coerce
    .number({ invalid_type_error: 'page must be a positive integer' })
    .int('page must be a positive integer')
    .min(1, 'page must be at least 1')
    .optional()
    .default(1),
  limit: z.coerce
    .number({ invalid_type_error: 'limit must be a positive integer' })
    .int('limit must be a positive integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must not exceed 100')
    .optional()
    .default(20),
});

export const replayDlqBodySchema = z
  .object({
    payload: z
      .record(z.string(), z.unknown())
      .refine(
        (obj) => {
          try {
            return Buffer.byteLength(JSON.stringify(obj), 'utf8') <= JOB_LIMITS.MAX_PAYLOAD_BYTES;
          } catch {
            return false;
          }
        },
        { message: `payload must not exceed ${JOB_LIMITS.MAX_PAYLOAD_BYTES} bytes` },
      )
      .optional(),
    priority: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_PRIORITY)
      .max(QUEUE_LIMITS.MAX_PRIORITY)
      .optional(),
    maxRetries: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_MAX_RETRIES)
      .max(QUEUE_LIMITS.MAX_MAX_RETRIES)
      .optional(),
    backoffMs: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_BACKOFF_MS)
      .max(QUEUE_LIMITS.MAX_BACKOFF_MS)
      .optional(),
  })
  .optional()
  .default({});

export const metricsQuerySchema = z.object({
  windowMinutes: z.coerce
    .number({ invalid_type_error: 'windowMinutes must be a positive integer' })
    .int('windowMinutes must be a positive integer')
    .min(1, 'windowMinutes must be at least 1')
    .max(10080, 'windowMinutes must not exceed 10080 (7 days)')
    .optional()
    .default(60),
});

export const ALLOWED_BUCKET_MINUTES = [1, 5, 15, 60] as const;
export const MAX_TIMESERIES_BUCKETS = 360;

export const metricsTimeseriesQuerySchema = z
  .object({
    windowMinutes: z.coerce
      .number({ invalid_type_error: 'windowMinutes must be a positive integer' })
      .int('windowMinutes must be a positive integer')
      .min(5, 'windowMinutes must be at least 5')
      .max(10080, 'windowMinutes must not exceed 10080 (7 days)')
      .optional()
      .default(60),
    bucketMinutes: z.coerce
      .number({ invalid_type_error: 'bucketMinutes must be an integer (1, 5, 15, or 60)' })
      .int('bucketMinutes must be an integer (1, 5, 15, or 60)')
      .refine(
        (v): v is (typeof ALLOWED_BUCKET_MINUTES)[number] =>
          (ALLOWED_BUCKET_MINUTES as readonly number[]).includes(v),
        { message: 'bucketMinutes must be one of 1, 5, 15, or 60' },
      )
      .optional(),
    queueId: z.string().uuid('queueId must be a valid UUID').optional(),
  })
  .superRefine((data, ctx) => {
    const resolvedBucket =
      data.bucketMinutes ??
      (data.windowMinutes <= 60
        ? 1
        : data.windowMinutes <= 360
          ? 5
          : data.windowMinutes <= 1440
            ? 15
            : 60);

    if (resolvedBucket > data.windowMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bucketMinutes'],
        message: 'bucketMinutes must not exceed windowMinutes',
      });
    }

    if (Math.ceil(data.windowMinutes / resolvedBucket) > MAX_TIMESERIES_BUCKETS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bucketMinutes'],
        message: `Requested window and bucket size exceed maximum of ${MAX_TIMESERIES_BUCKETS} buckets`,
      });
    }
  });

export const listEventsQuerySchema = z.object({
  type: z.nativeEnum(PlatformEventType).optional(),
  queueId: z.string().uuid('queueId must be a valid UUID').optional(),
  jobId: z.string().uuid('jobId must be a valid UUID').optional(),
  page: z.coerce
    .number({ invalid_type_error: 'page must be a positive integer' })
    .int('page must be a positive integer')
    .min(1, 'page must be at least 1')
    .optional()
    .default(1),
  limit: z.coerce
    .number({ invalid_type_error: 'limit must be a positive integer' })
    .int('limit must be a positive integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must not exceed 100')
    .optional()
    .default(20),
});

export const recoverStalledBodySchema = z
  .object({
    staleActiveThresholdMs: z.number().int().min(100).max(3_600_000).optional(),
    maxStalledRecoveries: z.number().int().min(1).max(20).optional(),
  })
  .optional()
  .default({});

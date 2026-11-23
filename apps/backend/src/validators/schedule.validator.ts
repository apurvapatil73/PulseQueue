import { z } from 'zod';
import { ScheduleStatus, ScheduleType } from '@prisma/client';
import { QUEUE_LIMITS } from './queue.validator.js';
import { JOB_LIMITS } from './job.validator.js';
import { isValidTimezone } from '../utils/scheduleTime.js';

const schedulePayloadSchema = z
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

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((tz) => isValidTimezone(tz), {
    message: 'Invalid IANA timezone identifier (e.g. UTC, Asia/Kolkata, America/New_York)',
  });

export const createScheduleSchema = z
  .object({
    queueId: z
      .string({ required_error: 'queueId is required' })
      .uuid('queueId must be a valid UUID'),
    name: z
      .string({ required_error: 'Schedule name is required' })
      .trim()
      .min(2, 'Schedule name must be at least 2 characters')
      .max(100, 'Schedule name must not exceed 100 characters'),
    description: z.string().trim().max(500).nullable().optional(),
    type: z.nativeEnum(ScheduleType, {
      errorMap: () => ({ message: 'type must be ONE_TIME or RECURRING' }),
    }),
    jobName: z
      .string({ required_error: 'jobName is required' })
      .trim()
      .min(JOB_LIMITS.MIN_NAME_LENGTH)
      .max(JOB_LIMITS.MAX_NAME_LENGTH),
    payload: schedulePayloadSchema.optional().default({}),
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
    timezone: timezoneSchema.optional().default('UTC'),
    runAt: z.string().trim().min(1).optional(),
    cronExpression: z.string().trim().min(1).max(120).optional(),
    preventOverlap: z.boolean().optional().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.type === ScheduleType.ONE_TIME) {
      if (!data.runAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAt'],
          message: 'runAt is required for ONE_TIME schedules',
        });
      }
      if (data.cronExpression) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'cronExpression is not allowed on ONE_TIME schedules',
        });
      }
    } else if (data.type === ScheduleType.RECURRING) {
      if (!data.cronExpression) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cronExpression'],
          message: 'cronExpression is required for RECURRING schedules',
        });
      }
      if (data.runAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAt'],
          message: 'runAt is not allowed on RECURRING schedules',
        });
      }
    }
  });

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    jobName: z
      .string()
      .trim()
      .min(JOB_LIMITS.MIN_NAME_LENGTH)
      .max(JOB_LIMITS.MAX_NAME_LENGTH)
      .optional(),
    payload: schedulePayloadSchema.optional(),
    priority: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_PRIORITY)
      .max(QUEUE_LIMITS.MAX_PRIORITY)
      .nullable()
      .optional(),
    maxRetries: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_MAX_RETRIES)
      .max(QUEUE_LIMITS.MAX_MAX_RETRIES)
      .nullable()
      .optional(),
    backoffMs: z
      .number()
      .int()
      .min(QUEUE_LIMITS.MIN_BACKOFF_MS)
      .max(QUEUE_LIMITS.MAX_BACKOFF_MS)
      .nullable()
      .optional(),
    timezone: timezoneSchema.optional(),
    runAt: z.string().trim().min(1).optional(),
    cronExpression: z.string().trim().min(1).max(120).optional(),
    preventOverlap: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one updatable field must be provided',
  });

export const listSchedulesQuerySchema = z.object({
  status: z.nativeEnum(ScheduleStatus).optional(),
  type: z.nativeEnum(ScheduleType).optional(),
  queueId: z.string().uuid('queueId must be a valid UUID').optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const listScheduleExecutionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>;
export type ListScheduleExecutionsQuery = z.infer<typeof listScheduleExecutionsQuerySchema>;

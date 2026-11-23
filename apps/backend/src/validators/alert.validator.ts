import { z } from 'zod';
import { AlertComparisonOperator, AlertSeverity, AlertStatus, AlertType } from '@prisma/client';

const PERCENTAGE_ALERT_TYPES = new Set<AlertType>([
  AlertType.JOB_FAILURE_RATE,
  AlertType.JOB_RETRY_RATE,
]);

export const createAlertRuleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Rule name must be at least 2 characters')
      .max(120, 'Rule name must not exceed 120 characters'),
    description: z
      .string()
      .trim()
      .max(500, 'Description must not exceed 500 characters')
      .optional()
      .nullable(),
    type: z.nativeEnum(AlertType),
    operator: z.nativeEnum(AlertComparisonOperator).optional().default(AlertComparisonOperator.GT),
    threshold: z
      .number({ invalid_type_error: 'threshold must be a number' })
      .min(0, 'threshold must be >= 0'),
    windowMinutes: z
      .number()
      .int('windowMinutes must be an integer')
      .min(1, 'windowMinutes must be at least 1')
      .max(1440, 'windowMinutes must not exceed 1440 (24 hours)')
      .optional()
      .default(60),
    cooldownSeconds: z
      .number()
      .int('cooldownSeconds must be an integer')
      .min(0, 'cooldownSeconds must be >= 0')
      .max(86_400, 'cooldownSeconds must not exceed 86400 (24 hours)')
      .optional()
      .default(300),
    queueId: z.string().uuid('queueId must be a valid UUID').optional().nullable(),
    severity: z.nativeEnum(AlertSeverity).optional().default(AlertSeverity.WARNING),
    isEnabled: z.boolean().optional().default(true),
  })
  .superRefine((data, ctx) => {
    if (PERCENTAGE_ALERT_TYPES.has(data.type) && data.threshold > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['threshold'],
        message: 'Percentage threshold must be between 0 and 100',
      });
    }
    if (data.type === AlertType.WORKER_STALE && data.queueId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queueId'],
        message: 'WORKER_STALE rules are organisation-scoped and cannot target a single queue',
      });
    }
    if (data.type === AlertType.SCHEDULE_MISFIRES && data.queueId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queueId'],
        message: 'SCHEDULE_MISFIRES rules are organisation-scoped and cannot target a single queue',
      });
    }
  });

export const updateAlertRuleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Rule name must be at least 2 characters')
      .max(120, 'Rule name must not exceed 120 characters')
      .optional(),
    description: z
      .string()
      .trim()
      .max(500, 'Description must not exceed 500 characters')
      .optional()
      .nullable(),
    operator: z.nativeEnum(AlertComparisonOperator).optional(),
    threshold: z.number().min(0, 'threshold must be >= 0').optional(),
    windowMinutes: z.number().int().min(1).max(1440).optional(),
    cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
    queueId: z.string().uuid('queueId must be a valid UUID').optional().nullable(),
    severity: z.nativeEnum(AlertSeverity).optional(),
    isEnabled: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided for update',
  });

export const toggleAlertRuleSchema = z.object({
  isEnabled: z.boolean(),
});

export const listAlertsQuerySchema = z.object({
  status: z.nativeEnum(AlertStatus).optional(),
  severity: z.nativeEnum(AlertSeverity).optional(),
  type: z.nativeEnum(AlertType).optional(),
  queueId: z.string().uuid('queueId must be a valid UUID').optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const resolveAlertBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .optional()
  .default({});

export const listNotificationsQuerySchema = z.object({
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional()
    .default(false),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type CreateAlertRuleInput = z.infer<typeof createAlertRuleSchema>;
export type UpdateAlertRuleInput = z.infer<typeof updateAlertRuleSchema>;
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

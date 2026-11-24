import { z } from 'zod';
import { JOB_LIMITS } from './job.validator.js';

export const updateOrgQuotasSchema = z
  .object({
    maxOutstandingJobs: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxActiveJobs: z.number().int().min(1).max(100_000).nullable().optional(),
    maxQueuedJobs: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxDelayedJobs: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxPayloadBytes: z
      .number()
      .int()
      .min(128)
      .max(JOB_LIMITS.MAX_PAYLOAD_BYTES)
      .nullable()
      .optional(),
    retryBudgetMaxRetries: z.number().int().min(0).max(100_000).nullable().optional(),
    retryBudgetWindowSeconds: z.number().int().min(10).max(86_400).optional(),
    schedulingWeight: z.number().int().min(1).max(100).optional(),
    drrBaseQuantum: z.number().min(1).max(1_000).optional(),
    drrMaxDeficit: z.number().min(100).max(10_000).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one quota, retry-budget, or fairness field must be provided',
  });

export type UpdateOrgQuotasInput = z.infer<typeof updateOrgQuotasSchema>;

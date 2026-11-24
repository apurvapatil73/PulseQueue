import { z } from 'zod';

/**
 * Explicit least-privilege scopes assignable to tenant API keys.
 * API keys NEVER grant OWNER or unrestricted ADMIN privileges (they cannot delete
 * organisations, transfer ownership, manage members/invitations, or manage API keys).
 */
export const API_KEY_SCOPES = [
  'queues:read',
  'queues:write',
  'jobs:read',
  'jobs:write',
  'jobs:cancel',
  'dlq:read',
  'dlq:replay',
  'schedules:read',
  'schedules:write',
  'monitoring:read',
  'governance:read',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

const apiKeyMetadataSchema = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()]))
  .refine((obj) => Object.keys(obj).length <= 16, {
    message: 'metadata must contain at most 16 keys',
  });

export const createApiKeySchema = z
  .object({
    name: z
      .string({ required_error: 'API key name is required' })
      .trim()
      .min(2, 'API key name must be at least 2 characters')
      .max(100, 'API key name must not exceed 100 characters'),
    scopes: z
      .array(apiKeyScopeSchema, { required_error: 'At least one scope is required' })
      .min(1, 'At least one scope is required')
      .max(API_KEY_SCOPES.length)
      .transform((arr) => Array.from(new Set(arr))),
    expiresAt: z
      .string()
      .datetime({ offset: true, message: 'expiresAt must be a valid ISO-8601 timestamp' })
      .nullable()
      .optional(),
    metadata: apiKeyMetadataSchema.optional().default({}),
  })
  .strict();

export const rotateApiKeySchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    scopes: z
      .array(apiKeyScopeSchema)
      .min(1)
      .max(API_KEY_SCOPES.length)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    expiresAt: z
      .string()
      .datetime({ offset: true, message: 'expiresAt must be a valid ISO-8601 timestamp' })
      .nullable()
      .optional(),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>;

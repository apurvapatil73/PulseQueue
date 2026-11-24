import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables from .env
dotenv.config();
// Also attempt loading from backend specific or root if available
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const DEFAULT_DEV_API_KEY_SECRET = 'pulsequeue-dev-api-key-pepper-change-in-production';

function parseTrustProxy(val: string): boolean | number | string {
  const normalized = val.trim().toLowerCase();
  if (normalized === '' || normalized === 'false' || normalized === '0') {
    return false;
  }
  if (normalized === 'loopback' || normalized === 'linklocal' || normalized === 'uniquelocal') {
    return normalized;
  }
  if (/^[1-5]$/.test(normalized)) {
    return parseInt(normalized, 10);
  }
  throw new Error(
    'TRUST_PROXY must be "false", "loopback", "linklocal", "uniquelocal", or an integer hop count between 1 and 5 (unrestricted "true" is forbidden)',
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z
      .string()
      .default('3000')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val > 0 && val < 65536, {
        message: 'PORT must be a valid port number between 1 and 65535',
      }),
    DATABASE_URL: z
      .string({
        required_error: 'DATABASE_URL is required for database connectivity',
      })
      .min(1, 'DATABASE_URL cannot be empty'),
    REDIS_URL: z
      .string({
        required_error: 'REDIS_URL is required for queue and cache connectivity',
      })
      .min(1, 'REDIS_URL cannot be empty'),
    JWT_SECRET: z
      .string({
        required_error: 'JWT_SECRET is required for token signing',
      })
      .min(16, 'JWT_SECRET must be at least 16 characters long for security'),
    API_KEY_SECRET: z
      .string()
      .optional()
      .transform((val) => (val && val.trim().length > 0 ? val : DEFAULT_DEV_API_KEY_SECRET)),
    JWT_ISSUER: z.string().trim().min(1).default('pulsequeue-api'),
    JWT_AUDIENCE: z.string().trim().min(1).default('pulsequeue-client'),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((val, ctx) => {
        try {
          return parseTrustProxy(val);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : 'Invalid TRUST_PROXY value',
          });
          return z.NEVER;
        }
      }),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || val.trim() === '') return DEFAULT_DEV_CORS_ORIGINS;
        return val
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
      }),
    RATE_LIMIT_WINDOW_MS: z
      .string()
      .default('60000')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val >= 1000 && val <= 3_600_000, {
        message: 'RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000',
      }),
    RATE_LIMIT_AUTH_MAX: z
      .string()
      .default('20')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val >= 1 && val <= 10_000, {
        message: 'RATE_LIMIT_AUTH_MAX must be between 1 and 10000',
      }),
    RATE_LIMIT_WRITE_MAX: z
      .string()
      .default('300')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val >= 1 && val <= 100_000, {
        message: 'RATE_LIMIT_WRITE_MAX must be between 1 and 100000',
      }),
    RATE_LIMIT_DLQ_REPLAY_MAX: z
      .string()
      .default('60')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val >= 1 && val <= 10_000, {
        message: 'RATE_LIMIT_DLQ_REPLAY_MAX must be between 1 and 10000',
      }),
    RATE_LIMIT_GENERAL_MAX: z
      .string()
      .default('600')
      .transform((val) => parseInt(val, 10))
      .refine((val) => !isNaN(val) && val >= 1 && val <= 100_000, {
        message: 'RATE_LIMIT_GENERAL_MAX must be between 1 and 100000',
      }),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message: 'JWT_SECRET must be at least 32 characters long in production',
        });
      }
      if (data.API_KEY_SECRET === DEFAULT_DEV_API_KEY_SECRET || data.API_KEY_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_KEY_SECRET'],
          message: 'API_KEY_SECRET must be explicitly set (>= 32 chars) in production',
        });
      }
      if (data.API_KEY_SECRET === data.JWT_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_KEY_SECRET'],
          message: 'API_KEY_SECRET must be distinct from JWT_SECRET in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates provided or current environment variables against schema.
 * Throws a formatted, safe error when validation fails without leaking secrets.
 */
export function validateEnv(customEnv?: Record<string, unknown>): Env {
  const targetEnv = customEnv || process.env;
  const result = envSchema.safeParse(targetEnv);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`)
      .join('\n');

    throw new Error(
      `PulseQueue Environment Validation Failed:\n${errorDetails}\nCheck your .env file or environment settings.`,
    );
  }

  return result.data;
}

// Cached singleton validated env
export const env = validateEnv();

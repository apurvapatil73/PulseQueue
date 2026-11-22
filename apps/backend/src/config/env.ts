import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables from .env
dotenv.config();
// Also attempt loading from backend specific or root if available
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
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

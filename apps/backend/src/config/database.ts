import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let prismaInstance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      datasources: {
        db: {
          url: env.DATABASE_URL,
        },
      },
      log:
        env.NODE_ENV === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'error' },
              { emit: 'stdout', level: 'warn' },
            ]
          : [{ emit: 'stdout', level: 'error' }],
    });

    if (env.NODE_ENV === 'development') {
      // Log slow queries or debug queries if desired
      (
        prismaInstance as unknown as {
          $on?: (event: string, cb: (e: { query: string; duration: number }) => void) => void;
        }
      ).$on?.('query', (e: { query: string; duration: number }) => {
        if (e.duration > 200) {
          logger.warn(`Slow Database Query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }

  return prismaInstance;
}

export const prisma = getPrismaClient();

/**
 * Connects to PostgreSQL via Prisma
 */
export async function connectDatabase(): Promise<boolean> {
  try {
    const client = getPrismaClient();
    await client.$connect();
    logger.info('Database connection established successfully');
    return true;
  } catch (err) {
    logger.error('Failed to establish database connection', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Disconnects from PostgreSQL gracefully
 */
export async function disconnectDatabase(): Promise<void> {
  if (prismaInstance) {
    try {
      await prismaInstance.$disconnect();
      logger.info('Database connection closed cleanly');
    } catch (err) {
      logger.error('Error during database disconnection', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      prismaInstance = null;
    }
  }
}

/**
 * Checks PostgreSQL health by running a low-overhead probe query with timeout
 */
export async function checkDatabaseHealth(
  timeoutMs: number = 3000,
): Promise<'connected' | 'disconnected'> {
  try {
    const client = getPrismaClient();
    const probe = client.$queryRaw`SELECT 1`;

    const timeout = new Promise<'disconnected'>((_, reject) =>
      setTimeout(() => reject(new Error('Database health probe timed out')), timeoutMs),
    );

    await Promise.race([probe, timeout]);
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

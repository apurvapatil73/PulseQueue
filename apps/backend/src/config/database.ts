import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let prismaInstance: PrismaClient | null = null;

export interface DatabasePoolConfig {
  connectionLimit: number | null;
  poolTimeoutSec: number | null;
  source: 'url' | 'env' | 'production_default' | 'prisma_default';
}

/**
 * Appends `connection_limit` / `pool_timeout` to a PostgreSQL URL if not already specified,
 * ensuring multi-replica deployments respect PostgreSQL's `max_connections` budget.
 */
export function buildPooledDatabaseUrl(
  rawUrl: string,
  poolSize?: number,
  poolTimeoutSec?: number,
  nodeEnv: string = env.NODE_ENV,
): { url: string; config: DatabasePoolConfig } {
  try {
    const parsed = new URL(rawUrl);
    const urlLimit = parsed.searchParams.get('connection_limit');
    const urlTimeout = parsed.searchParams.get('pool_timeout');

    let effectiveLimit: number | null = urlLimit ? parseInt(urlLimit, 10) : null;
    let source: DatabasePoolConfig['source'] = urlLimit ? 'url' : 'prisma_default';

    if (effectiveLimit === null) {
      if (poolSize !== undefined) {
        effectiveLimit = poolSize;
        source = 'env';
        parsed.searchParams.set('connection_limit', String(poolSize));
      } else if (nodeEnv === 'production') {
        effectiveLimit = 10;
        source = 'production_default';
        parsed.searchParams.set('connection_limit', '10');
      }
    }

    let effectiveTimeout: number | null = urlTimeout ? parseInt(urlTimeout, 10) : null;
    if (effectiveTimeout === null && poolTimeoutSec !== undefined) {
      effectiveTimeout = poolTimeoutSec;
      parsed.searchParams.set('pool_timeout', String(poolTimeoutSec));
    }

    return {
      url: parsed.toString(),
      config: {
        connectionLimit: Number.isFinite(effectiveLimit) ? effectiveLimit : null,
        poolTimeoutSec: Number.isFinite(effectiveTimeout) ? effectiveTimeout : null,
        source,
      },
    };
  } catch {
    return {
      url: rawUrl,
      config: {
        connectionLimit: poolSize ?? null,
        poolTimeoutSec: poolTimeoutSec ?? null,
        source: poolSize !== undefined ? 'env' : 'prisma_default',
      },
    };
  }
}

export function getDatabasePoolConfig(): DatabasePoolConfig {
  return buildPooledDatabaseUrl(
    env.DATABASE_URL,
    env.DATABASE_POOL_SIZE,
    env.DATABASE_POOL_TIMEOUT_SEC,
    env.NODE_ENV,
  ).config;
}

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const { url } = buildPooledDatabaseUrl(
      env.DATABASE_URL,
      env.DATABASE_POOL_SIZE,
      env.DATABASE_POOL_TIMEOUT_SEC,
      env.NODE_ENV,
    );
    prismaInstance = new PrismaClient({
      datasources: {
        db: {
          url,
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

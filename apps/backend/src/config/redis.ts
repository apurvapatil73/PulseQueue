import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let redisInstance: Redis | null = null;
let bullmqConnectionInstance: Redis | null = null;

export interface ParsedRedisConfig {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
}

/**
 * Masks credentials in a Redis URL so secrets are never leaked in logs or errors.
 */
export function sanitizeRedisUrl(redisUrl: string): string {
  try {
    const parsed = new URL(redisUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch {
    return '[invalid-redis-url]';
  }
}

/**
 * Parses REDIS_URL into safe ioredis / BullMQ connection options.
 * Supports redis:// and rediss:// (TLS), optional credentials, and logical DB index.
 */
export function parseRedisConnectionOptions(redisUrl: string): ParsedRedisConfig {
  const parsed = new URL(redisUrl);

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis protocol "${parsed.protocol}". Expected redis: or rediss:.`);
  }

  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port ? parseInt(parsed.port, 10) : 6379;

  if (Number.isNaN(port) || port <= 0 || port >= 65536) {
    throw new Error(`Invalid Redis port in REDIS_URL`);
  }

  const dbPath = parsed.pathname.replace(/^\//, '');
  const db = dbPath ? parseInt(dbPath, 10) : 0;
  if (Number.isNaN(db) || db < 0) {
    throw new Error(`Invalid Redis database index in REDIS_URL`);
  }

  const config: ParsedRedisConfig = {
    host,
    port,
    db,
  };

  if (parsed.username) {
    config.username = decodeURIComponent(parsed.username);
  }
  if (parsed.password) {
    config.password = decodeURIComponent(parsed.password);
  }
  if (parsed.protocol === 'rediss:') {
    config.tls = {};
  }

  return config;
}

/**
 * Builds BullMQ-compatible ioredis options from REDIS_URL.
 * Uses maxRetriesPerRequest: null as required by BullMQ.
 */
export function buildBullMQRedisOptions(redisUrl: string = env.REDIS_URL): RedisOptions {
  const parsed = parseRedisConnectionOptions(redisUrl);
  return {
    ...parsed,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: 3000,
    retryStrategy: (times) => {
      if (times > 5) {
        return null;
      }
      return Math.min(times * 250, 2000);
    },
  };
}

export function getRedisClient(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      retryStrategy: (times) => {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts in standalone probes
        }
        return Math.min(times * 200, 1000);
      },
    });

    redisInstance.on('error', (err) => {
      logger.error('Redis Client Error', {
        error: err.message,
      });
    });
  }

  return redisInstance;
}

/**
 * Returns a single shared reusable Redis connection for BullMQ Queue producers.
 * Avoids opening a separate TCP connection per registered queue.
 */
export function getBullMQConnection(): Redis {
  if (!bullmqConnectionInstance || bullmqConnectionInstance.status === 'end') {
    const options = buildBullMQRedisOptions(env.REDIS_URL);
    bullmqConnectionInstance = new Redis(options);

    bullmqConnectionInstance.on('error', (err) => {
      logger.error('BullMQ Redis connection error', {
        target: sanitizeRedisUrl(env.REDIS_URL),
        error: err.message,
      });
    });

    bullmqConnectionInstance.on('ready', () => {
      logger.info('BullMQ Redis connection ready', {
        target: sanitizeRedisUrl(env.REDIS_URL),
      });
    });
  }

  return bullmqConnectionInstance;
}

/**
 * Ensures the shared BullMQ Redis connection is ready within a bounded timeout
 * so callers fail fast instead of hanging when Redis is unavailable.
 */
export async function ensureBullMQConnectionReady(
  connection: Redis,
  timeoutMs: number = 3000,
): Promise<void> {
  if ((connection.status as string) === 'ready') {
    return;
  }

  if (connection.status === 'wait') {
    await Promise.race([
      connection.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('BullMQ Redis connection timed out')), timeoutMs),
      ),
    ]);
  }

  if ((connection.status as string) === 'ready') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('BullMQ Redis connection timed out waiting for ready state'));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onEnd = () => {
      cleanup();
      reject(new Error('BullMQ Redis connection closed before becoming ready'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      connection.off('ready', onReady);
      connection.off('error', onError);
      connection.off('end', onEnd);
    };

    connection.once('ready', onReady);
    connection.once('error', onError);
    connection.once('end', onEnd);
  });
}

/**
 * Gracefully disconnects the shared BullMQ Redis connection.
 */
export async function disconnectBullMQConnection(): Promise<void> {
  if (!bullmqConnectionInstance) {
    return;
  }

  const client = bullmqConnectionInstance;
  bullmqConnectionInstance = null;

  try {
    if (client.status !== 'end' && client.status !== 'wait') {
      await client.quit();
    } else {
      client.disconnect();
    }
    logger.info('BullMQ Redis connection closed cleanly');
  } catch (err) {
    logger.warn('Error during BullMQ Redis quit, forcing disconnect', {
      error: err instanceof Error ? err.message : String(err),
    });
    client.disconnect();
  }
}

/**
 * Connects to Redis
 */
export async function connectRedis(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (client.status === 'ready' || client.status === 'connecting') {
      return true;
    }
    await client.connect();
    logger.info('Redis connection established successfully', {
      target: sanitizeRedisUrl(env.REDIS_URL),
    });
    return true;
  } catch (err) {
    logger.error('Failed to establish Redis connection', {
      target: sanitizeRedisUrl(env.REDIS_URL),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Disconnects from Redis cleanly
 */
export async function disconnectRedis(): Promise<void> {
  if (redisInstance) {
    try {
      if (redisInstance.status !== 'end') {
        await redisInstance.quit();
      }
      logger.info('Redis connection closed cleanly');
    } catch (err) {
      logger.warn('Error during Redis quit, forcing disconnect', {
        error: err instanceof Error ? err.message : String(err),
      });
      redisInstance.disconnect();
    } finally {
      redisInstance = null;
    }
  }
}

/**
 * Checks Redis health by sending a PING command with timeout
 */
export async function checkRedisHealth(
  timeoutMs: number = 3000,
): Promise<'connected' | 'disconnected'> {
  let probeClient: Redis | null = null;
  try {
    probeClient = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: timeoutMs,
      retryStrategy: () => null,
    });

    // Suppress unhandled error event during probe disconnection/failure
    probeClient.on('error', () => {
      // Handled silently by health probe catch
    });

    const pingPromise = (async () => {
      await probeClient!.connect();
      const pong = await probeClient!.ping();
      return pong === 'PONG' ? ('connected' as const) : ('disconnected' as const);
    })();

    const timeoutPromise = new Promise<'disconnected'>((_, reject) =>
      setTimeout(() => reject(new Error('Redis health probe timed out')), timeoutMs),
    );

    const result = await Promise.race([pingPromise, timeoutPromise]);
    return result;
  } catch {
    return 'disconnected';
  } finally {
    if (probeClient) {
      try {
        probeClient.disconnect();
      } catch {
        // Ignore probe cleanup errors
      }
    }
  }
}

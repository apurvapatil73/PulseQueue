import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let redisInstance: Redis | null = null;

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
 * Connects to Redis
 */
export async function connectRedis(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (client.status === 'ready' || client.status === 'connecting') {
      return true;
    }
    await client.connect();
    logger.info('Redis connection established successfully');
    return true;
  } catch (err) {
    logger.error('Failed to establish Redis connection', {
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

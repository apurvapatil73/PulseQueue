import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { PlatformEventType } from '@prisma/client';
import { env } from '../config/env.js';
import { getRedisClient } from '../config/redis.js';
import { ServiceUnavailableError, TooManyRequestsError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { eventService } from '../services/event.service.js';

export type RateLimitFailurePolicy = 'fail-closed' | 'fail-open';

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  /**
   * Explicit behavior when Redis is unreachable:
   * - `fail-closed`: returns 503 Service Unavailable (used for auth and DLQ replay).
   * - `fail-open`: permits request with structured warning log (used for general API & durable job submission).
   */
  failurePolicy?: RateLimitFailurePolicy;
  /** Optional explicit Redis client (used for multi-instance and failure-mode integration tests). */
  redisClient?: Pick<Redis, 'eval' | 'status' | 'connect'>;
  /** When true, enforces rate limiting even in NODE_ENV === 'test' without requiring header opt-in. */
  alwaysEnforce?: boolean;
  /** Key prefix namespace for Redis isolation (defaults to `pq:rl`). */
  keyPrefix?: string;
  keyGenerator?: (req: Request) => string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

/**
 * Atomic single-roundtrip Redis Lua fixed-window counter:
 * - Increments counter atomically
 * - Sets PEXPIRE on first hit (or repairs missing TTL if a prior crash left a persistent key)
 * - Returns {currentCount, pttlMs}
 * Guarantees zero GET/INCR/EXPIRE race conditions across concurrent API instances.
 */
const ATOMIC_RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {current, pttl}
`;

const activeStores = new Set<Map<string, BucketEntry>>();

/**
 * Resets all in-process fallback rate-limit buckets (used in isolated tests).
 */
export function resetRateLimitStores(): void {
  for (const store of activeStores) {
    store.clear();
  }
}

/**
 * Produces a privacy-conscious, fixed-length Redis key without embedding raw IPs,
 * emails, or credentials.
 */
function buildHashedRedisKey(prefix: string, policyName: string, rawIdentity: string): string {
  const digest = crypto.createHash('sha256').update(rawIdentity).digest('hex').slice(0, 24);
  return `${prefix}:${policyName}:${digest}`;
}

/**
 * Extracts client identity safely using Express's trusted-proxy-aware `req.ip`
 * (never trusting raw spoofed X-Forwarded-For headers when `trust proxy` is disabled).
 */
function defaultKeyGenerator(name: string, req: Request): string {
  if (req.apiKey) {
    return `${name}:ak:${req.apiKey.id}:o:${req.apiKey.organisationId}`;
  }
  const userId = req.user?.id;
  const orgId = req.membership?.organisationId;
  if (userId && orgId) return `${name}:u:${userId}:o:${orgId}`;
  if (userId) return `${name}:u:${userId}`;
  return `${name}:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

async function consumeRedisWindow(
  client: Pick<Redis, 'eval' | 'status' | 'connect'>,
  key: string,
  windowMs: number,
): Promise<{ count: number; pttlMs: number }> {
  if (client.status === 'wait') {
    await client.connect();
  }
  const res = (await client.eval(ATOMIC_RATE_LIMIT_LUA, 1, key, String(windowMs))) as [
    number | string,
    number | string,
  ];
  const count = Number(res[0]);
  const pttlMs = Math.max(1, Number(res[1]));
  if (!Number.isFinite(count) || !Number.isFinite(pttlMs)) {
    throw new Error('Unexpected Redis rate-limit script response');
  }
  return { count, pttlMs };
}

function consumeMemoryWindow(
  store: Map<string, BucketEntry>,
  key: string,
  windowMs: number,
): { count: number; pttlMs: number } {
  const now = Date.now();
  if (store.size > 10_000) {
    for (const [k, v] of store.entries()) {
      if (v.resetAt <= now) store.delete(k);
    }
  }
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return { count: 1, pttlMs: windowMs };
  }
  existing.count += 1;
  return { count: existing.count, pttlMs: Math.max(1, existing.resetAt - now) };
}

/**
 * Redis-backed distributed rate limiter middleware using an atomic Lua script.
 *
 * - Shared across all API instances pointing at the same Redis cluster.
 * - Explicit fail-closed / fail-open handling on Redis outages (never leaks Redis credentials).
 * - In `test` mode, bypassed unless `alwaysEnforce: true` or header `x-enable-rate-limit: true` is present.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const memoryStore = new Map<string, BucketEntry>();
  activeStores.add(memoryStore);

  const failurePolicy: RateLimitFailurePolicy = options.failurePolicy ?? 'fail-open';
  const keyPrefix = options.keyPrefix ?? 'pq:rl';
  const keyGen = options.keyGenerator ?? ((req: Request) => defaultKeyGenerator(options.name, req));

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const enforceInTest = options.alwaysEnforce || req.header('x-enable-rate-limit') === 'true';
    if (env.NODE_ENV === 'test' && !enforceInTest) {
      next();
      return;
    }

    const rawIdentity = keyGen(req);
    const redisKey = buildHashedRedisKey(keyPrefix, options.name, rawIdentity);
    const useMemoryOnly = req.header('x-rate-limit-store') === 'memory';

    let count: number;
    let pttlMs: number;

    if (useMemoryOnly && env.NODE_ENV !== 'production') {
      ({ count, pttlMs } = consumeMemoryWindow(memoryStore, redisKey, options.windowMs));
    } else {
      try {
        const client = options.redisClient ?? getRedisClient();
        ({ count, pttlMs } = await consumeRedisWindow(client, redisKey, options.windowMs));
      } catch (err) {
        logger.warn('Distributed rate-limiter Redis backend unavailable', {
          limiter: options.name,
          failurePolicy,
          error: err instanceof Error ? err.name : 'RedisError',
        });

        if (failurePolicy === 'fail-closed') {
          next(
            new ServiceUnavailableError(
              'Rate limiting service temporarily unavailable. Please retry shortly.',
              {
                reason: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
                limiter: options.name,
              },
            ),
          );
          return;
        }

        // fail-open: allow request without exposing backend details
        next();
        return;
      }
    }

    const remaining = Math.max(0, options.maxRequests - count);
    const retryAfterSeconds = Math.max(1, Math.ceil(pttlMs / 1000));
    const resetEpochSec = Math.ceil((Date.now() + pttlMs) / 1000);

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetEpochSec));

    if (count > options.maxRequests) {
      const orgId = req.membership?.organisationId ?? req.apiKey?.organisationId;
      if (orgId) {
        void eventService
          .record({
            type: PlatformEventType.SECURITY_RATE_LIMIT_EXCEEDED,
            organisationId: orgId,
            message: `Rate limit exceeded on "${options.name}" policy`,
            metadata: {
              limiter: options.name,
              limit: options.maxRequests,
              windowMs: options.windowMs,
              actorType: req.apiKey ? 'api_key' : req.user ? 'user' : 'anonymous',
              ...(req.apiKey ? { apiKeyId: req.apiKey.id } : {}),
            },
          })
          .catch(() => {
            // Never allow audit logging failures to break rate-limit 429 response
          });
      }

      next(
        new TooManyRequestsError('Too many requests. Please try again later.', {
          reason: 'RATE_LIMIT_EXCEEDED',
          limiter: options.name,
          limit: options.maxRequests,
          windowMs: options.windowMs,
          retryAfterSeconds,
        }),
      );
      return;
    }

    next();
  };
}

/** Auth endpoints (/login, /register, /refresh): strict fail-closed on Redis outage */
export const authRateLimiter = createRateLimiter({
  name: 'auth',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_AUTH_MAX,
  failurePolicy: 'fail-closed',
});

/** Job submission (POST /queues/:queueId/jobs): fail-open to preserve durable PostgreSQL writes */
export const jobSubmitRateLimiter = createRateLimiter({
  name: 'job_submit',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_WRITE_MAX,
  failurePolicy: 'fail-open',
});

/** DLQ replay (POST /dlq/:dlqId/replay): fail-closed to prevent unthrottled replay storms */
export const dlqReplayRateLimiter = createRateLimiter({
  name: 'dlq_replay',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_DLQ_REPLAY_MAX,
  failurePolicy: 'fail-closed',
});

/** General API traffic: fail-open with generous per-window ceiling */
export const generalApiRateLimiter = createRateLimiter({
  name: 'general',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_GENERAL_MAX,
  failurePolicy: 'fail-open',
});

/** Backward-compatible alias */
export const writeRateLimiter = jobSubmitRateLimiter;

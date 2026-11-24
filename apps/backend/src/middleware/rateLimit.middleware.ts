import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { TooManyRequestsError } from '../utils/errors.js';

export interface RateLimitOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const activeStores = new Set<Map<string, BucketEntry>>();

/**
 * Resets all in-process rate-limit buckets (used in isolated unit/integration tests).
 */
export function resetRateLimitStores(): void {
  for (const store of activeStores) {
    store.clear();
  }
}

/**
 * Configurable fixed-window rate limiter middleware.
 *
 * - Active by default in `production` and `development`.
 * - In `test` mode, bypassed unless the request includes `x-enable-rate-limit: true`
 *   (so unrelated integration suites are not throttled while security tests verify 429 enforcement).
 * - Sets standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const store = new Map<string, BucketEntry>();
  activeStores.add(store);

  const keyGen =
    options.keyGenerator ??
    ((req: Request) => {
      const userId = req.user?.id;
      const orgId = req.membership?.organisationId;
      if (userId && orgId) return `${options.name}:u:${userId}:o:${orgId}`;
      if (userId) return `${options.name}:u:${userId}`;
      return `${options.name}:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    });

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const enforceInTest = req.header('x-enable-rate-limit') === 'true';
    if (env.NODE_ENV === 'test' && !enforceInTest) {
      next();
      return;
    }

    const now = Date.now();
    // Bounded memory hygiene: prune expired entries when map grows large
    if (store.size > 10_000) {
      for (const [k, v] of store.entries()) {
        if (v.resetAt <= now) store.delete(k);
      }
    }

    const key = keyGen(req);
    const existing = store.get(key);
    let bucket: BucketEntry;

    if (!existing || existing.resetAt <= now) {
      bucket = { count: 1, resetAt: now + options.windowMs };
      store.set(key, bucket);
    } else {
      existing.count += 1;
      bucket = existing;
    }

    const remaining = Math.max(0, options.maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.maxRequests) {
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

export const authRateLimiter = createRateLimiter({
  name: 'auth',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_AUTH_MAX,
});

export const writeRateLimiter = createRateLimiter({
  name: 'write',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_WRITE_MAX,
});

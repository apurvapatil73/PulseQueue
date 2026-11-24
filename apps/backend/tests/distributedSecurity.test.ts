import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PlatformEventType, Role } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { validateEnv } from '../src/config/env.js';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { hashPassword, signAccessToken } from '../src/utils/security.js';

const app = createApp();

describe('Phase 9.2 — Distributed Redis Rate Limiting, Tenant API Keys & Secrets Management', () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const testRedisPrefix = `pq:rl:test92:${Date.now()}`;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  let adminAToken = '';
  let memberAToken = '';
  let ownerBToken = '';

  beforeAll(async () => {
    await connectRedis();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const pwHash = await hashPassword('Phase92Pass123!');

    const [adminA, memberA, ownerB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `p92-admina-${suffix}@test.local`,
          name: 'P92 Admin A',
          passwordHash: pwHash,
        },
      }),
      prisma.user.create({
        data: {
          email: `p92-membera-${suffix}@test.local`,
          name: 'P92 Member A',
          passwordHash: pwHash,
        },
      }),
      prisma.user.create({
        data: {
          email: `p92-ownerb-${suffix}@test.local`,
          name: 'P92 Owner B',
          passwordHash: pwHash,
        },
      }),
    ]);

    createdUserIds.push(adminA.id, memberA.id, ownerB.id);
    adminAToken = signAccessToken(adminA.id, adminA.email);
    memberAToken = signAccessToken(memberA.id, memberA.email);
    ownerBToken = signAccessToken(ownerB.id, ownerB.email);

    const orgA = await prisma.organisation.create({
      data: {
        name: `P92 Org A ${suffix}`,
        memberships: {
          create: [
            { userId: adminA.id, role: Role.ADMIN },
            { userId: memberA.id, role: Role.MEMBER },
          ],
        },
      },
    });
    const orgB = await prisma.organisation.create({
      data: {
        name: `P92 Org B ${suffix}`,
        memberships: {
          create: [{ userId: ownerB.id, role: Role.OWNER }],
        },
      },
    });
    createdOrgIds.push(orgA.id, orgB.id);
    orgAId = orgA.id;
    orgBId = orgB.id;

    const [qA, qB] = await Promise.all([
      prisma.queue.create({
        data: { organisationId: orgAId, name: `p92-qa-${suffix}`, createdById: adminA.id },
      }),
      prisma.queue.create({
        data: { organisationId: orgBId, name: `p92-qb-${suffix}`, createdById: ownerB.id },
      }),
    ]);
    queueAId = qA.id;
    queueBId = qB.id;
  });

  afterAll(async () => {
    const redis = getRedisClient();
    try {
      const keys = await redis.keys(`${testRedisPrefix}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // Ignore cleanup errors
    }
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  describe('1–5 & 13. Redis Lua distributed rate limiting, concurrency, reset, failure modes & proxy spoofing', () => {
    it('shares rate-limit state across two independent Express app instances and enforces atomic concurrency + window reset', async () => {
      const redis = getRedisClient();
      const windowMs = 1000;
      const maxRequests = 5;

      const makeInstance = () => {
        const instance = express();
        instance.set('trust proxy', false);
        instance.use(
          createRateLimiter({
            name: `shared-${Date.now()}`,
            windowMs,
            maxRequests,
            failurePolicy: 'fail-closed',
            redisClient: redis,
            alwaysEnforce: true,
            keyPrefix: testRedisPrefix,
          }),
        );
        instance.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
        instance.use(errorHandler);
        return instance;
      };

      // Use identical policy name so both independent app instances share the exact same Redis bucket
      const sharedPolicy = `multi-${Date.now()}`;
      const mkShared = () => {
        const inst = express();
        inst.set('trust proxy', false);
        inst.use(
          createRateLimiter({
            name: sharedPolicy,
            windowMs,
            maxRequests,
            failurePolicy: 'fail-closed',
            redisClient: redis,
            alwaysEnforce: true,
            keyPrefix: testRedisPrefix,
          }),
        );
        inst.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
        inst.use(errorHandler);
        return inst;
      };

      void makeInstance;
      const instanceA = mkShared();
      const instanceB = mkShared();

      // Fire 10 concurrent requests split across Instance A (5) and Instance B (5)
      // Also vary spoofed X-Forwarded-For headers — must be ignored because trust proxy is false!
      const responses = await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          request(instanceA)
            .get('/ping')
            .set('X-Forwarded-For', `198.51.100.${i + 1}`),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          request(instanceB)
            .get('/ping')
            .set('X-Forwarded-For', `203.0.113.${i + 1}`),
        ),
      ]);

      const okCount = responses.filter((r) => r.status === 200).length;
      const blocked = responses.filter((r) => r.status === 429);

      // Atomic Lua guarantees strictly 5 allowed and 5 blocked across both instances despite spoofed XFF
      expect(okCount).toBe(5);
      expect(blocked.length).toBe(5);
      expect(blocked[0]!.headers['x-ratelimit-limit']).toBe('5');
      expect(blocked[0]!.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(blocked[0]!.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      // Wait for Redis PEXPIRE window to reset and confirm traffic is allowed again
      await new Promise((resolve) => setTimeout(resolve, windowMs + 150));
      const afterReset = await request(instanceA).get('/ping');
      expect(afterReset.status).toBe(200);
      expect(afterReset.headers['x-ratelimit-remaining']).toBe('4');
    });

    it('enforces explicit fail-closed (503) and fail-open (200) Redis outage policies without leaking Redis details', async () => {
      const brokenRedis = {
        status: 'ready' as const,
        connect: async () => undefined,
        eval: async () => {
          throw new Error('ECONNREFUSED redis://user:super-secret-pass@10.0.0.5:6379');
        },
      };

      const failClosedApp = express();
      failClosedApp.use(
        createRateLimiter({
          name: 'auth',
          windowMs: 60_000,
          maxRequests: 10,
          failurePolicy: 'fail-closed',
          redisClient: brokenRedis,
          alwaysEnforce: true,
        }),
      );
      failClosedApp.get('/test', (_req, res) => res.json({ ok: true }));
      failClosedApp.use(errorHandler);

      const closedRes = await request(failClosedApp).get('/test');
      expect(closedRes.status).toBe(503);
      expect(JSON.stringify(closedRes.body)).not.toContain('super-secret-pass');
      expect(JSON.stringify(closedRes.body)).not.toContain('10.0.0.5');

      const failOpenApp = express();
      failOpenApp.use(
        createRateLimiter({
          name: 'general',
          windowMs: 60_000,
          maxRequests: 10,
          failurePolicy: 'fail-open',
          redisClient: brokenRedis,
          alwaysEnforce: true,
        }),
      );
      failOpenApp.get('/test', (_req, res) => res.json({ ok: true }));
      failOpenApp.use(errorHandler);

      const openRes = await request(failOpenApp).get('/test');
      expect(openRes.status).toBe(200);
    });
  });

  describe('6–11 & 14. Tenant-scoped API keys, scopes, rotation, isolation & audit events', () => {
    it('enforces full API key lifecycle, zero plaintext storage, scope bounds, cross-org isolation, rotation & audit logging', async () => {
      // MEMBER cannot create API keys (ADMIN/OWNER only)
      const memberForbidden = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${memberAToken}`)
        .send({ name: 'member-key', scopes: ['jobs:read'] });
      expect(memberForbidden.status).toBe(403);

      // ADMIN creates a least-privilege API key with ['jobs:read', 'queues:read']
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          name: 'ci-readonly-key',
          scopes: ['jobs:read', 'queues:read'],
          metadata: { env: 'ci' },
        });
      expect(createRes.status).toBe(201);
      const plaintextKey = createRes.body.data.plaintextKey as string;
      const apiKeyId = createRes.body.data.apiKey.id as string;
      expect(plaintextKey).toMatch(/^pq_live_[a-f0-9]{8}_[a-f0-9]{48}$/);

      // Verify zero plaintext key persisted in PostgreSQL
      const dbRow = await prisma.apiKey.findUnique({ where: { id: apiKeyId } });
      expect(dbRow).not.toBeNull();
      expect(dbRow!.keyHash).not.toBe(plaintextKey);
      expect(dbRow!.keyHash).not.toContain(plaintextKey);
      expect(dbRow!.keyHash).toHaveLength(64); // HMAC-SHA256 hex

      // List endpoint NEVER returns plaintextKey or keyHash
      const listRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(listRes.status).toBe(200);
      expect(JSON.stringify(listRes.body)).not.toContain(plaintextKey);
      expect(JSON.stringify(listRes.body)).not.toContain(dbRow!.keyHash);

      // Allowed scope works: GET queues & GET jobs in Org A
      const allowedQueues = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('X-API-Key', plaintextKey);
      expect(allowedQueues.status).toBe(200);

      // Missing scope is rejected (403): POST job requires 'jobs:write'
      const deniedWrite = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
        .set('X-API-Key', plaintextKey)
        .send({ name: 'unscoped-job' });
      expect(deniedWrite.status).toBe(403);

      // API keys can NEVER access admin/owner-only key management or org deletion (403)
      const deniedKeyMgmt = await request(app)
        .get(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('X-API-Key', plaintextKey);
      expect(deniedKeyMgmt.status).toBe(403);

      // Cross-organisation access with Org A's API key is rejected (404 anti-enumeration)
      const crossOrgRes = await request(app)
        .get(`/api/v1/organisations/${orgBId}/queues`)
        .set('X-API-Key', plaintextKey);
      expect(crossOrgRes.status).toBe(404);

      const crossOrgQueueRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueBId}`)
        .set('X-API-Key', plaintextKey);
      expect(crossOrgQueueRes.status).toBe(404);

      // Rotate API key: old key immediately rejected (401), new key works (200)
      const rotateRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys/${apiKeyId}/rotate`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ scopes: ['queues:read', 'jobs:write'] });
      expect(rotateRes.status).toBe(200);
      const rotatedPlaintext = rotateRes.body.data.plaintextKey as string;
      const rotatedId = rotateRes.body.data.apiKey.id as string;
      expect(rotatedPlaintext).not.toBe(plaintextKey);

      const oldKeyAfterRotate = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('X-API-Key', plaintextKey);
      expect(oldKeyAfterRotate.status).toBe(401);

      const newKeyAfterRotate = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('X-API-Key', rotatedPlaintext);
      expect(newKeyAfterRotate.status).toBe(200);

      // Revoke rotated key -> immediately rejected (401)
      const revokeRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys/${rotatedId}/revoke`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(revokeRes.status).toBe(200);

      const afterRevoke = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('X-API-Key', rotatedPlaintext);
      expect(afterRevoke.status).toBe(401);

      // Expired API key is rejected (401)
      const expiredCreate = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          name: 'short-lived-key',
          scopes: ['queues:read'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      const expiredPlaintext = expiredCreate.body.data.plaintextKey as string;
      await prisma.apiKey.update({
        where: { id: expiredCreate.body.data.apiKey.id as string },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const expiredUse = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('X-API-Key', expiredPlaintext);
      expect(expiredUse.status).toBe(401);

      // Verify tenant-scoped audit events (API_KEY_CREATED, API_KEY_ROTATED, API_KEY_REVOKED)
      const orgAEvents = await prisma.platformEvent.findMany({
        where: {
          organisationId: orgAId,
          type: {
            in: [
              PlatformEventType.API_KEY_CREATED,
              PlatformEventType.API_KEY_ROTATED,
              PlatformEventType.API_KEY_REVOKED,
            ],
          },
        },
      });
      const types = new Set(orgAEvents.map((e) => e.type));
      expect(types.has(PlatformEventType.API_KEY_CREATED)).toBe(true);
      expect(types.has(PlatformEventType.API_KEY_ROTATED)).toBe(true);
      expect(types.has(PlatformEventType.API_KEY_REVOKED)).toBe(true);
      expect(JSON.stringify(orgAEvents)).not.toContain(plaintextKey);
      expect(JSON.stringify(orgAEvents)).not.toContain(rotatedPlaintext);

      // Org B cannot see Org A's audit events
      const orgBEventsRes = await request(app)
        .get(`/api/v1/organisations/${orgBId}/monitoring/events`)
        .set('Authorization', `Bearer ${ownerBToken}`);
      expect(orgBEventsRes.status).toBe(200);
      expect(JSON.stringify(orgBEventsRes.body)).not.toContain('ci-readonly-key');
    });
  });

  describe('12. Production secret validation & trusted-proxy guardrails', () => {
    it('rejects missing/weak/reused API_KEY_SECRET and unrestricted TRUST_PROXY=true in production', () => {
      const strongJwt = 'jwt-production-secret-at-least-32-chars-long-001';
      const strongApiKey = 'api-key-production-pepper-at-least-32-chars-002';

      // Missing API_KEY_SECRET in production
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          PORT: '3000',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          JWT_SECRET: strongJwt,
        }),
      ).toThrow(/API_KEY_SECRET must be explicitly set/i);

      // API_KEY_SECRET equal to JWT_SECRET in production
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          PORT: '3000',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          JWT_SECRET: strongJwt,
          API_KEY_SECRET: strongJwt,
        }),
      ).toThrow(/must be distinct from JWT_SECRET/i);

      // Unrestricted TRUST_PROXY=true rejected
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          PORT: '3000',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          JWT_SECRET: strongJwt,
          API_KEY_SECRET: strongApiKey,
          TRUST_PROXY: 'true',
        }),
      ).toThrow(/unrestricted "true" is forbidden/i);

      // Valid production config passes
      const parsed = validateEnv({
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: strongJwt,
        API_KEY_SECRET: strongApiKey,
        TRUST_PROXY: '1',
      });
      expect(parsed.TRUST_PROXY).toBe(1);
    });
  });
});

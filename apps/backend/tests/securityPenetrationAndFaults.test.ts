import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DeadLetterStatus, JobStatus, Role, ScheduleType } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { connectRedis, getRedisClient } from '../src/config/redis.js';
import { createRateLimiter } from '../src/middleware/rateLimit.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { eventService } from '../src/services/event.service.js';
import { hashPassword, signAccessToken } from '../src/utils/security.js';

const app = createApp();

describe('Phase 9.3 — Penetration-Style Security Validation & Infrastructure Fault Tolerance', () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const testRedisPrefix = `pq:rl:p93:${Date.now()}`;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  let dlqAId = '';
  let dlqBId = '';
  let adminAEmail = '';
  let adminAToken = '';
  let ownerBToken = '';

  beforeAll(async () => {
    await connectRedis();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const pwHash = await hashPassword('PenTestPass123!');

    const [adminA, ownerB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `p93-admina-${suffix}@test.local`,
          name: 'P93 Admin A',
          passwordHash: pwHash,
        },
      }),
      prisma.user.create({
        data: {
          email: `p93-ownerb-${suffix}@test.local`,
          name: 'P93 Owner B',
          passwordHash: pwHash,
        },
      }),
    ]);
    createdUserIds.push(adminA.id, ownerB.id);
    adminAEmail = adminA.email;
    adminAToken = signAccessToken(adminA.id, adminA.email);
    ownerBToken = signAccessToken(ownerB.id, ownerB.email);

    const [orgA, orgB] = await Promise.all([
      prisma.organisation.create({
        data: {
          name: `P93 Org A ${suffix}`,
          memberships: { create: [{ userId: adminA.id, role: Role.ADMIN }] },
        },
      }),
      prisma.organisation.create({
        data: {
          name: `P93 Org B ${suffix}`,
          memberships: { create: [{ userId: ownerB.id, role: Role.OWNER }] },
        },
      }),
    ]);
    createdOrgIds.push(orgA.id, orgB.id);
    orgAId = orgA.id;
    orgBId = orgB.id;

    const [qA, qB] = await Promise.all([
      prisma.queue.create({
        data: { organisationId: orgAId, name: `p93-qa-${suffix}`, createdById: adminA.id },
      }),
      prisma.queue.create({
        data: { organisationId: orgBId, name: `p93-qb-${suffix}`, createdById: ownerB.id },
      }),
    ]);
    queueAId = qA.id;
    queueBId = qB.id;

    const [jobA, jobB] = await Promise.all([
      prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'p93-failed-a',
          status: JobStatus.FAILED,
          payload: { ok: true },
          createdById: adminA.id,
        },
      }),
      prisma.job.create({
        data: {
          queueId: queueBId,
          name: 'p93-failed-b',
          status: JobStatus.FAILED,
          payload: { secret: 'org-b' },
          createdById: ownerB.id,
        },
      }),
    ]);

    const [dlqA, dlqB] = await Promise.all([
      prisma.deadLetterJob.create({
        data: {
          originalJobId: jobA.id,
          organisationId: orgAId,
          queueId: queueAId,
          queueName: qA.name,
          jobName: jobA.name,
          payloadSummary: { keyCount: 1, keys: ['ok'], byteLength: 11 },
          failureReason: 'Transient failure A',
          attemptsMade: 3,
          maxRetries: 3,
          status: DeadLetterStatus.OPEN,
          failedAt: new Date(),
        },
      }),
      prisma.deadLetterJob.create({
        data: {
          originalJobId: jobB.id,
          organisationId: orgBId,
          queueId: queueBId,
          queueName: qB.name,
          jobName: jobB.name,
          payloadSummary: { keyCount: 1, keys: ['secret'], byteLength: 18 },
          failureReason: 'Org B internal error',
          attemptsMade: 3,
          maxRetries: 3,
          status: DeadLetterStatus.OPEN,
          failedAt: new Date(),
        },
      }),
    ]);
    dlqAId = dlqA.id;
    dlqBId = dlqB.id;

    await prisma.schedule.create({
      data: {
        organisationId: orgBId,
        queueId: queueBId,
        name: `p93-sched-b-${suffix}`,
        jobName: 'tenant-b-cron',
        type: ScheduleType.RECURRING,
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        createdById: ownerB.id,
      },
    });
  });

  afterAll(async () => {
    const redis = getRedisClient();
    try {
      const keys = await redis.keys(`${testRedisPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
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

  describe('1. Auth edge cases, payload caps & global health privacy', () => {
    it('revokes all user sessions when a logged-out refresh token is replayed', async () => {
      const login1 = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: adminAEmail, password: 'PenTestPass123!' });
      const login2 = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: adminAEmail, password: 'PenTestPass123!' });
      expect(login1.status).toBe(200);
      expect(login2.status).toBe(200);

      const rt1 = login1.body.data.refreshToken as string;
      const rt2 = login2.body.data.refreshToken as string;

      // Logout revokes rt1
      expect(
        (await request(app).post('/api/v1/auth/logout').send({ refreshToken: rt1 })).status,
      ).toBe(200);

      // Replaying revoked rt1 triggers reuse detection and revokes rt2 as well
      expect(
        (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt1 })).status,
      ).toBe(401);
      expect(
        (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt2 })).status,
      ).toBe(401);
    });

    it('rejects oversized auth JSON payloads (>16kb) with 413 and exposes zero tenant/secret info on /health', async () => {
      const oversized = { email: adminAEmail, password: 'A'.repeat(20_000) };
      const res = await request(app).post('/api/v1/auth/login').send(oversized);
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

      const healthRes = await request(app).get('/health');
      expect([200, 503]).toContain(healthRes.status);
      const serialized = JSON.stringify(healthRes.body);
      expect(serialized).not.toContain(orgAId);
      expect(serialized).not.toContain(orgBId);
      expect(serialized).not.toContain('DATABASE_URL');
      expect(serialized).not.toContain('JWT_SECRET');
    });
  });

  describe('2. Systematic API-key scope enforcement, query-param IDOR & concurrent key rotation races', () => {
    it('enforces schedules:read scope, blocks cross-org query-param IDOR, and serializes concurrent key rotation', async () => {
      // Create schedules:read scoped API key in Org A
      const keyRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'sched-reader', scopes: ['schedules:read'] });
      expect(keyRes.status).toBe(201);
      const keyId = keyRes.body.data.apiKey.id as string;
      const plaintext = keyRes.body.data.plaintextKey as string;

      // Allowed: GET /schedules in Org A
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/schedules`)
            .set('X-API-Key', plaintext)
        ).status,
      ).toBe(200);

      // Query-param IDOR probe: passing Org B's queueId in query string must never return Org B schedules
      const queryIdor = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules?queueId=${queueBId}`)
        .set('X-API-Key', plaintext);
      expect(queryIdor.status).toBe(200);
      expect(queryIdor.body.data.schedules).toHaveLength(0);

      // Missing scope: POST /schedules requires schedules:write -> 403
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/schedules`)
            .set('X-API-Key', plaintext)
            .send({
              name: 'blocked-sched',
              queueId: queueAId,
              jobName: 'echo',
              type: 'RECURRING',
              cronExpression: '0 * * * *',
            })
        ).status,
      ).toBe(403);

      // Cross-org access -> 404
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgBId}/schedules`)
            .set('X-API-Key', plaintext)
        ).status,
      ).toBe(404);

      // Concurrent rotation race on the exact same API key: strictly ONE succeeds (200), ONE conflicts (409)
      const [rot1, rot2] = await Promise.all([
        request(app)
          .post(`/api/v1/organisations/${orgAId}/api-keys/${keyId}/rotate`)
          .set('Authorization', `Bearer ${adminAToken}`)
          .send({}),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/api-keys/${keyId}/rotate`)
          .set('Authorization', `Bearer ${adminAToken}`)
          .send({}),
      ]);
      expect([rot1.status, rot2.status].sort()).toEqual([200, 409]);

      // Old key is immediately invalid (401)
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/schedules`)
            .set('X-API-Key', plaintext)
        ).status,
      ).toBe(401);

      // Sanity: Owner B still sees Org B's schedule
      const orgBScheds = await request(app)
        .get(`/api/v1/organisations/${orgBId}/schedules`)
        .set('Authorization', `Bearer ${ownerBToken}`);
      expect(orgBScheds.status).toBe(200);
      expect(orgBScheds.body.data.schedules.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Distributed rate-limit isolation, Redis timeout/script faults & recovery', () => {
    it('isolates rate-limit buckets by identity and policy, survives Redis fault + recovery, and keeps TTL bounded', async () => {
      const redis = getRedisClient();
      const policyA = `isoA-${Date.now()}`;
      const policyB = `isoB-${Date.now()}`;

      const testApp = express();
      testApp.use(
        '/a',
        createRateLimiter({
          name: policyA,
          windowMs: 5000,
          maxRequests: 2,
          failurePolicy: 'fail-closed',
          redisClient: redis,
          alwaysEnforce: true,
          keyPrefix: testRedisPrefix,
          keyGenerator: (req) => String(req.header('x-client-id') ?? 'anon'),
        }),
        (_req, res) => res.json({ route: 'a' }),
      );
      testApp.use(
        '/b',
        createRateLimiter({
          name: policyB,
          windowMs: 5000,
          maxRequests: 2,
          failurePolicy: 'fail-open',
          redisClient: redis,
          alwaysEnforce: true,
          keyPrefix: testRedisPrefix,
          keyGenerator: (req) => String(req.header('x-client-id') ?? 'anon'),
        }),
        (_req, res) => res.json({ route: 'b' }),
      );
      testApp.use(errorHandler);

      // Client 1 exhausts policy A
      expect((await request(testApp).get('/a').set('x-client-id', 'client-1')).status).toBe(200);
      expect((await request(testApp).get('/a').set('x-client-id', 'client-1')).status).toBe(200);
      expect((await request(testApp).get('/a').set('x-client-id', 'client-1')).status).toBe(429);

      // Identity isolation: Client 2 is unaffected on policy A
      expect((await request(testApp).get('/a').set('x-client-id', 'client-2')).status).toBe(200);

      // Policy isolation: Client 1 is unaffected on policy B
      expect((await request(testApp).get('/b').set('x-client-id', 'client-1')).status).toBe(200);

      // Verify every created Redis key has a bounded positive PTTL (no unbounded key growth)
      const keys = await redis.keys(`${testRedisPrefix}:*`);
      expect(keys.length).toBeGreaterThanOrEqual(3);
      for (const k of keys) {
        const pttl = await redis.pttl(k);
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(5000);
      }

      // Fault injection + recovery: toggle simulated Redis timeout/script failure on and off
      let failRedis = true;
      const flakyRedis = {
        status: 'ready' as const,
        connect: async () => undefined,
        eval: async (...args: Parameters<typeof redis.eval>) => {
          if (failRedis)
            throw new Error('ERR Lua script timeout on redis://:secret@127.0.0.1:6379');
          return redis.eval(...args);
        },
      };

      const recoveryApp = express();
      recoveryApp.use(
        '/protected',
        createRateLimiter({
          name: `rec-${Date.now()}`,
          windowMs: 5000,
          maxRequests: 2,
          failurePolicy: 'fail-closed',
          redisClient: flakyRedis,
          alwaysEnforce: true,
          keyPrefix: testRedisPrefix,
        }),
        (_req, res) => res.json({ ok: true }),
      );
      recoveryApp.use(errorHandler);

      // During outage -> fail-closed 503 with zero secret leakage
      const outageRes = await request(recoveryApp).get('/protected');
      expect(outageRes.status).toBe(503);
      expect(JSON.stringify(outageRes.body)).not.toContain('secret');

      // After Redis recovers -> requests succeed and rate limit enforces cleanly
      failRedis = false;
      expect((await request(recoveryApp).get('/protected')).status).toBe(200);
      expect((await request(recoveryApp).get('/protected')).status).toBe(200);
      expect((await request(recoveryApp).get('/protected')).status).toBe(429);
    });
  });

  describe('4. PostgreSQL concurrency races & audit-event failure resilience', () => {
    it('enforces atomic idempotency under concurrent job submissions and atomic OPEN->REPLAYED under concurrent DLQ replays', async () => {
      // 5 concurrent identical idempotencyKey job submissions -> strictly 1 DB job created
      const idemKey = `p93-idem-${Date.now()}`;
      const jobResponses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app)
            .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
            .set('Authorization', `Bearer ${adminAToken}`)
            .set('Idempotency-Key', idemKey)
            .send({ name: 'p93-idem-job', payload: { n: 1 } }),
        ),
      );
      for (const r of jobResponses) {
        expect([200, 201]).toContain(r.status);
      }
      const distinctJobIds = new Set(jobResponses.map((r) => r.body.data.job.id));
      expect(distinctJobIds.size).toBe(1);

      // 3 concurrent DLQ replays via scoped dlq:replay API key -> strictly 1 x 201 and 2 x 409
      const dlqKeyRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/api-keys`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'dlq-replayer', scopes: ['dlq:replay'] });
      const dlqPlaintext = dlqKeyRes.body.data.plaintextKey as string;

      // Cross-org DLQ replay with Org A's dlq:replay key -> 404
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/dlq/${dlqBId}/replay`)
            .set('X-API-Key', dlqPlaintext)
        ).status,
      ).toBe(404);

      const replayResponses = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(app)
            .post(`/api/v1/organisations/${orgAId}/dlq/${dlqAId}/replay`)
            .set('X-API-Key', dlqPlaintext),
        ),
      );
      expect(replayResponses.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    });

    it('never bypasses 429 rate-limit enforcement when audit-event persistence fails', async () => {
      const spy = vi
        .spyOn(eventService, 'record')
        .mockRejectedValue(new Error('Simulated PostgreSQL audit write outage'));

      try {
        const redis = getRedisClient();
        const auditFailApp = express();
        auditFailApp.use((req, _res, next) => {
          req.membership = {
            id: 'mem-1',
            userId: 'user-1',
            organisationId: orgAId,
            role: Role.MEMBER,
          };
          next();
        });
        auditFailApp.use(
          createRateLimiter({
            name: `auditfail-${Date.now()}`,
            windowMs: 5000,
            maxRequests: 1,
            failurePolicy: 'fail-closed',
            redisClient: redis,
            alwaysEnforce: true,
            keyPrefix: testRedisPrefix,
          }),
        );
        auditFailApp.get('/check', (_req, res) => res.json({ ok: true }));
        auditFailApp.use(errorHandler);

        expect((await request(auditFailApp).get('/check')).status).toBe(200);
        const blocked = await request(auditFailApp).get('/check');
        expect(blocked.status).toBe(429);
        expect(JSON.stringify(blocked.body)).not.toContain('Simulated PostgreSQL');
      } finally {
        spy.mockRestore();
      }
    });
  });
});

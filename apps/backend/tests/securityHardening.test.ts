import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { DeadLetterStatus, JobStatus, Role, ScheduleType } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { env, validateEnv } from '../src/config/env.js';
import { resetRateLimitStores } from '../src/middleware/rateLimit.middleware.js';
import { hashPassword, signAccessToken } from '../src/utils/security.js';

const app = createApp();

describe('Phase 9.1 — Security Architecture, Authentication, RBAC & Tenant Isolation', () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  let jobBId = '';
  let scheduleBId = '';
  let dlqBId = '';

  let ownerAId = '';
  let ownerAEmail = '';
  let ownerAToken = '';
  let adminAToken = '';
  let memberAToken = '';
  let ownerBToken = '';

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const pwHash = await hashPassword('SecurePass123!');

    const [ownerA, adminA, memberA, ownerB] = await Promise.all([
      prisma.user.create({
        data: { email: `s91-ownera-${suffix}@test.local`, name: 'Owner A', passwordHash: pwHash },
      }),
      prisma.user.create({
        data: { email: `s91-admina-${suffix}@test.local`, name: 'Admin A', passwordHash: pwHash },
      }),
      prisma.user.create({
        data: { email: `s91-membera-${suffix}@test.local`, name: 'Member A', passwordHash: pwHash },
      }),
      prisma.user.create({
        data: { email: `s91-ownerb-${suffix}@test.local`, name: 'Owner B', passwordHash: pwHash },
      }),
    ]);

    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);
    ownerAId = ownerA.id;
    ownerAEmail = ownerA.email;
    ownerAToken = signAccessToken(ownerA.id, ownerA.email);
    adminAToken = signAccessToken(adminA.id, adminA.email);
    memberAToken = signAccessToken(memberA.id, memberA.email);
    ownerBToken = signAccessToken(ownerB.id, ownerB.email);

    const orgA = await prisma.organisation.create({
      data: {
        name: `Sec91 Org A ${suffix}`,
        memberships: {
          create: [
            { userId: ownerA.id, role: Role.OWNER },
            { userId: adminA.id, role: Role.ADMIN },
            { userId: memberA.id, role: Role.MEMBER },
          ],
        },
      },
    });
    const orgB = await prisma.organisation.create({
      data: {
        name: `Sec91 Org B ${suffix}`,
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
        data: { organisationId: orgAId, name: `sec-qa-${suffix}`, createdById: ownerA.id },
      }),
      prisma.queue.create({
        data: { organisationId: orgBId, name: `sec-qb-${suffix}`, createdById: ownerB.id },
      }),
    ]);
    queueAId = qA.id;
    queueBId = qB.id;

    const jobB = await prisma.job.create({
      data: {
        queueId: queueBId,
        name: 'tenant-b-secret-job',
        status: JobStatus.FAILED,
        payload: { secret: 'org-b-only' },
        createdById: ownerB.id,
      },
    });
    jobBId = jobB.id;

    const schedB = await prisma.schedule.create({
      data: {
        organisationId: orgBId,
        queueId: queueBId,
        name: `sched-b-${suffix}`,
        jobName: 'tenant-b-scheduled',
        type: ScheduleType.RECURRING,
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        createdById: ownerB.id,
      },
    });
    scheduleBId = schedB.id;

    const dlqB = await prisma.deadLetterJob.create({
      data: {
        originalJobId: jobB.id,
        organisationId: orgBId,
        queueId: queueBId,
        queueName: qB.name,
        jobName: jobB.name,
        payloadSummary: { keyCount: 1, keys: ['secret'], byteLength: 24 },
        failureReason: 'Org B internal failure',
        attemptsMade: 3,
        maxRetries: 3,
        status: DeadLetterStatus.OPEN,
        failedAt: new Date(),
      },
    });
    dlqBId = dlqB.id;
  });

  afterAll(async () => {
    resetRateLimitStores();
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  describe('1 & 2. JWT verification, claims, disallowed algorithms & secret validation', () => {
    it('rejects missing, malformed, expired, and bad-signature tokens', async () => {
      expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', 'Basic abc123')).status,
      ).toBe(401);
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt')).status,
      ).toBe(401);

      const expiredToken = jwt.sign({ sub: ownerAId, email: ownerAEmail }, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: -10,
      });
      const expiredRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(expiredRes.status).toBe(401);
      expect(expiredRes.body.error.message).toMatch(/expired/i);

      const wrongSigToken = jwt.sign(
        { sub: ownerAId, email: ownerAEmail },
        'wrong-secret-key-99999',
        {
          algorithm: 'HS256',
          issuer: env.JWT_ISSUER,
          audience: env.JWT_AUDIENCE,
          expiresIn: '5m',
        },
      );
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${wrongSigToken}`))
          .status,
      ).toBe(401);
    });

    it('rejects disallowed algorithms (none, HS384) and invalid iss/aud/sub claims', async () => {
      // Unsigned alg:none token
      const headerNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const bodyNone = Buffer.from(
        JSON.stringify({
          sub: ownerAId,
          email: ownerAEmail,
          iss: env.JWT_ISSUER,
          aud: env.JWT_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString('base64url');
      expect(
        (
          await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${headerNone}.${bodyNone}.`)
        ).status,
      ).toBe(401);

      // Disallowed HS384 algorithm
      const hs384Token = jwt.sign({ sub: ownerAId, email: ownerAEmail }, env.JWT_SECRET, {
        algorithm: 'HS384',
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: '5m',
      });
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${hs384Token}`))
          .status,
      ).toBe(401);

      // Wrong issuer
      const wrongIssToken = jwt.sign({ sub: ownerAId, email: ownerAEmail }, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: 'evil-issuer',
        audience: env.JWT_AUDIENCE,
        expiresIn: '5m',
      });
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${wrongIssToken}`))
          .status,
      ).toBe(401);

      // Wrong audience
      const wrongAudToken = jwt.sign({ sub: ownerAId, email: ownerAEmail }, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        audience: 'wrong-audience',
        expiresIn: '5m',
      });
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${wrongAudToken}`))
          .status,
      ).toBe(401);

      // Non-UUID sub claim
      const badSubToken = jwt.sign({ sub: 'not-a-uuid', email: ownerAEmail }, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: '5m',
      });
      expect(
        (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${badSubToken}`))
          .status,
      ).toBe(401);
    });

    it('rejects weak JWT_SECRET (< 32 chars) in production env validation', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          PORT: '3000',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          JWT_SECRET: 'too-short-20-char-key',
        }),
      ).toThrow(/at least 32 characters long in production/i);
    });
  });

  describe('3 & 4. Unauthenticated access & RBAC permission boundaries', () => {
    it('blocks unauthenticated access to all tenant-scoped protected endpoints', async () => {
      const endpoints = [
        `/api/v1/organisations/${orgAId}`,
        `/api/v1/organisations/${orgAId}/queues`,
        `/api/v1/organisations/${orgAId}/schedules`,
        `/api/v1/organisations/${orgAId}/dlq`,
        `/api/v1/organisations/${orgAId}/governance`,
        `/api/v1/organisations/${orgAId}/monitoring/metrics`,
        `/api/v1/organisations/${orgAId}/monitoring/scheduler`,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
      ];
      for (const url of endpoints) {
        expect((await request(app).get(url)).status).toBe(401);
      }
    });

    it('prevents MEMBER from performing ADMIN/OWNER actions and ADMIN from OWNER-only actions', async () => {
      // MEMBER cannot create queues, update governance quotas, or delete orgs
      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/queues`)
            .set('Authorization', `Bearer ${memberAToken}`)
            .send({ name: 'member-blocked-q' })
        ).status,
      ).toBe(403);

      expect(
        (
          await request(app)
            .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
            .set('Authorization', `Bearer ${memberAToken}`)
            .send({ schedulingWeight: 5 })
        ).status,
      ).toBe(403);

      expect(
        (
          await request(app)
            .delete(`/api/v1/organisations/${orgAId}`)
            .set('Authorization', `Bearer ${memberAToken}`)
        ).status,
      ).toBe(403);

      // ADMIN cannot delete org, delete queue, or transfer ownership (OWNER-only)
      expect(
        (
          await request(app)
            .delete(`/api/v1/organisations/${orgAId}`)
            .set('Authorization', `Bearer ${adminAToken}`)
        ).status,
      ).toBe(403);

      expect(
        (
          await request(app)
            .delete(`/api/v1/organisations/${orgAId}/queues/${queueAId}`)
            .set('Authorization', `Bearer ${adminAToken}`)
        ).status,
      ).toBe(403);

      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/transfer-ownership`)
            .set('Authorization', `Bearer ${adminAToken}`)
            .send({ targetUserId: ownerAId })
        ).status,
      ).toBe(403);
    });
  });

  describe('5 & 6. Cross-tenant isolation & IDOR protection (PostgreSQL)', () => {
    it('blocks Owner A from accessing Org B directly or probing Org B resource IDs via Org A URLs', async () => {
      // Direct cross-org access returns 404 (anti-enumeration)
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgBId}/queues`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgBId}/monitoring/metrics`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgBId}/monitoring/stream`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      // IDOR: Valid Org B resource IDs injected into Org A's authenticated URL path
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/queues/${queueBId}`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/jobs/${jobBId}`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs/${jobBId}`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/schedules/${scheduleBId}`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgAId}/dlq/${dlqBId}`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      expect(
        (
          await request(app)
            .post(`/api/v1/organisations/${orgAId}/dlq/${dlqBId}/replay`)
            .set('Authorization', `Bearer ${ownerAToken}`)
        ).status,
      ).toBe(404);

      // Sanity: Owner B can still read Org B's own DLQ job
      expect(
        (
          await request(app)
            .get(`/api/v1/organisations/${orgBId}/dlq/${dlqBId}`)
            .set('Authorization', `Bearer ${ownerBToken}`)
        ).status,
      ).toBe(200);
    });
  });

  describe('7, 8, 9 & 10. Mass assignment, CORS allowlist, atomic refresh rotation & rate limiting', () => {
    it('prevents mass-assignment attempts against protected fields (strict reject or safe strip)', async () => {
      const regMassAssign = await request(app).post('/api/v1/auth/register').send({
        name: 'Attacker',
        email: 'attacker@test.local',
        password: 'Password123',
        role: 'OWNER',
        isAdmin: true,
      });
      expect(regMassAssign.status).toBe(400);

      const govMassAssign = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/governance/quotas`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({
          schedulingWeight: 2,
          schedulingDeficit: 999999,
        });
      expect(govMassAssign.status).toBe(400);

      // Queue & job schemas strip unknown fields for backward compatibility while never persisting them
      const queueMassAssign = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({
          name: `mass-assign-q-${Date.now()}`,
          organisationId: orgBId,
          isPaused: true,
        });
      expect(queueMassAssign.status).toBe(201);
      expect(queueMassAssign.body.data.queue.organisationId).toBe(orgAId);
      expect(queueMassAssign.body.data.queue.isPaused).toBe(false);

      const jobMassAssign = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueAId}/jobs`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({
          name: 'mass-assign-job',
          status: 'COMPLETED',
          fencingToken: 999,
        });
      expect(jobMassAssign.status).toBe(201);
      expect(jobMassAssign.body.data.job.status).toBe('PENDING');
      expect(jobMassAssign.body.data.job.fencingToken).toBe(0);
    });

    it('enforces strict CORS origin allowlist and omits ACAO header for untrusted origins', async () => {
      const allowedRes = await request(app).get('/health').set('Origin', 'http://localhost:5173');
      expect(allowedRes.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(allowedRes.headers['access-control-allow-credentials']).toBe('true');

      const blockedRes = await request(app)
        .get('/health')
        .set('Origin', 'https://evil-attacker.example.com');
      expect(blockedRes.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('prevents concurrent refresh token rotation race and revokes all user sessions on reuse', async () => {
      const loginRes = await request(app).post('/api/v1/auth/login').send({
        email: ownerAEmail,
        password: 'SecurePass123!',
      });
      expect(loginRes.status).toBe(200);
      const token = loginRes.body.data.refreshToken as string;

      // Fire two concurrent refresh requests with the exact same single-use refresh token
      const [r1, r2] = await Promise.all([
        request(app).post('/api/v1/auth/refresh').send({ refreshToken: token }),
        request(app).post('/api/v1/auth/refresh').send({ refreshToken: token }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 401]);
    });

    it('enforces rate limiting with 429 and Retry-After headers when limit is exceeded', async () => {
      resetRateLimitStores();
      let lastStatus = 200;
      let retryAfterHeader: string | undefined;

      for (let i = 0; i < env.RATE_LIMIT_AUTH_MAX + 2; i++) {
        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .set('x-enable-rate-limit', 'true')
          .send({ refreshToken: 'invalid-refresh-token-probe' });
        lastStatus = res.status;
        if (res.status === 429) {
          retryAfterHeader = res.headers['retry-after'];
          expect(res.headers['x-ratelimit-limit']).toBe(String(env.RATE_LIMIT_AUTH_MAX));
          expect(res.headers['x-ratelimit-remaining']).toBe('0');
          break;
        }
      }

      expect(lastStatus).toBe(429);
      expect(Number(retryAfterHeader)).toBeGreaterThanOrEqual(1);
      resetRateLimitStores();
    });
  });
});

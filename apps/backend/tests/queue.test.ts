import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobStatus } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';

interface TestUser {
  id: string;
  name: string;
  email: string;
  accessToken: string;
}

async function createAndLoginUser(prefix: string, suffix: string): Promise<TestUser> {
  const email = `${prefix}_${suffix}@pulsequeue.dev`;
  const password = 'SecurePassword123!';
  const name = `${prefix.toUpperCase()} User`;

  const regRes = await request(app).post('/api/v1/auth/register').send({ name, email, password });
  expect(regRes.status).toBe(201);

  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(loginRes.status).toBe(200);

  return {
    id: regRes.body.data.user.id,
    name,
    email: email.toLowerCase(),
    accessToken: loginRes.body.data.accessToken,
  };
}

describe('Organisation-Scoped Queue Management & Security (Step 3.3)', () => {
  const suffix = `q_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';

  let queueA1Id = '';
  let queueA2Id = '';
  let queueB1Id = '';

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ownerA = await createAndLoginUser('q_owner_a', suffix);
    adminA = await createAndLoginUser('q_admin_a', suffix);
    memberA = await createAndLoginUser('q_member_a', suffix);
    ownerB = await createAndLoginUser('q_owner_b', suffix);

    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);

    // Create Org A (ownerA = OWNER)
    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Queue Tenant Alpha' });
    expect(orgARes.status).toBe(201);
    orgAId = orgARes.body.data.organisation.id;
    createdOrgIds.push(orgAId);

    // Create Org B (ownerB = OWNER)
    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Queue Tenant Beta' });
    expect(orgBRes.status).toBe(201);
    orgBId = orgBRes.body.data.organisation.id;
    createdOrgIds.push(orgBId);

    // Add adminA (ADMIN) and memberA (MEMBER) to Org A via invitations
    const adminInv = await request(app)
      .post(`/api/v1/organisations/${orgAId}/invitations`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ email: adminA.email, role: 'ADMIN' });
    expect(adminInv.status).toBe(201);

    const acceptAdmin = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${adminA.accessToken}`)
      .send({ token: adminInv.body.data.token });
    expect(acceptAdmin.status).toBe(200);

    const memberInv = await request(app)
      .post(`/api/v1/organisations/${orgAId}/invitations`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ email: memberA.email, role: 'MEMBER' });
    expect(memberInv.status).toBe(201);

    const acceptMember = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({ token: memberInv.body.data.token });
    expect(acceptMember.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({
        where: { id: { in: createdOrgIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  }, 20_000);

  // ─── 1. Authentication Enforcement ────────────────────────────────────────

  describe('Authentication Enforcement', () => {
    it('rejects unauthenticated requests to all queue endpoints with 401', async () => {
      const fakeQueueId = '00000000-0000-4000-8000-000000000099';

      const responses = await Promise.all([
        request(app).post(`/api/v1/organisations/${orgAId}/queues`).send({ name: 'unauth-q' }),
        request(app).get(`/api/v1/organisations/${orgAId}/queues`),
        request(app).get(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}`),
        request(app)
          .patch(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}`)
          .send({ concurrency: 10 }),
        request(app).delete(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}`),
        request(app).post(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}/pause`),
        request(app).post(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}/resume`),
        request(app).get(`/api/v1/organisations/${orgAId}/queues/${fakeQueueId}/stats`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── 2. Queue Creation & Configuration Validation ─────────────────────────

  describe('Queue Creation & Validation', () => {
    it('allows OWNER to create a queue with custom BullMQ-compatible configuration', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({
          name: 'Email-Notifications',
          description: 'Outbound transactional emails',
          concurrency: 15,
          defaultPriority: 10,
          maxRetries: 5,
          backoffMs: 2500,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const queue = res.body.data.queue;
      expect(queue.id).toBeDefined();
      expect(queue.organisationId).toBe(orgAId);
      expect(queue.name).toBe('email-notifications'); // normalized lowercase
      expect(queue.description).toBe('Outbound transactional emails');
      expect(queue.isPaused).toBe(false);
      expect(queue.pausedAt).toBeNull();
      expect(queue.concurrency).toBe(15);
      expect(queue.defaultPriority).toBe(10);
      expect(queue.maxRetries).toBe(5);
      expect(queue.backoffMs).toBe(2500);
      expect(queue.jobCount).toBe(0);
      expect(queue.createdBy.id).toBe(ownerA.id);
      expect(queue.createdBy.passwordHash).toBeUndefined();

      queueA1Id = queue.id;
    });

    it('allows ADMIN to create a queue using default configuration values', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ name: 'webhooks_v1' });

      expect(res.status).toBe(201);
      const queue = res.body.data.queue;
      expect(queue.name).toBe('webhooks_v1');
      expect(queue.concurrency).toBe(5);
      expect(queue.defaultPriority).toBe(5);
      expect(queue.maxRetries).toBe(3);
      expect(queue.backoffMs).toBe(1000);
      expect(queue.description).toBeNull();

      queueA2Id = queue.id;
    });

    it('forbids MEMBER from creating a queue (403)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .set('X-Role', 'OWNER')
        .send({ name: 'member-queue', role: 'OWNER' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('prevents duplicate queue names within the same organisation (409)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'EMAIL-NOTIFICATIONS' }); // case-insensitive duplicate

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('allows the same queue name in a different organisation (tenant-scoped uniqueness)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgBId}/queues`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ name: 'email-notifications', description: 'Org B email queue' });

      expect(res.status).toBe(201);
      expect(res.body.data.queue.organisationId).toBe(orgBId);
      expect(res.body.data.queue.name).toBe('email-notifications');

      queueB1Id = res.body.data.queue.id;
    });

    it('rejects BullMQ-unsafe queue names and out-of-range configuration limits (400)', async () => {
      const badPayloads = [
        { name: 'bad:colon' }, // colons forbidden by BullMQ
        { name: 'has spaces' },
        { name: 'x' }, // too short
        { name: '-leading-dash' },
        { name: 'valid-name', concurrency: 0 },
        { name: 'valid-name', concurrency: 101 },
        { name: 'valid-name', concurrency: 2.5 },
        { name: 'valid-name', defaultPriority: 0 },
        { name: 'valid-name', defaultPriority: 21 },
        { name: 'valid-name', maxRetries: -1 },
        { name: 'valid-name', maxRetries: 25 },
        { name: 'valid-name', backoffMs: -10 },
        { name: 'valid-name', backoffMs: 500_000 },
      ];

      for (const payload of badPayloads) {
        const res = await request(app)
          .post(`/api/v1/organisations/${orgAId}/queues`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send(payload);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
      }
    });
  });

  // ─── 3. Queue Retrieval ───────────────────────────────────────────────────

  describe('Queue Retrieval', () => {
    it('lists only queues belonging to the caller organisation for MEMBER, ADMIN, and OWNER', async () => {
      const resA = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(resA.status).toBe(200);
      const queuesA = resA.body.data.queues as Array<{ id: string; organisationId: string }>;
      expect(queuesA).toHaveLength(2);
      expect(queuesA.map((q) => q.id)).toContain(queueA1Id);
      expect(queuesA.map((q) => q.id)).toContain(queueA2Id);
      expect(queuesA.map((q) => q.id)).not.toContain(queueB1Id);
      for (const q of queuesA) {
        expect(q.organisationId).toBe(orgAId);
      }
    });

    it('retrieves an individual queue by ID and returns 404 for malformed or unknown UUIDs', async () => {
      const okRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(okRes.status).toBe(200);
      expect(okRes.body.data.queue.id).toBe(queueA1Id);
      expect(okRes.body.data.queue.name).toBe('email-notifications');

      const badUuidRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/not-a-uuid`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(badUuidRes.status).toBe(404);

      const missingRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/00000000-0000-4000-8000-000000000123`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(missingRes.status).toBe(404);
    });
  });

  // ─── 4. Queue Updates ─────────────────────────────────────────────────────

  describe('Queue Updates', () => {
    it('forbids MEMBER from updating queue configuration (403)', async () => {
      const res = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ concurrency: 50 });

      expect(res.status).toBe(403);
    });

    it('allows ADMIN and OWNER to update configuration and ignores client-supplied organisationId', async () => {
      const adminRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          description: 'Updated by Admin',
          concurrency: 25,
          defaultPriority: 15,
          maxRetries: 4,
          backoffMs: 5000,
          organisationId: orgBId, // must be ignored by Zod + service
        });

      expect(adminRes.status).toBe(200);
      expect(adminRes.body.data.queue.organisationId).toBe(orgAId);
      expect(adminRes.body.data.queue.description).toBe('Updated by Admin');
      expect(adminRes.body.data.queue.concurrency).toBe(25);
      expect(adminRes.body.data.queue.defaultPriority).toBe(15);
      expect(adminRes.body.data.queue.maxRetries).toBe(4);
      expect(adminRes.body.data.queue.backoffMs).toBe(5000);

      const ownerRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'webhooks_v2' });
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.data.queue.name).toBe('webhooks_v2');
    });

    it('rejects empty update body (400) and duplicate name rename (409)', async () => {
      const emptyRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({});
      expect(emptyRes.status).toBe(400);

      const dupRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'email-notifications' });
      expect(dupRes.status).toBe(409);
    });
  });

  // ─── 5. Queue Controls (Pause & Resume) ───────────────────────────────────

  describe('Queue Pause & Resume Controls', () => {
    it('forbids MEMBER from pausing or resuming a queue (403)', async () => {
      const pauseRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/pause`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(pauseRes.status).toBe(403);

      const resumeRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/resume`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(resumeRes.status).toBe(403);
    });

    it('persists pause and resume state transitions cleanly and supports filtering by isPaused', async () => {
      // ADMIN pauses queueA1
      const pauseRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.queue.isPaused).toBe(true);
      expect(pauseRes.body.data.queue.pausedAt).not.toBeNull();
      const firstPausedAt = pauseRes.body.data.queue.pausedAt;

      // Verify persisted in PostgreSQL
      const dbPaused = await prisma.queue.findUnique({ where: { id: queueA1Id } });
      expect(dbPaused?.isPaused).toBe(true);
      expect(dbPaused?.pausedAt).not.toBeNull();

      // Idempotent second pause preserves original pausedAt
      const pauseAgain = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/pause`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(pauseAgain.status).toBe(200);
      expect(pauseAgain.body.data.queue.pausedAt).toBe(firstPausedAt);

      // Filter list by isPaused=true returns only queueA1
      const pausedList = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues?isPaused=true`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(pausedList.status).toBe(200);
      expect(pausedList.body.data.queues).toHaveLength(1);
      expect(pausedList.body.data.queues[0].id).toBe(queueA1Id);

      // OWNER resumes queueA1
      const resumeRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/resume`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.queue.isPaused).toBe(false);
      expect(resumeRes.body.data.queue.pausedAt).toBeNull();

      const dbResumed = await prisma.queue.findUnique({ where: { id: queueA1Id } });
      expect(dbResumed?.isPaused).toBe(false);
      expect(dbResumed?.pausedAt).toBeNull();
    });
  });

  // ─── 6. Genuine Persisted Statistics & Safe Deletion ──────────────────────

  describe('Queue Statistics & Safe Deletion Protection', () => {
    it('returns genuine zeroed stats when queue has no persisted jobs', async () => {
      const res = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/stats`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(res.status).toBe(200);
      const stats = res.body.data.stats;
      expect(stats.queueId).toBe(queueA1Id);
      expect(stats.organisationId).toBe(orgAId);
      expect(stats.jobs.total).toBe(0);
      expect(stats.jobs.byStatus).toEqual({
        PENDING: 0,
        ACTIVE: 0,
        COMPLETED: 0,
        FAILED: 0,
        DELAYED: 0,
        PAUSED: 0,
      });
    });

    it('returns exact persisted job counts by status and protects queue with jobs from deletion (409)', async () => {
      // Seed genuine persisted jobs into queueA1
      await prisma.job.createMany({
        data: [
          { queueId: queueA1Id, name: 'send-welcome-1', status: JobStatus.PENDING, priority: 5 },
          { queueId: queueA1Id, name: 'send-welcome-2', status: JobStatus.PENDING, priority: 5 },
          { queueId: queueA1Id, name: 'send-invoice', status: JobStatus.ACTIVE, priority: 10 },
          { queueId: queueA1Id, name: 'send-receipt-1', status: JobStatus.COMPLETED, priority: 5 },
          { queueId: queueA1Id, name: 'send-receipt-2', status: JobStatus.COMPLETED, priority: 5 },
          { queueId: queueA1Id, name: 'send-receipt-3', status: JobStatus.COMPLETED, priority: 5 },
          { queueId: queueA1Id, name: 'send-bounce', status: JobStatus.FAILED, priority: 5 },
          { queueId: queueA1Id, name: 'send-digest', status: JobStatus.DELAYED, priority: 1 },
        ],
      });

      const statsRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/stats`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(statsRes.status).toBe(200);
      expect(statsRes.body.data.stats.jobs.total).toBe(8);
      expect(statsRes.body.data.stats.jobs.byStatus).toEqual({
        PENDING: 2,
        ACTIVE: 1,
        COMPLETED: 3,
        FAILED: 1,
        DELAYED: 1,
        PAUSED: 0,
      });

      // GET single queue also reflects accurate persisted jobCount
      const getRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.queue.jobCount).toBe(8);

      // MEMBER and ADMIN are forbidden from deleting queues (403)
      const memberDel = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberDel.status).toBe(403);

      const adminDel = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminDel.status).toBe(403);

      // OWNER attempting to delete non-empty queue receives 409 Conflict
      const ownerDelConflict = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(ownerDelConflict.status).toBe(409);
      expect(ownerDelConflict.body.error.code).toBe('CONFLICT');
      expect(ownerDelConflict.body.error.details.jobCount).toBe(8);

      // Verify queue and its jobs were NOT deleted
      const remainingJobs = await prisma.job.count({ where: { queueId: queueA1Id } });
      expect(remainingJobs).toBe(8);

      // Drain jobs, then OWNER can safely delete the empty queue
      await prisma.job.deleteMany({ where: { queueId: queueA1Id } });

      const ownerDelOk = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(ownerDelOk.status).toBe(200);

      const afterDeleteGet = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(afterDeleteGet.status).toBe(404);
    });
  });

  // ─── 7. Strict Cross-Tenant Isolation ─────────────────────────────────────

  describe('Strict Cross-Tenant Isolation (Org A vs Org B)', () => {
    it('blocks Owner A from accessing Org B queues directly or by spoofing Org B queueId under Org A URL', async () => {
      const crossTenantRequests = [
        // Direct Org B URL attempts by Owner A (non-member of Org B)
        request(app)
          .post(`/api/v1/organisations/${orgBId}/queues`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: 'injected-queue' }),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/queues`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ concurrency: 99 }),
        request(app)
          .delete(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/pause`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/resume`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/stats`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),

        // Cross-org ID spoofing: Owner A uses their own valid Org A ID with Org B's queueId
        request(app)
          .get(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ description: 'Spoofed hijack' }),
        request(app)
          .delete(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}/pause`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}/resume`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}/stats`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
      ];

      const responses = await Promise.all(crossTenantRequests);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
      }

      // Confirm Org B's queue was completely untouched
      const orgBQueueCheck = await request(app)
        .get(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(orgBQueueCheck.status).toBe(200);
      expect(orgBQueueCheck.body.data.queue.description).toBe('Org B email queue');
      expect(orgBQueueCheck.body.data.queue.isPaused).toBe(false);
    });
  });
});

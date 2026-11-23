import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobStatus } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { jobService } from '../src/services/job.service.js';
import {
  canTransitionJobStatus,
  isCancellableJobStatus,
  resolveInitialJobStatus,
} from '../src/utils/jobLifecycle.js';

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

describe('Organisation-Scoped Job Management, Lifecycle & Security (Step 3.4)', () => {
  const suffix = `job_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';

  let queueA1Id = '';
  let queueA2Id = '';
  let queueB1Id = '';

  let pendingJobId = '';
  let delayedJobId = '';
  let pausedJobId = '';
  let orgBJobId = '';

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ownerA = await createAndLoginUser('j_owner_a', suffix);
    adminA = await createAndLoginUser('j_admin_a', suffix);
    memberA = await createAndLoginUser('j_member_a', suffix);
    ownerB = await createAndLoginUser('j_owner_b', suffix);

    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);

    // Create Org A and Org B
    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Job Tenant Alpha' });
    expect(orgARes.status).toBe(201);
    orgAId = orgARes.body.data.organisation.id;
    createdOrgIds.push(orgAId);

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Job Tenant Beta' });
    expect(orgBRes.status).toBe(201);
    orgBId = orgBRes.body.data.organisation.id;
    createdOrgIds.push(orgBId);

    // Invite adminA (ADMIN) and memberA (MEMBER) into Org A
    const adminInv = await request(app)
      .post(`/api/v1/organisations/${orgAId}/invitations`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ email: adminA.email, role: 'ADMIN' });
    expect(adminInv.status).toBe(201);
    await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${adminA.accessToken}`)
      .send({ token: adminInv.body.data.token });

    const memberInv = await request(app)
      .post(`/api/v1/organisations/${orgAId}/invitations`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ email: memberA.email, role: 'MEMBER' });
    expect(memberInv.status).toBe(201);
    await request(app)
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${memberA.accessToken}`)
      .send({ token: memberInv.body.data.token });

    // Create Queue A1 with custom defaults to test inheritance
    const qA1Res = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: 'billing-jobs',
        concurrency: 10,
        defaultPriority: 12,
        maxRetries: 6,
        backoffMs: 3500,
      });
    expect(qA1Res.status).toBe(201);
    queueA1Id = qA1Res.body.data.queue.id;

    // Create Queue A2 (paused) to test paused-queue submission and cross-queue scoping
    const qA2Res = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'paused-maintenance' });
    expect(qA2Res.status).toBe(201);
    queueA2Id = qA2Res.body.data.queue.id;

    const pauseRes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}/pause`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(pauseRes.status).toBe(200);

    // Create Queue B1 in Org B
    const qB1Res = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'beta-jobs' });
    expect(qB1Res.status).toBe(201);
    queueB1Id = qB1Res.body.data.queue.id;
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

  // ─── 1. Job Lifecycle State Machine ───────────────────────────────────────

  describe('Job Lifecycle State Machine', () => {
    it('enforces valid and invalid JobStatus transitions accurately', () => {
      expect(canTransitionJobStatus(JobStatus.PENDING, JobStatus.ACTIVE)).toBe(true);
      expect(canTransitionJobStatus(JobStatus.ACTIVE, JobStatus.COMPLETED)).toBe(true);
      expect(canTransitionJobStatus(JobStatus.ACTIVE, JobStatus.FAILED)).toBe(true);
      expect(canTransitionJobStatus(JobStatus.FAILED, JobStatus.PENDING)).toBe(true);
      expect(canTransitionJobStatus(JobStatus.DELAYED, JobStatus.PENDING)).toBe(true);
      expect(canTransitionJobStatus(JobStatus.PAUSED, JobStatus.PENDING)).toBe(true);

      // Invalid / terminal transitions
      expect(canTransitionJobStatus(JobStatus.PENDING, JobStatus.COMPLETED)).toBe(false);
      expect(canTransitionJobStatus(JobStatus.COMPLETED, JobStatus.PENDING)).toBe(false);
      expect(canTransitionJobStatus(JobStatus.COMPLETED, JobStatus.ACTIVE)).toBe(false);
      expect(canTransitionJobStatus(JobStatus.PAUSED, JobStatus.ACTIVE)).toBe(false);
      expect(canTransitionJobStatus(JobStatus.DELAYED, JobStatus.COMPLETED)).toBe(false);

      // Cancellable statuses
      expect(isCancellableJobStatus(JobStatus.PENDING)).toBe(true);
      expect(isCancellableJobStatus(JobStatus.DELAYED)).toBe(true);
      expect(isCancellableJobStatus(JobStatus.PAUSED)).toBe(true);
      expect(isCancellableJobStatus(JobStatus.ACTIVE)).toBe(false);
      expect(isCancellableJobStatus(JobStatus.COMPLETED)).toBe(false);
      expect(isCancellableJobStatus(JobStatus.FAILED)).toBe(false);

      // Initial status resolution
      expect(resolveInitialJobStatus({ queueIsPaused: false, delayMs: 0 })).toBe(JobStatus.PENDING);
      expect(resolveInitialJobStatus({ queueIsPaused: false, delayMs: 5000 })).toBe(
        JobStatus.DELAYED,
      );
      expect(resolveInitialJobStatus({ queueIsPaused: true, delayMs: 0 })).toBe(JobStatus.PAUSED);
      expect(resolveInitialJobStatus({ queueIsPaused: true, delayMs: 5000 })).toBe(
        JobStatus.PAUSED,
      );
    });
  });

  // ─── 2. Authentication Enforcement ────────────────────────────────────────

  describe('Authentication Enforcement', () => {
    it('rejects unauthenticated requests to all job endpoints with 401', async () => {
      const fakeJobId = '00000000-0000-4000-8000-000000000088';

      const responses = await Promise.all([
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
          .send({ name: 'unauth-job' }),
        request(app).get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`),
        request(app).get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${fakeJobId}`),
        request(app).get(`/api/v1/organisations/${orgAId}/jobs/${fakeJobId}`),
        request(app).post(
          `/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${fakeJobId}/cancel`,
        ),
        request(app).post(`/api/v1/organisations/${orgAId}/jobs/${fakeJobId}/cancel`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── 3. Job Submission & Queue Default Inheritance ────────────────────────

  describe('Job Submission & Validation', () => {
    it('allows MEMBER to submit a job inheriting queue defaultPriority, maxRetries, and backoffMs', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({
          name: 'generate-monthly-invoice',
          payload: { accountId: 'acc_42', month: '2026-11' },
          // Spoofed fields must be ignored — never trusted from client
          status: 'COMPLETED',
          organisationId: orgBId,
          queueId: queueB1Id,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const job = res.body.data.job;
      expect(job.id).toBeDefined();
      expect(job.queueId).toBe(queueA1Id);
      expect(job.queueName).toBe('billing-jobs');
      expect(job.organisationId).toBe(orgAId);
      expect(job.name).toBe('generate-monthly-invoice');
      expect(job.status).toBe('PENDING'); // client status='COMPLETED' ignored
      expect(job.priority).toBe(12); // inherited from queueA1.defaultPriority
      expect(job.maxRetries).toBe(6); // inherited from queueA1.maxRetries
      expect(job.backoffMs).toBe(3500); // inherited from queueA1.backoffMs
      expect(job.delayMs).toBe(0);
      expect(job.payload).toEqual({ accountId: 'acc_42', month: '2026-11' });
      expect(job.createdBy.id).toBe(memberA.id);
      expect(job.createdBy.passwordHash).toBeUndefined();

      pendingJobId = job.id;
    });

    it('submits a delayed job with explicit priority/config and persists status=DELAYED', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          name: 'send-payment-reminder',
          payload: { invoiceId: 'inv_99' },
          priority: 18,
          maxRetries: 2,
          backoffMs: 500,
          delayMs: 60_000,
        });

      expect(res.status).toBe(201);
      const job = res.body.data.job;
      expect(job.status).toBe('DELAYED');
      expect(job.priority).toBe(18);
      expect(job.maxRetries).toBe(2);
      expect(job.backoffMs).toBe(500);
      expect(job.delayMs).toBe(60_000);

      delayedJobId = job.id;
    });

    it('submits a job into a paused queue with initial status=PAUSED', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}/jobs`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'rebuild-search-index' });

      expect(res.status).toBe(201);
      expect(res.body.data.job.status).toBe('PAUSED');
      expect(res.body.data.job.payload).toEqual({});
      expect(res.body.data.job.priority).toBe(5); // default from queueA2

      pausedJobId = res.body.data.job.id;
    });

    it('creates a job in Org B for cross-tenant isolation verification', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/jobs`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ name: 'beta-secret-job', payload: { secret: 'beta-only' } });

      expect(res.status).toBe(201);
      orgBJobId = res.body.data.job.id;
    });

    it('rejects invalid job payloads, priorities, delays, and oversized JSON bodies (400)', async () => {
      const oversizedPayload = { blob: 'x'.repeat(70_000) };

      const badPayloads = [
        { name: 'a' }, // too short
        { name: 'valid-job', payload: ['not', 'an', 'object'] },
        { name: 'valid-job', payload: 'string-not-object' },
        { name: 'valid-job', payload: oversizedPayload },
        { name: 'valid-job', priority: 0 },
        { name: 'valid-job', priority: 21 },
        { name: 'valid-job', priority: 4.5 },
        { name: 'valid-job', maxRetries: -1 },
        { name: 'valid-job', maxRetries: 25 },
        { name: 'valid-job', backoffMs: -1 },
        { name: 'valid-job', delayMs: -100 },
        { name: 'valid-job', delayMs: 90_000_000 },
      ];

      for (const payload of badPayloads) {
        const res = await request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send(payload);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('BAD_REQUEST');
      }
    });

    it('does not expose any arbitrary client-facing job status PATCH endpoint (404)', async () => {
      const res = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${pendingJobId}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(404);
    });
  });

  // ─── 4. Job Retrieval, Pagination & Filtering ─────────────────────────────

  describe('Job Retrieval, Pagination & Status Filtering', () => {
    it('lists jobs in a queue with pagination metadata and status filtering', async () => {
      // Seed 2 additional PENDING jobs so queueA1 has 4 jobs total (3 PENDING, 1 DELAYED)
      for (let i = 1; i <= 2; i++) {
        const res = await request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
          .send({ name: `batch-invoice-${i}` });
        expect(res.status).toBe(201);
      }

      // Page 1, limit 2
      const page1 = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs?page=1&limit=2`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(page1.status).toBe(200);
      expect(page1.body.data.jobs).toHaveLength(2);
      expect(page1.body.data.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 4,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      // Page 2, limit 2
      const page2 = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs?page=2&limit=2`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(page2.status).toBe(200);
      expect(page2.body.data.jobs).toHaveLength(2);
      expect(page2.body.data.pagination.hasNextPage).toBe(false);
      expect(page2.body.data.pagination.hasPreviousPage).toBe(true);

      // Filter by status=DELAYED
      const delayedOnly = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs?status=DELAYED`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(delayedOnly.status).toBe(200);
      expect(delayedOnly.body.data.jobs).toHaveLength(1);
      expect(delayedOnly.body.data.jobs[0].id).toBe(delayedJobId);
      expect(delayedOnly.body.data.pagination.total).toBe(1);

      // Invalid status filter or limit > 100 rejected with 400
      const badFilter = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs?status=BOGUS`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(badFilter.status).toBe(400);

      const badLimit = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs?limit=500`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(badLimit.status).toBe(400);
    });

    it('retrieves individual job via both queue-scoped and org-scoped routes and enforces queue match', async () => {
      const queueScoped = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${pendingJobId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(queueScoped.status).toBe(200);
      expect(queueScoped.body.data.job.id).toBe(pendingJobId);

      const orgScoped = await request(app)
        .get(`/api/v1/organisations/${orgAId}/jobs/${pendingJobId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(orgScoped.status).toBe(200);
      expect(orgScoped.body.data.job.id).toBe(pendingJobId);

      // Wrong queueId within the same organisation must return 404
      const wrongQueue = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}/jobs/${pendingJobId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(wrongQueue.status).toBe(404);

      // Malformed job UUID returns 404
      const badUuid = await request(app)
        .get(`/api/v1/organisations/${orgAId}/jobs/not-a-uuid`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(badUuid.status).toBe(404);
    });

    it('syncs cleanly with Step 3.3 queue statistics endpoint', async () => {
      const statsRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/stats`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);

      expect(statsRes.status).toBe(200);
      expect(statsRes.body.data.stats.jobs.total).toBe(4);
      expect(statsRes.body.data.stats.jobs.byStatus.PENDING).toBe(3);
      expect(statsRes.body.data.stats.jobs.byStatus.DELAYED).toBe(1);
    });
  });

  // ─── 5. Trusted Lifecycle Transitions & Safe Job Cancellation ─────────────

  describe('Trusted Lifecycle Transitions & Safe Job Cancellation', () => {
    it('forbids MEMBER from cancelling jobs (403)', async () => {
      const queueCancel = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${pendingJobId}/cancel`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(queueCancel.status).toBe(403);

      const orgCancel = await request(app)
        .post(`/api/v1/organisations/${orgAId}/jobs/${pendingJobId}/cancel`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(orgCancel.status).toBe(403);
    });

    it('allows ADMIN and OWNER to cancel PENDING, DELAYED, and PAUSED jobs safely', async () => {
      // ADMIN cancels PENDING job via queue-scoped endpoint
      const cancelPending = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${pendingJobId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(cancelPending.status).toBe(200);
      expect(cancelPending.body.data.cancelled).toBe(true);
      expect(cancelPending.body.data.previousStatus).toBe('PENDING');

      // Cancelling the same job a second time returns 404
      const cancelAgain = await request(app)
        .post(`/api/v1/organisations/${orgAId}/jobs/${pendingJobId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(cancelAgain.status).toBe(404);

      // OWNER cancels DELAYED job via org-scoped endpoint
      const cancelDelayed = await request(app)
        .post(`/api/v1/organisations/${orgAId}/jobs/${delayedJobId}/cancel`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(cancelDelayed.status).toBe(200);
      expect(cancelDelayed.body.data.previousStatus).toBe('DELAYED');

      // OWNER cancels PAUSED job
      const cancelPaused = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA2Id}/jobs/${pausedJobId}/cancel`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(cancelPaused.status).toBe(200);
      expect(cancelPaused.body.data.previousStatus).toBe('PAUSED');
    });

    it('prevents cancellation of ACTIVE, COMPLETED, and FAILED jobs (409) and enforces trusted transitions', async () => {
      // Create 3 fresh jobs and transition them via trusted internal jobService.transitionStatus
      const activeJobRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'lifecycle-active' });
      const activeJobId = activeJobRes.body.data.job.id;

      const completedJobRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'lifecycle-completed' });
      const completedJobId = completedJobRes.body.data.job.id;

      const failedJobRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'lifecycle-failed' });
      const failedJobId = failedJobRes.body.data.job.id;

      // Invalid direct jump PENDING -> COMPLETED must fail inside trusted service
      await expect(
        jobService.transitionStatus(orgAId, completedJobId, JobStatus.COMPLETED),
      ).rejects.toThrow('Invalid job status transition');

      // Valid transitions
      await jobService.transitionStatus(orgAId, activeJobId, JobStatus.ACTIVE);
      await jobService.transitionStatus(orgAId, completedJobId, JobStatus.ACTIVE);
      await jobService.transitionStatus(orgAId, completedJobId, JobStatus.COMPLETED);
      await jobService.transitionStatus(orgAId, failedJobId, JobStatus.ACTIVE);
      await jobService.transitionStatus(orgAId, failedJobId, JobStatus.FAILED);

      // Terminal COMPLETED job cannot transition to PENDING
      await expect(
        jobService.transitionStatus(orgAId, completedJobId, JobStatus.PENDING),
      ).rejects.toThrow('Invalid job status transition');

      // Attempting to cancel ACTIVE, COMPLETED, and FAILED jobs must return 409 Conflict
      for (const [jobId, expectedStatus] of [
        [activeJobId, 'ACTIVE'],
        [completedJobId, 'COMPLETED'],
        [failedJobId, 'FAILED'],
      ] as const) {
        const res = await request(app)
          .post(`/api/v1/organisations/${orgAId}/jobs/${jobId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
        expect(res.body.error.details.currentStatus).toBe(expectedStatus);

        // Confirm job is still intact in database
        const check = await request(app)
          .get(`/api/v1/organisations/${orgAId}/jobs/${jobId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`);
        expect(check.status).toBe(200);
        expect(check.body.data.job.status).toBe(expectedStatus);
      }
    });
  });

  // ─── 6. Strict Cross-Tenant Isolation ─────────────────────────────────────

  describe('Strict Cross-Tenant Isolation (Org A vs Org B)', () => {
    it('blocks Owner A from accessing, submitting to, or cancelling Org B jobs directly or via spoofed IDs', async () => {
      const crossTenantRequests = [
        // Direct Org B URL attempts by Owner A
        request(app)
          .post(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: 'cross-tenant-inject' }),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/jobs/${orgBJobId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/jobs/${orgBJobId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/queues/${queueB1Id}/jobs/${orgBJobId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/jobs/${orgBJobId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),

        // Cross-org ID spoofing using Owner A's own valid Org A ID
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: 'spoofed-queue-submit' }),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/queues/${queueB1Id}/jobs`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${orgBJobId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/jobs/${orgBJobId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/queues/${queueA1Id}/jobs/${orgBJobId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/jobs/${orgBJobId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
      ];

      const responses = await Promise.all(crossTenantRequests);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
      }

      // Confirm Org B's job was completely untouched
      const verifyOrgB = await request(app)
        .get(`/api/v1/organisations/${orgBId}/jobs/${orgBJobId}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(verifyOrgB.status).toBe(200);
      expect(verifyOrgB.body.data.job.name).toBe('beta-secret-job');
      expect(verifyOrgB.body.data.job.status).toBe('PENDING');
    });
  });
});

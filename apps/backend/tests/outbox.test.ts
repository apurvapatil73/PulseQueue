import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobStatus, OutboxStatus } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { jobService } from '../src/services/job.service.js';
import {
  bullMQService,
  BullMQService,
  buildBullMQQueueName,
} from '../src/services/bullmq.service.js';
import { OutboxReconciler } from '../src/services/outboxReconciler.service.js';

describe('Transactional Outbox Reconciliation & Atomic Job Sync (Step 4.2)', () => {
  const suffix = `outbox_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let token = '';
  let orgId = '';
  let queueId = '';
  const queueName = `outbox-q-${Date.now()}`;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const email = `outbox_owner_${suffix}@pulsequeue.dev`;
    const password = 'SecurePassword123!';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Outbox Owner', email, password });
    expect(regRes.status).toBe(201);
    createdUserIds.push(regRes.body.data.user.id);

    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(loginRes.status).toBe(200);
    token = loginRes.body.data.accessToken;

    const orgRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Outbox Tenant' });
    expect(orgRes.status).toBe(201);
    orgId = orgRes.body.data.organisation.id;
    createdOrgIds.push(orgId);

    const queueRes = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: queueName, concurrency: 4, defaultPriority: 7 });
    expect(queueRes.status).toBe(201);
    queueId = queueRes.body.data.queue.id;
  }, 30_000);

  afterAll(async () => {
    try {
      const entry = bullMQService.getRegisteredQueue(orgId, queueName);
      if (entry) {
        await entry.queue.obliterate({ force: true });
      }
    } catch {
      // ignore cleanup errors
    }

    await bullMQService.closeAll();

    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }, 30_000);

  it('commits Job + JobDispatchOutbox atomically and marks outbox DISPATCHED on healthy Redis', async () => {
    const res = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'echo', payload: { message: 'hello outbox' } });

    expect(res.status).toBe(201);
    expect(res.body.data.dispatch.enqueued).toBe(true);

    const outbox = await prisma.jobDispatchOutbox.findUnique({
      where: { jobId: res.body.data.job.id },
    });
    expect(outbox).not.toBeNull();
    expect(outbox?.status).toBe(OutboxStatus.DISPATCHED);
    expect(outbox?.dispatchedAt).not.toBeNull();
    expect(outbox?.attempts).toBe(1);
    expect(outbox?.lastError).toBeNull();
  });

  it('keeps outbox PENDING during Redis outage, backs off on retry failure, then reconciles idempotently when Redis recovers', async () => {
    // 1. Simulate Redis outage during submission
    const spy = vi.spyOn(bullMQService, 'enqueueJob').mockResolvedValueOnce({
      broker: 'bullmq',
      enqueued: false,
      deduplicated: false,
      bullmqQueueName: buildBullMQQueueName(orgId, queueName),
      bullmqJobId: null,
      error: 'Simulated Redis outage',
    });

    const res = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'echo', payload: { message: 'recover me' } });

    spy.mockRestore();

    expect(res.status).toBe(201);
    expect(res.body.data.dispatch.enqueued).toBe(false);
    const jobId = res.body.data.job.id;

    // Outbox must remain PENDING with error metadata
    const pendingOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId } });
    expect(pendingOutbox?.status).toBe(OutboxStatus.PENDING);
    expect(pendingOutbox?.attempts).toBe(1);
    expect(pendingOutbox?.lastError).toContain('Simulated Redis outage');

    // Make due immediately for deterministic test
    await prisma.jobDispatchOutbox.update({
      where: { jobId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    // 2. Reconcile while Redis is STILL failing -> stays PENDING with incremented attempts & backoff
    const failingBullMQ = new BullMQService({
      ensureReady: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const failingReconciler = new OutboxReconciler({ bullMQ: failingBullMQ, baseBackoffMs: 500 });
    const failSummary = await failingReconciler.reconcileOnce();

    expect(failSummary.scanned).toBeGreaterThanOrEqual(1);
    expect(failSummary.failed).toBeGreaterThanOrEqual(1);

    const afterFailOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId } });
    expect(afterFailOutbox?.status).toBe(OutboxStatus.PENDING);
    expect(afterFailOutbox?.attempts).toBe(2);
    expect(afterFailOutbox!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // 3. Redis recovers -> make due again and reconcile against real Docker Redis
    await prisma.jobDispatchOutbox.update({
      where: { jobId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    const liveReconciler = new OutboxReconciler({ bullMQ: bullMQService });
    const okSummary = await liveReconciler.reconcileOnce();
    expect(okSummary.dispatched).toBeGreaterThanOrEqual(1);

    const dispatchedOutbox = await prisma.jobDispatchOutbox.findUnique({ where: { jobId } });
    expect(dispatchedOutbox?.status).toBe(OutboxStatus.DISPATCHED);
    expect(dispatchedOutbox?.dispatchedAt).not.toBeNull();
    expect(dispatchedOutbox?.lastError).toBeNull();

    // Confirm job is now present in live Docker Redis
    const reg = bullMQService.getRegisteredQueue(orgId, queueName);
    expect(reg).toBeDefined();
    expect(await reg!.queue.getJob(jobId)).toBeDefined();

    // 4. Idempotency check: even if outbox were replayed, BullMQ deduplicates via stable jobId
    await prisma.jobDispatchOutbox.update({
      where: { jobId },
      data: { status: OutboxStatus.PENDING, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const dupSummary = await liveReconciler.reconcileOnce();
    expect(dupSummary.dispatched).toBe(1);
    expect(dupSummary.deduplicated).toBe(1);
  });

  it('cascades outbox deletion when a pre-execution job is cancelled', async () => {
    const res = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'echo', payload: { message: 'cancel outbox' } });
    const jobId = res.body.data.job.id;

    expect(await prisma.jobDispatchOutbox.findUnique({ where: { jobId } })).not.toBeNull();

    const cancelRes = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelRes.status).toBe(200);

    expect(await prisma.jobDispatchOutbox.findUnique({ where: { jobId } })).toBeNull();
  });

  it('prevents stale/duplicate workers from overwriting terminal COMPLETED or FAILED job states and handles missing jobs safely', async () => {
    const res = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'echo', payload: { message: 'atomic guard' } });
    const jobId = res.body.data.job.id;

    // Missing job returns missing cleanly
    const missing = await jobService.markJobActive(
      orgId,
      '00000000-0000-4000-8000-000000000777',
      1,
    );
    expect(missing.outcome).toBe('missing');

    // Claim ACTIVE
    const active1 = await jobService.markJobActive(orgId, jobId, 1);
    expect(active1.outcome).toBe('activated');

    // Concurrent second worker attempting to claim same ACTIVE job gets already_active
    const active2 = await jobService.markJobActive(orgId, jobId, 1);
    expect(active2.outcome).toBe('already_active');

    // Mark COMPLETED
    const completed = await jobService.markJobCompleted(orgId, jobId, { ok: true }, 1);
    expect(completed.outcome).toBe('updated');

    // Stale worker cannot re-activate or mark FAILED an already-COMPLETED job
    const reactivate = await jobService.markJobActive(orgId, jobId, 2);
    expect(reactivate).toEqual({ outcome: 'already_terminal', status: JobStatus.COMPLETED });

    const overwriteFail = await jobService.markJobFailed(orgId, jobId, 'late error', 2);
    expect(overwriteFail).toEqual({ outcome: 'already_terminal', status: JobStatus.COMPLETED });

    const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(finalJob?.status).toBe(JobStatus.COMPLETED);
    expect(finalJob?.result).toEqual({ ok: true });
    expect(finalJob?.errorMessage).toBeNull();
  });
});

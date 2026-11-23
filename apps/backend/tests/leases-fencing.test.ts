import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobStatus, PlatformEventType } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { jobService } from '../src/services/job.service.js';
import { stalledJobRecoveryService } from '../src/services/stalledJobRecovery.service.js';

describe('Phase 8.1 — Execution Leases, Monotonic Fencing Tokens & API Idempotency', () => {
  const suffix = `p81_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let userId = '';
  let accessToken = '';
  let orgId = '';
  let queue1Id = '';
  let queue2Id = '';

  beforeAll(async () => {
    const email = `p81_${suffix}@pulsequeue.dev`;
    const password = 'SecurePassword123!';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Phase81 Owner', email, password });
    expect(reg.status).toBe(201);
    userId = reg.body.data.user.id;

    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    accessToken = login.body.data.accessToken;

    const org = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `Phase81 Org ${suffix}` });
    expect(org.status).toBe(201);
    orgId = org.body.data.organisation.id;

    const q1 = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `p81-q1-${suffix}` });
    expect(q1.status).toBe(201);
    queue1Id = q1.body.data.queue.id;

    const q2 = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `p81-q2-${suffix}` });
    expect(q2.status).toBe(201);
    queue2Id = q2.body.data.queue.id;
  }, 30_000);

  afterAll(async () => {
    if (orgId) {
      await prisma.platformEvent.deleteMany({ where: { organisationId: orgId } });
      await prisma.deadLetterJob.deleteMany({ where: { organisationId: orgId } });
      await prisma.jobDispatchOutbox.deleteMany({ where: { organisationId: orgId } });
      await prisma.job.deleteMany({ where: { queue: { organisationId: orgId } } });
      await prisma.queue.deleteMany({ where: { organisationId: orgId } });
      await prisma.organisation.deleteMany({ where: { id: orgId } });
    }
    if (userId) {
      await prisma.refreshToken.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await bullMQService.closeAll().catch(() => {});
  }, 30_000);

  it('deduplicates sequential and concurrent job submissions by (queueId, idempotencyKey) via header or body', async () => {
    const key1 = `idem-hdr-${suffix}`;
    const first = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queue1Id}/jobs`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key1)
      .send({ name: 'echo', payload: { message: 'hello' } });
    expect(first.status).toBe(201);
    const firstJobId = first.body.data.job.id;
    expect(first.body.data.job.idempotencyKey).toBe(key1);

    // Replay returns 200 + deduplicated: true + exact same job ID
    const replay = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queue1Id}/jobs`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key1)
      .send({ name: 'echo', payload: { message: 'hello' } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.deduplicated).toBe(true);
    expect(replay.body.data.job.id).toBe(firstJobId);

    // Same key on a DIFFERENT queue creates a distinct job (201)
    const otherQueue = await request(app)
      .post(`/api/v1/organisations/${orgId}/queues/${queue2Id}/jobs`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key1)
      .send({ name: 'echo', payload: { message: 'hello-q2' } });
    expect(otherQueue.status).toBe(201);
    expect(otherQueue.body.data.job.id).not.toBe(firstJobId);

    // 5 concurrent identical submissions with body idempotencyKey produce exactly 1 DB row
    const raceKey = `idem-race-${suffix}`;
    const raceResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/organisations/${orgId}/queues/${queue1Id}/jobs`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: 'echo', payload: { message: 'race' }, idempotencyKey: raceKey }),
      ),
    );
    const ids = new Set(raceResults.map((r) => r.body.data?.job?.id));
    expect(ids.size).toBe(1);
    const dbCount = await prisma.job.count({
      where: { queueId: queue1Id, idempotencyKey: raceKey },
    });
    expect(dbCount).toBe(1);
  });

  it('prevents split-brain terminal overwrites using monotonic fencing tokens after lease expiry', async () => {
    const job = await prisma.job.create({
      data: {
        queueId: queue1Id,
        name: 'echo',
        payload: { message: 'split-brain' },
        status: JobStatus.PENDING,
      },
    });

    // 1. Worker A claims job -> fencingToken = 1
    const actA = await jobService.markJobActive(orgId, job.id, 1, 'worker-A', {
      leaseDurationMs: 5_000,
    });
    expect(actA.outcome).toBe('activated');
    if (actA.outcome !== 'activated') return;
    expect(actA.fencingToken).toBe(1);
    expect(actA.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

    // 2. Simulate Worker A freeze -> lease expires in PostgreSQL
    await prisma.job.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const recovery = await stalledJobRecoveryService.recoverStalledJobs({
      organisationId: orgId,
    });
    expect(recovery.recovered).toBeGreaterThanOrEqual(1);

    const afterRecovery = await prisma.job.findUnique({ where: { id: job.id } });
    expect(afterRecovery?.status).toBe(JobStatus.PENDING);
    expect(afterRecovery?.fencingToken).toBe(2);
    expect(afterRecovery?.leaseExpiresAt).toBeNull();

    // 3. Worker B claims recovered job -> fencingToken = 3
    const actB = await jobService.markJobActive(orgId, job.id, 2, 'worker-B', {
      leaseDurationMs: 30_000,
    });
    expect(actB.outcome).toBe('activated');
    if (actB.outcome !== 'activated') return;
    expect(actB.fencingToken).toBe(3);

    // 4. Worker A wakes up and attempts stale completion, retry, and failure with fencingToken = 1 -> ALL REJECTED
    const staleComplete = await jobService.markJobCompleted(orgId, job.id, { stale: true }, 1, {
      workerId: 'worker-A',
      fencingToken: 1,
      durationMs: 5000,
    });
    expect(staleComplete.outcome).toBe('stale_fencing_token');

    const staleRetry = await jobService.markJobRetryScheduled(orgId, job.id, 'stale err', 1, {
      workerId: 'worker-A',
      fencingToken: 1,
    });
    expect(staleRetry.outcome).toBe('stale_fencing_token');

    const staleFail = await jobService.markJobFailed(orgId, job.id, 'stale fatal', 1, {
      workerId: 'worker-A',
      fencingToken: 1,
      routeToDlq: true,
    });
    expect(staleFail.outcome).toBe('stale_fencing_token');

    // Job must still be ACTIVE owned by Worker B
    const stillActive = await prisma.job.findUnique({ where: { id: job.id } });
    expect(stillActive?.status).toBe(JobStatus.ACTIVE);
    expect(stillActive?.lastWorkerId).toBe('worker-B');

    // 5. Worker B completes with authoritative fencingToken = 3 -> SUCCEEDS
    const validComplete = await jobService.markJobCompleted(
      orgId,
      job.id,
      { authoritative: 'worker-B' },
      2,
      { workerId: 'worker-B', fencingToken: 3, durationMs: 120 },
    );
    expect(validComplete.outcome).toBe('updated');
    if (validComplete.outcome === 'updated') {
      expect(validComplete.job.status).toBe(JobStatus.COMPLETED);
      expect(validComplete.job.leaseExpiresAt).toBeNull();
    }

    // Verify JOB_LEASE_EXPIRED and JOB_FENCING_REJECTED audit events were recorded
    const events = await prisma.platformEvent.findMany({
      where: { organisationId: orgId, jobId: job.id },
      select: { type: true },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain(PlatformEventType.JOB_LEASE_EXPIRED);
    expect(types).toContain(PlatformEventType.JOB_FENCING_REJECTED);
  });

  it('protects long-running jobs from false stall recovery when lease is renewed and rejects stale renewals', async () => {
    const job = await prisma.job.create({
      data: {
        queueId: queue1Id,
        name: 'echo',
        payload: { message: 'long-running' },
        status: JobStatus.PENDING,
      },
    });

    const act = await jobService.markJobActive(orgId, job.id, 1, 'worker-long', {
      leaseDurationMs: 5_000,
    });
    expect(act.outcome).toBe('activated');
    if (act.outcome !== 'activated') return;

    // Backdate startedAt to 2 minutes ago (older than 60s staleActiveThresholdMs),
    // but renew the lease for +60s
    await prisma.job.update({
      where: { id: job.id },
      data: { startedAt: new Date(Date.now() - 120_000) },
    });

    const renewed = await jobService.renewJobLease(
      orgId,
      job.id,
      'worker-long',
      act.fencingToken,
      60_000,
    );
    expect(renewed.renewed).toBe(true);

    // Wrong fencing token or wrong worker cannot renew
    const badToken = await jobService.renewJobLease(
      orgId,
      job.id,
      'worker-long',
      act.fencingToken + 99,
      60_000,
    );
    expect(badToken.renewed).toBe(false);

    const badWorker = await jobService.renewJobLease(
      orgId,
      job.id,
      'worker-impostor',
      act.fencingToken,
      60_000,
    );
    expect(badWorker.renewed).toBe(false);

    // Stalled recovery MUST NOT steal this job because its lease is valid!
    const sweep = await stalledJobRecoveryService.recoverStalledJobs({
      organisationId: orgId,
      staleActiveThresholdMs: 1_000,
    });
    expect(sweep.recovered).toBe(0);

    const stillRunning = await prisma.job.findUnique({ where: { id: job.id } });
    expect(stillRunning?.status).toBe(JobStatus.ACTIVE);
    expect(stillRunning?.stalledCount).toBe(0);
  });
});

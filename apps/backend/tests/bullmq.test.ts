import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Queue as BullMQQueue } from 'bullmq';
import type { Redis } from 'ioredis';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import {
  parseRedisConnectionOptions,
  sanitizeRedisUrl,
  buildBullMQRedisOptions,
} from '../src/config/redis.js';
import {
  BullMQService,
  bullMQService,
  buildBullMQQueueName,
  mapPriorityToBullMQ,
  mapQueueConfigToBullMQ,
  mapJobOptionsToBullMQ,
  type BullMQJobPayload,
  type PersistedQueueDescriptor,
  type PersistedJobDescriptor,
} from '../src/services/bullmq.service.js';

describe('BullMQ & Redis Integration (Step 4.1)', () => {
  const sampleQueueA: PersistedQueueDescriptor = {
    id: '11111111-1111-4111-8111-111111111111',
    organisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'emails',
    isPaused: false,
    concurrency: 12,
    defaultPriority: 10,
    maxRetries: 4,
    backoffMs: 2500,
  };

  const sampleQueueB: PersistedQueueDescriptor = {
    ...sampleQueueA,
    id: '22222222-2222-4222-8222-222222222222',
    organisationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };

  // ─── 1. Redis Connection Configuration & Credential Sanitization ──────────

  describe('Redis Connection Configuration', () => {
    it('parses standard, authenticated, and TLS REDIS_URL values cleanly', () => {
      expect(parseRedisConnectionOptions('redis://localhost:6379')).toEqual({
        host: 'localhost',
        port: 6379,
        db: 0,
      });

      expect(parseRedisConnectionOptions('rediss://admin:s3cr3t@redis.internal:6380/2')).toEqual({
        host: 'redis.internal',
        port: 6380,
        db: 2,
        username: 'admin',
        password: 's3cr3t',
        tls: {},
      });
    });

    it('rejects unsupported Redis URL protocols or invalid DB indexes', () => {
      expect(() => parseRedisConnectionOptions('http://localhost:6379')).toThrow(
        'Unsupported Redis protocol',
      );
      expect(() => parseRedisConnectionOptions('redis://localhost:6379/notanumber')).toThrow(
        'Invalid Redis database index',
      );
    });

    it('masks Redis credentials in sanitized URLs for safe logging', () => {
      const sanitized = sanitizeRedisUrl('redis://pulseuser:supersecret@127.0.0.1:6379/1');
      expect(sanitized).not.toContain('supersecret');
      expect(sanitized).not.toContain('pulseuser');
      expect(sanitized).toContain('127.0.0.1:6379');
      expect(sanitizeRedisUrl('not-a-url')).toBe('[invalid-redis-url]');
    });

    it('builds BullMQ-compatible Redis options with maxRetriesPerRequest: null', () => {
      const opts = buildBullMQRedisOptions('redis://localhost:6379');
      expect(opts.maxRetriesPerRequest).toBeNull();
      expect(opts.lazyConnect).toBe(true);
      expect(opts.host).toBe('localhost');
      expect(opts.port).toBe(6379);
    });
  });

  // ─── 2. Queue Naming & Configuration Mapping ──────────────────────────────

  describe('Queue Naming & Configuration Mapping', () => {
    it('generates deterministic, organisation-scoped, colon-free BullMQ queue names', () => {
      const nameA = buildBullMQQueueName(sampleQueueA.organisationId, sampleQueueA.name);
      const nameB = buildBullMQQueueName(sampleQueueB.organisationId, sampleQueueB.name);

      expect(nameA).toBe(`org_${sampleQueueA.organisationId}__emails`);
      expect(nameA).not.toContain(':');
      expect(nameA).not.toBe(nameB); // Same logical name in different orgs is isolated

      expect(() => buildBullMQQueueName('org:bad', 'emails')).toThrow('must not contain ":"');
      expect(() => buildBullMQQueueName(sampleQueueA.organisationId, 'bad:name')).toThrow(
        'must not contain ":"',
      );
    });

    it('inverts PulseQueue priority (higher=more urgent) to BullMQ priority (lower=more urgent)', () => {
      expect(mapPriorityToBullMQ(20)).toBe(1); // CRITICAL -> highest BullMQ priority
      expect(mapPriorityToBullMQ(10)).toBe(11); // HIGH
      expect(mapPriorityToBullMQ(5)).toBe(16); // NORMAL
      expect(mapPriorityToBullMQ(1)).toBe(20); // LOW -> lowest BullMQ priority
      // Clamping guard
      expect(mapPriorityToBullMQ(999)).toBe(1);
      expect(mapPriorityToBullMQ(-5)).toBe(20);
    });

    it('maps persisted queue concurrency, defaultPriority, maxRetries, and backoffMs accurately', () => {
      const mapped = mapQueueConfigToBullMQ(sampleQueueA);

      expect(mapped.bullmqQueueName).toBe(`org_${sampleQueueA.organisationId}__emails`);
      expect(mapped.workerOptions.concurrency).toBe(12);
      expect(mapped.defaultJobOptions.priority).toBe(11);
      expect(mapped.defaultJobOptions.attempts).toBe(5); // 1 initial + 4 retries
      expect(mapped.defaultJobOptions.backoff).toEqual({
        type: 'exponential',
        delay: 2500,
      });

      const zeroBackoff = mapQueueConfigToBullMQ({
        ...sampleQueueA,
        maxRetries: 0,
        backoffMs: 0,
      });
      expect(zeroBackoff.defaultJobOptions.attempts).toBe(1);
      expect(zeroBackoff.defaultJobOptions.backoff).toBeUndefined();
    });

    it('maps persisted job fields to BullMQ JobsOptions with stable jobId', () => {
      const job: PersistedJobDescriptor = {
        id: '33333333-3333-4333-8333-333333333333',
        queueId: sampleQueueA.id,
        name: 'send-welcome',
        priority: 20,
        payload: { userId: 'u1' },
        maxRetries: 3,
        backoffMs: 1500,
        delayMs: 10_000,
      };

      const opts = mapJobOptionsToBullMQ(job);
      expect(opts.jobId).toBe(job.id);
      expect(opts.priority).toBe(1);
      expect(opts.attempts).toBe(4);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1500 });
      expect(opts.delay).toBe(10_000);
    });
  });

  // ─── 3. Deduplicated Registration, Failure Handling & Graceful Shutdown ───

  describe('Registration Deduplication, Redis Failure Handling & Shutdown (Mocked)', () => {
    it('prevents duplicate BullMQ queue registration and reuses a single Redis connection', () => {
      const fakeConn = { status: 'ready' } as unknown as Redis;
      const getConnection = vi.fn(() => fakeConn);
      const createQueue = vi.fn(
        () =>
          ({
            on: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as BullMQQueue<BullMQJobPayload>,
      );

      const service = new BullMQService({
        getConnection,
        ensureReady: vi.fn().mockResolvedValue(undefined),
        disconnectConnection: vi.fn().mockResolvedValue(undefined),
        createQueue,
      });

      const first = service.getOrRegisterQueue(sampleQueueA);
      const second = service.getOrRegisterQueue({ ...sampleQueueA, concurrency: 30 });
      const otherOrg = service.getOrRegisterQueue(sampleQueueB);

      expect(first).toBe(second);
      expect(first.config.workerOptions.concurrency).toBe(30); // refreshed metadata
      expect(otherOrg).not.toBe(first);
      expect(createQueue).toHaveBeenCalledTimes(2); // only once per distinct org+queue
      expect(getConnection).toHaveBeenCalledTimes(2); // both share same fakeConn
      expect(service.listRegisteredQueueNames()).toHaveLength(2);
    });

    it('handles Redis outages gracefully without throwing or losing persisted job context', async () => {
      const service = new BullMQService({
        getConnection: () => ({ status: 'close' }) as unknown as Redis,
        ensureReady: vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
        disconnectConnection: vi.fn().mockResolvedValue(undefined),
      });

      const job: PersistedJobDescriptor = {
        id: '44444444-4444-4444-8444-444444444444',
        queueId: sampleQueueA.id,
        name: 'resilient-job',
        priority: 5,
        payload: { important: true },
        maxRetries: 3,
        backoffMs: 1000,
        delayMs: 0,
      };

      const enqueueRes = await service.enqueueJob(sampleQueueA, job);
      expect(enqueueRes.enqueued).toBe(false);
      expect(enqueueRes.deduplicated).toBe(false);
      expect(enqueueRes.bullmqJobId).toBeNull();
      expect(enqueueRes.error).toContain('ECONNREFUSED');

      const pauseRes = await service.syncQueuePauseState({ ...sampleQueueA, isPaused: true });
      expect(pauseRes.synced).toBe(false);
      expect(pauseRes.error).toContain('ECONNREFUSED');

      const removed = await service.removeJobFromBullMQ(sampleQueueA, job.id);
      expect(removed).toBe(false);
    });

    it('gracefully closes all registered queues and disconnects the shared Redis connection', async () => {
      const closeOk = vi.fn().mockResolvedValue(undefined);
      const closeFail = vi.fn().mockRejectedValue(new Error('already closed'));
      const disconnectConnection = vi.fn().mockResolvedValue(undefined);

      let idx = 0;
      const service = new BullMQService({
        getConnection: () => ({ status: 'ready' }) as unknown as Redis,
        ensureReady: vi.fn().mockResolvedValue(undefined),
        disconnectConnection,
        createQueue: () =>
          ({
            on: vi.fn(),
            close: idx++ === 0 ? closeOk : closeFail,
          }) as unknown as BullMQQueue<BullMQJobPayload>,
      });

      service.getOrRegisterQueue(sampleQueueA);
      service.getOrRegisterQueue(sampleQueueB);
      expect(service.listRegisteredQueueNames()).toHaveLength(2);

      await service.closeAll();

      expect(closeOk).toHaveBeenCalledTimes(1);
      expect(closeFail).toHaveBeenCalledTimes(1);
      expect(disconnectConnection).toHaveBeenCalledTimes(1);
      expect(service.listRegisteredQueueNames()).toHaveLength(0);
    });
  });

  // ─── 4. Live Docker Redis Integration & End-to-End API Flow ───────────────

  describe('Live Docker Redis & End-to-End API Integration', () => {
    const liveService = new BullMQService();
    const liveQueueDesc: PersistedQueueDescriptor = {
      id: crypto.randomUUID(),
      organisationId: crypto.randomUUID(),
      name: `live-int-${Date.now()}`,
      isPaused: false,
      concurrency: 8,
      defaultPriority: 10,
      maxRetries: 3,
      backoffMs: 1200,
    };

    const createdOrgIds: string[] = [];
    const createdUserIds: string[] = [];

    afterAll(async () => {
      // Obliterate temporary Redis keys for our live test queue before closing
      try {
        const entry = liveService.getRegisteredQueue(
          liveQueueDesc.organisationId,
          liveQueueDesc.name,
        );
        if (entry) {
          await entry.queue.obliterate({ force: true });
        }
      } catch {
        // Ignore cleanup errors
      }

      await liveService.closeAll();
      await bullMQService.closeAll();

      if (createdOrgIds.length > 0) {
        await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
    }, 30_000);

    it('enqueues persisted jobs to live Docker Redis, prevents duplicates via stable jobId, syncs pause/resume, and removes cancelled jobs', async () => {
      const jobId = crypto.randomUUID();
      const jobDesc: PersistedJobDescriptor = {
        id: jobId,
        queueId: liveQueueDesc.id,
        name: 'send-digest',
        priority: 18,
        payload: { recipient: 'ops@pulsequeue.dev' },
        maxRetries: 4,
        backoffMs: 2000,
        delayMs: 0,
      };

      // 1. Enqueue job
      const firstEnqueue = await liveService.enqueueJob(liveQueueDesc, jobDesc);
      expect(firstEnqueue.enqueued).toBe(true);
      expect(firstEnqueue.deduplicated).toBe(false);
      expect(firstEnqueue.bullmqJobId).toBe(jobId);

      // Verify job exists directly in live Docker Redis via BullMQ Queue
      const registered = liveService.getRegisteredQueue(
        liveQueueDesc.organisationId,
        liveQueueDesc.name,
      );
      expect(registered).toBeDefined();

      const redisJob = await registered!.queue.getJob(jobId);
      expect(redisJob).toBeDefined();
      expect(redisJob?.id).toBe(jobId);
      expect(redisJob?.data.organisationId).toBe(liveQueueDesc.organisationId);
      expect(redisJob?.data.payload).toEqual({ recipient: 'ops@pulsequeue.dev' });
      expect(redisJob?.opts.priority).toBe(mapPriorityToBullMQ(18));
      expect(redisJob?.opts.attempts).toBe(5);

      // 2. Duplicate enqueue attempt with the same jobId must NOT create a duplicate BullMQ job
      const dupEnqueue = await liveService.enqueueJob(liveQueueDesc, jobDesc);
      expect(dupEnqueue.enqueued).toBe(true);
      expect(dupEnqueue.deduplicated).toBe(true);
      expect(dupEnqueue.bullmqJobId).toBe(jobId);

      const waitingCount = await registered!.queue.getWaitingCount();
      const prioritizedCount = await registered!.queue.getPrioritizedCount();
      expect(waitingCount + prioritizedCount).toBe(1);

      // 3. Delayed job lands in Redis delayed state
      const delayedJobId = crypto.randomUUID();
      const delayedRes = await liveService.enqueueJob(liveQueueDesc, {
        ...jobDesc,
        id: delayedJobId,
        name: 'delayed-reminder',
        delayMs: 60_000,
      });
      expect(delayedRes.enqueued).toBe(true);
      const redisDelayed = await registered!.queue.getJob(delayedJobId);
      expect(await redisDelayed?.getState()).toBe('delayed');

      // 4. Pause & resume synchronization with live Redis
      const pausedSync = await liveService.syncQueuePauseState({
        ...liveQueueDesc,
        isPaused: true,
      });
      expect(pausedSync.synced).toBe(true);
      expect(await registered!.queue.isPaused()).toBe(true);

      const resumedSync = await liveService.syncQueuePauseState({
        ...liveQueueDesc,
        isPaused: false,
      });
      expect(resumedSync.synced).toBe(true);
      expect(await registered!.queue.isPaused()).toBe(false);

      // 5. Removing cancelled job cleans it up from live Redis
      const removed = await liveService.removeJobFromBullMQ(liveQueueDesc, jobId);
      expect(removed).toBe(true);
      expect(await registered!.queue.getJob(jobId)).toBeUndefined();

      await liveService.removeJobFromBullMQ(liveQueueDesc, delayedJobId);
    }, 15_000);

    it('persists job in PostgreSQL (status stays PENDING), dispatches to BullMQ via HTTP API, and survives simulated Redis outage without losing the job', async () => {
      const suffix = `bmq_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const email = `bmq_owner_${suffix}@pulsequeue.dev`;
      const password = 'SecurePassword123!';

      const regRes = await request(app)
        .post('/api/v1/auth/register')
        .send({ name: 'BullMQ Owner', email, password });
      expect(regRes.status).toBe(201);
      createdUserIds.push(regRes.body.data.user.id);

      const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
      expect(loginRes.status).toBe(200);
      const token = loginRes.body.data.accessToken;

      const orgRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'BullMQ Live Tenant' });
      expect(orgRes.status).toBe(201);
      const orgId = orgRes.body.data.organisation.id;
      createdOrgIds.push(orgId);

      const queueRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'live-dispatch', concurrency: 6, defaultPriority: 8 });
      expect(queueRes.status).toBe(201);
      const queueId = queueRes.body.data.queue.id;

      // Normal HTTP submission: persisted in PG as PENDING + enqueued in live BullMQ
      const jobRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'sync-ledger', payload: { batch: 7 } });

      expect(jobRes.status).toBe(201);
      expect(jobRes.body.data.job.status).toBe('PENDING'); // Never marked ACTIVE or COMPLETED
      expect(jobRes.body.data.dispatch.broker).toBe('bullmq');
      expect(jobRes.body.data.dispatch.enqueued).toBe(true);
      expect(jobRes.body.data.dispatch.bullmqJobId).toBe(jobRes.body.data.job.id);

      const submittedJobId = jobRes.body.data.job.id;

      // Confirm job exists in live BullMQ Redis queue
      const regEntry = bullMQService.getRegisteredQueue(orgId, 'live-dispatch');
      expect(regEntry).toBeDefined();
      expect(await regEntry!.queue.getJob(submittedJobId)).toBeDefined();

      // Cancelling via HTTP removes job from BOTH PostgreSQL and live Redis
      const cancelRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs/${submittedJobId}/cancel`)
        .set('Authorization', `Bearer ${token}`);
      expect(cancelRes.status).toBe(200);
      expect(await regEntry!.queue.getJob(submittedJobId)).toBeUndefined();

      // Simulate Redis outage during HTTP job submission -> job MUST remain durably persisted in PostgreSQL
      const spy = vi.spyOn(bullMQService, 'enqueueJob').mockResolvedValueOnce({
        broker: 'bullmq',
        enqueued: false,
        deduplicated: false,
        bullmqQueueName: buildBullMQQueueName(orgId, 'live-dispatch'),
        bullmqJobId: null,
        error: 'Simulated Redis outage',
      });

      const outageJobRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues/${queueId}/jobs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'outage-resilient-job', payload: { retryLater: true } });

      spy.mockRestore();

      expect(outageJobRes.status).toBe(201);
      expect(outageJobRes.body.data.job.status).toBe('PENDING');
      expect(outageJobRes.body.data.dispatch.enqueued).toBe(false);
      expect(outageJobRes.body.data.dispatch.error).toBe('Simulated Redis outage');

      // Verify the job was NOT lost in PostgreSQL
      const persisted = await prisma.job.findUnique({
        where: { id: outageJobRes.body.data.job.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe('PENDING');

      // Clean up Redis keys for this test queue
      await regEntry!.queue.obliterate({ force: true });
      await bullMQService.unregisterQueue(orgId, 'live-dispatch');
    }, 30_000);
  });
});

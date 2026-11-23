import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  JobStatus,
  OutboxStatus,
  ScheduleExecutionStatus,
  ScheduleStatus,
  ScheduleType,
} from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService, BullMQService } from '../src/services/bullmq.service.js';
import { ScheduleDispatcherService } from '../src/services/scheduleDispatcher.service.js';
import { OutboxReconciler } from '../src/services/outboxReconciler.service.js';
import {
  computeNextCronRun,
  computeUpcomingCronRuns,
  formatInTimezone,
  isValidTimezone,
  parseScheduledTimestamp,
  validateCronExpression,
} from '../src/utils/scheduleTime.js';

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

async function createAndLoginUser(prefix: string, suffix: string): Promise<TestUser> {
  const email = `${prefix}_${suffix}@pulsequeue.dev`;
  const password = 'SecurePassword123!';
  const regRes = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: `${prefix.toUpperCase()} User`, email, password });
  expect(regRes.status).toBe(201);

  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(loginRes.status).toBe(200);

  return {
    id: regRes.body.data.user.id,
    email: email.toLowerCase(),
    accessToken: loginRes.body.data.accessToken,
  };
}

describe('Advanced Job Scheduling — One-Time, Recurring, Timezones & Reliability (Step 5.1)', () => {
  const suffix = `sched_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  const queueAName = `sched-alpha-${Date.now()}`;
  const queueBName = `sched-beta-${Date.now()}`;

  let oneTimeScheduleId = '';
  let recurringScheduleId = '';
  let orgBScheduleId = '';

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ownerA = await createAndLoginUser('s_owner_a', suffix);
    adminA = await createAndLoginUser('s_admin_a', suffix);
    memberA = await createAndLoginUser('s_member_a', suffix);
    ownerB = await createAndLoginUser('s_owner_b', suffix);
    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Schedule Tenant Alpha' });
    orgAId = orgARes.body.data.organisation.id;
    createdOrgIds.push(orgAId);

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Schedule Tenant Beta' });
    orgBId = orgBRes.body.data.organisation.id;
    createdOrgIds.push(orgBId);

    // Add adminA (ADMIN) and memberA (MEMBER) to Org A
    for (const [user, role] of [
      [adminA, 'ADMIN'],
      [memberA, 'MEMBER'],
    ] as const) {
      const inv = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: user.email, role });
      await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ token: inv.body.data.token });
    }

    const qARes = await request(app)
      .post(`/api/v1/organisations/${orgAId}/queues`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        name: queueAName,
        concurrency: 4,
        defaultPriority: 9,
        maxRetries: 2,
        backoffMs: 100,
      });
    queueAId = qARes.body.data.queue.id;

    const qBRes = await request(app)
      .post(`/api/v1/organisations/${orgBId}/queues`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: queueBName, concurrency: 2 });
    queueBId = qBRes.body.data.queue.id;
  }, 60_000);

  afterAll(async () => {
    for (const [orgId, qName] of [
      [orgAId, queueAName],
      [orgBId, queueBName],
    ]) {
      try {
        const reg = bullMQService.getRegisteredQueue(orgId, qName);
        if (reg) await reg.queue.obliterate({ force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    await bullMQService.closeAll();

    if (createdOrgIds.length > 0) {
      await prisma.platformEvent.deleteMany({ where: { organisationId: { in: createdOrgIds } } });
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }, 30_000);

  // ─── 1. Timezone, Cron & DST Edge-Case Utilities ──────────────────────────

  describe('Timezone Conversion, Cron Validation & DST Edge Cases', () => {
    it('validates IANA timezones and converts wall-clock local times accurately to canonical UTC', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Asia/Kolkata')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Mars/Olympus')).toBe(false);
      expect(isValidTimezone('')).toBe(false);

      const refNow = new Date('2027-01-01T00:00:00.000Z');
      // 16:00 IST (+05:30) == 10:30 UTC
      const utcFromWall = parseScheduledTimestamp('2027-01-15T16:00:00', 'Asia/Kolkata', refNow);
      expect(utcFromWall.toISOString()).toBe('2027-01-15T10:30:00.000Z');
      expect(formatInTimezone(utcFromWall, 'Asia/Kolkata')).toBe('2027-01-15T16:00:00.000+05:30');

      // Explicit offset ISO input
      const utcFromIso = parseScheduledTimestamp('2027-01-15T16:00:00+05:30', 'UTC', refNow);
      expect(utcFromIso.toISOString()).toBe('2027-01-15T10:30:00.000Z');

      // Past timestamp rejected
      expect(() => parseScheduledTimestamp('2026-12-31T23:59:59Z', 'UTC', refNow)).toThrow(
        'must be in the future',
      );
    });

    it('handles DST spring-forward nonexistent times and fall-back ambiguous times safely', () => {
      const refNow = new Date('2027-01-01T00:00:00.000Z');

      // 2027-03-14 02:30 does NOT exist in America/New_York (spring-forward skips 02:00 -> 03:00)
      expect(() =>
        parseScheduledTimestamp('2027-03-14T02:30:00', 'America/New_York', refNow),
      ).toThrow('daylight-saving spring-forward');

      // 2027-11-07 01:30 occurs twice in America/New_York (EDT -04:00 then EST -05:00).
      // Un-offset wall-clock deterministically resolves via Luxon to standard time (EST -05:00 => 06:30 UTC).
      const ambiguousUtc = parseScheduledTimestamp(
        '2027-11-07T01:30:00',
        'America/New_York',
        refNow,
      );
      expect(ambiguousUtc.toISOString()).toBe('2027-11-07T06:30:00.000Z');

      // Explicit offset selects the earlier daylight-saving occurrence (EDT -04:00 => 05:30 UTC).
      const explicitEdtUtc = parseScheduledTimestamp(
        '2027-11-07T01:30:00-04:00',
        'America/New_York',
        refNow,
      );
      expect(explicitEdtUtc.toISOString()).toBe('2027-11-07T05:30:00.000Z');

      // Recurring cron across DST spring-forward computes valid future UTC timestamp
      const afterDst = computeNextCronRun(
        '30 2 * * *',
        'America/New_York',
        new Date('2027-03-14T05:00:00.000Z'),
      );
      expect(afterDst.getTime()).toBeGreaterThan(new Date('2027-03-14T05:00:00.000Z').getTime());
    });

    it('validates standard, predefined, and custom cron expressions and computes upcoming runs', () => {
      expect(() => validateCronExpression('@hourly', 'UTC')).not.toThrow();
      expect(() => validateCronExpression('@daily', 'Asia/Kolkata')).not.toThrow();
      expect(() => validateCronExpression('@weekly', 'America/New_York')).not.toThrow();
      expect(() => validateCronExpression('0 9 * * 1-5', 'Asia/Kolkata')).not.toThrow();
      expect(() => validateCronExpression('*/2 * * * * *', 'UTC')).not.toThrow();

      expect(() => validateCronExpression('invalid cron', 'UTC')).toThrow(
        'Invalid cron expression',
      );
      expect(() => validateCronExpression('99 * * * *', 'UTC')).toThrow('Invalid cron expression');

      const upcoming = computeUpcomingCronRuns(
        '0 * * * *',
        'UTC',
        3,
        new Date('2027-01-01T00:05:00Z'),
      );
      expect(upcoming).toHaveLength(3);
      expect(upcoming[0].toISOString()).toBe('2027-01-01T01:00:00.000Z');
      expect(upcoming[1].toISOString()).toBe('2027-01-01T02:00:00.000Z');
      expect(upcoming[2].toISOString()).toBe('2027-01-01T03:00:00.000Z');
    });
  });

  // ─── 2. One-Time Schedule API & Lifecycle ─────────────────────────────────

  describe('One-Time Scheduling API & Pause/Resume/Cancel', () => {
    it('creates near-term and far-future timezone-aware ONE_TIME schedules, persists UTC + delayed Job + Outbox, and handles pause/resume/cancel', async () => {
      // Near-term wall-clock time (10 minutes ahead in Asia/Kolkata, rounded to whole seconds)
      const targetUtc = new Date(Math.floor((Date.now() + 10 * 60 * 1000) / 1000) * 1000);
      const localIsoWithOffset = formatInTimezone(targetUtc, 'Asia/Kolkata'); // e.g. 2026-11-23T10:30:00.000+05:30
      const nearWallClock = localIsoWithOffset.slice(0, 19); // strip ".000+05:30"

      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Q2-Report-Once',
          description: 'Generate quarterly report once',
          type: ScheduleType.ONE_TIME,
          jobName: 'echo',
          payload: { message: 'quarterly report' },
          timezone: 'Asia/Kolkata',
          runAt: nearWallClock,
        });

      expect(res.status).toBe(201);
      const { schedule, initialJobId, dispatch } = res.body.data;
      expect(schedule.type).toBe(ScheduleType.ONE_TIME);
      expect(schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(schedule.timezone).toBe('Asia/Kolkata');
      expect(schedule.runAt).toBe(targetUtc.toISOString());
      expect(schedule.nextRunAtLocal).toBe(localIsoWithOffset);
      expect(initialJobId).toBeDefined();
      expect(dispatch.enqueued).toBe(true);

      oneTimeScheduleId = schedule.id;

      // Verify delayed Job exists in PostgreSQL + BullMQ Redis
      const pgJob = await prisma.job.findUnique({ where: { id: initialJobId } });
      expect(pgJob?.status).toBe(JobStatus.DELAYED);
      expect(pgJob?.priority).toBe(9); // inherited from queueA

      const reg = bullMQService.getRegisteredQueue(orgAId, queueAName);
      expect(await reg!.queue.getJob(initialJobId)).toBeDefined();

      // Pause removes pending delayed job so it cannot fire while paused
      const pauseRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${oneTimeScheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.schedule.status).toBe(ScheduleStatus.PAUSED);
      expect(pauseRes.body.data.schedule.nextRunAt).toBeNull();
      expect(await reg!.queue.getJob(initialJobId)).toBeUndefined();

      // Resume re-schedules the future one-time execution cleanly
      const resumeRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${oneTimeScheduleId}/resume`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.schedule.status).toBe(ScheduleStatus.ACTIVE);
      expect(resumeRes.body.data.schedule.nextRunAt).toBe(targetUtc.toISOString());

      // Cancel permanently cancels and removes the pending job
      const cancelRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${oneTimeScheduleId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.schedule.status).toBe(ScheduleStatus.CANCELLED);

      // Far-future ONE_TIME schedule (> 24h, e.g. 2028) persists cleanly without INT4 delay_ms overflow
      const farRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Far-Future-2028-Once',
          type: ScheduleType.ONE_TIME,
          jobName: 'echo',
          payload: { message: 'far future' },
          timezone: 'Asia/Kolkata',
          runAt: '2028-06-15T16:00:00',
        });

      expect(farRes.status).toBe(201);
      expect(farRes.body.data.schedule.runAt).toBe('2028-06-15T10:30:00.000Z');
      expect(farRes.body.data.schedule.nextRunAtLocal).toBe('2028-06-15T16:00:00.000+05:30');
      expect(farRes.body.data.initialJobId).toBeUndefined();

      // When time reaches the 60s lookahead window, two racing ScheduleDispatcherService instances materialize it strictly once
      const farScheduleId = farRes.body.data.schedule.id;
      const farDispatcher1 = new ScheduleDispatcherService();
      const farDispatcher2 = new ScheduleDispatcherService();
      const simNow = new Date('2028-06-15T10:29:45.000Z');
      const [t1, t2] = await Promise.all([
        farDispatcher1.tick(simNow, { organisationId: orgAId }),
        farDispatcher2.tick(simNow, { organisationId: orgAId }),
      ]);
      expect(t1.dispatched + t2.dispatched).toBe(1);

      const farExecs = await prisma.scheduleExecution.findMany({
        where: { scheduleId: farScheduleId },
      });
      expect(farExecs).toHaveLength(1);
      expect(farExecs[0].jobId).toBeTruthy();

      // Cancel far-future schedule cleanly so it doesn't interfere with subsequent tests
      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${farScheduleId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });

    it('rejects past timestamps, nonexistent DST times, and invalid cron inputs (400)', async () => {
      const badRequests = [
        {
          queueId: queueAId,
          name: 'Past-Once',
          type: ScheduleType.ONE_TIME,
          jobName: 'echo',
          runAt: '2020-01-01T00:00:00Z',
        },
        {
          queueId: queueAId,
          name: 'DST-Gap',
          type: ScheduleType.ONE_TIME,
          jobName: 'echo',
          timezone: 'America/New_York',
          runAt: '2027-03-14T02:30:00',
        },
        {
          queueId: queueAId,
          name: 'Bad-Cron',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          cronExpression: 'not valid cron',
        },
        {
          queueId: queueAId,
          name: 'Bad-TZ',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          cronExpression: '@hourly',
          timezone: 'Invalid/Timezone',
        },
      ];

      for (const body of badRequests) {
        const res = await request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules`)
          .set('Authorization', `Bearer ${adminA.accessToken}`)
          .send(body);
        expect(res.status).toBe(400);
      }
    });
  });

  // ─── 3. Recurring Schedules, Concurrency, Overlap & Redis Outage Recovery ─

  describe('Recurring Schedules, Concurrent Dispatchers, Overlap & Outage Recovery', () => {
    it('creates a recurring schedule, previews next-run, prevents duplicates across concurrent schedulers, enforces preventOverlap, and survives Redis outage via outbox', async () => {
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Hourly-Metrics-Rollup',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'hourly rollup' },
          cronExpression: '0 * * * *',
          timezone: 'Asia/Kolkata',
          preventOverlap: true,
        });

      expect(createRes.status).toBe(201);
      recurringScheduleId = createRes.body.data.schedule.id;

      // Preview next-run endpoint (MEMBER allowed)
      const nextRunRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}/next-run`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(nextRunRes.status).toBe(200);
      expect(nextRunRes.body.data.nextRun.upcomingRuns).toHaveLength(5);
      expect(nextRunRes.body.data.nextRun.timezone).toBe('Asia/Kolkata');

      // Force schedule due now and race TWO concurrent ScheduleDispatcherService instances
      const dueTime = new Date(Date.now() - 5_000);
      await prisma.schedule.update({
        where: { id: recurringScheduleId },
        data: { nextRunAt: dueTime },
      });

      const dispatcher1 = new ScheduleDispatcherService();
      const dispatcher2 = new ScheduleDispatcherService();

      const [sum1, sum2] = await Promise.all([
        dispatcher1.tick(new Date(), { organisationId: orgAId }),
        dispatcher2.tick(new Date(), { organisationId: orgAId }),
      ]);
      // Strictly ONE occurrence created despite two racing schedulers!
      expect(sum1.dispatched + sum2.dispatched).toBe(1);
      expect(sum1.skippedContention + sum2.skippedContention).toBeGreaterThanOrEqual(0);

      const execsAfter1 = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}/executions`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(execsAfter1.status).toBe(200);
      expect(execsAfter1.body.data.executions).toHaveLength(1);
      expect(execsAfter1.body.data.executions[0].status).toBe(ScheduleExecutionStatus.DISPATCHED);
      const firstJobId = execsAfter1.body.data.executions[0].jobId;

      // Overlap protection: prior job is still PENDING -> next due tick MUST skip with SKIPPED_OVERLAP
      const dueTime2 = new Date(Date.now() - 3_000);
      await prisma.schedule.update({
        where: { id: recurringScheduleId },
        data: { nextRunAt: dueTime2 },
      });

      const overlapSummary = await dispatcher1.tick(new Date(), { organisationId: orgAId });
      expect(overlapSummary.skippedOverlap).toBe(1);
      expect(overlapSummary.dispatched).toBe(0);

      const execsAfterOverlap = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}/executions`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(execsAfterOverlap.body.data.executions).toHaveLength(2);
      expect(execsAfterOverlap.body.data.executions[0].status).toBe(
        ScheduleExecutionStatus.SKIPPED_OVERLAP,
      );

      // Complete prior job so next occurrence can dispatch during a simulated Redis outage
      await prisma.job.update({
        where: { id: firstJobId },
        data: { status: JobStatus.COMPLETED, completedAt: new Date() },
      });

      const dueTime3 = new Date(Date.now() - 1_000);
      await prisma.schedule.update({
        where: { id: recurringScheduleId },
        data: { nextRunAt: dueTime3 },
      });

      const failingBullMQ = new BullMQService({
        ensureReady: vi.fn().mockRejectedValue(new Error('ECONNREFUSED Redis down')),
      });
      const outageDispatcher = new ScheduleDispatcherService({ bullMQ: failingBullMQ });
      const outageSummary = await outageDispatcher.tick(new Date(), { organisationId: orgAId });
      expect(outageSummary.outboxDeferred).toBe(1);

      // Verify occurrence job & PENDING outbox survived the Redis outage
      const execsAfterOutage = await prisma.scheduleExecution.findMany({
        where: { scheduleId: recurringScheduleId },
        orderBy: { createdAt: 'desc' },
      });
      const outageJobId = execsAfterOutage[0].jobId!;
      const pendingOutbox = await prisma.jobDispatchOutbox.findUnique({
        where: { jobId: outageJobId },
      });
      expect(pendingOutbox?.status).toBe(OutboxStatus.PENDING);

      // Redis recovers -> OutboxReconciler dispatches idempotently
      await prisma.jobDispatchOutbox.update({
        where: { jobId: outageJobId },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      const reconciler = new OutboxReconciler({ bullMQ: bullMQService });
      const recSummary = await reconciler.reconcileOnce();
      expect(recSummary.dispatched).toBeGreaterThanOrEqual(1);

      const dispatchedOutbox = await prisma.jobDispatchOutbox.findUnique({
        where: { jobId: outageJobId },
      });
      expect(dispatchedOutbox?.status).toBe(OutboxStatus.DISPATCHED);

      // Pause recurring schedule -> due tick produces ZERO occurrences
      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      const pausedTick = await dispatcher1.tick(new Date(), { organisationId: orgAId });
      expect(pausedTick.dispatched).toBe(0);

      // Update cron expression while paused, then resume
      const updateRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ cronExpression: '@daily', description: 'Updated to daily' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.schedule.cronExpression).toBe('@daily');
    });
  });

  // ─── 4. RBAC & Strict Cross-Tenant Isolation ──────────────────────────────

  describe('RBAC & Strict Multi-Tenant Isolation', () => {
    it('enforces 401 unauthenticated, MEMBER read-only (403 writes), ADMIN no-delete (403), and cross-tenant 404 isolation', async () => {
      // Seed a schedule in Org B
      const orgBRes = await request(app)
        .post(`/api/v1/organisations/${orgBId}/schedules`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({
          queueId: queueBId,
          name: 'OrgB-Daily',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          cronExpression: '@daily',
        });
      expect(orgBRes.status).toBe(201);
      orgBScheduleId = orgBRes.body.data.schedule.id;

      // Unauthenticated -> 401
      const unauth = await request(app).get(`/api/v1/organisations/${orgAId}/schedules`);
      expect(unauth.status).toBe(401);

      // MEMBER can list/get, forbidden from creating/updating/pausing/cancelling/deleting (403)
      const memberList = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberList.status).toBe(200);

      for (const reqPromise of [
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
          .send({
            queueId: queueAId,
            name: 'Member-Blocked',
            type: ScheduleType.RECURRING,
            jobName: 'echo',
            cronExpression: '@hourly',
          }),
        request(app)
          .patch(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}`)
          .set('Authorization', `Bearer ${memberA.accessToken}`)
          .send({ description: 'nope' }),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}/pause`)
          .set('Authorization', `Bearer ${memberA.accessToken}`),
        request(app)
          .delete(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}`)
          .set('Authorization', `Bearer ${memberA.accessToken}`),
      ]) {
        const res = await reqPromise;
        expect(res.status).toBe(403);
      }

      // ADMIN cannot DELETE schedule (OWNER only -> 403)
      const adminDel = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminDel.status).toBe(403);

      // Cross-tenant probes -> all 404
      const crossProbes = await Promise.all([
        // Owner A trying to attach Org B's queueId inside Org A
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({
            queueId: queueBId,
            name: 'Cross-Queue-Hijack',
            type: ScheduleType.RECURRING,
            jobName: 'echo',
            cronExpression: '@hourly',
          }),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/schedules`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/schedules/${orgBScheduleId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/schedules/${orgBScheduleId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules/${orgBScheduleId}/cancel`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .delete(`/api/v1/organisations/${orgAId}/schedules/${orgBScheduleId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
      ]);

      for (const res of crossProbes) {
        expect(res.status).toBe(404);
      }

      // OWNER deletes recurring schedule cleanly (200)
      const ownerDel = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/schedules/${recurringScheduleId}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(ownerDel.status).toBe(200);
    });
  });
});

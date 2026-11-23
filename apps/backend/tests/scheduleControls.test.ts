import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  JobStatus,
  MisfirePolicy,
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
  collectDueCronRuns,
  computeLatestMissedCronRun,
  isCronOccurrenceMisfired,
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

describe('Advanced Scheduling Controls & Reliability (Step 5.2)', () => {
  const suffix = `ctrl_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';
  let queueAId = '';
  let queueBId = '';
  const queueAName = `ctrl-alpha-${Date.now()}`;
  const queueBName = `ctrl-beta-${Date.now()}`;

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ownerA = await createAndLoginUser('c_owner_a', suffix);
    adminA = await createAndLoginUser('c_admin_a', suffix);
    memberA = await createAndLoginUser('c_member_a', suffix);
    ownerB = await createAndLoginUser('c_owner_b', suffix);
    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Schedule Controls Alpha' });
    orgAId = orgARes.body.data.organisation.id;
    createdOrgIds.push(orgAId);

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Schedule Controls Beta' });
    orgBId = orgBRes.body.data.organisation.id;
    createdOrgIds.push(orgBId);

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
      .send({ name: queueAName, concurrency: 5, defaultPriority: 7, maxRetries: 2, backoffMs: 50 });
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

  // ─── 1. Misfire Utilities Across Long Downtime & DST Boundaries ───────────

  describe('Misfire Calculation Utilities & DST Boundaries', () => {
    it('collects missed occurrences cleanly in bounded O(limit) time across long downtime and DST boundaries', () => {
      // 30-day downtime on an every-minute cron (43,200 missed slots) -> strictly capped at maxCollect=5
      const start = new Date('2027-01-01T00:00:00.000Z');
      const thirtyDaysLater = new Date('2027-01-31T00:00:00.000Z');
      const { runs, truncated } = collectDueCronRuns('* * * * *', 'UTC', start, thirtyDaysLater, 5);
      expect(runs).toHaveLength(5);
      expect(truncated).toBe(true);
      expect(runs[0].toISOString()).toBe('2027-01-01T00:00:00.000Z');
      expect(runs[4].toISOString()).toBe('2027-01-01T00:04:00.000Z');

      // O(1) latest missed run computation across 30-day downtime
      const latest = computeLatestMissedCronRun('* * * * *', 'UTC', start, thirtyDaysLater);
      expect(latest.toISOString()).toBe('2027-01-31T00:00:00.000Z');

      // DST spring-forward boundary in America/New_York (2027-03-14 skips 02:00 -> 03:00)
      // Hourly cron from 01:00 EST (06:00Z) to 04:00 EDT (08:00Z): 01:00 EST (06:00Z), 03:00 EDT (07:00Z), 04:00 EDT (08:00Z)
      const dstStart = new Date('2027-03-14T06:00:00.000Z');
      const dstEnd = new Date('2027-03-14T08:05:00.000Z');
      const dstCollected = collectDueCronRuns(
        '0 * * * *',
        'America/New_York',
        dstStart,
        dstEnd,
        10,
      );
      expect(dstCollected.truncated).toBe(false);
      expect(dstCollected.runs.map((d) => d.toISOString())).toEqual([
        '2027-03-14T06:00:00.000Z',
        '2027-03-14T07:00:00.000Z',
        '2027-03-14T08:00:00.000Z',
      ]);

      // On-time vs misfired detection
      expect(
        isCronOccurrenceMisfired(
          '0 * * * *',
          'UTC',
          new Date('2027-01-01T10:00:00.000Z'),
          new Date('2027-01-01T10:00:05.000Z'),
          60_000,
        ),
      ).toBe(false);
      expect(
        isCronOccurrenceMisfired(
          '0 * * * *',
          'UTC',
          new Date('2027-01-01T10:00:00.000Z'),
          new Date('2027-01-01T10:05:00.000Z'),
          60_000,
        ),
      ).toBe(true);
    });
  });

  // ─── 2. Misfire Policies: SKIP_MISSED, FIRE_ONCE, CATCH_UP ────────────────

  describe('Misfire Policies (SKIP_MISSED, FIRE_ONCE, CATCH_UP)', () => {
    it('SKIP_MISSED skips all missed occurrences across extended downtime, records bounded MISSED history, and advances nextRunAt', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Misfire-Skip-Missed',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'skip' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.SKIP_MISSED,
        });
      expect(res.status).toBe(201);
      const scheduleId = res.body.data.schedule.id;
      expect(res.body.data.schedule.misfirePolicy).toBe(MisfirePolicy.SKIP_MISSED);

      // Simulate 20-hour scheduler downtime
      const simNow = new Date('2027-05-10T20:15:00.000Z');
      const missedStart = new Date('2027-05-10T00:00:00.000Z');
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: missedStart },
      });

      const dispatcher = new ScheduleDispatcherService();
      const summary = await dispatcher.tick(simNow, { organisationId: orgAId });

      expect(summary.dispatched).toBe(0);
      expect(summary.missedRecorded).toBeGreaterThanOrEqual(1);
      expect(summary.missedRecorded).toBeLessThanOrEqual(10); // bounded audit cap

      const updated = await prisma.schedule.findUnique({ where: { id: scheduleId } });
      expect(updated?.nextRunAt?.toISOString()).toBe('2027-05-10T21:00:00.000Z');
      expect(updated?.runCount).toBe(0);

      // Filter execution history by status=MISSED
      const missedRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/executions?status=MISSED`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(missedRes.status).toBe(200);
      expect(missedRes.body.data.executions.length).toBeGreaterThanOrEqual(1);
      expect(missedRes.body.data.executions[0].status).toBe(ScheduleExecutionStatus.MISSED);
      expect(missedRes.body.data.executions[0].jobId).toBeNull();
      expect(missedRes.body.data.executions[0].reason).toContain('SKIP_MISSED');

      // Pause cleanly so it does not interfere with subsequent tests
      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });

    it('FIRE_ONCE creates strictly one catch-up execution regardless of missed count and prevents duplicates across concurrent schedulers', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Misfire-Fire-Once',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'fire-once' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.FIRE_ONCE,
        });
      expect(res.status).toBe(201);
      const scheduleId = res.body.data.schedule.id;

      // Simulate 12-hour downtime (12 missed runs) and race TWO concurrent dispatchers
      const simNow = new Date('2027-06-01T12:20:00.000Z');
      const missedStart = new Date('2027-06-01T01:00:00.000Z');
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: missedStart },
      });

      const d1 = new ScheduleDispatcherService();
      const d2 = new ScheduleDispatcherService();
      const [s1, s2] = await Promise.all([
        d1.tick(simNow, { organisationId: orgAId }),
        d2.tick(simNow, { organisationId: orgAId }),
      ]);

      expect(s1.dispatched + s2.dispatched).toBe(1);
      expect(s1.catchUpDispatched + s2.catchUpDispatched).toBe(1);

      const updated = await prisma.schedule.findUnique({ where: { id: scheduleId } });
      expect(updated?.runCount).toBe(1);
      expect(updated?.nextRunAt?.toISOString()).toBe('2027-06-01T13:00:00.000Z');

      const execs = await prisma.scheduleExecution.findMany({
        where: { scheduleId },
        orderBy: { scheduledFor: 'asc' },
      });
      const dispatched = execs.filter((e) => e.status === ScheduleExecutionStatus.DISPATCHED);
      const missed = execs.filter((e) => e.status === ScheduleExecutionStatus.MISSED);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].isCatchUp).toBe(true);
      expect(dispatched[0].dispatchedAt).not.toBeNull();
      expect(dispatched[0].scheduledFor.toISOString()).toBe('2027-06-01T12:00:00.000Z');
      expect(missed).toHaveLength(1);
      expect(missed[0].scheduledFor.toISOString()).toBe('2027-06-01T01:00:00.000Z');

      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });

    it('CATCH_UP replays missed occurrences chronologically up to maxCatchUpRuns and records overflow as MISSED', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Misfire-Catch-Up-Capped',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'catch-up' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.CATCH_UP,
          maxCatchUpRuns: 3,
          preventOverlap: false,
        });
      expect(res.status).toBe(201);
      const scheduleId = res.body.data.schedule.id;

      // 7 missed hours (01:00 .. 07:00) with cap = 3 -> strictly 3 replayed + 1 overflow MISSED audit
      const simNow = new Date('2027-07-01T07:10:00.000Z');
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: new Date('2027-07-01T01:00:00.000Z') },
      });

      const dispatcher = new ScheduleDispatcherService();
      const summary = await dispatcher.tick(simNow, { organisationId: orgAId });

      expect(summary.dispatched).toBe(3);
      expect(summary.catchUpDispatched).toBe(3);
      expect(summary.missedRecorded).toBe(1);

      const execs = await prisma.scheduleExecution.findMany({
        where: { scheduleId },
        orderBy: { scheduledFor: 'asc' },
      });
      const dispatched = execs.filter((e) => e.status === ScheduleExecutionStatus.DISPATCHED);
      const missed = execs.filter((e) => e.status === ScheduleExecutionStatus.MISSED);

      expect(dispatched.map((e) => e.scheduledFor.toISOString())).toEqual([
        '2027-07-01T01:00:00.000Z',
        '2027-07-01T02:00:00.000Z',
        '2027-07-01T03:00:00.000Z',
      ]);
      expect(dispatched.every((e) => e.isCatchUp === true && e.jobId !== null)).toBe(true);
      expect(missed).toHaveLength(1);
      expect(missed[0].reason).toContain('maxCatchUpRuns limit (3)');

      const updated = await prisma.schedule.findUnique({ where: { id: scheduleId } });
      expect(updated?.nextRunAt?.toISOString()).toBe('2027-07-01T08:00:00.000Z');
      expect(updated?.runCount).toBe(3);

      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });
  });

  // ─── 3. Concurrency, Max Total Runs & Min Interval Limits ─────────────────

  describe('Concurrency, Execution Caps & Minimum Interval Controls', () => {
    it('enforces maxConcurrentRuns atomically across concurrent ticks and records SKIPPED_CONCURRENCY', async () => {
      // Setting maxConcurrentRuns > 1 without preventOverlap automatically sets preventOverlap=false
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Concurrent-Cap-2',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'cap-2' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.CATCH_UP,
          maxCatchUpRuns: 5,
          maxConcurrentRuns: 2,
        });
      expect(createRes.status).toBe(201);
      expect(createRes.body.data.schedule.preventOverlap).toBe(false);
      expect(createRes.body.data.schedule.maxConcurrentRuns).toBe(2);
      const scheduleId = createRes.body.data.schedule.id;

      // Reject conflicting preventOverlap: true + maxConcurrentRuns: 2
      const conflictRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Conflict-Cap',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          cronExpression: '@hourly',
          preventOverlap: true,
          maxConcurrentRuns: 2,
        });
      expect(conflictRes.status).toBe(400);

      // 4 missed slots with maxConcurrentRuns = 2 -> strictly 2 dispatched, 2 SKIPPED_CONCURRENCY
      const simNow = new Date('2027-08-01T04:05:00.000Z');
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: new Date('2027-08-01T01:00:00.000Z') },
      });

      const d1 = new ScheduleDispatcherService();
      const d2 = new ScheduleDispatcherService();
      const [r1, r2] = await Promise.all([
        d1.tick(simNow, { organisationId: orgAId }),
        d2.tick(simNow, { organisationId: orgAId }),
      ]);

      expect(r1.dispatched + r2.dispatched).toBe(2);
      expect(r1.skippedConcurrency + r2.skippedConcurrency).toBe(2);

      // Complete 1 in-flight job -> next due occurrence is now allowed!
      const dispatchedExecs = await prisma.scheduleExecution.findMany({
        where: { scheduleId, status: ScheduleExecutionStatus.DISPATCHED },
      });
      await prisma.job.update({
        where: { id: dispatchedExecs[0].jobId! },
        data: { status: JobStatus.COMPLETED, completedAt: new Date() },
      });

      const simNext = new Date('2027-08-01T05:00:05.000Z');
      const r3 = await d1.tick(simNext, { organisationId: orgAId });
      expect(r3.dispatched).toBe(1);

      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });

    it('enforces maxTotalRuns, auto-completes schedule, blocks resume (409), and rejects arbitrary status changes (400)', async () => {
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Max-Total-2',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'max-2' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.CATCH_UP,
          maxCatchUpRuns: 5,
          preventOverlap: false,
          maxTotalRuns: 2,
        });
      expect(createRes.status).toBe(201);
      const scheduleId = createRes.body.data.schedule.id;

      // Arbitrary status mutation via PATCH is strictly rejected (400)
      const statusHack = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ status: 'COMPLETED' });
      expect(statusHack.status).toBe(400);

      // 4 due runs with maxTotalRuns = 2 -> 2 dispatched, 2 SKIPPED_MAX_RUNS, schedule -> COMPLETED
      const simNow = new Date('2027-09-01T04:05:00.000Z');
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: new Date('2027-09-01T01:00:00.000Z') },
      });

      const dispatcher = new ScheduleDispatcherService();
      const summary = await dispatcher.tick(simNow, { organisationId: orgAId });
      expect(summary.dispatched).toBe(2);
      expect(summary.skippedMaxRuns).toBe(2);
      expect(summary.completedMaxRuns).toBe(1);

      const completed = await prisma.schedule.findUnique({ where: { id: scheduleId } });
      expect(completed?.status).toBe(ScheduleStatus.COMPLETED);
      expect(completed?.nextRunAt).toBeNull();
      expect(completed?.runCount).toBe(2);

      // Cannot resume, pause, cancel, or update a COMPLETED schedule (409)
      for (const reqPromise of [
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/resume`)
          .set('Authorization', `Bearer ${adminA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
          .set('Authorization', `Bearer ${adminA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/cancel`)
          .set('Authorization', `Bearer ${adminA.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}`)
          .set('Authorization', `Bearer ${adminA.accessToken}`)
          .send({ description: 'blocked' }),
      ]) {
        const r = await reqPromise;
        expect(r.status).toBe(409);
      }
    });

    it('enforces minIntervalMs durably across ticks/restarts and records SKIPPED_MIN_INTERVAL', async () => {
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Min-Interval-30s',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'interval' },
          cronExpression: '*/10 * * * * *', // every 10 seconds
          timezone: 'UTC',
          preventOverlap: false,
          minIntervalMs: 30_000,
        });
      expect(createRes.status).toBe(201);
      const scheduleId = createRes.body.data.schedule.id;

      // Tick 1 at T=0 -> dispatches (sets persisted lastDispatchedAt = T0)
      const t0 = new Date('2027-10-01T00:00:00.000Z');
      await prisma.schedule.update({ where: { id: scheduleId }, data: { nextRunAt: t0 } });

      const d1 = new ScheduleDispatcherService();
      const s1 = await d1.tick(t0, { organisationId: orgAId });
      expect(s1.dispatched).toBe(1);

      // Tick 2 at T+10s using a FRESH dispatcher instance (simulating restart) -> SKIPPED_MIN_INTERVAL
      const d2 = new ScheduleDispatcherService();
      const t10 = new Date('2027-10-01T00:00:10.000Z');
      const s2 = await d2.tick(t10, { organisationId: orgAId });
      expect(s2.dispatched).toBe(0);
      expect(s2.skippedMinInterval).toBe(1);

      // Tick 3 at T+30s -> allowed again!
      const t30 = new Date('2027-10-01T00:00:30.000Z');
      await prisma.schedule.update({ where: { id: scheduleId }, data: { nextRunAt: t30 } });
      const s3 = await d2.tick(t30, { organisationId: orgAId });
      expect(s3.dispatched).toBe(1);

      // Verify stats endpoint reflects exact persisted breakdown
      const statsRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/stats`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(statsRes.status).toBe(200);
      expect(statsRes.body.data.stats.runCount).toBe(2);
      expect(statsRes.body.data.stats.byStatus.dispatched).toBe(2);
      expect(statsRes.body.data.stats.byStatus.skippedMinInterval).toBe(1);

      // Updating cron/payload preserves immutable historical executions
      const updateRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ cronExpression: '@hourly', payload: { message: 'updated-v2' } });
      expect(updateRes.status).toBe(200);

      const execsAfterUpdate = await prisma.scheduleExecution.findMany({ where: { scheduleId } });
      expect(execsAfterUpdate).toHaveLength(3);

      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/pause`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });
  });

  // ─── 4. BullMQ Reconciliation, Redis Outage & Cross-Tenant Security ───────

  describe('BullMQ Reconciliation, Redis Outage Recovery & Security', () => {
    it('reconciles pending/delayed scheduled jobs missing from Redis back into BullMQ and enforces RBAC & cross-tenant isolation', async () => {
      // Create near-term ONE_TIME schedule (10 min in future)
      const targetRunAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Reconcile-OneTime',
          type: ScheduleType.ONE_TIME,
          jobName: 'echo',
          payload: { message: 'reconcile-me' },
          timezone: 'UTC',
          runAt: targetRunAt,
        });
      expect(createRes.status).toBe(201);
      const scheduleId = createRes.body.data.schedule.id;
      const jobId = createRes.body.data.initialJobId as string;

      // Simulate Redis flush/data loss by removing the job directly from BullMQ while PG stays DELAYED
      const reg = bullMQService.getRegisteredQueue(orgAId, queueAName);
      expect(await reg!.queue.getJob(jobId)).toBeDefined();
      await (await reg!.queue.getJob(jobId))!.remove();
      expect(await reg!.queue.getJob(jobId)).toBeUndefined();

      // MEMBER cannot trigger /reconcile (403)
      const memberReconcile = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/reconcile`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberReconcile.status).toBe(403);

      // ADMIN triggers org-scoped /reconcile -> restores missing job into BullMQ!
      const adminReconcile = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/reconcile`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminReconcile.status).toBe(200);
      expect(adminReconcile.body.data.reconciliation.bullmq.reEnqueued).toBeGreaterThanOrEqual(1);
      expect(await reg!.queue.getJob(jobId)).toBeDefined();

      // Outage test: recurring schedule dispatches via OutboxReconciler and stamps dispatchedAt
      const outageSchedRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({
          queueId: queueAId,
          name: 'Outage-Recovery-FireOnce',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          payload: { message: 'after-outage' },
          cronExpression: '0 * * * *',
          timezone: 'UTC',
          misfirePolicy: MisfirePolicy.FIRE_ONCE,
        });
      const outageSchedId = outageSchedRes.body.data.schedule.id;
      const simNow = new Date('2027-11-01T05:10:00.000Z');
      await prisma.schedule.update({
        where: { id: outageSchedId },
        data: { nextRunAt: new Date('2027-11-01T02:00:00.000Z') },
      });

      const failingBullMQ = new BullMQService({
        ensureReady: vi.fn().mockRejectedValue(new Error('ECONNREFUSED Redis outage')),
      });
      const outageDispatcher = new ScheduleDispatcherService({ bullMQ: failingBullMQ });
      const outageTick = await outageDispatcher.tick(simNow, { organisationId: orgAId });
      expect(outageTick.outboxDeferred).toBe(1);

      const execBeforeRecovery = await prisma.scheduleExecution.findFirst({
        where: { scheduleId: outageSchedId, status: ScheduleExecutionStatus.DISPATCHED },
      });
      expect(execBeforeRecovery?.dispatchedAt).toBeNull();
      expect(execBeforeRecovery?.isCatchUp).toBe(true);

      await prisma.jobDispatchOutbox.update({
        where: { jobId: execBeforeRecovery!.jobId! },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      const reconciler = new OutboxReconciler({ bullMQ: bullMQService });
      await reconciler.reconcileOnce();

      const execAfterRecovery = await prisma.scheduleExecution.findUnique({
        where: { id: execBeforeRecovery!.id },
      });
      expect(execAfterRecovery?.dispatchedAt).not.toBeNull();
      const outboxDone = await prisma.jobDispatchOutbox.findUnique({
        where: { jobId: execBeforeRecovery!.jobId! },
      });
      expect(outboxDone?.status).toBe(OutboxStatus.DISPATCHED);

      // Cross-tenant security: Org B owner cannot view Org A /stats or trigger Org A /reconcile,
      // and Org A owner cannot view Org B schedule /stats
      const orgBSchedRes = await request(app)
        .post(`/api/v1/organisations/${orgBId}/schedules`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({
          queueId: queueBId,
          name: 'OrgB-Control-Sched',
          type: ScheduleType.RECURRING,
          jobName: 'echo',
          cronExpression: '@daily',
        });
      expect(orgBSchedRes.status).toBe(201);
      const orgBSchedId = orgBSchedRes.body.data.schedule.id;

      const crossStats = await request(app)
        .get(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/stats`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(crossStats.status).toBe(404);

      const crossStatsSpoof = await request(app)
        .get(`/api/v1/organisations/${orgBId}/schedules/${scheduleId}/stats`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(crossStatsSpoof.status).toBe(404);

      const crossStatsOrgB = await request(app)
        .get(`/api/v1/organisations/${orgBId}/schedules/${orgBSchedId}/stats`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(crossStatsOrgB.status).toBe(404);

      const crossReconcile = await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/reconcile`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(crossReconcile.status).toBe(404);

      // Clean cancel
      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${scheduleId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      await request(app)
        .post(`/api/v1/organisations/${orgAId}/schedules/${outageSchedId}/cancel`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
    });
  });
});

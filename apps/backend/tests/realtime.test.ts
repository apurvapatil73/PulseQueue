import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import express, { type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PlatformEventType, Role } from '@prisma/client';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/config/database.js';
import { authenticate } from '../src/middleware/auth.middleware.js';
import { requireOrgRole } from '../src/middleware/rbac.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { eventService } from '../src/services/event.service.js';
import { workerHealthService } from '../src/services/workerHealth.service.js';
import {
  RealtimeEventBus,
  realtimeEventBus,
  type RealtimePlatformEvent,
} from '../src/services/realtime.service.js';
import { createMonitoringStreamHandler } from '../src/controllers/stream.controller.js';

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

interface ParsedSseEvent {
  id?: string;
  event: string;
  data: unknown;
}

interface SseTestClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  events: ParsedSseEvent[];
  comments: string[];
  waitForEvent: (
    predicate: (e: ParsedSseEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<ParsedSseEvent>;
  waitForComment: (timeoutMs?: number) => Promise<string>;
  waitForEnd: (timeoutMs?: number) => Promise<void>;
  close: () => void;
}

function openSseClient(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<SseTestClient> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...headers,
        },
      },
      (res) => {
        const events: ParsedSseEvent[] = [];
        const comments: string[] = [];
        const eventWaiters: Array<(e: ParsedSseEvent) => void> = [];
        const commentWaiters: Array<(c: string) => void> = [];
        const endWaiters: Array<() => void> = [];
        let ended = false;

        let buffer = '';
        let curEvent = 'message';
        let curId: string | undefined;
        let curData: string[] = [];

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);

            if (line === '') {
              if (curData.length > 0) {
                const raw = curData.join('\n');
                let parsed: unknown = raw;
                try {
                  parsed = JSON.parse(raw);
                } catch {
                  // leave as string
                }
                const evt: ParsedSseEvent = { id: curId, event: curEvent, data: parsed };
                events.push(evt);
                for (const fn of [...eventWaiters]) fn(evt);
              }
              curEvent = 'message';
              curId = undefined;
              curData = [];
            } else if (line.startsWith(':')) {
              const comment = line.slice(1).trim();
              comments.push(comment);
              for (const fn of [...commentWaiters]) fn(comment);
            } else {
              const idx = line.indexOf(':');
              const field = idx === -1 ? line : line.slice(0, idx);
              let value = idx === -1 ? '' : line.slice(idx + 1);
              if (value.startsWith(' ')) value = value.slice(1);
              if (field === 'event') curEvent = value || 'message';
              else if (field === 'id') curId = value;
              else if (field === 'data') curData.push(value);
            }
          }
        });

        const markEnd = () => {
          ended = true;
          for (const fn of [...endWaiters]) fn();
        };
        res.on('end', markEnd);
        res.on('close', markEnd);

        const client: SseTestClient = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          comments,
          waitForEvent(predicate, timeoutMs = 5000) {
            const existing = events.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(() => {
                rejWait(
                  new Error(
                    `Timed out waiting for SSE event. Received so far: ${JSON.stringify(events)}`,
                  ),
                );
              }, timeoutMs);
              const listener = (e: ParsedSseEvent) => {
                if (predicate(e)) {
                  clearTimeout(timer);
                  const i = eventWaiters.indexOf(listener);
                  if (i !== -1) eventWaiters.splice(i, 1);
                  resWait(e);
                }
              };
              eventWaiters.push(listener);
            });
          },
          waitForComment(timeoutMs = 5000) {
            if (comments.length > 0) return Promise.resolve(comments[0]);
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(
                () => rejWait(new Error('Timed out waiting for SSE heartbeat comment')),
                timeoutMs,
              );
              const listener = (c: string) => {
                clearTimeout(timer);
                const i = commentWaiters.indexOf(listener);
                if (i !== -1) commentWaiters.splice(i, 1);
                resWait(c);
              };
              commentWaiters.push(listener);
            });
          },
          waitForEnd(timeoutMs = 5000) {
            if (ended) return Promise.resolve();
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(
                () => rejWait(new Error('Timed out waiting for SSE stream end')),
                timeoutMs,
              );
              endWaiters.push(() => {
                clearTimeout(timer);
                resWait();
              });
            });
          },
          close() {
            req.destroy();
          },
        };

        resolve(client);
      },
    );

    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
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

describe('Step 7.3 — Real-Time Event Delivery (Redis Pub/Sub + SSE)', () => {
  const suffix = `rt73_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';

  let primaryServer: http.Server;
  let primaryBaseUrl = '';

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdWorkerIds: string[] = [];

  beforeAll(async () => {
    primaryServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = primaryServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    primaryBaseUrl = `http://127.0.0.1:${port}`;

    ownerA = await createAndLoginUser('rt_owner_a', suffix);
    adminA = await createAndLoginUser('rt_admin_a', suffix);
    memberA = await createAndLoginUser('rt_member_a', suffix);
    ownerB = await createAndLoginUser('rt_owner_b', suffix);
    createdUserIds.push(ownerA.id, adminA.id, memberA.id, ownerB.id);

    const orgARes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ name: 'Realtime Org Alpha' });
    orgAId = orgARes.body.data.organisation.id;

    const orgBRes = await request(app)
      .post('/api/v1/organisations')
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ name: 'Realtime Org Beta' });
    orgBId = orgBRes.body.data.organisation.id;

    createdOrgIds.push(orgAId, orgBId);

    for (const [invitee, role] of [
      [adminA, 'ADMIN'],
      [memberA, 'MEMBER'],
    ] as const) {
      const inv = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: invitee.email, role });
      await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: inv.body.data.token });
    }
  }, 60_000);

  afterAll(async () => {
    await realtimeEventBus.closeAll();
    await new Promise<void>((resolve) => primaryServer.close(() => resolve()));

    if (createdWorkerIds.length > 0) {
      await prisma.workerHeartbeat.deleteMany({
        where: { workerInstanceId: { in: createdWorkerIds } },
      });
      await prisma.platformEvent.deleteMany({
        where: { workerId: { in: createdWorkerIds } },
      });
    }
    if (createdOrgIds.length > 0) {
      await prisma.platformEvent.deleteMany({
        where: { organisationId: { in: createdOrgIds } },
      });
      await prisma.organisation.deleteMany({
        where: { id: { in: createdOrgIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  }, 30_000);

  describe('Authentication & RBAC Enforcement', () => {
    it('rejects unauthenticated, invalid, and expired Bearer tokens with 401 and blocks cross-org users with 404', async () => {
      const expiredToken = jwt.sign({ sub: ownerA.id, email: ownerA.email }, env.JWT_SECRET, {
        expiresIn: -10,
        algorithm: 'HS256',
      });

      const [noAuth, badAuth, expiredAuth, crossOrg] = await Promise.all([
        request(app).get(`/api/v1/organisations/${orgAId}/monitoring/stream`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/stream`)
          .set('Authorization', 'Bearer invalid.jwt.token'),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/stream`)
          .set('Authorization', `Bearer ${expiredToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgAId}/monitoring/stream`)
          .set('Authorization', `Bearer ${ownerB.accessToken}`),
      ]);

      expect(noAuth.status).toBe(401);
      expect(badAuth.status).toBe(401);
      expect(expiredAuth.status).toBe(401);
      expect(crossOrg.status).toBe(404);
    });

    it('allows OWNER, ADMIN, and MEMBER to open authenticated SSE streams with proper headers', async () => {
      for (const user of [ownerA, adminA, memberA]) {
        const client = await openSseClient(
          primaryBaseUrl,
          `/api/v1/organisations/${orgAId}/monitoring/stream`,
          { Authorization: `Bearer ${user.accessToken}` },
        );
        try {
          expect(client.status).toBe(200);
          expect(client.headers['content-type']).toContain('text/event-stream');
          expect(client.headers['cache-control']).toContain('no-cache');
          expect(client.headers['x-accel-buffering']).toBe('no');

          const connected = await client.waitForEvent((e) => e.event === 'connected');
          expect(connected.data).toMatchObject({ organisationId: orgAId });
        } finally {
          client.close();
        }
      }
    });
  });

  describe('Redis Pub/Sub Delivery, Sanitization & Two-Organisation Isolation', () => {
    it('delivers live events strictly to the owning organisation, redacts sensitive metadata, and fans out worker health transitions', async () => {
      const clientA = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        { Authorization: `Bearer ${memberA.accessToken}` },
      );
      const clientB = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgBId}/monitoring/stream`,
        { Authorization: `Bearer ${ownerB.accessToken}` },
      );

      try {
        await Promise.all([
          clientA.waitForEvent((e) => e.event === 'connected'),
          clientB.waitForEvent((e) => e.event === 'connected'),
        ]);

        const evtA = await eventService.record({
          type: PlatformEventType.JOB_FAILED,
          organisationId: orgAId,
          message: 'Org A job failed safely',
          metadata: {
            token: 'secret-bearer-123',
            stack: 'Error: internal trace\n at secret.ts:1',
            attemptNumber: 2,
          },
        });
        expect(evtA).not.toBeNull();

        const evtB = await eventService.record({
          type: PlatformEventType.JOB_COMPLETED,
          organisationId: orgBId,
          message: 'Org B job completed',
        });
        expect(evtB).not.toBeNull();

        const receivedA = await clientA.waitForEvent((e) => e.id === evtA!.id);
        const receivedB = await clientB.waitForEvent((e) => e.id === evtB!.id);

        expect(receivedA.event).toBe(PlatformEventType.JOB_FAILED);
        const dataA = receivedA.data as RealtimePlatformEvent;
        expect(dataA.organisationId).toBe(orgAId);
        expect(dataA.metadata.token).toBe('[REDACTED]');
        expect(dataA.metadata.stack).toBe('[REDACTED]');
        expect(dataA.metadata.attemptNumber).toBe(2);

        expect(receivedB.event).toBe(PlatformEventType.JOB_COMPLETED);
        expect((receivedB.data as RealtimePlatformEvent).organisationId).toBe(orgBId);

        const wId = `worker-rt-${suffix}`;
        createdWorkerIds.push(wId);
        await workerHealthService.registerWorkerStart({
          workerInstanceId: wId,
          hostname: 'rt-host',
          pid: 4242,
          registeredQueues: [`org_${orgAId}__q1`],
          organisationIds: [orgAId],
        });

        const workerEvtA = await clientA.waitForEvent(
          (e) => e.event === PlatformEventType.WORKER_STARTED,
        );
        expect((workerEvtA.data as RealtimePlatformEvent).workerId).toBe(wId);

        await new Promise((r) => setTimeout(r, 150));
        expect(clientA.events.some((e) => e.id === evtB!.id)).toBe(false);
        expect(clientB.events.some((e) => e.id === evtA!.id)).toBe(false);
        expect(clientB.events.some((e) => e.event === PlatformEventType.WORKER_STARTED)).toBe(
          false,
        );
      } finally {
        clientA.close();
        clientB.close();
      }
    });
  });

  describe('Multiple Backend Instances via Redis Pub/Sub', () => {
    it('delivers a single published event to SSE clients connected to two separate API instances without duplicates', async () => {
      const bus1 = new RealtimeEventBus({ heartbeatIntervalMs: 60_000 });
      const bus2 = new RealtimeEventBus({ heartbeatIntervalMs: 60_000 });

      const buildInstance = (bus: RealtimeEventBus) => {
        const inst = express();
        inst.get(
          '/api/v1/organisations/:organisationId/monitoring/stream',
          authenticate,
          requireOrgRole(Role.MEMBER),
          createMonitoringStreamHandler(bus),
        );
        inst.use(errorHandler);
        return inst;
      };

      const srv1 = await new Promise<http.Server>((resolve) => {
        const s = buildInstance(bus1).listen(0, '127.0.0.1', () => resolve(s));
      });
      const srv2 = await new Promise<http.Server>((resolve) => {
        const s = buildInstance(bus2).listen(0, '127.0.0.1', () => resolve(s));
      });

      const p1 = (srv1.address() as { port: number }).port;
      const p2 = (srv2.address() as { port: number }).port;

      const c1 = await openSseClient(
        `http://127.0.0.1:${p1}`,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        { Authorization: `Bearer ${ownerA.accessToken}` },
      );
      const c2 = await openSseClient(
        `http://127.0.0.1:${p2}`,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        { Authorization: `Bearer ${adminA.accessToken}` },
      );

      try {
        await Promise.all([
          c1.waitForEvent((e) => e.event === 'connected'),
          c2.waitForEvent((e) => e.event === 'connected'),
        ]);

        const evt = await eventService.record({
          type: PlatformEventType.JOB_COMPLETED,
          organisationId: orgAId,
          message: 'Multi-instance broadcast test',
        });
        expect(evt).not.toBeNull();

        const [r1, r2] = await Promise.all([
          c1.waitForEvent((e) => e.id === evt!.id),
          c2.waitForEvent((e) => e.id === evt!.id),
        ]);

        expect(r1.id).toBe(evt!.id);
        expect(r2.id).toBe(evt!.id);
        await new Promise((r) => setTimeout(r, 100));
        expect(c1.events.filter((e) => e.id === evt!.id)).toHaveLength(1);
        expect(c2.events.filter((e) => e.id === evt!.id)).toHaveLength(1);
      } finally {
        c1.close();
        c2.close();
        await bus1.closeAll();
        await bus2.closeAll();
        await new Promise<void>((resolve) => srv1.close(() => resolve()));
        await new Promise<void>((resolve) => srv2.close(() => resolve()));
      }
    });
  });

  describe('Event Replay, Reconnection & Cursor Validation', () => {
    it('replays missed events chronologically via Last-Event-ID, deduplicates overlap, and handles invalid/cross-org/expired cursors safely', async () => {
      const e1 = await eventService.record({
        type: PlatformEventType.JOB_SUBMITTED,
        organisationId: orgAId,
        message: 'Replay cursor anchor',
      });
      await new Promise((r) => setTimeout(r, 15));
      const e2 = await eventService.record({
        type: PlatformEventType.JOB_STARTED,
        organisationId: orgAId,
        message: 'Missed event 1',
      });
      await new Promise((r) => setTimeout(r, 15));
      const e3 = await eventService.record({
        type: PlatformEventType.JOB_COMPLETED,
        organisationId: orgAId,
        message: 'Missed event 2',
      });

      const replayClient = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        {
          Authorization: `Bearer ${ownerA.accessToken}`,
          'Last-Event-ID': e1!.id,
        },
      );
      try {
        await replayClient.waitForEvent((e) => e.id === e3!.id);
        const replayedIds = replayClient.events.filter((e) => e.id).map((e) => e.id);
        expect(replayedIds).toEqual([e2!.id, e3!.id]);

        const e4 = await eventService.record({
          type: PlatformEventType.JOB_RETRIED,
          organisationId: orgAId,
          message: 'Live event after replay',
        });
        await replayClient.waitForEvent((e) => e.id === e4!.id);
        expect(replayClient.events.filter((e) => e.id === e4!.id)).toHaveLength(1);
      } finally {
        replayClient.close();
      }

      const crossCursorClient = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgBId}/monitoring/stream`,
        {
          Authorization: `Bearer ${ownerB.accessToken}`,
          'Last-Event-ID': e1!.id,
        },
      );
      try {
        const resync = await crossCursorClient.waitForEvent((e) => e.event === 'resync');
        expect(resync.data).toMatchObject({ reason: 'cursor_not_found' });
        expect(crossCursorClient.events.some((e) => e.id === e2!.id)).toBe(false);
      } finally {
        crossCursorClient.close();
      }

      const invalidCursorClient = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        {
          Authorization: `Bearer ${ownerA.accessToken}`,
          'Last-Event-ID': 'not-a-uuid',
        },
      );
      try {
        const resync = await invalidCursorClient.waitForEvent((e) => e.event === 'resync');
        expect(resync.data).toMatchObject({ reason: 'invalid_cursor' });
      } finally {
        invalidCursorClient.close();
      }

      const expiredEvent = await prisma.platformEvent.create({
        data: {
          type: PlatformEventType.JOB_SUBMITTED,
          organisationId: orgAId,
          message: 'Expired 35-day cursor',
          createdAt: new Date(Date.now() - 35 * 86_400_000),
        },
      });
      const expiredCursorClient = await openSseClient(
        primaryBaseUrl,
        `/api/v1/organisations/${orgAId}/monitoring/stream`,
        {
          Authorization: `Bearer ${ownerA.accessToken}`,
          'Last-Event-ID': expiredEvent.id,
        },
      );
      try {
        const resync = await expiredCursorClient.waitForEvent((e) => e.event === 'resync');
        expect(resync.data).toMatchObject({ reason: 'cursor_expired' });
      } finally {
        expiredCursorClient.close();
      }
    });
  });

  describe('Heartbeats, Cleanup, Connection Limits, Backpressure & Redis Recovery', () => {
    it('sends heartbeats, enforces per-user connection limits (429), cleans up on disconnect, and closes on shutdown', async () => {
      const bus = new RealtimeEventBus({
        heartbeatIntervalMs: 80,
        maxConnectionsPerUser: 2,
      });

      const inst = express();
      inst.get(
        '/api/v1/organisations/:organisationId/monitoring/stream',
        authenticate,
        requireOrgRole(Role.MEMBER),
        createMonitoringStreamHandler(bus),
      );
      inst.use(errorHandler);

      const srv = await new Promise<http.Server>((resolve) => {
        const s = inst.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = (srv.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;

      const c1 = await openSseClient(base, `/api/v1/organisations/${orgAId}/monitoring/stream`, {
        Authorization: `Bearer ${ownerA.accessToken}`,
      });
      const c2 = await openSseClient(base, `/api/v1/organisations/${orgAId}/monitoring/stream`, {
        Authorization: `Bearer ${ownerA.accessToken}`,
      });

      try {
        await Promise.all([
          c1.waitForEvent((e) => e.event === 'connected'),
          c2.waitForEvent((e) => e.event === 'connected'),
        ]);

        const hb = await c1.waitForComment();
        expect(hb).toContain('heartbeat');

        const overLimit = await request(inst)
          .get(`/api/v1/organisations/${orgAId}/monitoring/stream`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`);
        expect(overLimit.status).toBe(429);
        expect(overLimit.body.error.code).toBe('TOO_MANY_REQUESTS');

        c1.close();
        await new Promise((r) => setTimeout(r, 80));
        expect(bus.getStats().totalConnections).toBe(1);

        const endPromise = c2.waitForEnd();
        await bus.closeAll();
        await endPromise;
        expect(c2.events.some((e) => e.event === 'shutdown')).toBe(true);
        expect(bus.getStats().totalConnections).toBe(0);
        expect(bus.getStats().subscribedOrganisations).toBe(0);
      } finally {
        c1.close();
        c2.close();
        await bus.closeAll();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    it('handles socket backpressure safely and notifies active clients on Redis subscriber reconnect', async () => {
      class FakeRedis extends EventEmitter {
        status = 'ready';
        async connect() {
          this.status = 'ready';
        }
        async subscribe() {
          return 1;
        }
        async unsubscribe() {
          return 0;
        }
        async publish() {
          throw new Error('ECONNREFUSED simulated Redis publish outage');
        }
        async quit() {
          this.status = 'end';
        }
        disconnect() {
          this.status = 'end';
        }
      }

      const fakePub = new FakeRedis();
      const fakeSub = new FakeRedis();

      const bus = new RealtimeEventBus({
        createPublisher: () => fakePub as unknown as never,
        createSubscriber: () => fakeSub as unknown as never,
        heartbeatIntervalMs: 60_000,
        maxBackpressureDropped: 3,
      });

      const pubOk = await bus.publish({
        id: '11111111-1111-4111-8111-111111111111',
        type: PlatformEventType.JOB_SUBMITTED,
        organisationId: orgAId,
        queueId: null,
        jobId: null,
        workerId: null,
        message: 'Outage resilience test',
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      expect(pubOk).toBe(false);

      const chunks: string[] = [];
      let returnOk = true;
      const fakeRes = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        write(chunk: string) {
          chunks.push(chunk);
          return returnOk;
        },
        end() {
          this.writableEnded = true;
        },
      });

      const client = await bus.registerClient({
        organisationId: orgAId,
        userId: ownerA.id,
        res: fakeRes as unknown as Response,
      });
      bus.finishReplayAndGoLive(client);

      fakeSub.emit('close');
      fakeSub.emit('ready');
      expect(chunks.some((c) => c.includes('redis_reconnected'))).toBe(true);

      returnOk = false;
      bus.deliverEvent(client, {
        id: '22222222-2222-4222-8222-222222222222',
        type: PlatformEventType.JOB_STARTED,
        organisationId: orgAId,
        queueId: null,
        jobId: null,
        workerId: null,
        message: 'Triggers backpressure',
        metadata: {},
        createdAt: new Date().toISOString(),
      });

      const droppedDelivered = bus.deliverEvent(client, {
        id: '33333333-3333-4333-8333-333333333333',
        type: PlatformEventType.JOB_COMPLETED,
        organisationId: orgAId,
        queueId: null,
        jobId: null,
        workerId: null,
        message: 'Dropped while congested',
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      expect(droppedDelivered).toBe(false);

      returnOk = true;
      fakeRes.emit('drain');
      expect(chunks.some((c) => c.includes('backpressure_dropped'))).toBe(true);

      await bus.closeAll();
    });
  });
});

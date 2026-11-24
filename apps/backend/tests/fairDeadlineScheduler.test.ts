import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { JobDispatchState, JobStatus, Role, SchedulingPolicy } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import {
  accumulateDrrDeficit,
  computeDrrQuantum,
  consumeDrrDeficit,
  evaluateDeadlineUrgency,
} from '../src/services/fairDeadline.utils.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
  compareCandidatesByPolicy,
  rankEligibleCandidates,
  type SchedulingPolicyConfig,
} from '../src/services/priorityScheduler.service.js';
import { signAccessToken } from '../src/utils/security.js';

const app = createApp();

describe('Phase 8.4 — Weighted Fair (DRR) & Deadline-Aware (EDF + Hybrid) Scheduling', () => {
  describe('1. Pure algorithm unit tests (DRR, EDF, Hybrid)', () => {
    it('computes DRR quantum, bounded deficit accumulation, and head-of-line cost consumption', () => {
      expect(computeDrrQuantum(10, 4)).toBe(40);
      expect(accumulateDrrDeficit(180, 10, 4, 200)).toBe(200);
      expect(accumulateDrrDeficit(0, 5, 2, 100)).toBe(10);

      const denied = consumeDrrDeficit(10, 12);
      expect(denied).toEqual({ allowed: false, nextDeficit: 10, cost: 12 });

      const allowed = consumeDrrDeficit(15, 12);
      expect(allowed).toEqual({ allowed: true, nextDeficit: 3, cost: 12 });
    });

    it('evaluates deadline urgency bands accurately in UTC', () => {
      const now = new Date('2026-11-24T12:00:00.000Z');
      expect(evaluateDeadlineUrgency(null, now, 60)).toMatchObject({
        hasDeadline: false,
        isApproaching: false,
        isExpired: false,
        latenessMs: null,
      });
      expect(evaluateDeadlineUrgency(new Date('2026-11-24T12:00:30.000Z'), now, 60)).toMatchObject({
        hasDeadline: true,
        isApproaching: true,
        isExpired: false,
        latenessMs: 0,
      });
      expect(evaluateDeadlineUrgency(new Date('2026-11-24T12:05:00.000Z'), now, 60)).toMatchObject({
        hasDeadline: true,
        isApproaching: false,
        isExpired: false,
      });
      expect(evaluateDeadlineUrgency(new Date('2026-11-24T11:59:55.000Z'), now, 60)).toMatchObject({
        hasDeadline: true,
        isApproaching: false,
        isExpired: true,
        latenessMs: 5000,
      });
    });

    it('orders DEADLINE_AWARE candidates deterministically (EDF, tie-breaks, expired, no-deadline, excludes delayed)', () => {
      const now = new Date('2026-11-24T12:00:00.000Z');
      const cfg: SchedulingPolicyConfig = {
        schedulingPolicy: SchedulingPolicy.DEADLINE_AWARE,
        agingRatePerSec: 0.1,
        maxEffectivePriority: 30,
        starvationThresholdSec: 300,
        deadlineUrgencyWindowSec: 60,
      };
      const mk = (
        id: string,
        priority: number,
        readyOffsetSec: number,
        deadlineOffsetSec: number | null,
      ) => {
        const readyAt = new Date(now.getTime() + readyOffsetSec * 1000);
        return {
          id,
          priority,
          readyAt,
          virtualRankAt: new Date(readyAt.getTime() - (priority / 0.1) * 1000),
          deadlineAt:
            deadlineOffsetSec !== null ? new Date(now.getTime() + deadlineOffsetSec * 1000) : null,
        };
      };

      const candidates = [
        mk('delayed-urgent', 20, +30, +5), // ineligible until readyAt <= now
        mk('no-deadline-high', 20, -10, null),
        mk('expired-newer', 10, -10, -5),
        mk('expired-older', 1, -10, -20),
        mk('edf-later', 20, -10, +40),
        mk('edf-tie-low-prio', 5, -20, +10),
        mk('edf-tie-high-prio', 15, -5, +10),
        mk('starved-job', 1, -400, null),
      ];

      const ranked = rankEligibleCandidates(candidates, cfg, now).map((c) => c.id);
      expect(ranked).toEqual([
        'starved-job', // Band 0: hard starvation
        'expired-older', // Band 1: strict EDF — earliest absolute deadline (-20s)
        'expired-newer', // Band 1: strict EDF — second earliest (-5s)
        'edf-tie-high-prio', // Band 1: +10s, higher priority (15 > 5)
        'edf-tie-low-prio', // Band 1: +10s, lower priority
        'edf-later', // Band 1: later active deadline (+40s)
        'no-deadline-high', // Band 2: no deadline
      ]);
      expect(ranked).not.toContain('delayed-urgent');
    });

    it('enforces HYBRID_FAIR_DEADLINE precedence: starvation > approaching deadline > distant deadline priority', () => {
      const now = new Date('2026-11-24T12:00:00.000Z');
      const cfg: SchedulingPolicyConfig = {
        schedulingPolicy: SchedulingPolicy.HYBRID_FAIR_DEADLINE,
        agingRatePerSec: 0.1,
        maxEffectivePriority: 30,
        starvationThresholdSec: 300,
        deadlineUrgencyWindowSec: 60,
      };
      const mk = (
        id: string,
        priority: number,
        readyOffsetSec: number,
        deadlineOffsetSec: number | null,
      ) => {
        const readyAt = new Date(now.getTime() + readyOffsetSec * 1000);
        return {
          id,
          priority,
          readyAt,
          virtualRankAt: new Date(readyAt.getTime() - (priority / 0.1) * 1000),
          deadlineAt:
            deadlineOffsetSec !== null ? new Date(now.getTime() + deadlineOffsetSec * 1000) : null,
        };
      };

      const starved = mk('starved', 1, -400, null);
      const approachingLowPrio = mk('approaching-low', 2, -5, +20);
      const distantHighPrio = mk('distant-high', 20, -5, +600);
      const noDeadlineLowPrio = mk('no-dl-low', 1, -5, null);

      expect(compareCandidatesByPolicy(starved, approachingLowPrio, cfg, now)).toBeLessThan(0);
      expect(compareCandidatesByPolicy(approachingLowPrio, distantHighPrio, cfg, now)).toBeLessThan(
        0,
      );
      expect(compareCandidatesByPolicy(distantHighPrio, noDeadlineLowPrio, cfg, now)).toBeLessThan(
        0,
      );
    });
  });

  describe('2. PostgreSQL distributed DRR, EDF, Hybrid & API integration tests', () => {
    const createdOrgIds: string[] = [];
    const createdUserIds: string[] = [];
    const scheduler = new PrioritySchedulerService();

    async function createTestOrgAndQueue(opts: {
      slugPrefix: string;
      policy: SchedulingPolicy;
      orgWeight?: number;
      drrBaseQuantum?: number;
      drrMaxDeficit?: number;
      drrInitialDeficit?: number;
      queueWeight?: number;
      urgencyWindowSec?: number;
    }) {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const org = await prisma.organisation.create({
        data: {
          name: `P84 ${opts.slugPrefix} ${suffix}`,
          schedulingWeight: opts.orgWeight ?? 1,
          drrBaseQuantum: opts.drrBaseQuantum ?? 10,
          drrMaxDeficit: opts.drrMaxDeficit ?? 200,
          schedulingDeficit: opts.drrInitialDeficit ?? 0,
        },
      });
      createdOrgIds.push(org.id);

      const queue = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `q-${opts.slugPrefix}-${suffix}`,
          schedulingPolicy: opts.policy,
          schedulingWeight: opts.queueWeight ?? 1,
          deadlineUrgencyWindowSec: opts.urgencyWindowSec ?? 60,
          concurrency: 20,
        },
      });
      return { org, queue };
    }

    async function seedJobs(
      queue: { id: string; schedulingPolicy: SchedulingPolicy; agingRatePerSec: number },
      specs: Array<{
        name: string;
        priority?: number;
        cost?: number;
        readyAt?: Date;
        deadlineAt?: Date | null;
        status?: JobStatus;
      }>,
    ) {
      const now = new Date();
      const created = [];
      for (const s of specs) {
        const prio = s.priority ?? 5;
        const readyAt = s.readyAt ?? now;
        const fields = buildInitialSchedulingFields(queue, prio, 0, readyAt);
        const job = await prisma.job.create({
          data: {
            queueId: queue.id,
            name: s.name,
            status: s.status ?? JobStatus.PENDING,
            priority: prio,
            payload: {},
            schedulingCost: s.cost ?? 1,
            deadlineAt: s.deadlineAt ?? null,
            dispatchState: JobDispatchState.QUEUED,
            readyAt,
            virtualRankAt: fields.virtualRankAt,
          },
        });
        created.push(job);
      }
      return created;
    }

    afterAll(async () => {
      if (createdOrgIds.length > 0) {
        await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      }
    });

    it('distributes capacity proportionally (1:2:4) across weighted organisations via DRR', async () => {
      const t1 = await createTestOrgAndQueue({
        slugPrefix: 'w1',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 1,
        drrBaseQuantum: 2,
      });
      const t2 = await createTestOrgAndQueue({
        slugPrefix: 'w2',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 2,
        drrBaseQuantum: 2,
      });
      const t4 = await createTestOrgAndQueue({
        slugPrefix: 'w4',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 4,
        drrBaseQuantum: 2,
      });

      const mkSpecs = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, i) => ({ name: `${prefix}-${i}`, cost: 1 }));

      await Promise.all([
        seedJobs(t1.queue, mkSpecs('w1', 30)),
        seedJobs(t2.queue, mkSpecs('w2', 30)),
        seedJobs(t4.queue, mkSpecs('w4', 30)),
      ]);

      let c1 = 0;
      let c2 = 0;
      let c4 = 0;
      for (let round = 0; round < 3; round++) {
        const [r1, r2, r4] = await Promise.all([
          scheduler.claimCandidatesForQueue({
            queueId: t1.queue.id,
            limit: 20,
            claimerId: 'drr-test',
          }),
          scheduler.claimCandidatesForQueue({
            queueId: t2.queue.id,
            limit: 20,
            claimerId: 'drr-test',
          }),
          scheduler.claimCandidatesForQueue({
            queueId: t4.queue.id,
            limit: 20,
            claimerId: 'drr-test',
          }),
        ]);
        c1 += r1.claimed.length;
        c2 += r2.claimed.length;
        c4 += r4.claimed.length;
      }

      // 3 rounds * baseQuantum 2 * weights (1, 2, 4) => exact 6, 12, 24
      expect(c1).toBe(6);
      expect(c2).toBe(12);
      expect(c4).toBe(24);
    });

    it('prevents large-job starvation by accumulating DRR deficit across rounds and resets idle deficit', async () => {
      const { org, queue } = await createTestOrgAndQueue({
        slugPrefix: 'large',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 1,
        drrBaseQuantum: 5,
        drrMaxDeficit: 100,
      });

      await seedJobs(queue, [{ name: 'heavy-job', cost: 12 }]);

      // Round 1: deficit 0 -> 5 (< 12) => deferred, retained at 5
      const r1 = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 5,
        claimerId: 'large-test',
      });
      expect(r1.claimed).toHaveLength(0);
      expect(r1.skippedReason).toBe('drr_insufficient_deficit');

      // Round 2: deficit 5 -> 10 (< 12) => deferred, retained at 10
      const r2 = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 5,
        claimerId: 'large-test',
      });
      expect(r2.claimed).toHaveLength(0);
      expect(r2.skippedReason).toBe('drr_insufficient_deficit');

      // Round 3: deficit 10 -> 15 (>= 12) => claimed! Remainder = 3
      const r3 = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 5,
        claimerId: 'large-test',
      });
      expect(r3.claimed).toHaveLength(1);
      expect(r3.claimed[0]!.name).toBe('heavy-job');
      expect(r3.claimed[0]!.schedulingDecision?.deficitAfter).toBe(3);

      // Round 4 (now idle): deficit resets to 0 so idle org cannot hoard credit
      const r4 = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 5,
        claimerId: 'large-test',
      });
      expect(r4.claimed).toHaveLength(0);
      const updatedOrg = await prisma.organisation.findUnique({
        where: { id: org.id },
        select: { schedulingDeficit: true, drrVersion: true },
      });
      expect(updatedOrg?.schedulingDeficit).toBe(0);
      expect(updatedOrg?.drrVersion).toBe(4);
    });

    it('serializes concurrent multi-process DRR claims with zero duplicates and exact deficit conservation', async () => {
      const { org, queue } = await createTestOrgAndQueue({
        slugPrefix: 'conc',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 1,
        drrBaseQuantum: 1,
        drrInitialDeficit: 5,
      });

      await seedJobs(
        queue,
        Array.from({ length: 12 }, (_, i) => ({ name: `conc-job-${i}`, cost: 1 })),
      );

      // 5 concurrent scheduler instances racing without adding new round quantum
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          scheduler.claimCandidatesForQueue({
            queueId: queue.id,
            limit: 3,
            claimerId: `sched-${n}`,
            accumulateDrrRound: false,
          }),
        ),
      );

      const allClaimedIds = results.flatMap((r) => r.claimed.map((c) => c.id));
      const uniqueIds = new Set(allClaimedIds);
      expect(uniqueIds.size).toBe(allClaimedIds.length);
      expect(allClaimedIds.length).toBe(5);

      const finalOrg = await prisma.organisation.findUnique({
        where: { id: org.id },
        select: { schedulingDeficit: true },
      });
      expect(finalOrg?.schedulingDeficit).toBe(0);
    });

    it('enforces DEADLINE_AWARE EDF ordering in PostgreSQL, excludes delayed jobs, and persists schedulingDecision + deadlineMissedAt', async () => {
      const { queue } = await createTestOrgAndQueue({
        slugPrefix: 'edf',
        policy: SchedulingPolicy.DEADLINE_AWARE,
        urgencyWindowSec: 60,
      });

      const now = new Date();
      await seedJobs(queue, [
        {
          name: 'delayed-urgent',
          priority: 20,
          readyAt: new Date(now.getTime() + 60_000),
          deadlineAt: new Date(now.getTime() + 5_000),
          status: JobStatus.DELAYED,
        },
        { name: 'no-deadline', priority: 20, readyAt: now, deadlineAt: null },
        {
          name: 'expired-newer',
          priority: 5,
          readyAt: now,
          deadlineAt: new Date(now.getTime() - 5_000),
        },
        {
          name: 'expired-older',
          priority: 2,
          readyAt: now,
          deadlineAt: new Date(now.getTime() - 15_000),
        },
        {
          name: 'later-dl',
          priority: 20,
          readyAt: now,
          deadlineAt: new Date(now.getTime() + 45_000),
        },
        {
          name: 'earliest-active-dl',
          priority: 2,
          readyAt: now,
          deadlineAt: new Date(now.getTime() + 10_000),
        },
      ]);

      const res = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 10,
        claimerId: 'edf-test',
        now,
      });

      // Strict EDF: overdue jobs ordered by earliest absolute deadline precede future deadlines
      expect(res.claimed.map((j) => j.name)).toEqual([
        'expired-older',
        'expired-newer',
        'earliest-active-dl',
        'later-dl',
        'no-deadline',
      ]);

      const expiredClaim = res.claimed.find((j) => j.name === 'expired-older');
      expect(expiredClaim?.deadlineMissedAt).not.toBeNull();
      expect(expiredClaim?.schedulingDecision?.reason).toBe('expired_deadline_recovery');

      const activeClaim = res.claimed.find((j) => j.name === 'earliest-active-dl');
      const dbActive = await prisma.job.findUnique({
        where: { id: activeClaim!.id },
        select: { schedulingDecision: true },
      });
      expect(dbActive?.schedulingDecision).toMatchObject({
        policy: 'DEADLINE_AWARE',
        reason: 'approaching_deadline_edf',
      });
    });

    it('prevents urgent-deadline flood from one tenant starving another tenant under HYBRID_FAIR_DEADLINE', async () => {
      const floodTenant = await createTestOrgAndQueue({
        slugPrefix: 'flood-a',
        policy: SchedulingPolicy.HYBRID_FAIR_DEADLINE,
        orgWeight: 1,
        drrBaseQuantum: 2,
      });
      const fairTenant = await createTestOrgAndQueue({
        slugPrefix: 'fair-b',
        policy: SchedulingPolicy.HYBRID_FAIR_DEADLINE,
        orgWeight: 2,
        drrBaseQuantum: 2,
      });

      const now = new Date();
      await seedJobs(
        floodTenant.queue,
        Array.from({ length: 15 }, (_, i) => ({
          name: `urgent-flood-${i}`,
          priority: 20,
          readyAt: now,
          deadlineAt: new Date(now.getTime() + 5_000 + i * 100),
        })),
      );
      await seedJobs(
        fairTenant.queue,
        Array.from({ length: 15 }, (_, i) => ({
          name: `normal-b-${i}`,
          priority: 5,
          readyAt: now,
          deadlineAt: null,
        })),
      );

      // 2 rounds: Flood Tenant (weight 1 * quantum 2) gets 4; Fair Tenant (weight 2 * quantum 2) gets 8
      let floodClaimed = 0;
      let fairClaimed = 0;
      for (let i = 0; i < 2; i++) {
        const ra = await scheduler.claimCandidatesForQueue({
          queueId: floodTenant.queue.id,
          limit: 10,
          claimerId: 'hybrid-test',
          now,
        });
        const rb = await scheduler.claimCandidatesForQueue({
          queueId: fairTenant.queue.id,
          limit: 10,
          claimerId: 'hybrid-test',
          now,
        });
        floodClaimed += ra.claimed.length;
        fairClaimed += rb.claimed.length;
      }

      expect(floodClaimed).toBe(4);
      expect(fairClaimed).toBe(8);
    });

    it('prevents multi-process DRR quantum over-accumulation within the same logical round while preserving large-job accumulation across rounds', async () => {
      const mockAdapter = {
        dispatchClaimedJob: async () => ({
          enqueued: true,
          deduplicated: false,
          bullmqJobId: 'mock-id',
          bullmqQueueName: 'mock-queue',
        }),
      };

      // Two completely independent PrioritySchedulerService instances (separate in-memory state)
      const procA = new PrioritySchedulerService(mockAdapter);
      const procB = new PrioritySchedulerService(mockAdapter);

      // Part 1: Unit-cost jobs — two independent processes ticking inside the same 250ms round
      // must accumulate at most 1x quantum (4) across BOTH processes, never 2x (8).
      const { org: unitOrg, queue: unitQueue } = await createTestOrgAndQueue({
        slugPrefix: 'mp-unit',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 1,
        drrBaseQuantum: 4,
        drrMaxDeficit: 100,
      });

      const t0 = new Date();
      await seedJobs(
        unitQueue,
        Array.from({ length: 12 }, (_, i) => ({ name: `mp-u-${i}`, cost: 1, readyAt: t0 })),
      );

      const [sumA, sumB] = await Promise.all([
        procA.tickAllQueues({
          organisationId: unitOrg.id,
          claimerId: 'proc-a',
          now: t0,
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
        procB.tickAllQueues({
          organisationId: unitOrg.id,
          claimerId: 'proc-b',
          now: new Date(t0.getTime() + 20),
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
      ]);

      expect(sumA.dispatched + sumB.dispatched).toBe(4);
      const unitOrgAfter = await prisma.organisation.findUnique({
        where: { id: unitOrg.id },
        select: { schedulingDeficit: true, drrVersion: true },
      });
      expect(unitOrgAfter?.schedulingDeficit).toBe(0);
      expect(unitOrgAfter?.drrVersion).toBe(1);

      // Part 2: Large job (cost 9, quantum 4) across 3 logical rounds with 2 concurrent processes each round
      const { org: heavyOrg, queue: heavyQueue } = await createTestOrgAndQueue({
        slugPrefix: 'mp-heavy',
        policy: SchedulingPolicy.WEIGHTED_FAIR,
        orgWeight: 1,
        drrBaseQuantum: 4,
        drrMaxDeficit: 100,
      });
      await seedJobs(heavyQueue, [
        { name: 'mp-large-9', cost: 9, readyAt: t0 },
        { name: 'mp-followup-10', cost: 10, readyAt: new Date(t0.getTime() + 1) },
      ]);

      // Round 1 (t0): both procs tick -> deficit = 4 (< 9), 0 dispatched
      const r1 = await Promise.all([
        procA.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-a',
          now: t0,
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
        procB.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-b',
          now: new Date(t0.getTime() + 25),
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
      ]);
      expect(r1[0].dispatched + r1[1].dispatched).toBe(0);
      expect(
        (await prisma.organisation.findUnique({ where: { id: heavyOrg.id } }))?.schedulingDeficit,
      ).toBe(4);

      // Round 2 (t0 + 300ms): both procs tick -> deficit = 8 (< 9), 0 dispatched
      const t1 = new Date(t0.getTime() + 300);
      const r2 = await Promise.all([
        procA.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-a',
          now: t1,
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
        procB.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-b',
          now: new Date(t1.getTime() + 25),
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
      ]);
      expect(r2[0].dispatched + r2[1].dispatched).toBe(0);
      expect(
        (await prisma.organisation.findUnique({ where: { id: heavyOrg.id } }))?.schedulingDeficit,
      ).toBe(8);

      // Round 3 (t0 + 600ms): both procs tick -> deficit = 12 (>= 9), large job dispatched ONCE, remainder = 3
      const t2 = new Date(t0.getTime() + 600);
      const r3 = await Promise.all([
        procA.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-a',
          now: t2,
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
        procB.tickAllQueues({
          organisationId: heavyOrg.id,
          claimerId: 'proc-b',
          now: new Date(t2.getTime() + 25),
          drrMinRoundIntervalMs: 250,
          adapter: mockAdapter,
        }),
      ]);
      expect(r3[0].dispatched + r3[1].dispatched).toBe(1);
      expect(
        (await prisma.organisation.findUnique({ where: { id: heavyOrg.id } }))?.schedulingDeficit,
      ).toBe(3);
    });

    it('exposes Phase 8.4 governance, queue, job deadline/cost, and scheduler monitoring APIs with RBAC', async () => {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const admin = await prisma.user.create({
        data: {
          email: `p84-admin-${suffix}@test.local`,
          name: 'P84 Admin',
          passwordHash: 'hash',
        },
      });
      const member = await prisma.user.create({
        data: {
          email: `p84-member-${suffix}@test.local`,
          name: 'P84 Member',
          passwordHash: 'hash',
        },
      });
      createdUserIds.push(admin.id, member.id);

      const org = await prisma.organisation.create({
        data: {
          name: `P84 API Org ${suffix}`,
          memberships: {
            create: [
              { userId: admin.id, role: Role.ADMIN },
              { userId: member.id, role: Role.MEMBER },
            ],
          },
        },
      });
      createdOrgIds.push(org.id);

      const adminToken = signAccessToken(admin.id, admin.email);
      const memberToken = signAccessToken(member.id, member.email);

      // RBAC: MEMBER cannot update org DRR weights
      const forbiddenRes = await request(app)
        .patch(`/api/v1/organisations/${org.id}/governance/quotas`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ schedulingWeight: 4, drrBaseQuantum: 15, drrMaxDeficit: 300 });
      expect(forbiddenRes.status).toBe(403);

      // ADMIN updates org DRR weights
      const govRes = await request(app)
        .patch(`/api/v1/organisations/${org.id}/governance/quotas`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ schedulingWeight: 4, drrBaseQuantum: 15, drrMaxDeficit: 300 });
      expect(govRes.status).toBe(200);
      expect(govRes.body.data.governance.fairness).toMatchObject({
        schedulingWeight: 4,
        drrBaseQuantum: 15,
        drrMaxDeficit: 300,
      });

      // Create HYBRID_FAIR_DEADLINE queue with schedulingWeight and deadlineUrgencyWindowSec
      const queueRes = await request(app)
        .post(`/api/v1/organisations/${org.id}/queues`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: `hybrid-q-${suffix}`,
          schedulingPolicy: 'HYBRID_FAIR_DEADLINE',
          schedulingWeight: 3,
          deadlineUrgencyWindowSec: 45,
        });
      expect(queueRes.status).toBe(201);
      expect(queueRes.body.data.queue).toMatchObject({
        schedulingPolicy: 'HYBRID_FAIR_DEADLINE',
        schedulingWeight: 3,
        deadlineUrgencyWindowSec: 45,
      });
      const queueId = queueRes.body.data.queue.id as string;

      // Submit job with UTC deadlineAt and schedulingCost
      const deadlineIso = new Date(Date.now() + 30_000).toISOString();
      const jobRes = await request(app)
        .post(`/api/v1/organisations/${org.id}/queues/${queueId}/jobs`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'deadline-job',
          priority: 10,
          schedulingCost: 5,
          deadlineAt: deadlineIso,
        });
      expect(jobRes.status).toBe(201);
      expect(jobRes.body.data.job).toMatchObject({
        schedulingCost: 5,
        deadlineAt: deadlineIso,
      });

      // GET /monitoring/scheduler includes fairness & deadlines sections
      const monRes = await request(app)
        .get(`/api/v1/organisations/${org.id}/monitoring/scheduler`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(monRes.status).toBe(200);
      expect(monRes.body.data.scheduler.fairness).toMatchObject({
        schedulingWeight: 4,
        drrBaseQuantum: 15,
        drrMaxDeficit: 300,
      });
      expect(monRes.body.data.scheduler.deadlines.withDeadlinePending).toBeGreaterThanOrEqual(1);
      expect(monRes.body.data.scheduler.deadlines.approachingDeadlineCount).toBeGreaterThanOrEqual(
        1,
      );
    });
  });
});

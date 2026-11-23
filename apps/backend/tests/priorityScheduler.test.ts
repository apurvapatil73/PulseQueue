import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import {
  applyPausedShift,
  clampBasePriority,
  compareCandidatesByPolicy,
  computeClampCutoffAt,
  computePausedShiftMs,
  computeReadyAt,
  computeVirtualRankAt,
  evaluateCandidateScore,
  prioritySchedulerService,
  rankEligibleCandidates,
  type JobDispatchAdapter,
  type SchedulingCandidateInput,
  type SchedulingPolicyConfig,
} from '../src/services/priorityScheduler.service.js';

describe('Milestone 8.3.1 — Custom Priority Scheduling & Virtual-Time Foundation', () => {
  describe('Pure Virtual-Time Math, Equivalence, Clamping & Pause Exclusion', () => {
    const baseNow = new Date('2026-11-23T12:00:00.000Z');
    const agingConfig: SchedulingPolicyConfig = {
      schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      agingRatePerSec: 0.05,
      maxEffectivePriority: 25.0,
      starvationThresholdSec: 300,
    };

    it('clamps base priority boundaries into [1..20] and preserves higher-is-more-urgent semantics', () => {
      expect(clampBasePriority(0)).toBe(1);
      expect(clampBasePriority(-5)).toBe(1);
      expect(clampBasePriority(1)).toBe(1);
      expect(clampBasePriority(20)).toBe(20);
      expect(clampBasePriority(99)).toBe(20);

      const vHigh = computeVirtualRankAt(baseNow, 20, 0.05);
      const vLow = computeVirtualRankAt(baseNow, 1, 0.05);
      // Higher priority -> smaller (earlier) virtualRankAt
      expect(vHigh.getTime()).toBeLessThan(vLow.getTime());
      expect(vLow.getTime() - vHigh.getTime()).toBe(Math.round((19 / 0.05) * 1000));
    });

    it('proves algebraic equivalence V(j1) < V(j2) <=> P_eff(j1, t) > P_eff(j2, t) on unclamped linear band', () => {
      const rates = [0.01, 0.05, 0.25, 1.0];
      for (const rate of rates) {
        const cfg: SchedulingPolicyConfig = {
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
          agingRatePerSec: rate,
          maxEffectivePriority: 1000, // keep all jobs strictly in unclamped Band 2
          starvationThresholdSec: null,
        };
        const jobs: SchedulingCandidateInput[] = [
          { id: 'a', priority: 20, readyAt: new Date(baseNow.getTime() - 10_000) },
          { id: 'b', priority: 10, readyAt: new Date(baseNow.getTime() - 250_000) },
          { id: 'c', priority: 5, readyAt: new Date(baseNow.getTime() - 400_000) },
          { id: 'd', priority: 1, readyAt: new Date(baseNow.getTime() - 50_000) },
        ];

        for (let i = 0; i < jobs.length; i += 1) {
          for (let j = i + 1; j < jobs.length; j += 1) {
            const ei = evaluateCandidateScore(jobs[i], cfg, baseNow);
            const ej = evaluateCandidateScore(jobs[j], cfg, baseNow);
            expect(ei.band).toBe(2);
            expect(ej.band).toBe(2);
            if (ei.effectivePriority > ej.effectivePriority) {
              expect(ei.virtualRankAt.getTime()).toBeLessThan(ej.virtualRankAt.getTime());
            } else if (ei.effectivePriority < ej.effectivePriority) {
              expect(ei.virtualRankAt.getTime()).toBeGreaterThan(ej.virtualRankAt.getTime());
            } else {
              expect(ei.virtualRankAt.getTime()).toBe(ej.virtualRankAt.getTime());
            }
          }
        }
      }
    });

    it('prevents clamping-induced ordering inconsistency via Band 1 FIFO tie-breaking', () => {
      // Disable starvation band to isolate Band 1 (clamped at 25.0)
      const clampOnlyConfig: SchedulingPolicyConfig = {
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        agingRatePerSec: 0.05,
        maxEffectivePriority: 25.0,
        starvationThresholdSec: null,
      };

      // Job A: P=20 waiting 150s -> unclamped 27.5 -> clamped 25.0 (V = now - 550s)
      const jobA: SchedulingCandidateInput = {
        id: 'job-a',
        priority: 20,
        readyAt: new Date(baseNow.getTime() - 150_000),
      };
      // Job B: P=1 waiting 490s -> unclamped 25.5 -> clamped 25.0 (V = now - 510s)
      const jobB: SchedulingCandidateInput = {
        id: 'job-b',
        priority: 1,
        readyAt: new Date(baseNow.getTime() - 490_000),
      };

      const evalA = evaluateCandidateScore(jobA, clampOnlyConfig, baseNow);
      const evalB = evaluateCandidateScore(jobB, clampOnlyConfig, baseNow);

      expect(evalA.band).toBe(1);
      expect(evalB.band).toBe(1);
      expect(evalA.effectivePriority).toBe(25.0);
      expect(evalB.effectivePriority).toBe(25.0);
      // Raw virtualRankAt would mistakenly put jobA first (now-550s < now-510s),
      // but Band 1 FIFO tie-breaking strictly puts older jobB ahead of jobA.
      expect(evalA.virtualRankAt.getTime()).toBeLessThan(evalB.virtualRankAt.getTime());
      expect(compareCandidatesByPolicy(jobB, jobA, clampOnlyConfig, baseNow)).toBeLessThan(0);

      const ranked = rankEligibleCandidates([jobA, jobB], clampOnlyConfig, baseNow);
      expect(ranked.map((j) => j.id)).toEqual(['job-b', 'job-a']);
    });

    it('promotes starved jobs into Band 0 ahead of clamped and critical arrivals, ordered oldest first', () => {
      const starvedOldest: SchedulingCandidateInput = {
        id: 'starved-1',
        priority: 1,
        readyAt: new Date(baseNow.getTime() - 360_000), // 360s >= 300s
      };
      const starvedNewer: SchedulingCandidateInput = {
        id: 'starved-2',
        priority: 5,
        readyAt: new Date(baseNow.getTime() - 310_000), // 310s >= 300s
      };
      const clampedCritical: SchedulingCandidateInput = {
        id: 'clamped-crit',
        priority: 20,
        readyAt: new Date(baseNow.getTime() - 150_000), // clamped at 25, not starved
      };
      const freshCritical: SchedulingCandidateInput = {
        id: 'fresh-crit',
        priority: 20,
        readyAt: new Date(baseNow.getTime() - 1_000),
      };

      const ranked = rankEligibleCandidates(
        [freshCritical, clampedCritical, starvedNewer, starvedOldest],
        agingConfig,
        baseNow,
      );
      expect(ranked.map((j) => j.id)).toEqual([
        'starved-1',
        'starved-2',
        'clamped-crit',
        'fresh-crit',
      ]);
    });

    it('excludes delayed jobs until readyAt <= now and breaks ties deterministically by readyAt then id', () => {
      const delayed = {
        id: 'delayed',
        priority: 20,
        readyAt: computeReadyAt(baseNow, 5_000), // 5s in future
      };
      const tieB = { id: 'id-b', priority: 10, readyAt: new Date(baseNow.getTime() - 10_000) };
      const tieA = { id: 'id-a', priority: 10, readyAt: new Date(baseNow.getTime() - 10_000) };

      const ranked = rankEligibleCandidates([delayed, tieB, tieA], agingConfig, baseNow);
      expect(ranked.map((j) => j.id)).toEqual(['id-a', 'id-b']);
    });

    it('excludes paused time accurately across pre-pause, during-pause, and delayed-past-resume jobs', () => {
      const pausedAt = new Date('2026-11-23T12:00:00.000Z');
      const resumedAt = new Date('2026-11-23T12:02:00.000Z'); // 120s pause

      // Case 1: Ready 30s before pause -> shifts full 120s -> retains 30s wait at resume
      const prePauseReady = new Date(pausedAt.getTime() - 30_000);
      const prePauseV = computeVirtualRankAt(prePauseReady, 5, 0.05);
      const shifted1 = applyPausedShift(prePauseReady, prePauseV, pausedAt, resumedAt);
      expect(shifted1.shiftMs).toBe(120_000);
      expect(resumedAt.getTime() - shifted1.readyAt.getTime()).toBe(30_000);
      expect(shifted1.virtualRankAt.getTime() - prePauseV.getTime()).toBe(120_000);

      // Case 2: Submitted 40s into pause -> shifts 80s -> 0s wait at resume
      const duringPauseReady = new Date(pausedAt.getTime() + 40_000);
      expect(computePausedShiftMs(duringPauseReady, pausedAt, resumedAt)).toBe(80_000);

      // Case 3: Delayed until 60s after resume -> shifts 0ms
      const futureReady = new Date(resumedAt.getTime() + 60_000);
      expect(computePausedShiftMs(futureReady, pausedAt, resumedAt)).toBe(0);
    });

    it('computes clamp cutoff consistent with virtualRankAt boundary', () => {
      const cutoff = computeClampCutoffAt(baseNow, 25.0, 0.05);
      // P=20 needs (25-20)/0.05 = 100s to hit clamp
      const atBoundary = computeVirtualRankAt(new Date(baseNow.getTime() - 100_000), 20, 0.05);
      const justBelow = computeVirtualRankAt(new Date(baseNow.getTime() - 99_000), 20, 0.05);
      expect(atBoundary.getTime()).toBeLessThanOrEqual(cutoff.getTime());
      expect(justBelow.getTime()).toBeGreaterThan(cutoff.getTime());
    });
  });

  describe('PostgreSQL Atomic Claiming, Multi-Process SKIP LOCKED & Compatibility', () => {
    const suffix = `p831_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    let ownerToken = '';
    let orgId = '';
    let legacyQueueId = '';
    let agingQueueId = '';
    let fifoQueueId = '';
    let strictQueueId = '';
    let quotaOrgId = '';
    let quotaQueue1Id = '';
    let quotaQueue2Id = '';

    beforeAll(async () => {
      const email = `sched_owner_${suffix}@pulsequeue.dev`;
      const password = 'SecurePassword123!';
      const reg = await request(app)
        .post('/api/v1/auth/register')
        .send({ name: 'Scheduler Owner', email, password });
      expect(reg.status).toBe(201);
      const login = await request(app).post('/api/v1/auth/login').send({ email, password });
      expect(login.status).toBe(200);
      ownerToken = login.body.data.accessToken;

      const orgRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `Sched Org ${suffix}` });
      expect(orgRes.status).toBe(201);
      orgId = orgRes.body.data.organisation.id;

      // Default queue -> must remain LEGACY_BULLMQ
      const legacyRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `legacy-q-${suffix}` });
      expect(legacyRes.status).toBe(201);
      expect(legacyRes.body.data.queue.schedulingPolicy).toBe(SchedulingPolicy.LEGACY_BULLMQ);
      legacyQueueId = legacyRes.body.data.queue.id;

      const agingRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: `aging-q-${suffix}`,
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
          agingRatePerSec: 0.05,
          maxEffectivePriority: 25.0,
          starvationThresholdSec: 300,
        });
      expect(agingRes.status).toBe(201);
      agingQueueId = agingRes.body.data.queue.id;

      const fifoRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `fifo-q-${suffix}`, schedulingPolicy: SchedulingPolicy.FIFO });
      expect(fifoRes.status).toBe(201);
      fifoQueueId = fifoRes.body.data.queue.id;

      const strictRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `strict-q-${suffix}`, schedulingPolicy: SchedulingPolicy.STRICT_PRIORITY });
      expect(strictRes.status).toBe(201);
      strictQueueId = strictRes.body.data.queue.id;

      // Dedicated org for tenant-level maxActiveJobs reservation tests
      const qOrg = await prisma.organisation.create({
        data: { name: `Sched Quota Org ${suffix}`, maxActiveJobs: 3 },
      });
      quotaOrgId = qOrg.id;
      const qq1 = await prisma.queue.create({
        data: {
          organisationId: quotaOrgId,
          name: `qq1-${suffix}`,
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        },
      });
      const qq2 = await prisma.queue.create({
        data: {
          organisationId: quotaOrgId,
          name: `qq2-${suffix}`,
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        },
      });
      quotaQueue1Id = qq1.id;
      quotaQueue2Id = qq2.id;
    });

    afterAll(async () => {
      await prisma.organisation.deleteMany({ where: { id: { in: [orgId, quotaOrgId] } } });
      await bullMQService.closeAll();
    });

    it('keeps LEGACY_BULLMQ inactive in PrioritySchedulerService and preserves normal submission', async () => {
      const submit = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues/${legacyQueueId}/jobs`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'echo', payload: { legacy: true } });
      expect(submit.status).toBe(201);

      const claim = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: legacyQueueId,
        claimerId: 'sched-legacy-check',
        limit: 10,
      });
      expect(claim.skippedReason).toBe('legacy_policy');
      expect(claim.claimed).toHaveLength(0);
    });

    it('matches SQL 3-band PRIORITY_AGING claim order 100% identically to the pure reference comparator', async () => {
      const fixedNow = new Date('2026-11-23T15:00:00.000Z');
      const cfg: SchedulingPolicyConfig = {
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        agingRatePerSec: 0.05,
        maxEffectivePriority: 25.0,
        starvationThresholdSec: 300,
      };

      // Seed 30 deterministic jobs spanning Band 0 (starved), Band 1 (clamped), Band 2 (linear),
      // plus 3 delayed (future readyAt) and 1 quarantined job that must be excluded
      const seededInputs: SchedulingCandidateInput[] = [];
      for (let i = 0; i < 30; i += 1) {
        const priority = 1 + ((i * 7) % 20);
        const ageSec = (i * 23) % 520; // spans 0..519s (Band 0, Band 1, Band 2)
        const readyAt = new Date(fixedNow.getTime() - ageSec * 1000);
        const virtualRankAt = computeVirtualRankAt(readyAt, priority, cfg.agingRatePerSec);
        const created = await prisma.job.create({
          data: {
            queueId: agingQueueId,
            name: 'echo',
            status: JobStatus.PENDING,
            priority,
            dispatchState: JobDispatchState.QUEUED,
            readyAt,
            virtualRankAt,
          },
          select: { id: true, priority: true, readyAt: true, virtualRankAt: true },
        });
        seededInputs.push(created);
      }

      // Add delayed (ineligible) and quarantined (ineligible) jobs
      await prisma.job.create({
        data: {
          queueId: agingQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 20,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(fixedNow.getTime() + 60_000),
          virtualRankAt: computeVirtualRankAt(
            new Date(fixedNow.getTime() + 60_000),
            20,
            cfg.agingRatePerSec,
          ),
        },
      });
      await prisma.job.create({
        data: {
          queueId: agingQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 20,
          isQuarantined: true,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(fixedNow.getTime() - 1000_000),
          virtualRankAt: computeVirtualRankAt(
            new Date(fixedNow.getTime() - 1000_000),
            20,
            cfg.agingRatePerSec,
          ),
        },
      });

      const expectedOrder = rankEligibleCandidates(seededInputs, cfg, fixedNow).map((j) => j.id);
      expect(expectedOrder).toHaveLength(30);

      // Claim in batches of 7 via SQL and concatenate
      const actualOrder: string[] = [];
      for (let round = 0; round < 6; round += 1) {
        const res = await prioritySchedulerService.claimCandidatesForQueue({
          queueId: agingQueueId,
          claimerId: `sched-equiv-${round}`,
          limit: 7,
          now: fixedNow,
        });
        actualOrder.push(...res.claimed.map((j) => j.id));
        if (res.claimed.length === 0) break;
      }

      expect(actualOrder).toEqual(expectedOrder);

      // Clean up aging queue jobs for subsequent tests
      await prisma.job.deleteMany({ where: { queueId: agingQueueId } });
    });

    it('enforces FIFO and STRICT_PRIORITY ordering accurately in PostgreSQL', async () => {
      const now = new Date('2026-11-23T16:00:00.000Z');
      // FIFO: older P=1 must beat newer P=20
      const fOld = await prisma.job.create({
        data: {
          queueId: fifoQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 1,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 20_000),
          virtualRankAt: new Date(now.getTime() - 20_000),
        },
      });
      const fNew = await prisma.job.create({
        data: {
          queueId: fifoQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 20,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 5_000),
          virtualRankAt: new Date(now.getTime() - 5_000),
        },
      });
      const fifoClaim = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: fifoQueueId,
        claimerId: 'sched-fifo',
        limit: 5,
        now,
      });
      expect(fifoClaim.claimed.map((j) => j.id)).toEqual([fOld.id, fNew.id]);

      // STRICT_PRIORITY: newer P=20 must beat older P=1
      const sOld = await prisma.job.create({
        data: {
          queueId: strictQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 1,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 600_000),
          virtualRankAt: new Date(now.getTime() - 600_000),
        },
      });
      const sNew = await prisma.job.create({
        data: {
          queueId: strictQueueId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 20,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 1_000),
          virtualRankAt: new Date(now.getTime() - 1_000),
        },
      });
      const strictClaim = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: strictQueueId,
        claimerId: 'sched-strict',
        limit: 5,
        now,
      });
      expect(strictClaim.claimed.map((j) => j.id)).toEqual([sNew.id, sOld.id]);
    });

    it('prevents duplicate claims across concurrent SKIP LOCKED scheduler instances and recovers crashed reservations', async () => {
      const now = new Date();
      for (let i = 0; i < 20; i += 1) {
        const readyAt = new Date(now.getTime() - (i + 1) * 1000);
        await prisma.job.create({
          data: {
            queueId: agingQueueId,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 1 + (i % 20),
            dispatchState: JobDispatchState.QUEUED,
            readyAt,
            virtualRankAt: computeVirtualRankAt(readyAt, 1 + (i % 20), 0.05),
          },
        });
      }

      // 4 concurrent scheduler instances each claiming up to 6 jobs
      const results = await Promise.all([
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: agingQueueId,
          claimerId: 'sched-proc-1',
          limit: 6,
          now,
        }),
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: agingQueueId,
          claimerId: 'sched-proc-2',
          limit: 6,
          now,
        }),
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: agingQueueId,
          claimerId: 'sched-proc-3',
          limit: 6,
          now,
        }),
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: agingQueueId,
          claimerId: 'sched-proc-4',
          limit: 6,
          now,
        }),
      ]);

      const allClaimedIds = results.flatMap((r) => r.claimed.map((j) => j.id));
      const uniqueIds = new Set(allClaimedIds);
      expect(allClaimedIds).toHaveLength(20);
      expect(uniqueIds.size).toBe(20);

      // Simulate crash of sched-proc-1: backdate its DISPATCHING claims by 30s
      const staleTime = new Date(Date.now() - 30_000);
      const proc1Ids = results[0].claimed.map((j) => j.id);
      await prisma.job.updateMany({
        where: { id: { in: proc1Ids } },
        data: { dispatchClaimedAt: staleTime },
      });

      const recovered = await prioritySchedulerService.recoverStaleReservations(
        15_000,
        new Date(),
        agingQueueId,
      );
      expect(recovered).toBe(proc1Ids.length);

      // Healthy scheduler can immediately re-claim the recovered jobs
      const reclaimed = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: agingQueueId,
        claimerId: 'sched-healthy',
        limit: 10,
      });
      expect(reclaimed.claimed).toHaveLength(proc1Ids.length);

      await prisma.job.deleteMany({ where: { queueId: agingQueueId } });
    });

    it('enforces tenant-level maxActiveJobs reservation cap atomically across concurrent queues', async () => {
      const now = new Date();
      for (const qId of [quotaQueue1Id, quotaQueue2Id]) {
        for (let i = 0; i < 5; i += 1) {
          const readyAt = new Date(now.getTime() - 10_000);
          await prisma.job.create({
            data: {
              queueId: qId,
              name: 'echo',
              status: JobStatus.PENDING,
              priority: 10,
              dispatchState: JobDispatchState.QUEUED,
              readyAt,
              virtualRankAt: computeVirtualRankAt(readyAt, 10, 0.05),
            },
          });
        }
      }

      // Concurrently claim from both queues under org maxActiveJobs = 3
      const [c1, c2] = await Promise.all([
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: quotaQueue1Id,
          claimerId: 'tenant-sched-1',
          limit: 5,
          now,
        }),
        prioritySchedulerService.claimCandidatesForQueue({
          queueId: quotaQueue2Id,
          claimerId: 'tenant-sched-2',
          limit: 5,
          now,
        }),
      ]);

      expect(c1.claimed.length + c2.claimed.length).toBe(3);

      // Next claim must be blocked with org_active_limit_reached
      const c3 = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: quotaQueue1Id,
        claimerId: 'tenant-sched-3',
        limit: 5,
        now,
      });
      expect(c3.claimed).toHaveLength(0);
      expect(c3.skippedReason).toBe('org_active_limit_reached');

      // Simulating crash + stale reservation cleanup restores tenant capacity
      await prisma.job.updateMany({
        where: { queueId: { in: [quotaQueue1Id, quotaQueue2Id] } },
        data: { dispatchClaimedAt: new Date(Date.now() - 60_000) },
      });
      const recovered = await prioritySchedulerService.recoverStaleReservations(15_000, new Date());
      expect(recovered).toBeGreaterThanOrEqual(3);

      const c4 = await prioritySchedulerService.claimCandidatesForQueue({
        queueId: quotaQueue1Id,
        claimerId: 'tenant-sched-4',
        limit: 2,
      });
      expect(c4.claimed).toHaveLength(2);
    });

    it('shifts ready_at and virtual_rank_at on queue resume so paused time is excluded from aging', async () => {
      const initialReadyAt = new Date(Date.now() - 120_000); // 120s ago
      const initialV = computeVirtualRankAt(initialReadyAt, 5, 0.05);
      const pausedAt = new Date(Date.now() - 60_000); // paused 60s ago

      await prisma.queue.update({
        where: { id: agingQueueId },
        data: { isPaused: true, pausedAt },
      });
      const pausedJob = await prisma.job.create({
        data: {
          queueId: agingQueueId,
          name: 'echo',
          status: JobStatus.PAUSED,
          priority: 5,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: initialReadyAt,
          virtualRankAt: initialV,
        },
      });

      const resumeRes = await request(app)
        .post(`/api/v1/organisations/${orgId}/queues/${agingQueueId}/resume`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(resumeRes.status).toBe(200);

      const refreshed = await prisma.job.findUnique({ where: { id: pausedJob.id } });
      expect(refreshed?.status).toBe(JobStatus.PENDING);
      const shiftMs = refreshed!.readyAt.getTime() - initialReadyAt.getTime();
      // Shifted forward by ~60s (the paused window)
      expect(shiftMs).toBeGreaterThanOrEqual(58_000);
      expect(shiftMs).toBeLessThanOrEqual(65_000);
      expect(refreshed!.virtualRankAt.getTime() - initialV.getTime()).toBe(shiftMs);

      await prisma.job.delete({ where: { id: pausedJob.id } });
    });

    it('decouples candidate claiming from dispatch adapter and releases failed reservations cleanly', async () => {
      const now = new Date();
      const jOk = await prisma.job.create({
        data: {
          queueId: agingQueueId,
          name: 'ok-job',
          status: JobStatus.PENDING,
          priority: 20,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 5_000),
          virtualRankAt: computeVirtualRankAt(new Date(now.getTime() - 5_000), 20, 0.05),
        },
      });
      const jFail = await prisma.job.create({
        data: {
          queueId: agingQueueId,
          name: 'fail-job',
          status: JobStatus.PENDING,
          priority: 5,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: new Date(now.getTime() - 5_000),
          virtualRankAt: computeVirtualRankAt(new Date(now.getTime() - 5_000), 5, 0.05),
        },
      });

      const mockAdapter: JobDispatchAdapter = {
        dispatchClaimedJob: async (_queue, job) => ({
          broker: 'bullmq',
          enqueued: job.id === jOk.id,
          deduplicated: false,
          bullmqQueueName: 'mock',
          bullmqJobId: job.id === jOk.id ? job.id : null,
          error: job.id === jFail.id ? 'Simulated Redis failure' : undefined,
        }),
      };

      const queueRow = await prisma.queue.findUniqueOrThrow({ where: { id: agingQueueId } });
      const summary = await prioritySchedulerService.dispatchBatchWithAdapter(
        queueRow,
        { claimerId: 'adapter-test', limit: 5, now },
        mockAdapter,
      );

      expect(summary).toEqual({
        claimed: 2,
        dispatched: 1,
        released: 1,
        skippedReason: null,
      });

      const [okRow, failRow] = await Promise.all([
        prisma.job.findUnique({ where: { id: jOk.id } }),
        prisma.job.findUnique({ where: { id: jFail.id } }),
      ]);
      expect(okRow?.dispatchState).toBe(JobDispatchState.DISPATCHED);
      expect(failRow?.dispatchState).toBe(JobDispatchState.QUEUED);
      expect(failRow?.dispatchClaimedBy).toBeNull();
    });
  });
});

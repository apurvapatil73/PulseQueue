import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { JobDispatchState, JobStatus, OutboxStatus, Role, SchedulingPolicy } from '@prisma/client';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import {
  computeDistribution,
  computeJainsFairnessIndex,
  computePercentile,
  countPriorityInversions,
  createSeededRng,
} from '../src/benchmark/benchmarkStats.js';
import { computeVirtualRankAt } from '../src/services/priorityScheduler.service.js';
import {
  SchedulerMetricsRegistry,
  mapPriorityToTier,
  schedulerMetricsRegistry,
} from '../src/services/schedulerMetrics.service.js';

describe('Phase 8.3.3 — Scheduler Observability, Privacy, RBAC & Benchmark Stats', () => {
  describe('Bounded-Cardinality SchedulerMetricsRegistry', () => {
    it('tracks counters, gauges, and fixed-bucket histograms with strictly bounded labels', () => {
      const reg = new SchedulerMetricsRegistry();
      reg.setLoopRunning(true);
      reg.recordClaim(SchedulingPolicy.PRIORITY_AGING, 4, 8);
      reg.recordDispatchSuccess(SchedulingPolicy.PRIORITY_AGING, 22, false);
      reg.recordDispatchSuccess(SchedulingPolicy.PRIORITY_AGING, 45, true);
      reg.recordDispatchFailure(SchedulingPolicy.FIFO);
      reg.recordDelayedPromoted(2);
      reg.recordStarvationPromotions(1);
      reg.recordPriorityInversion(1);
      reg.recordTenantCapacityDenial();
      reg.recordReservationRecovery(3);
      reg.recordTickDuration(15);

      const snap = reg.getGlobalSnapshot();
      expect(snap.scope).toBe('global_aggregate');
      expect(snap.gauges.isLoopRunning).toBe(true);
      expect(snap.gauges.lastTickDurationMs).toBe(15);
      expect(snap.gauges.lastBatchSize).toBe(4);
      expect(snap.counters.claimsTotal).toBe(4);
      expect(snap.counters.dispatchesTotal).toBe(2);
      expect(snap.counters.dispatchFailuresTotal).toBe(1);
      expect(snap.counters.dispatchRetriesTotal).toBe(1);
      expect(snap.counters.delayedPromotedTotal).toBe(2);
      expect(snap.counters.starvationPromotionsTotal).toBe(1);
      expect(snap.counters.priorityInversionsTotal).toBe(1);
      expect(snap.counters.tenantCapacityDenialsTotal).toBe(1);
      expect(snap.counters.reservationRecoveriesTotal).toBe(3);
      expect(snap.counters.byPolicy.PRIORITY_AGING).toEqual({
        claims: 4,
        dispatches: 2,
        failures: 0,
      });
      expect(snap.counters.byPolicy.FIFO.failures).toBe(1);
      expect(snap.histograms.claimLatencyMs.unit).toBe('ms');
      expect(snap.histograms.claimLatencyMs.count).toBe(1);
      expect(snap.histograms.dispatchLatencyMs.count).toBe(2);
      expect(snap.histograms.dispatchLatencyMs.avg).toBe(33.5);
      expect(snap.histograms.batchSize.unit).toBe('jobs');
      expect(mapPriorityToTier(20)).toBe('critical');
      expect(mapPriorityToTier(12)).toBe('high');
      expect(mapPriorityToTier(7)).toBe('medium');
      expect(mapPriorityToTier(2)).toBe('low');
    });
  });

  describe('Benchmark Statistics (Percentiles, Jain Fairness, Inversions, Seeded PRNG)', () => {
    it('computes exact percentiles and latency distributions deterministically', () => {
      expect(computePercentile([], 50)).toBeNull();
      expect(computePercentile([42], 95)).toBe(42);
      expect(computePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
      expect(computePercentile([10, 20, 30, 40, 50], 95)).toBe(48);

      const dist = computeDistribution([50, 10, 40, 20, 30]);
      expect(dist).toEqual({
        sampleCount: 5,
        avgMs: 30,
        p50Ms: 30,
        p95Ms: 48,
        p99Ms: 49.6,
        maxMs: 50,
      });
    });

    it('computes Jain fairness index normalized by quota weight for unequal-quota tenants', () => {
      // Equal normalized service despite 2x unequal quotas -> J = 1.0
      const perfect = computeJainsFairnessIndex([
        { tenantLabel: 'big', quotaWeight: 4, completedJobs: 40 },
        { tenantLabel: 'small', quotaWeight: 2, completedJobs: 20 },
      ]);
      expect(perfect.metricDefinition).toBe('completed_jobs_per_quota_weight');
      expect(perfect.jainsFairnessIndex).toBe(1);

      // Completely monopolized -> J = 0.5 for 2 tenants
      const skewed = computeJainsFairnessIndex([
        { tenantLabel: 'big', quotaWeight: 4, completedJobs: 40 },
        { tenantLabel: 'small', quotaWeight: 2, completedJobs: 0 },
      ]);
      expect(skewed.jainsFairnessIndex).toBe(0.5);
    });

    it('counts priority inversions and produces reproducible seeded PRNG sequences', () => {
      const inversions = countPriorityInversions([
        { id: 'low', priority: 2, readyAtMs: 0, startedAtMs: 10 },
        { id: 'high', priority: 20, readyAtMs: 5, startedAtMs: 20 }, // ready before low started!
      ]);
      expect(inversions).toBe(1);

      const noInversion = countPriorityInversions([
        { id: 'high', priority: 20, readyAtMs: 0, startedAtMs: 10 },
        { id: 'low', priority: 2, readyAtMs: 0, startedAtMs: 20 },
      ]);
      expect(noInversion).toBe(0);

      const r1 = createSeededRng(12345);
      const r2 = createSeededRng(12345);
      const seq1 = [r1(), r1(), r1(), r1()];
      const seq2 = [r2(), r2(), r2(), r2()];
      expect(seq1).toEqual(seq2);
    });
  });

  describe('Tenant-Scoped & Global Scheduler Monitoring APIs (RBAC + Isolation + Privacy)', () => {
    const suffix = `obs833_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    let ownerAToken = '';
    let memberAToken = '';
    let ownerBToken = '';
    let orgAId = '';
    let orgBId = '';
    let queueAId = '';

    beforeAll(async () => {
      const mkUser = async (prefix: string) => {
        const email = `${prefix}_${suffix}@pulsequeue.dev`;
        const password = 'SecurePassword123!';
        const reg = await request(app)
          .post('/api/v1/auth/register')
          .send({ name: `${prefix} User`, email, password });
        expect(reg.status).toBe(201);
        const login = await request(app).post('/api/v1/auth/login').send({ email, password });
        expect(login.status).toBe(200);
        return {
          id: reg.body.data.user.id as string,
          token: login.body.data.accessToken as string,
        };
      };

      const ownerA = await mkUser('obs_ownera');
      const memberA = await mkUser('obs_membera');
      const ownerB = await mkUser('obs_ownerb');
      ownerAToken = ownerA.token;
      memberAToken = memberA.token;
      ownerBToken = ownerB.token;

      const orgARes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({ name: `Obs Org A ${suffix}` });
      expect(orgARes.status).toBe(201);
      orgAId = orgARes.body.data.organisation.id;

      await prisma.organisation.update({
        where: { id: orgAId },
        data: { maxActiveJobs: 4 },
      });
      await prisma.membership.create({
        data: { userId: memberA.id, organisationId: orgAId, role: Role.MEMBER },
      });

      const orgBRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerBToken}`)
        .send({ name: `Obs Org B ${suffix}` });
      expect(orgBRes.status).toBe(201);
      orgBId = orgBRes.body.data.organisation.id;
    });

    afterAll(async () => {
      await prisma.organisation.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
    });

    it('enforces authentication (401), RBAC (MEMBER 200), cross-tenant isolation (403), and query validation (400)', async () => {
      const unauth = await request(app).get(`/api/v1/organisations/${orgAId}/monitoring/scheduler`);
      expect(unauth.status).toBe(401);

      const crossTenant = await request(app)
        .get(`/api/v1/organisations/${orgAId}/monitoring/scheduler`)
        .set('Authorization', `Bearer ${ownerBToken}`);
      // requireOrgRole returns 404 for non-members to prevent tenant enumeration
      expect([403, 404]).toContain(crossTenant.status);

      const invalidWindow = await request(app)
        .get(`/api/v1/organisations/${orgAId}/monitoring/scheduler?windowMinutes=999999`)
        .set('Authorization', `Bearer ${memberAToken}`);
      expect(invalidWindow.status).toBe(400);

      // Empty org returns clean zero counts & null percentiles
      const emptyRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/monitoring/scheduler?windowMinutes=60`)
        .set('Authorization', `Bearer ${memberAToken}`);
      expect(emptyRes.status).toBe(200);
      const sched = emptyRes.body.data.scheduler;
      expect(sched.backlog.eligibleQueued).toBe(0);
      expect(sched.backlog.oldestEligibleAgeMs).toBeNull();
      expect(sched.dispatchLatency.sampleCount).toBe(0);
      expect(sched.dispatchLatency.p95Ms).toBeNull();
    });

    it('reports accurate backlog by priority, starvation count, tenant capacity, and preserves global privacy', async () => {
      const qRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/queues`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({
          name: `obs-aging-${suffix}`,
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
          starvationThresholdSec: 60,
        });
      expect(qRes.status).toBe(201);
      queueAId = qRes.body.data.queue.id;

      const now = new Date();
      // 1 starved low-priority job (120s old > 60s threshold), 2 critical queued jobs, 1 active job
      const starvedReady = new Date(now.getTime() - 120_000);
      await prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 2,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: starvedReady,
          virtualRankAt: computeVirtualRankAt(starvedReady, 2, 0.05),
        },
      });
      for (let i = 0; i < 2; i += 1) {
        await prisma.job.create({
          data: {
            queueId: queueAId,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 19,
            dispatchState: JobDispatchState.QUEUED,
            readyAt: now,
            virtualRankAt: computeVirtualRankAt(now, 19, 0.05),
          },
        });
      }
      const activeJob = await prisma.job.create({
        data: {
          queueId: queueAId,
          name: 'echo',
          status: JobStatus.ACTIVE,
          priority: 12,
          dispatchState: JobDispatchState.DISPATCHED,
          readyAt: new Date(now.getTime() - 500),
          firstStartedAt: now,
        },
      });
      await prisma.jobDispatchOutbox.create({
        data: {
          jobId: activeJob.id,
          queueId: queueAId,
          organisationId: orgAId,
          status: OutboxStatus.DISPATCHED,
          dispatchedAt: new Date(now.getTime() - 200),
        },
      });

      const res = await request(app)
        .get(`/api/v1/organisations/${orgAId}/monitoring/scheduler?windowMinutes=60`)
        .set('Authorization', `Bearer ${ownerAToken}`);
      expect(res.status).toBe(200);
      const s = res.body.data.scheduler;
      expect(s.backlog.eligibleQueued).toBe(3);
      expect(s.backlog.starvedEligibleCount).toBe(1);
      expect(s.backlogByPriority.byTier.critical).toBe(2);
      expect(s.backlogByPriority.byTier.low).toBe(1);
      expect(s.tenantCapacity.maxActiveJobs).toBe(4);
      expect(s.tenantCapacity.reservedTotal).toBe(1);
      expect(s.tenantCapacity.utilizationPercent).toBe(25);
      expect(s.schedulerHealth.status).toBe('degraded'); // starved job present
      expect(s.dispatchLatency.sampleCount).toBe(1);

      // Global endpoint must expose aggregate metrics with ZERO tenant-specific identifiers
      schedulerMetricsRegistry.recordClaim(SchedulingPolicy.PRIORITY_AGING, 1, 3);
      const globalRes = await request(app).get('/health/scheduler');
      expect(globalRes.status).toBe(200);
      const serialized = JSON.stringify(globalRes.body);
      expect(globalRes.body.data.scheduler.scope).toBe('global_aggregate');
      expect(serialized).not.toContain(orgAId);
      expect(serialized).not.toContain(orgBId);
      expect(serialized).not.toContain(`obs-aging-${suffix}`);
    });
  });
});

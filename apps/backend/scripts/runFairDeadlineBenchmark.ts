import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import { prisma } from '../src/config/database.js';
import { computeDistribution, computeJainsFairnessIndex } from '../src/benchmark/benchmarkStats.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';

interface ScenarioResult {
  scenario: string;
  policy: string;
  workload: string;
  metrics: Record<string, number | string | null>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  const scheduler = new PrioritySchedulerService();
  const createdOrgIds: string[] = [];
  const results: ScenarioResult[] = [];
  const runTag = `p84bench-${Date.now()}`;

  async function mkOrgQueue(
    label: string,
    policy: SchedulingPolicy,
    opts?: { weight?: number; quantum?: number; maxDeficit?: number; initialDeficit?: number },
  ) {
    const org = await prisma.organisation.create({
      data: {
        name: `${runTag}-${label}`,
        schedulingWeight: opts?.weight ?? 1,
        drrBaseQuantum: opts?.quantum ?? 10,
        drrMaxDeficit: opts?.maxDeficit ?? 200,
        schedulingDeficit: opts?.initialDeficit ?? 0,
      },
    });
    createdOrgIds.push(org.id);
    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `q-${label}`,
        schedulingPolicy: policy,
        concurrency: 50,
        deadlineUrgencyWindowSec: 60,
      },
    });
    return { org, queue };
  }

  async function seedBatch(
    queue: { id: string; schedulingPolicy: SchedulingPolicy; agingRatePerSec: number },
    items: Array<{
      name: string;
      priority?: number;
      cost?: number;
      readyAt: Date;
      deadlineAt?: Date | null;
    }>,
  ) {
    await prisma.job.createMany({
      data: items.map((item) => {
        const prio = item.priority ?? 5;
        const fields = buildInitialSchedulingFields(queue, prio, 0, item.readyAt);
        return {
          queueId: queue.id,
          name: item.name,
          status: JobStatus.PENDING,
          priority: prio,
          payload: {},
          schedulingCost: item.cost ?? 1,
          deadlineAt: item.deadlineAt ?? null,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: item.readyAt,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });
  }

  try {
    const now = new Date();

    // Scenario A: Equal weights (1:1:1)
    {
      const orgs = await Promise.all([
        mkOrgQueue('a1', SchedulingPolicy.WEIGHTED_FAIR, { weight: 1, quantum: 2 }),
        mkOrgQueue('a2', SchedulingPolicy.WEIGHTED_FAIR, { weight: 1, quantum: 2 }),
        mkOrgQueue('a3', SchedulingPolicy.WEIGHTED_FAIR, { weight: 1, quantum: 2 }),
      ]);
      await Promise.all(
        orgs.map((o, idx) =>
          seedBatch(
            o.queue,
            Array.from({ length: 30 }, (_, i) => ({ name: `a${idx}-${i}`, readyAt: now })),
          ),
        ),
      );
      const counts = [0, 0, 0];
      const latencies: number[] = [];
      for (let r = 0; r < 5; r++) {
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          const res = await scheduler.claimCandidatesForQueue({
            queueId: orgs[i]!.queue.id,
            limit: 20,
            claimerId: 'bench-a',
            now,
          });
          latencies.push(Date.now() - t0);
          counts[i]! += res.claimed.length;
        }
      }
      const dist = computeDistribution(latencies);
      results.push({
        scenario: 'A: Equal Weights (1:1:1)',
        policy: 'WEIGHTED_FAIR',
        workload: '3 orgs x 30 jobs, 5 DRR rounds, quantum=2',
        metrics: {
          claimedPerOrg: counts.join(':'),
          jainsFairnessIndex: round2(computeJainsFairnessIndex(counts)),
          p95ClaimMs: dist.p95Ms,
        },
      });
    }

    // Scenario B: Unequal weights (1:2:4)
    {
      const weights = [1, 2, 4];
      const orgs = await Promise.all(
        weights.map((w, idx) =>
          mkOrgQueue(`b${idx}`, SchedulingPolicy.WEIGHTED_FAIR, { weight: w, quantum: 2 }),
        ),
      );
      await Promise.all(
        orgs.map((o, idx) =>
          seedBatch(
            o.queue,
            Array.from({ length: 60 }, (_, i) => ({ name: `b${idx}-${i}`, readyAt: now })),
          ),
        ),
      );
      const counts = [0, 0, 0];
      const latencies: number[] = [];
      for (let r = 0; r < 5; r++) {
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          const res = await scheduler.claimCandidatesForQueue({
            queueId: orgs[i]!.queue.id,
            limit: 30,
            claimerId: 'bench-b',
            now,
          });
          latencies.push(Date.now() - t0);
          counts[i]! += res.claimed.length;
        }
      }
      const normalizedByWeight = counts.map((c, i) => c / weights[i]!);
      const total = counts.reduce((a, b) => a + b, 0);
      const maxDeviationPct = Math.max(
        ...counts.map((c, i) => Math.abs(c / total - weights[i]! / 7) * 100),
      );
      results.push({
        scenario: 'B: Unequal Weights (1:2:4)',
        policy: 'WEIGHTED_FAIR',
        workload: '3 orgs x 60 jobs, weights 1:2:4, 5 DRR rounds',
        metrics: {
          claimedPerOrg: counts.join(':'),
          weightedJainsIndex: round2(computeJainsFairnessIndex(normalizedByWeight)),
          maxWeightedDeviationPct: round2(maxDeviationPct),
          p95ClaimMs: computeDistribution(latencies).p95Ms,
        },
      });
    }

    // Scenario C: Unequal job costs (1 vs 5 vs 20)
    {
      const costs = [1, 5, 20];
      const orgs = await Promise.all(
        costs.map((c, idx) =>
          mkOrgQueue(`c${idx}`, SchedulingPolicy.WEIGHTED_FAIR, {
            weight: 1,
            quantum: 10,
            maxDeficit: 200,
          }),
        ),
      );
      await Promise.all(
        orgs.map((o, idx) =>
          seedBatch(
            o.queue,
            Array.from({ length: 40 }, (_, i) => ({
              name: `c${idx}-${i}`,
              cost: costs[idx]!,
              readyAt: now,
            })),
          ),
        ),
      );
      const totalCostClaimed = [0, 0, 0];
      const jobsClaimed = [0, 0, 0];
      for (let r = 0; r < 6; r++) {
        for (let i = 0; i < 3; i++) {
          const res = await scheduler.claimCandidatesForQueue({
            queueId: orgs[i]!.queue.id,
            limit: 20,
            claimerId: 'bench-c',
            now,
          });
          jobsClaimed[i]! += res.claimed.length;
          totalCostClaimed[i]! += res.claimed.reduce((s, j) => s + j.schedulingCost, 0);
        }
      }
      results.push({
        scenario: 'C: Unequal Job Costs (1 / 5 / 20)',
        policy: 'WEIGHTED_FAIR',
        workload: '3 orgs weight=1, quantum=10, 6 DRR rounds',
        metrics: {
          jobsClaimedByCostTier: jobsClaimed.join(' / '),
          totalCostDispatched: totalCostClaimed.join(' / '),
          costWeightedJainsIndex: round2(computeJainsFairnessIndex(totalCostClaimed)),
        },
      });
    }

    // Scenario D: Deadline ordering (EDF)
    {
      const { queue } = await mkOrgQueue('d-edf', SchedulingPolicy.DEADLINE_AWARE);
      const offsetsSec = [
        45, 5, 30, 12, 60, 2, 18, 25, 8, 50, 15, 3, 40, 22, 10, 35, 6, 28, 14, 55,
      ];
      await seedBatch(
        queue,
        offsetsSec.map((sec, i) => ({
          name: `edf-${sec}s-${i}`,
          priority: 5,
          readyAt: now,
          deadlineAt: new Date(now.getTime() + sec * 1000),
        })),
      );
      const t0 = Date.now();
      const res = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 20,
        claimerId: 'bench-d',
        now,
      });
      const claimMs = Date.now() - t0;
      let inversions = 0;
      for (let i = 1; i < res.claimed.length; i++) {
        if (res.claimed[i]!.deadlineAt!.getTime() < res.claimed[i - 1]!.deadlineAt!.getTime()) {
          inversions++;
        }
      }
      results.push({
        scenario: 'D: Deadline Ordering (EDF)',
        policy: 'DEADLINE_AWARE',
        workload: '20 jobs with shuffled deadlines (+2s..+60s)',
        metrics: {
          claimedCount: res.claimed.length,
          edfOrderingInversions: inversions,
          claimLatencyMs: claimMs,
        },
      });
    }

    // Scenario E: Deadline overload (expired + active)
    {
      const { queue } = await mkOrgQueue('e-overload', SchedulingPolicy.DEADLINE_AWARE);
      const items = Array.from({ length: 30 }, (_, i) => ({
        name: `ov-${i}`,
        priority: 5,
        readyAt: now,
        deadlineAt: new Date(now.getTime() + (i < 10 ? -(i + 1) * 500 : (i - 9) * 1000)),
      }));
      await seedBatch(queue, items);
      const res = await scheduler.claimCandidatesForQueue({
        queueId: queue.id,
        limit: 30,
        claimerId: 'bench-e',
        now,
      });
      const missed = res.claimed.filter((c) => c.deadlineMissedAt !== null);
      const lateness = missed.map((c) => c.deadlineMissedAt!.getTime() - c.deadlineAt!.getTime());
      const dist = computeDistribution(lateness);
      results.push({
        scenario: 'E: Deadline Overload',
        policy: 'DEADLINE_AWARE',
        workload: '30 jobs (10 already expired, 20 active)',
        metrics: {
          claimedTotal: res.claimed.length,
          deadlineMissRatePct: round2((missed.length / res.claimed.length) * 100),
          avgLatenessMs: dist.avgMs,
          p95LatenessMs: dist.p95Ms,
        },
      });
    }

    // Scenario F: Hybrid fairness + urgent-deadline flood
    {
      const floodA = await mkOrgQueue('f-flood', SchedulingPolicy.HYBRID_FAIR_DEADLINE, {
        weight: 1,
        quantum: 2,
      });
      const fairB = await mkOrgQueue('f-fair', SchedulingPolicy.HYBRID_FAIR_DEADLINE, {
        weight: 2,
        quantum: 2,
      });
      await seedBatch(
        floodA.queue,
        Array.from({ length: 30 }, (_, i) => ({
          name: `fa-${i}`,
          priority: 20,
          readyAt: now,
          deadlineAt: new Date(now.getTime() + 5_000 + i * 100),
        })),
      );
      await seedBatch(
        fairB.queue,
        Array.from({ length: 30 }, (_, i) => ({
          name: `fb-${i}`,
          priority: 5,
          readyAt: now,
          deadlineAt: null,
        })),
      );
      let cA = 0;
      let cB = 0;
      for (let r = 0; r < 5; r++) {
        const ra = await scheduler.claimCandidatesForQueue({
          queueId: floodA.queue.id,
          limit: 20,
          claimerId: 'bench-f',
          now,
        });
        const rb = await scheduler.claimCandidatesForQueue({
          queueId: fairB.queue.id,
          limit: 20,
          claimerId: 'bench-f',
          now,
        });
        cA += ra.claimed.length;
        cB += rb.claimed.length;
      }
      results.push({
        scenario: 'F: Hybrid Fairness vs Urgent Flood',
        policy: 'HYBRID_FAIR_DEADLINE',
        workload: 'Flood org (w=1, urgent deadlines) vs Fair org (w=2, normal), 5 rounds',
        metrics: {
          floodOrgClaimed: cA,
          fairOrgClaimed: cB,
          observedRatio: `${cA}:${cB}`,
          starvationPrevented: cB === cA * 2 ? 'YES' : 'NO',
        },
      });
    }

    // Scenario G: Distributed multi-scheduler contention (4 concurrent claimers)
    {
      const { org, queue } = await mkOrgQueue('g-dist', SchedulingPolicy.HYBRID_FAIR_DEADLINE, {
        weight: 1,
        quantum: 1,
        initialDeficit: 24,
      });
      await seedBatch(
        queue,
        Array.from({ length: 40 }, (_, i) => ({
          name: `dist-${i}`,
          priority: (i % 10) + 1,
          cost: 1,
          readyAt: now,
          deadlineAt: i % 2 === 0 ? new Date(now.getTime() + (i + 5) * 1000) : null,
        })),
      );
      const t0 = Date.now();
      const parallel = await Promise.all(
        [1, 2, 3, 4].map((id) =>
          scheduler.claimCandidatesForQueue({
            queueId: queue.id,
            limit: 10,
            claimerId: `dist-sched-${id}`,
            accumulateDrrRound: false,
            now,
          }),
        ),
      );
      const elapsedMs = Date.now() - t0;
      const allIds = parallel.flatMap((r) => r.claimed.map((c) => c.id));
      const unique = new Set(allIds);
      const finalOrg = await prisma.organisation.findUnique({
        where: { id: org.id },
        select: { schedulingDeficit: true, drrVersion: true },
      });
      results.push({
        scenario: 'G: Distributed Multi-Scheduler Contention',
        policy: 'HYBRID_FAIR_DEADLINE',
        workload: '4 concurrent claimers, initialDeficit=24, 40 jobs',
        metrics: {
          totalClaimed: allIds.length,
          duplicateClaims: allIds.length - unique.size,
          finalDeficit: finalOrg?.schedulingDeficit ?? -1,
          drrVersion: finalOrg?.drrVersion ?? 0,
          wallClockMs: elapsedMs,
        },
      });
    }

    console.log('\n=== Phase 8.4 Weighted Fair (DRR) & Deadline-Aware (EDF/Hybrid) Benchmark ===');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    await prisma.$disconnect();
  }
}

void main();

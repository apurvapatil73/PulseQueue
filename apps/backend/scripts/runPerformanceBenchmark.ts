import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import { prisma } from '../src/config/database.js';
import { connectRedis, disconnectRedis, getRedisClient } from '../src/config/redis.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { realtimeEventBus } from '../src/services/realtime.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';
import { jobService } from '../src/services/job.service.js';
import { computeDistribution } from '../src/benchmark/benchmarkStats.js';

interface BenchmarkScenarioRow {
  scenario: string;
  policy: string;
  jobCount: number;
  throughputJobsPerSec: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  wallClockMs: number;
  errorCount: number;
  notes: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function main() {
  const format = (parseArg('--format') ?? 'json').toLowerCase();
  const outPath = parseArg('--out');

  await connectRedis();
  const redis = getRedisClient();
  const scheduler = new PrioritySchedulerService();
  const createdOrgIds: string[] = [];
  const rows: BenchmarkScenarioRow[] = [];
  const runTag = `p10bench-${Date.now()}`;
  const redisPrefix = `pq:rl:${runTag}`;

  const cpus = os.cpus();
  const envMetadata = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpuModel: cpus[0]?.model ?? 'unknown',
    logicalCores: cpus.length,
    totalMemoryGb: round2(os.totalmem() / 1024 ** 3),
    initialHeapUsedMb: round2(process.memoryUsage().heapUsed / 1024 ** 2),
  };

  async function mkOrgQueue(label: string, policy: SchedulingPolicy, concurrency = 25) {
    const org = await prisma.organisation.create({
      data: {
        name: `${runTag}-${label}`,
        schedulingWeight: 2,
        drrBaseQuantum: 50,
        drrMaxDeficit: 500,
      },
    });
    createdOrgIds.push(org.id);
    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `q-${label}`,
        schedulingPolicy: policy,
        concurrency,
        deadlineUrgencyWindowSec: 60,
      },
    });
    return { org, queue };
  }

  async function seedJobs(
    queue: { id: string; schedulingPolicy: SchedulingPolicy; agingRatePerSec: number },
    count: number,
    withDeadlines: boolean,
  ) {
    const now = new Date();
    await prisma.job.createMany({
      data: Array.from({ length: count }, (_, i) => {
        const prio = (i % 20) + 1;
        const fields = buildInitialSchedulingFields(queue, prio, 0, now);
        return {
          queueId: queue.id,
          name: `bench-job-${i}`,
          status: JobStatus.PENDING,
          priority: prio,
          payload: { idx: i, tag: runTag },
          schedulingCost: (i % 3) + 1,
          deadlineAt: withDeadlines ? new Date(now.getTime() + ((i % 40) + 5) * 1000) : null,
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });
  }

  try {
    // 1. Small Baseline Submission Latency (LEGACY_BULLMQ vs PRIORITY_AGING, 20 jobs each)
    for (const policy of [SchedulingPolicy.LEGACY_BULLMQ, SchedulingPolicy.PRIORITY_AGING]) {
      const { org, queue } = await mkOrgQueue(`sub-${policy.toLowerCase()}`, policy);
      const latencies: number[] = [];
      let errors = 0;
      const tStart = performance.now();
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        try {
          await jobService.create(org.id, queue.id, null, {
            name: `sub-${i}`,
            payload: { step: i },
            delayMs: 0,
            schedulingCost: 1,
          });
        } catch {
          errors++;
        }
        latencies.push(performance.now() - t0);
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(latencies);
      rows.push({
        scenario: 'W1: Small Job Submission (20 jobs)',
        policy,
        jobCount: 20,
        throughputJobsPerSec: round2((20 / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: errors,
        notes: 'End-to-end PostgreSQL job + outbox transaction',
      });
    }

    // 2. Policy Claim Throughput across all 6 custom scheduling policies (100 jobs, batch=25)
    const customPolicies: SchedulingPolicy[] = [
      SchedulingPolicy.FIFO,
      SchedulingPolicy.STRICT_PRIORITY,
      SchedulingPolicy.PRIORITY_AGING,
      SchedulingPolicy.WEIGHTED_FAIR,
      SchedulingPolicy.DEADLINE_AWARE,
      SchedulingPolicy.HYBRID_FAIR_DEADLINE,
    ];
    for (const policy of customPolicies) {
      const { queue } = await mkOrgQueue(`claim-${policy.toLowerCase()}`, policy, 25);
      const hasDl =
        policy === SchedulingPolicy.DEADLINE_AWARE ||
        policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE;
      await seedJobs(queue, 100, hasDl);

      const batchLatencies: number[] = [];
      let totalClaimed = 0;
      const tStart = performance.now();
      for (let b = 0; b < 4; b++) {
        const t0 = performance.now();
        const res = await scheduler.claimCandidatesForQueue({
          queueId: queue.id,
          limit: 25,
          claimerId: 'p10-claimer',
        });
        batchLatencies.push(performance.now() - t0);
        totalClaimed += res.claimed.length;
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(batchLatencies);
      rows.push({
        scenario: 'W2: Policy Claim Throughput (100 jobs, batch=25)',
        policy,
        jobCount: totalClaimed,
        throughputJobsPerSec: round2((totalClaimed / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: 0,
        notes: '4 x claimCandidatesForQueue(limit=25) against PostgreSQL',
      });
    }

    // 3. Multi-Tenant & Multi-Queue Sweep (4 orgs x 4 queues = 16 queues, 20 jobs each = 320 jobs)
    {
      const orgIds: string[] = [];
      for (let o = 0; o < 4; o++) {
        const org = await prisma.organisation.create({
          data: {
            name: `${runTag}-mt-${o}`,
            schedulingWeight: o + 1,
            drrBaseQuantum: 25,
            drrMaxDeficit: 500,
          },
        });
        createdOrgIds.push(org.id);
        orgIds.push(org.id);
        for (let q = 0; q < 4; q++) {
          const queue = await prisma.queue.create({
            data: {
              organisationId: org.id,
              name: `mt-q-${o}-${q}`,
              schedulingPolicy: SchedulingPolicy.HYBRID_FAIR_DEADLINE,
              concurrency: 20,
            },
          });
          await seedJobs(queue, 20, true);
        }
      }

      const mockAdapter = {
        dispatchClaimedJob: async () => ({
          enqueued: true,
          deduplicated: false,
          bullmqJobId: 'bench-mock',
          bullmqQueueName: 'bench-q',
        }),
      };
      const tickLatencies: number[] = [];
      let dispatched = 0;
      const tStart = performance.now();
      for (const orgId of orgIds) {
        const t0 = performance.now();
        const summary = await scheduler.tickAllQueues({
          organisationId: orgId,
          claimerId: 'p10-mt',
          drrMinRoundIntervalMs: 0,
          adapter: mockAdapter,
        });
        tickLatencies.push(performance.now() - t0);
        dispatched += summary.dispatched;
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(tickLatencies);
      rows.push({
        scenario: 'W3: Multi-Tenant/Multi-Queue Sweep (4 orgs x 4 queues)',
        policy: 'HYBRID_FAIR_DEADLINE',
        jobCount: dispatched,
        throughputJobsPerSec: round2((dispatched / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: 0,
        notes: '320 seeded jobs across 16 queues',
      });
    }

    // 4. Mixed Payload Sizes (128B, 4KB, 32KB — 30 jobs)
    {
      const { org, queue } = await mkOrgQueue('mixed-payload', SchedulingPolicy.FIFO);
      const sizes = [128, 4096, 32768];
      const latencies: number[] = [];
      const tStart = performance.now();
      for (let i = 0; i < 30; i++) {
        const bytes = sizes[i % sizes.length]!;
        const t0 = performance.now();
        await jobService.create(org.id, queue.id, null, {
          name: `payload-${bytes}-${i}`,
          payload: { blob: 'x'.repeat(bytes) },
          delayMs: 0,
          schedulingCost: 1,
        });
        latencies.push(performance.now() - t0);
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(latencies);
      rows.push({
        scenario: 'W4: Mixed Payload Sizes (128B / 4KB / 32KB)',
        policy: 'FIFO',
        jobCount: 30,
        throughputJobsPerSec: round2((30 / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: 0,
        notes: '10 jobs per payload size tier',
      });
    }

    // 5. Redis Distributed Rate-Limiter Lua Benchmark (200 ops)
    {
      const lua = `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
        local pttl = redis.call('PTTL', KEYS[1])
        if pttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) pttl = tonumber(ARGV[1]) end
        return {current, pttl}
      `;
      const latencies: number[] = [];
      const tStart = performance.now();
      for (let i = 0; i < 200; i++) {
        const key = `${redisPrefix}:k:${i % 20}`;
        const t0 = performance.now();
        await redis.eval(lua, 1, key, '60000');
        latencies.push(performance.now() - t0);
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(latencies);
      rows.push({
        scenario: 'W5: Redis Atomic Rate-Limit Lua (200 ops)',
        policy: 'REDIS_LUA',
        jobCount: 200,
        throughputJobsPerSec: round2((200 / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: 0,
        notes: '20 distinct hashed keys, 60s PEXPIRE',
      });
    }

    // 6. Sustained Multi-Round Stability (10 rounds x 20 jobs = 200 jobs)
    {
      const { queue } = await mkOrgQueue('sustained', SchedulingPolicy.PRIORITY_AGING, 20);
      const roundLatencies: number[] = [];
      const heapBeforeMb = process.memoryUsage().heapUsed / 1024 ** 2;
      const tStart = performance.now();
      for (let r = 0; r < 10; r++) {
        await seedJobs(queue, 20, false);
        const t0 = performance.now();
        const res = await scheduler.claimCandidatesForQueue({
          queueId: queue.id,
          limit: 20,
          claimerId: 'p10-sustained',
        });
        await scheduler.markDispatched(
          res.claimed.map((c) => c.id),
          'p10-sustained',
        );
        roundLatencies.push(performance.now() - t0);
      }
      const wallMs = performance.now() - tStart;
      const heapDeltaMb = round2(process.memoryUsage().heapUsed / 1024 ** 2 - heapBeforeMb);
      const dist = computeDistribution(roundLatencies);
      rows.push({
        scenario: 'W6: Sustained 10-Round Claim+Mark (200 jobs)',
        policy: 'PRIORITY_AGING',
        jobCount: 200,
        throughputJobsPerSec: round2((200 / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        avgMs: dist.avgMs,
        wallClockMs: round2(wallMs),
        errorCount: 0,
        notes: `Round1=${round2(roundLatencies[0]!)}ms, Round10=${round2(roundLatencies[9]!)}ms, HeapDelta=${heapDeltaMb}MB`,
      });
    }

    const report = {
      metadata: {
        ...envMetadata,
        finalHeapUsedMb: round2(process.memoryUsage().heapUsed / 1024 ** 2),
      },
      results: rows,
    };

    let outputText = '';
    if (format === 'csv') {
      const header =
        'scenario,policy,jobCount,throughputJobsPerSec,p50Ms,p95Ms,p99Ms,avgMs,wallClockMs,errorCount,notes';
      const csvRows = rows.map((r) =>
        [
          `"${r.scenario}"`,
          r.policy,
          r.jobCount,
          r.throughputJobsPerSec,
          r.p50Ms ?? '',
          r.p95Ms ?? '',
          r.p99Ms ?? '',
          r.avgMs ?? '',
          r.wallClockMs,
          r.errorCount,
          `"${r.notes}"`,
        ].join(','),
      );
      outputText = [header, ...csvRows].join('\n');
    } else {
      outputText = JSON.stringify(report, null, 2);
    }

    if (outPath) {
      fs.writeFileSync(outPath, outputText, 'utf8');
    }
    console.log(outputText);
  } finally {
    try {
      const keys = await redis.keys(`${redisPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // Ignore Redis cleanup errors
    }
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    await realtimeEventBus.closeAll();
    await bullMQService.closeAll();
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

void main();

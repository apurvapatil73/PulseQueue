import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import { prisma, getDatabasePoolConfig } from '../src/config/database.js';
import { connectRedis, disconnectRedis, getRedisClient } from '../src/config/redis.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { realtimeEventBus } from '../src/services/realtime.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';
import { computeDistribution, computeJainsFairnessIndex } from '../src/benchmark/benchmarkStats.js';

interface HighVolumeResult {
  workload: string;
  targetJobs: number;
  submitted: number;
  claimed: number;
  dispatched: number;
  completed: number;
  failed: number;
  retried: number;
  remaining: number;
  submitThroughputJobsPerSec: number;
  dispatchThroughputJobsPerSec: number;
  completionThroughputJobsPerSec: number;
  drainWallClockMs: number;
  tickP50Ms: number | null;
  tickP95Ms: number | null;
  tickP99Ms: number | null;
  pgQueryP95Ms: number | null;
  redisPingP95Ms: number | null;
  cpuPercent: number | null;
  rssMb: number;
  heapUsedMb: number;
  eventLoopP95Ms: number | null;
  notes: string;
}

interface PolicyFairnessResult {
  policy: SchedulingPolicy;
  tenants: Array<{
    tenant: string;
    weight: number;
    cost: number;
    maxActiveJobs: number;
    submitted: number;
    dispatched: number;
    maxObservedActive: number;
  }>;
  jainsFairnessIndex: number | null;
  normalizedFairnessIndex: number | null;
  starvedTenants: number;
  concurrencyViolations: number;
  deadlineOrderPreserved: boolean | null;
  notes: string;
}

interface StabilitySample {
  elapsedSec: number;
  completedCumulative: number;
  backlog: number;
  errors: number;
  heapUsedMb: number;
  rssMb: number;
  eventLoopP95Ms: number;
  pgConnectionsTotal: number;
  redisUsedMemoryHuman: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function measureCpuWindow(startCpu: NodeJS.CpuUsage, startHrNs: bigint): number | null {
  const elapsedUs = Number(process.hrtime.bigint() - startHrNs) / 1000;
  if (elapsedUs <= 0) return null;
  const delta = process.cpuUsage(startCpu);
  return round2(((delta.user + delta.system) / elapsedUs) * 100);
}

async function getPgConnectionCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
  `;
  return rows[0]?.count ?? 0;
}

async function getRedisMemoryHuman(): Promise<string> {
  const info = await getRedisClient().info('memory');
  const match = /used_memory_human:([^\r\n]+)/.exec(info);
  return match?.[1]?.trim() ?? 'unknown';
}

function runWorkerDrainChild(
  queueId: string,
  targetJobs: number,
  timeoutMs = 120_000,
): Promise<{
  pid: number;
  completedJobs: number;
  drainWallClockMs: number;
  throughputJobsPerSec: number;
  cpuPercent: number | null;
  rssMb: number;
  heapUsedMb: number;
  eventLoopP95Ms: number;
}> {
  const repoRoot = path.resolve(process.cwd());
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const childScript = path.join(repoRoot, 'apps', 'worker', 'scripts', 'multiProcessChild.ts');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, childScript, 'profile-worker'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANCE_ID: `ls-worker-${Date.now()}`,
        MP_QUEUE_ID: queueId,
        MP_TARGET_JOBS: String(targetJobs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new Error(`Worker drain child timed out after ${timeoutMs}ms.\nstderr=${stderrBuf}`),
        );
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('PROFILE_DONE ')) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(JSON.parse(line.slice('PROFILE_DONE '.length)));
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Worker drain child exited early (code=${code}).\nstderr=${stderrBuf}`));
      }
    });
  });
}

async function main() {
  const format = (parseArg('--format') ?? 'json').toLowerCase();
  const outPath = parseArg('--out');
  const maxJobsCap = Math.min(
    10_000,
    Math.max(100, parseInt(parseArg('--max-jobs') ?? '10000', 10)),
  );
  const workerDrainJobs = Math.min(
    1000,
    Math.max(50, parseInt(parseArg('--worker-drain-jobs') ?? '300', 10)),
  );
  const stabilitySec = Math.min(60, Math.max(5, parseInt(parseArg('--stability-sec') ?? '15', 10)));
  const sizes = (parseArg('--jobs') ?? '1000,5000,10000')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= maxJobsCap);

  await connectRedis();
  const redis = getRedisClient();
  const scheduler = new PrioritySchedulerService();
  const createdOrgIds: string[] = [];
  const runTag = `p103-${Date.now()}`;

  const highVolumeResults: HighVolumeResult[] = [];
  const fairnessResults: PolicyFairnessResult[] = [];
  const stabilitySamples: StabilitySample[] = [];

  try {
    // -------------------------------------------------------------------------
    // PART 1: High-Volume Workloads (1,000 / 5,000 / 10,000 jobs)
    // -------------------------------------------------------------------------
    const payloadSmall = 'x'.repeat(128);
    const payloadMed = 'y'.repeat(1024);
    const payloadLarge = 'z'.repeat(4096);

    for (const totalJobs of sizes) {
      const orgCount = 4;
      const jobsPerOrg = Math.floor(totalJobs / orgCount);
      const actualTotal = jobsPerOrg * orgCount;

      const orgs: Array<{
        id: string;
        queueId: string;
        queue: {
          id: string;
          organisationId: string;
          name: string;
          isPaused: boolean;
          concurrency: number;
          defaultPriority: number;
          maxRetries: number;
          backoffMs: number;
          poisonFailureThreshold: number;
          schedulingPolicy: SchedulingPolicy;
          agingRatePerSec: number;
          schedulingWeight: number;
        };
      }> = [];
      for (let o = 0; o < orgCount; o++) {
        const org = await prisma.organisation.create({
          data: {
            name: `${runTag}-hv-${totalJobs}-org-${o}`,
            maxActiveJobs: 500,
            schedulingWeight: o + 1,
            drrBaseQuantum: 100,
            drrMaxDeficit: 1000,
          },
        });
        createdOrgIds.push(org.id);
        const queue = await prisma.queue.create({
          data: {
            organisationId: org.id,
            name: `hv-${totalJobs}-q-${o}`,
            schedulingPolicy:
              o % 2 === 0 ? SchedulingPolicy.PRIORITY_AGING : SchedulingPolicy.HYBRID_FAIR_DEADLINE,
            concurrency: 100,
            deadlineUrgencyWindowSec: 60,
          },
        });
        orgs.push({ id: org.id, queueId: queue.id, queue });
      }

      // 1a. Measure batched submission throughput (mixed payloads, priorities, deadlines)
      const now = new Date();
      const tSubmitStart = performance.now();
      for (const item of orgs) {
        const chunkSize = 500;
        for (let offset = 0; offset < jobsPerOrg; offset += chunkSize) {
          const count = Math.min(chunkSize, jobsPerOrg - offset);
          await prisma.job.createMany({
            data: Array.from({ length: count }, (_, idx) => {
              const i = offset + idx;
              const prio = (i % 20) + 1;
              const fields = buildInitialSchedulingFields(item.queue, prio, 0, now);
              const body = i % 10 === 0 ? payloadLarge : i % 3 === 0 ? payloadMed : payloadSmall;
              return {
                queueId: item.queueId,
                name: 'echo',
                status: JobStatus.PENDING,
                priority: prio,
                payload: { message: `hv-${i}`, pad: body },
                schedulingCost: (i % 3) + 1,
                deadlineAt: i % 4 === 0 ? new Date(now.getTime() + ((i % 120) + 5) * 1000) : null,
                dispatchState: JobDispatchState.QUEUED,
                readyAt: now,
                virtualRankAt: fields.virtualRankAt,
              };
            }),
          });
        }
      }
      const submitWallMs = performance.now() - tSubmitStart;

      // 1b. Measure scheduler claim + dispatch + completion drain
      const tickLatencies: number[] = [];
      const pgLatencies: number[] = [];
      const redisLatencies: number[] = [];
      let totalClaimed = 0;
      let totalDispatched = 0;
      let totalCompleted = 0;

      const el = monitorEventLoopDelay({ resolution: 10 });
      el.enable();
      const cpu0 = process.cpuUsage();
      const hr0 = process.hrtime.bigint();
      const tDrainStart = performance.now();

      const mockAdapter = {
        dispatchClaimedJob: async () => ({ enqueued: true, deduplicated: false }),
      };

      const batchLimit = 100;
      let round = 0;
      while (totalDispatched < actualTotal && round < Math.ceil(actualTotal / 50) + 20) {
        round += 1;
        let roundDispatched = 0;
        for (const item of orgs) {
          const t0 = performance.now();
          const res = await scheduler.dispatchBatchWithAdapter(
            item.queue,
            {
              claimerId: `${runTag}-hv-${totalJobs}`,
              limit: batchLimit,
              maxInFlightForQueue: 10_000,
              enforceOrgActiveLimit: false,
            },
            mockAdapter,
          );
          if (res.claimed > 0) {
            tickLatencies.push(performance.now() - t0);
            totalClaimed += res.claimed;
            totalDispatched += res.dispatched;
            roundDispatched += res.dispatched;
          }
        }
        // Periodically sample PG & Redis latency
        if (round % 5 === 1) {
          const tp = performance.now();
          await prisma.$queryRaw`SELECT 1`;
          pgLatencies.push(performance.now() - tp);
          const tr = performance.now();
          await redis.ping();
          redisLatencies.push(performance.now() - tr);
        }
        if (roundDispatched === 0) break;
      }

      const dispatchWallMs = performance.now() - tDrainStart;

      // Mark dispatched jobs COMPLETED in bounded SQL batches to measure DB completion commit throughput
      const tCompStart = performance.now();
      const compRes = await prisma.job.updateMany({
        where: {
          queueId: { in: orgs.map((o) => o.queueId) },
          dispatchState: JobDispatchState.DISPATCHED,
        },
        data: {
          status: JobStatus.COMPLETED,
          completedAt: new Date(),
          attemptsMade: 1,
        },
      });
      totalCompleted = compRes.count;
      const totalDrainMs = performance.now() - tDrainStart;
      el.disable();

      const remaining = actualTotal - totalCompleted;
      const tickDist = computeDistribution(tickLatencies);
      const pgDist = computeDistribution(pgLatencies);
      const redisDist = computeDistribution(redisLatencies);
      const mem = process.memoryUsage();

      highVolumeResults.push({
        workload: `High-Volume Scheduler+DB (${actualTotal} jobs, 4 orgs)`,
        targetJobs: actualTotal,
        submitted: actualTotal,
        claimed: totalClaimed,
        dispatched: totalDispatched,
        completed: totalCompleted,
        failed: 0,
        retried: 0,
        remaining,
        submitThroughputJobsPerSec: round2((actualTotal / submitWallMs) * 1000),
        dispatchThroughputJobsPerSec: round2((totalDispatched / dispatchWallMs) * 1000),
        completionThroughputJobsPerSec: round2((totalCompleted / totalDrainMs) * 1000),
        drainWallClockMs: round2(totalDrainMs),
        tickP50Ms: tickDist.p50Ms,
        tickP95Ms: tickDist.p95Ms,
        tickP99Ms: tickDist.p99Ms,
        pgQueryP95Ms: pgDist.p95Ms,
        redisPingP95Ms: redisDist.p95Ms,
        cpuPercent: measureCpuWindow(cpu0, hr0),
        rssMb: round2(mem.rss / 1024 ** 2),
        heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
        eventLoopP95Ms: round2(el.percentile(95) / 1e6),
        notes: `batchLimit=${batchLimit}, completionCommitMs=${round2(performance.now() - tCompStart)}, mixed payloads 128B/1KB/4KB`,
      });

      // Clean up this workload's orgs before the next larger workload to keep DB lean
      await prisma.organisation.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
      for (const o of orgs) {
        const idx = createdOrgIds.indexOf(o.id);
        if (idx !== -1) createdOrgIds.splice(idx, 1);
      }
    }

    // 1c. Live End-to-End Worker OS Process Drain (PG + BullMQ + WorkerManager + markJobActive/Completed)
    {
      const org = await prisma.organisation.create({
        data: { name: `${runTag}-live-drain`, maxActiveJobs: 100 },
      });
      createdOrgIds.push(org.id);
      const queue = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `live-drain-${workerDrainJobs}`,
          schedulingPolicy: SchedulingPolicy.FIFO,
          concurrency: 20,
        },
      });
      const now = new Date();
      const tSub0 = performance.now();
      await prisma.job.createMany({
        data: Array.from({ length: workerDrainJobs }, (_, i) => {
          const fields = buildInitialSchedulingFields(queue, (i % 10) + 1, 0, now);
          return {
            queueId: queue.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: (i % 10) + 1,
            payload: { message: `live-${i}` },
            dispatchState: JobDispatchState.QUEUED,
            readyAt: now,
            virtualRankAt: fields.virtualRankAt,
          };
        }),
      });
      const subMs = performance.now() - tSub0;

      const workerOut = await runWorkerDrainChild(queue.id, workerDrainJobs, 120_000);
      const [completedCount, failedCount] = await Promise.all([
        prisma.job.count({ where: { queueId: queue.id, status: JobStatus.COMPLETED } }),
        prisma.job.count({ where: { queueId: queue.id, status: JobStatus.FAILED } }),
      ]);

      highVolumeResults.push({
        workload: `Live Worker OS End-to-End Drain (${workerDrainJobs} echo jobs)`,
        targetJobs: workerDrainJobs,
        submitted: workerDrainJobs,
        claimed: completedCount + failedCount,
        dispatched: completedCount + failedCount,
        completed: completedCount,
        failed: failedCount,
        retried: 0,
        remaining: workerDrainJobs - completedCount - failedCount,
        submitThroughputJobsPerSec: round2((workerDrainJobs / subMs) * 1000),
        dispatchThroughputJobsPerSec: workerOut.throughputJobsPerSec,
        completionThroughputJobsPerSec: workerOut.throughputJobsPerSec,
        drainWallClockMs: workerOut.drainWallClockMs,
        tickP50Ms: null,
        tickP95Ms: null,
        tickP99Ms: null,
        pgQueryP95Ms: null,
        redisPingP95Ms: null,
        cpuPercent: workerOut.cpuPercent,
        rssMb: workerOut.rssMb,
        heapUsedMb: workerOut.heapUsedMb,
        eventLoopP95Ms: workerOut.eventLoopP95Ms,
        notes: `Separate Worker OS pid=${workerOut.pid}, concurrency=20, full PG+BullMQ lifecycle`,
      });
    }

    // -------------------------------------------------------------------------
    // PART 2: Multi-Tenant Fairness Across All 6 Scheduling Policies
    // -------------------------------------------------------------------------
    const allPolicies: SchedulingPolicy[] = [
      SchedulingPolicy.FIFO,
      SchedulingPolicy.STRICT_PRIORITY,
      SchedulingPolicy.PRIORITY_AGING,
      SchedulingPolicy.WEIGHTED_FAIR,
      SchedulingPolicy.DEADLINE_AWARE,
      SchedulingPolicy.HYBRID_FAIR_DEADLINE,
    ];

    const schedA = new PrioritySchedulerService();
    const schedB = new PrioritySchedulerService();

    for (const policy of allPolicies) {
      // Saturated backlogs so policies actually contend instead of draining 100% of jobs:
      // - heavy-w1-c1: weight=1, cost=1, maxActiveJobs=10, 80 jobs from round 0
      // - costly-w2-c2: weight=2, cost=2, maxActiveJobs=10, 80 jobs from round 0
      // - rejoin-w4-c1: weight=4, cost=1, maxActiveJobs=12, starts idle (0 jobs), joins round 2 with 80 jobs
      const tenantSpecs = [
        {
          name: 'heavy-w1-c1',
          weight: 1,
          cost: 1,
          maxActiveJobs: 10,
          initialJobs: 80,
          rejoinJobs: 0,
        },
        {
          name: 'costly-w2-c2',
          weight: 2,
          cost: 2,
          maxActiveJobs: 10,
          initialJobs: 80,
          rejoinJobs: 0,
        },
        {
          name: 'rejoin-w4-c1',
          weight: 4,
          cost: 1,
          maxActiveJobs: 12,
          initialJobs: 0,
          rejoinJobs: 80,
        },
      ];

      const tenants: Array<{
        spec: (typeof tenantSpecs)[number];
        orgId: string;
        queueId: string;
        maxObservedActive: number;
      }> = [];

      const now = new Date();
      for (const spec of tenantSpecs) {
        const org = await prisma.organisation.create({
          data: {
            name: `${runTag}-fair-${policy}-${spec.name}`,
            maxActiveJobs: spec.maxActiveJobs,
            schedulingWeight: spec.weight,
            drrBaseQuantum: 2,
            drrMaxDeficit: 40,
          },
        });
        createdOrgIds.push(org.id);
        const queue = await prisma.queue.create({
          data: {
            organisationId: org.id,
            name: `fair-${policy.toLowerCase()}-${spec.name}`,
            schedulingPolicy: policy,
            concurrency: 12,
            agingRatePerSec: 1.0,
            starvationThresholdSec: 30,
            deadlineUrgencyWindowSec: 60,
          },
        });

        if (spec.initialJobs > 0) {
          await prisma.job.createMany({
            data: Array.from({ length: spec.initialJobs }, (_, i) => {
              const prio = spec.name.startsWith('heavy') ? 2 : (i % 15) + 5;
              const readyAt = new Date(now.getTime() - (spec.initialJobs - i) * 100);
              const fields = buildInitialSchedulingFields(queue, prio, 0, readyAt);
              // Mix overdue (-5s) and future (+10s..+240s) deadlines
              const deadlineAt =
                policy === SchedulingPolicy.DEADLINE_AWARE ||
                policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE
                  ? new Date(now.getTime() + (i % 5 === 0 ? -5_000 : (i + 1) * 3_000))
                  : null;
              return {
                queueId: queue.id,
                name: 'echo',
                status: JobStatus.PENDING,
                priority: prio,
                payload: { message: `${spec.name}-${i}` },
                schedulingCost: spec.cost,
                deadlineAt,
                dispatchState: JobDispatchState.QUEUED,
                readyAt,
                virtualRankAt: fields.virtualRankAt,
              };
            }),
          });
        }

        tenants.push({
          spec,
          orgId: org.id,
          queueId: queue.id,
          maxObservedActive: 0,
        });
      }

      let concurrencyViolations = 0;
      const observedDeadlines: number[] = [];

      // Run 6 contention rounds with 2 competing schedulers; rejoin tenant joins on round 2
      for (let round = 0; round < 6; round++) {
        if (round === 2) {
          const rejoinTenant = tenants[2]!;
          const q = await prisma.queue.findUniqueOrThrow({ where: { id: rejoinTenant.queueId } });
          await prisma.job.createMany({
            data: Array.from({ length: rejoinTenant.spec.rejoinJobs }, (_, i) => {
              const readyAt = new Date(now.getTime() + round * 1_000);
              const fields = buildInitialSchedulingFields(q, 10, 0, readyAt);
              return {
                queueId: q.id,
                name: 'echo',
                status: JobStatus.PENDING,
                priority: 10,
                payload: { message: `rejoin-burst-${i}` },
                schedulingCost: rejoinTenant.spec.cost,
                deadlineAt:
                  policy === SchedulingPolicy.DEADLINE_AWARE ||
                  policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE
                    ? new Date(readyAt.getTime() + (i + 1) * 2_000)
                    : null,
                dispatchState: JobDispatchState.QUEUED,
                readyAt,
                virtualRankAt: fields.virtualRankAt,
              };
            }),
          });
        }

        const roundTime = new Date(now.getTime() + round * 1_000);
        await Promise.all(
          tenants.map(async (t, idx) => {
            const s = idx % 2 === 0 ? schedA : schedB;
            const res = await s.claimCandidatesForQueue({
              queueId: t.queueId,
              limit: 12,
              maxInFlightForQueue: 12,
              enforceOrgActiveLimit: true,
              claimerId: `fair-sched-${idx % 2}`,
              now: roundTime,
              drrMinRoundIntervalMs: 0,
            });

            // Verify actual policy executed by scheduler matches requested policy
            if (res.policy !== policy) {
              throw new Error(`Policy mismatch: expected ${policy}, got ${res.policy}`);
            }

            // Check concurrency invariant
            const activeNow = await prisma.job.count({
              where: {
                queue: { organisationId: t.orgId },
                OR: [
                  { status: JobStatus.ACTIVE },
                  {
                    status: JobStatus.PENDING,
                    dispatchState: {
                      in: [JobDispatchState.DISPATCHING, JobDispatchState.DISPATCHED],
                    },
                  },
                ],
              },
            });
            if (activeNow > t.maxObservedActive) t.maxObservedActive = activeNow;
            if (activeNow > t.spec.maxActiveJobs) concurrencyViolations += 1;

            if (res.claimed.length > 0) {
              if (
                (policy === SchedulingPolicy.DEADLINE_AWARE ||
                  policy === SchedulingPolicy.HYBRID_FAIR_DEADLINE) &&
                idx === 0 &&
                round === 0
              ) {
                for (const c of res.claimed) {
                  if (c.deadlineAt) observedDeadlines.push(c.deadlineAt.getTime());
                }
              }
              // Mark claimed jobs COMPLETED in PostgreSQL
              await prisma.job.updateMany({
                where: { id: { in: res.claimed.map((c) => c.id) } },
                data: {
                  status: JobStatus.COMPLETED,
                  dispatchState: JobDispatchState.DISPATCHED,
                  dispatchClaimedAt: null,
                  dispatchClaimedBy: null,
                  completedAt: roundTime,
                },
              });
            }
          }),
        );
      }

      // Measure actual COMPLETED counts directly from PostgreSQL final job states
      const completedByTenant = await Promise.all(
        tenants.map((t) =>
          prisma.job.count({ where: { queueId: t.queueId, status: JobStatus.COMPLETED } }),
        ),
      );

      const rawFairness = computeJainsFairnessIndex(
        tenants.map((t, idx) => ({
          tenantLabel: t.spec.name,
          quotaWeight: 1,
          completedJobs: completedByTenant[idx]!,
        })),
      );
      const weightedFairness = computeJainsFairnessIndex(
        tenants.map((t, idx) => ({
          tenantLabel: t.spec.name,
          quotaWeight: t.spec.weight,
          completedJobs: completedByTenant[idx]! * t.spec.cost,
        })),
      );
      const starvedTenants = completedByTenant.filter((c) => c === 0).length;

      let deadlineOrderPreserved: boolean | null = null;
      if (observedDeadlines.length >= 2) {
        deadlineOrderPreserved = observedDeadlines.every(
          (val, idx) => idx === 0 || val >= observedDeadlines[idx - 1]!,
        );
      }

      fairnessResults.push({
        policy,
        tenants: tenants.map((t, idx) => ({
          tenant: t.spec.name,
          weight: t.spec.weight,
          cost: t.spec.cost,
          maxActiveJobs: t.spec.maxActiveJobs,
          submitted: t.spec.initialJobs + t.spec.rejoinJobs,
          dispatched: completedByTenant[idx]!,
          maxObservedActive: t.maxObservedActive,
        })),
        jainsFairnessIndex: rawFairness.jainsFairnessIndex,
        normalizedFairnessIndex: weightedFairness.jainsFairnessIndex,
        starvedTenants,
        concurrencyViolations,
        deadlineOrderPreserved,
        notes:
          '6 saturated rounds, 2 schedulers, drrBaseQuantum=2, idle rejoin on round 2, DB-verified COMPLETED counts',
      });
    }

    // -------------------------------------------------------------------------
    // PART 3: Long-Running Stability & Memory Profile
    // -------------------------------------------------------------------------
    {
      const org = await prisma.organisation.create({
        data: { name: `${runTag}-stability`, maxActiveJobs: 500 },
      });
      createdOrgIds.push(org.id);
      const queue = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `stability-q`,
          schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
          concurrency: 25,
        },
      });

      const el = monitorEventLoopDelay({ resolution: 10 });
      el.enable();
      const startMs = Date.now();
      const endMs = startMs + stabilitySec * 1000;
      let completedCumulative = 0;
      let errors = 0;
      let lastSampleMs = 0;

      while (Date.now() < endMs) {
        try {
          const batchNow = new Date();
          await prisma.job.createMany({
            data: Array.from({ length: 25 }, (_, i) => {
              const fields = buildInitialSchedulingFields(queue, (i % 10) + 1, 0, batchNow);
              return {
                queueId: queue.id,
                name: 'echo',
                status: JobStatus.PENDING,
                priority: (i % 10) + 1,
                payload: { message: `stab-${completedCumulative + i}` },
                dispatchState: JobDispatchState.QUEUED,
                readyAt: batchNow,
                virtualRankAt: fields.virtualRankAt,
              };
            }),
          });

          const claimed = await scheduler.claimCandidatesForQueue({
            queueId: queue.id,
            limit: 25,
            claimerId: `${runTag}-stab`,
          });

          if (claimed.claimed.length > 0) {
            await prisma.job.updateMany({
              where: { id: { in: claimed.claimed.map((c) => c.id) } },
              data: {
                status: JobStatus.COMPLETED,
                dispatchState: JobDispatchState.DISPATCHED,
                dispatchClaimedAt: null,
                dispatchClaimedBy: null,
                completedAt: new Date(),
              },
            });
            completedCumulative += claimed.claimed.length;
          }
          await redis.ping();
        } catch {
          errors += 1;
        }

        const nowMs = Date.now();
        if (nowMs - lastSampleMs >= 3_000 || nowMs >= endMs) {
          lastSampleMs = nowMs;
          const mem = process.memoryUsage();
          const [backlog, pgConns, redisMem] = await Promise.all([
            prisma.job.count({ where: { queueId: queue.id, status: JobStatus.PENDING } }),
            getPgConnectionCount(),
            getRedisMemoryHuman(),
          ]);
          stabilitySamples.push({
            elapsedSec: round2((nowMs - startMs) / 1000),
            completedCumulative,
            backlog,
            errors,
            heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
            rssMb: round2(mem.rss / 1024 ** 2),
            eventLoopP95Ms: round2(el.percentile(95) / 1e6),
            pgConnectionsTotal: pgConns,
            redisUsedMemoryHuman: redisMem,
          });
        }
      }
      el.disable();
    }

    const report = {
      environment: {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCores: os.cpus().length,
        totalMemoryGb: round2(os.totalmem() / 1024 ** 3),
        prismaPoolConfig: getDatabasePoolConfig(),
        stabilityDurationSec: stabilitySec,
      },
      highVolumeResults,
      fairnessResults,
      stabilitySamples,
    };

    const output =
      format === 'csv'
        ? [
            'workload,targetJobs,submitted,claimed,dispatched,completed,failed,remaining,submitOps,dispatchOps,completionOps,drainMs,tickP95Ms,rssMb,heapMb',
            ...highVolumeResults.map((r) =>
              [
                `"${r.workload}"`,
                r.targetJobs,
                r.submitted,
                r.claimed,
                r.dispatched,
                r.completed,
                r.failed,
                r.remaining,
                r.submitThroughputJobsPerSec,
                r.dispatchThroughputJobsPerSec,
                r.completionThroughputJobsPerSec,
                r.drainWallClockMs,
                r.tickP95Ms ?? '',
                r.rssMb,
                r.heapUsedMb,
              ].join(','),
            ),
          ].join('\n')
        : JSON.stringify(report, null, 2);

    if (outPath) {
      fs.writeFileSync(outPath, output, 'utf8');
      console.log(`Large-scale benchmark written to ${outPath}`);
    } else {
      console.log(output);
    }
  } finally {
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    await bullMQService.closeAll();
    await realtimeEventBus.closeAll();
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Large-scale benchmark failed:', err);
  process.exit(1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import {
  bullMQService,
  computeDistribution,
  computeJainsFairnessIndex,
  computeVirtualRankAt,
  connectRedis,
  countPriorityInversions,
  createSeededRng,
  disconnectRedis,
  getRedisClient,
  prioritySchedulerService,
  prisma,
  realtimeEventBus,
  schedulerMetricsRegistry,
  type BenchmarkConfig,
  type PriorityInversionSample,
  type ScenarioBenchmarkResult,
} from '../dist/index.js';
import { WorkerManager } from '../../worker/dist/runtime/workerManager.js';
import { createDefaultProcessorRegistry } from '../../worker/dist/processors/builtin.processors.js';

interface CliArgs {
  scenario: 'A' | 'B' | 'C' | 'D' | 'E' | 'all';
  scale: number;
  workMs: number;
  seed: number;
  outputJson: string | null;
  cleanup: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    scenario: 'all',
    scale: 1,
    workMs: 10,
    seed: 83301,
    outputJson: null,
    cleanup: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--scenario' && v && ['A', 'B', 'C', 'D', 'E', 'all'].includes(v)) {
      args.scenario = v as CliArgs['scenario'];
      i += 1;
    } else if (k === '--scale' && v) {
      const parsed = Number(v);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) args.scale = parsed;
      i += 1;
    } else if (k === '--work-ms' && v) {
      const parsed = Number(v);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000) args.workMs = parsed;
      i += 1;
    } else if (k === '--seed' && v) {
      const parsed = Number(v);
      if (Number.isInteger(parsed)) args.seed = parsed;
      i += 1;
    } else if (k === '--output-json' && v) {
      args.outputJson = v;
      i += 1;
    } else if (k === '--no-cleanup') {
      args.cleanup = false;
    }
  }
  return args;
}

async function cleanupRedisPrefix(prefix: string): Promise<number> {
  const redis = getRedisClient();
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `*${prefix}*`, 'COUNT', 500);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}

async function measureDbAndRedisLatency(): Promise<{ dbMs: number; redisMs: number }> {
  const dbStart = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  const dbMs = Date.now() - dbStart;

  const redis = getRedisClient();
  const rStart = Date.now();
  await redis.ping();
  const redisMs = Date.now() - rStart;
  return { dbMs, redisMs };
}

async function waitForCompletionOrTimeout(
  queueIds: string[],
  targetCompleted: number,
  maxDurationMs: number,
): Promise<number> {
  const deadline = Date.now() + maxDurationMs;
  let completed = 0;
  while (Date.now() < deadline) {
    completed = await prisma.job.count({
      where: { queueId: { in: queueIds }, status: JobStatus.COMPLETED },
    });
    if (completed >= targetCompleted) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return completed;
}

async function collectScenarioResult(
  config: BenchmarkConfig,
  queueIds: string[],
  elapsedMs: number,
  totalSubmitted: number,
  starvationThresholdMs: number,
  tenantCapacityViolations: number,
  notes: string[],
  fairnessInputs?: Array<{ tenantLabel: string; quotaWeight: number; queueId: string }>,
): Promise<ScenarioBenchmarkResult> {
  const rows = await prisma.job.findMany({
    where: { queueId: { in: queueIds } },
    select: {
      id: true,
      queueId: true,
      priority: true,
      status: true,
      readyAt: true,
      firstStartedAt: true,
      durationMs: true,
      dispatchOutbox: { select: { dispatchedAt: true } },
    },
  });

  const completedRows = rows.filter((r) => r.status === JobStatus.COMPLETED);
  const waitMs: number[] = [];
  const lowWaitMs: number[] = [];
  const highWaitMs: number[] = [];
  const dispatchMs: number[] = [];
  const execMs: number[] = [];
  const inversionSamples: PriorityInversionSample[] = [];
  let starvationCount = 0;
  let totalExecTimeMs = 0;

  for (const r of completedRows) {
    if (r.firstStartedAt) {
      const w = Math.max(0, r.firstStartedAt.getTime() - r.readyAt.getTime());
      waitMs.push(w);
      if (r.priority <= 5) lowWaitMs.push(w);
      if (r.priority >= 16) highWaitMs.push(w);
      if (w >= starvationThresholdMs) starvationCount += 1;
      inversionSamples.push({
        id: r.id,
        priority: r.priority,
        readyAtMs: r.readyAt.getTime(),
        startedAtMs: r.firstStartedAt.getTime(),
      });
    }
    if (r.dispatchOutbox?.dispatchedAt) {
      dispatchMs.push(Math.max(0, r.dispatchOutbox.dispatchedAt.getTime() - r.readyAt.getTime()));
    }
    if (r.durationMs !== null) {
      execMs.push(r.durationMs);
      totalExecTimeMs += r.durationMs;
    }
  }

  // Also count still-pending low-priority jobs exceeding starvation threshold
  const nowMs = Date.now();
  for (const r of rows) {
    if (r.status === JobStatus.PENDING && nowMs - r.readyAt.getTime() >= starvationThresholdMs) {
      starvationCount += 1;
    }
  }

  const totalCapacityMs = Math.max(1, elapsedMs * config.workerCount * config.workerConcurrency);
  const workerUtilizationPercent = Math.min(
    100,
    Math.round((totalExecTimeMs / totalCapacityMs) * 1000) / 10,
  );

  const globalSnap = schedulerMetricsRegistry.getGlobalSnapshot();
  const { dbMs, redisMs } = await measureDbAndRedisLatency();
  const remainingPending = rows.filter((r) => r.status === JobStatus.PENDING).length;

  const fairness = fairnessInputs
    ? computeJainsFairnessIndex(
        fairnessInputs.map((fi) => ({
          tenantLabel: fi.tenantLabel,
          quotaWeight: fi.quotaWeight,
          completedJobs: completedRows.filter((r) => r.queueId === fi.queueId).length,
        })),
      )
    : undefined;

  const queueWaitStats = computeDistribution(waitMs);

  return {
    config,
    environment: {
      nodeVersion: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      cpuCount: os.cpus().length,
      executedAt: new Date().toISOString(),
    },
    metrics: {
      elapsedMs,
      totalSubmitted,
      totalCompleted: completedRows.length,
      jobsPerSecond:
        elapsedMs > 0 ? Math.round((completedRows.length / (elapsedMs / 1000)) * 100) / 100 : 0,
      queueWaitMs: queueWaitStats,
      lowPriorityWaitMs: computeDistribution(lowWaitMs),
      highPriorityWaitMs: computeDistribution(highWaitMs),
      dispatchLatencyMs: computeDistribution(dispatchMs),
      executionDurationMs: computeDistribution(execMs),
      maxWaitingMs: queueWaitStats.maxMs,
      starvationCount,
      priorityInversionCount: countPriorityInversions(inversionSamples),
      workerUtilizationPercent,
      schedulerOverheadMs: {
        avgTickDurationMs: globalSnap.histograms.tickDurationMs.avg,
        p95ClaimLatencyMs: globalSnap.histograms.claimLatencyMs.p95Estimate,
      },
      dbQueryLatencyMs: dbMs,
      redisLatencyMs: redisMs,
      redisRemainingBacklog: remainingPending,
      tenantCapacityViolations,
      ...(fairness ? { fairness } : {}),
    },
    notes,
  };
}

async function seedJobsBulk(
  queueId: string,
  organisationId: string,
  agingRatePerSec: number,
  specs: Array<{ priority: number; readyAt: Date; sleepMs: number }>,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < specs.length; i += CHUNK) {
    const slice = specs.slice(i, i + CHUNK);
    const created = await prisma.$transaction(
      slice.map((s) =>
        prisma.job.create({
          data: {
            queueId,
            name: 'bench.work',
            payload: { sleepMs: s.sleepMs },
            status: JobStatus.PENDING,
            priority: s.priority,
            dispatchState: JobDispatchState.QUEUED,
            readyAt: s.readyAt,
            virtualRankAt: computeVirtualRankAt(s.readyAt, s.priority, agingRatePerSec),
          },
          select: { id: true },
        }),
      ),
    );
    await prisma.jobDispatchOutbox.createMany({
      data: created.map((j) => ({
        jobId: j.id,
        queueId,
        organisationId,
        status: 'PENDING',
      })),
    });
  }
}

async function runScenario(
  scenario: 'A' | 'B' | 'C' | 'D' | 'E',
  cli: CliArgs,
): Promise<ScenarioBenchmarkResult> {
  const runId = `bench833_${scenario}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const rng = createSeededRng(cli.seed + scenario.charCodeAt(0));
  schedulerMetricsRegistry.reset();

  const createdOrgIds: string[] = [];
  const managers: WorkerManager[] = [];
  let tenantCapacityViolations = 0;

  const makeWorkerRegistry = (onTrack?: (orgId: string, delta: number) => void) => {
    const reg = createDefaultProcessorRegistry();
    reg.register({
      name: 'bench.work',
      execute: async (ctx) => {
        onTrack?.(ctx.organisationId, 1);
        try {
          const sleepMs = Number((ctx.payload as Record<string, unknown>).sleepMs ?? cli.workMs);
          if (sleepMs > 0) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
          return { ok: true };
        } finally {
          onTrack?.(ctx.organisationId, -1);
        }
      },
    });
    return reg;
  };

  try {
    if (scenario === 'A') {
      const targetJobs = Math.max(20, Math.round(5000 * cli.scale));
      const config: BenchmarkConfig = {
        scenario: 'A',
        label: 'FIFO Baseline',
        policy: SchedulingPolicy.FIFO,
        totalJobs: targetJobs,
        queueCount: 1,
        organisationCount: 1,
        workerCount: 1,
        workerConcurrency: 8,
        jobExecutionMs: cli.workMs,
        priorityDistribution: 'uniform [1..20]',
        submissionRatePerSec: null,
        tenantQuotas: [],
        maxDurationMs: 45_000,
        seed: cli.seed,
      };
      const org = await prisma.organisation.create({ data: { name: `${runId}_org` } });
      createdOrgIds.push(org.id);
      const q = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `${runId}_fifo`,
          concurrency: config.workerConcurrency,
          schedulingPolicy: SchedulingPolicy.FIFO,
        },
      });

      const baseTime = new Date();
      const specs = Array.from({ length: targetJobs }, (_, idx) => ({
        priority: 1 + Math.floor(rng() * 20),
        readyAt: new Date(baseTime.getTime() + idx),
        sleepMs: cli.workMs,
      }));
      await seedJobsBulk(q.id, org.id, 0.05, specs);

      const wm = new WorkerManager({
        workerInstanceId: `${runId}_w1`,
        registry: makeWorkerRegistry(),
      });
      wm.registerWorker(q);
      await wm.waitUntilReady();
      managers.push(wm);

      const t0 = Date.now();
      prioritySchedulerService.start({ intervalMs: 50, claimerId: `${runId}_sched` });
      await waitForCompletionOrTimeout([q.id], targetJobs, config.maxDurationMs);
      const elapsedMs = Date.now() - t0;
      prioritySchedulerService.stop();

      return await collectScenarioResult(
        config,
        [q.id],
        elapsedMs,
        targetJobs,
        10_000,
        0,
        cli.scale < 1
          ? [`Bounded local run: executed ${targetJobs} jobs (scale=${cli.scale} of 5,000 target).`]
          : ['Executed full 5,000-job target.'],
      );
    }

    if (scenario === 'B' || scenario === 'C') {
      const isAging = scenario === 'C';
      const lowCount = Math.max(10, Math.round(100 * cli.scale));
      const highCount = Math.max(30, Math.round(200 * cli.scale));
      const totalJobs = lowCount + highCount;
      const starveSec = 1; // 1s starvation threshold for bounded benchmark observation
      const config: BenchmarkConfig = {
        scenario,
        label: isAging ? 'Priority Aging (Starvation Promotion)' : 'Strict Priority (Starvation)',
        policy: isAging ? SchedulingPolicy.PRIORITY_AGING : SchedulingPolicy.STRICT_PRIORITY,
        totalJobs,
        queueCount: 1,
        organisationCount: 1,
        workerCount: 1,
        workerConcurrency: 2,
        jobExecutionMs: Math.max(15, cli.workMs),
        priorityDistribution: `${lowCount} low (P=2) + ${highCount} continuous high (P=20)`,
        submissionRatePerSec: 40,
        tenantQuotas: [],
        maxDurationMs: 25_000,
        seed: cli.seed,
      };
      const org = await prisma.organisation.create({ data: { name: `${runId}_org` } });
      createdOrgIds.push(org.id);
      const q = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `${runId}_${isAging ? 'aging' : 'strict'}`,
          concurrency: config.workerConcurrency,
          schedulingPolicy: config.policy as SchedulingPolicy,
          agingRatePerSec: 10.0,
          maxEffectivePriority: 25.0,
          starvationThresholdSec: isAging ? starveSec : null,
        },
      });

      const baseTime = new Date();
      // Seed low-priority jobs first
      await seedJobsBulk(
        q.id,
        org.id,
        10.0,
        Array.from({ length: lowCount }, () => ({
          priority: 2,
          readyAt: new Date(baseTime.getTime() - 2000),
          sleepMs: config.jobExecutionMs,
        })),
      );
      // Seed continuous high-priority wave
      await seedJobsBulk(
        q.id,
        org.id,
        10.0,
        Array.from({ length: highCount }, () => ({
          priority: 20,
          readyAt: new Date(),
          sleepMs: config.jobExecutionMs,
        })),
      );

      const wm = new WorkerManager({
        workerInstanceId: `${runId}_w1`,
        registry: makeWorkerRegistry(),
      });
      wm.registerWorker(q);
      await wm.waitUntilReady();
      managers.push(wm);

      const t0 = Date.now();
      prioritySchedulerService.start({ intervalMs: 40, claimerId: `${runId}_sched` });
      await waitForCompletionOrTimeout([q.id], totalJobs, config.maxDurationMs);
      const elapsedMs = Date.now() - t0;
      prioritySchedulerService.stop();

      return await collectScenarioResult(
        config,
        [q.id],
        elapsedMs,
        totalJobs,
        starveSec * 1000,
        0,
        [
          `Executed ${lowCount} low-priority (P=2) + ${highCount} high-priority (P=20) jobs (scale=${cli.scale}).`,
        ],
      );
    }

    if (scenario === 'D') {
      const targetJobs = Math.max(40, Math.round(10000 * cli.scale));
      const queueCount = 3;
      const config: BenchmarkConfig = {
        scenario: 'D',
        label: 'Mixed Multi-Queue Multi-Worker Workload',
        policy: 'MIXED',
        totalJobs: targetJobs,
        queueCount,
        organisationCount: 1,
        workerCount: 2,
        workerConcurrency: 4,
        jobExecutionMs: cli.workMs,
        priorityDistribution: '20% critical, 30% high, 30% medium, 20% low',
        submissionRatePerSec: null,
        tenantQuotas: [],
        maxDurationMs: 45_000,
        seed: cli.seed,
      };
      const org = await prisma.organisation.create({ data: { name: `${runId}_org` } });
      createdOrgIds.push(org.id);
      const policies = [
        SchedulingPolicy.FIFO,
        SchedulingPolicy.STRICT_PRIORITY,
        SchedulingPolicy.PRIORITY_AGING,
      ];
      const queues = [];
      for (let i = 0; i < queueCount; i += 1) {
        queues.push(
          await prisma.queue.create({
            data: {
              organisationId: org.id,
              name: `${runId}_q${i}`,
              concurrency: config.workerConcurrency,
              schedulingPolicy: policies[i],
            },
          }),
        );
      }

      const now = new Date();
      const perQueue = Math.floor(targetJobs / queueCount);
      for (let qi = 0; qi < queues.length; qi += 1) {
        const count = qi === queues.length - 1 ? targetJobs - perQueue * qi : perQueue;
        const specs = Array.from({ length: count }, () => {
          const r = rng();
          const priority = r < 0.2 ? 19 : r < 0.5 ? 13 : r < 0.8 ? 8 : 3;
          return { priority, readyAt: now, sleepMs: cli.workMs };
        });
        await seedJobsBulk(queues[qi].id, org.id, 0.05, specs);
      }

      for (let w = 0; w < config.workerCount; w += 1) {
        const wm = new WorkerManager({
          workerInstanceId: `${runId}_w${w + 1}`,
          registry: makeWorkerRegistry(),
        });
        for (const q of queues) wm.registerWorker(q);
        await wm.waitUntilReady();
        managers.push(wm);
      }

      const t0 = Date.now();
      prioritySchedulerService.start({ intervalMs: 50, claimerId: `${runId}_sched` });
      await waitForCompletionOrTimeout(
        queues.map((q) => q.id),
        targetJobs,
        config.maxDurationMs,
      );
      const elapsedMs = Date.now() - t0;
      prioritySchedulerService.stop();

      return await collectScenarioResult(
        config,
        queues.map((q) => q.id),
        elapsedMs,
        targetJobs,
        10_000,
        0,
        cli.scale < 1
          ? [
              `Bounded local run: executed ${targetJobs} jobs across ${queueCount} queues & ${config.workerCount} workers (scale=${cli.scale} of 10,000 target).`,
            ]
          : ['Executed full 10,000-job target.'],
      );
    }

    // Scenario E: Multi-tenant unequal quotas & unequal submission rates
    const quotas = [4, 2]; // Org 1 gets 2x quota weight of Org 2
    const org1Jobs = Math.max(20, Math.round(120 * cli.scale));
    const org2Jobs = Math.max(15, Math.round(60 * cli.scale));
    const totalJobs = org1Jobs + org2Jobs;
    const config: BenchmarkConfig = {
      scenario: 'E',
      label: 'Multi-Tenant Unequal Quotas & Fairness',
      policy: SchedulingPolicy.PRIORITY_AGING,
      totalJobs,
      queueCount: 2,
      organisationCount: 2,
      workerCount: 1,
      workerConcurrency: 6,
      jobExecutionMs: Math.max(15, cli.workMs),
      priorityDistribution: 'uniform [5..15]',
      submissionRatePerSec: null,
      tenantQuotas: quotas,
      maxDurationMs: 25_000,
      seed: cli.seed,
    };

    const org1 = await prisma.organisation.create({
      data: { name: `${runId}_org1`, maxActiveJobs: quotas[0] },
    });
    const org2 = await prisma.organisation.create({
      data: { name: `${runId}_org2`, maxActiveJobs: quotas[1] },
    });
    createdOrgIds.push(org1.id, org2.id);

    const q1 = await prisma.queue.create({
      data: {
        organisationId: org1.id,
        name: `${runId}_t1`,
        concurrency: 6,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      },
    });
    const q2 = await prisma.queue.create({
      data: {
        organisationId: org2.id,
        name: `${runId}_t2`,
        concurrency: 6,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
      },
    });

    const now = new Date();
    await seedJobsBulk(
      q1.id,
      org1.id,
      0.05,
      Array.from({ length: org1Jobs }, () => ({
        priority: 5 + Math.floor(rng() * 11),
        readyAt: now,
        sleepMs: config.jobExecutionMs,
      })),
    );
    await seedJobsBulk(
      q2.id,
      org2.id,
      0.05,
      Array.from({ length: org2Jobs }, () => ({
        priority: 5 + Math.floor(rng() * 11),
        readyAt: now,
        sleepMs: config.jobExecutionMs,
      })),
    );

    const activeByOrg = new Map<string, number>([
      [org1.id, 0],
      [org2.id, 0],
    ]);
    const quotaByOrg = new Map<string, number>([
      [org1.id, quotas[0]],
      [org2.id, quotas[1]],
    ]);

    const wm = new WorkerManager({
      workerInstanceId: `${runId}_w1`,
      registry: makeWorkerRegistry((orgId, delta) => {
        const next = (activeByOrg.get(orgId) ?? 0) + delta;
        activeByOrg.set(orgId, next);
        const cap = quotaByOrg.get(orgId);
        if (cap !== undefined && next > cap) {
          tenantCapacityViolations += 1;
        }
      }),
    });
    wm.registerWorker(q1);
    wm.registerWorker(q2);
    await wm.waitUntilReady();
    managers.push(wm);

    const t0 = Date.now();
    prioritySchedulerService.start({ intervalMs: 40, claimerId: `${runId}_sched` });
    await waitForCompletionOrTimeout([q1.id, q2.id], totalJobs, config.maxDurationMs);
    const elapsedMs = Date.now() - t0;
    prioritySchedulerService.stop();

    return await collectScenarioResult(
      config,
      [q1.id, q2.id],
      elapsedMs,
      totalJobs,
      10_000,
      tenantCapacityViolations,
      [
        `Org 1 (maxActiveJobs=${quotas[0]}, ${org1Jobs} jobs) vs Org 2 (maxActiveJobs=${quotas[1]}, ${org2Jobs} jobs).`,
      ],
      [
        { tenantLabel: 'tenant-1 (quota=4)', quotaWeight: quotas[0], queueId: q1.id },
        { tenantLabel: 'tenant-2 (quota=2)', quotaWeight: quotas[1], queueId: q2.id },
      ],
    );
  } finally {
    prioritySchedulerService.stop();
    await Promise.all(managers.map((m) => m.closeAll()));
    if (cli.cleanup && createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
      await cleanupRedisPrefix(runId);
    }
  }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const scenarios: Array<'A' | 'B' | 'C' | 'D' | 'E'> =
    cli.scenario === 'all' ? ['A', 'B', 'C', 'D', 'E'] : [cli.scenario];

  const results: ScenarioBenchmarkResult[] = [];
  try {
    await connectRedis();
    for (const s of scenarios) {
      const res = await runScenario(s, cli);
      results.push(res);
    }

    if (cli.outputJson) {
      const outPath = path.resolve(cli.outputJson);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2), 'utf8');
    }

    console.log(JSON.stringify({ results }, null, 2));
  } finally {
    prioritySchedulerService.stop();
    await realtimeEventBus.closeAll();
    await bullMQService.closeAll();
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

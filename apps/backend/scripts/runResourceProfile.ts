import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import { prisma, getDatabasePoolConfig } from '../src/config/database.js';
import { connectRedis, disconnectRedis, getRedisClient } from '../src/config/redis.js';
import { createApp } from '../src/app.js';
import { bullMQService } from '../src/services/bullmq.service.js';
import { realtimeEventBus } from '../src/services/realtime.service.js';
import {
  PrioritySchedulerService,
  buildInitialSchedulingFields,
} from '../src/services/priorityScheduler.service.js';
import { computeDistribution } from '../src/benchmark/benchmarkStats.js';

interface ResourceProfileRow {
  phase: string;
  processRole: 'api' | 'scheduler' | 'worker_child';
  measurementType: 'direct';
  concurrency: number;
  operations: number;
  throughputOpsPerSec: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  wallClockMs: number;
  cpuPercent: number | null;
  rssMb: number;
  heapUsedMb: number;
  eventLoopP95Ms: number | null;
  notes: string;
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

async function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

function runSeparateWorkerProcess(
  queueId: string,
  targetJobs: number,
): Promise<{
  pid: number;
  instanceId: string;
  targetJobs: number;
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
        INSTANCE_ID: `prof-worker-${Date.now()}`,
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
        reject(new Error(`profile-worker timed out.\nstderr=${stderrBuf}`));
      }
    }, 40_000);

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
        reject(new Error(`profile-worker exited early (code=${code}).\nstderr=${stderrBuf}`));
      }
    });
  });
}

async function runPoolExperiment(mode: 'cold' | 'warm') {
  await connectRedis();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/health/ready`;

  const countConnections = async () => {
    const rows = await prisma.$queryRaw<Array<{ state: string | null; count: number }>>`
      SELECT state, COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `;
    const byState: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byState[r.state ?? 'null'] = r.count;
      total += r.count;
    }
    return { total, byState };
  };

  try {
    if (mode === 'warm') {
      await Promise.all(Array.from({ length: 8 }, () => prisma.$executeRaw`SELECT pg_sleep(0.05)`));
      await httpGet(url);
    } else {
      await prisma.$queryRaw`SELECT 1`;
    }

    const beforeConns = await countConnections();
    const conc = 8;
    const totalReqs = 160;
    const latencies: number[] = [];
    const tStart = performance.now();

    for (let offset = 0; offset < totalReqs; offset += conc) {
      await Promise.all(
        Array.from({ length: conc }, async () => {
          const t0 = performance.now();
          await httpGet(url);
          latencies.push(performance.now() - t0);
        }),
      );
    }

    const wallMs = performance.now() - tStart;
    const afterConns = await countConnections();
    const dist = computeDistribution(latencies);
    const maxMs = round2(Math.max(...latencies));

    console.log(
      JSON.stringify(
        {
          experiment: 'pool_cold_vs_warm',
          mode,
          pid: process.pid,
          poolConfig: getDatabasePoolConfig(),
          concurrency: conc,
          operations: totalReqs,
          beforeConns,
          afterConns,
          throughputOpsPerSec: round2((totalReqs / wallMs) * 1000),
          wallClockMs: round2(wallMs),
          p50Ms: dist.p50Ms,
          p95Ms: dist.p95Ms,
          p99Ms: dist.p99Ms,
          maxMs,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

async function main() {
  const poolExp = parseArg('--pool-experiment');
  if (poolExp === 'cold' || poolExp === 'warm') {
    await runPoolExperiment(poolExp);
    return;
  }

  const format = (parseArg('--format') ?? 'json').toLowerCase();
  const outPath = parseArg('--out');

  await connectRedis();
  const redis = getRedisClient();
  const scheduler = new PrioritySchedulerService();
  const createdOrgIds: string[] = [];
  const rows: ResourceProfileRow[] = [];
  const runTag = `p102prof-${Date.now()}`;

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 0. Warm-up (DB pool, Redis socket, Express route)
    for (let i = 0; i < 15; i++) {
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redis.ping(),
        httpGet(`${baseUrl}/health/live`),
        httpGet(`${baseUrl}/health/ready`),
      ]);
    }

    const pgMaxRows = await prisma.$queryRaw<Array<{ max_connections: string }>>`
      SHOW max_connections
    `;
    const redisInfoMem = await redis.info('memory');
    const usedMemMatch = /used_memory_human:([^\r\n]+)/.exec(redisInfoMem);
    const usedRssMatch = /used_memory_rss_human:([^\r\n]+)/.exec(redisInfoMem);

    // 1. Direct PostgreSQL query latency (SELECT 1)
    {
      const latencies: number[] = [];
      const cpu0 = process.cpuUsage();
      const hr0 = process.hrtime.bigint();
      const tStart = performance.now();
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        await prisma.$queryRaw`SELECT 1`;
        latencies.push(performance.now() - t0);
      }
      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(latencies);
      const mem = process.memoryUsage();
      rows.push({
        phase: 'PostgreSQL SELECT 1',
        processRole: 'api',
        measurementType: 'direct',
        concurrency: 1,
        operations: 50,
        throughputOpsPerSec: round2((50 / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        wallClockMs: round2(wallMs),
        cpuPercent: measureCpuWindow(cpu0, hr0),
        rssMb: round2(mem.rss / 1024 ** 2),
        heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
        eventLoopP95Ms: null,
        notes: 'Direct Prisma raw query latency',
      });
    }

    // 2. API HTTP Liveness (/health/live) and Readiness (/health/ready) at concurrency 1, 8, 24
    for (const endpoint of ['/health/live', '/health/ready'] as const) {
      for (const conc of [1, 8, 24]) {
        const totalReqs = conc * 20;
        const latencies: number[] = [];
        const el = monitorEventLoopDelay({ resolution: 10 });
        el.enable();
        const cpu0 = process.cpuUsage();
        const hr0 = process.hrtime.bigint();
        const tStart = performance.now();

        for (let offset = 0; offset < totalReqs; offset += conc) {
          const chunk = Math.min(conc, totalReqs - offset);
          await Promise.all(
            Array.from({ length: chunk }, async () => {
              const t0 = performance.now();
              await httpGet(`${baseUrl}${endpoint}`);
              latencies.push(performance.now() - t0);
            }),
          );
        }

        const wallMs = performance.now() - tStart;
        el.disable();
        const dist = computeDistribution(latencies);
        const mem = process.memoryUsage();
        rows.push({
          phase: `API GET ${endpoint}`,
          processRole: 'api',
          measurementType: 'direct',
          concurrency: conc,
          operations: totalReqs,
          throughputOpsPerSec: round2((totalReqs / wallMs) * 1000),
          p50Ms: dist.p50Ms,
          p95Ms: dist.p95Ms,
          p99Ms: dist.p99Ms,
          wallClockMs: round2(wallMs),
          cpuPercent: measureCpuWindow(cpu0, hr0),
          rssMb: round2(mem.rss / 1024 ** 2),
          heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
          eventLoopP95Ms: round2(el.percentile(95) / 1e6),
          notes: `HTTP concurrency=${conc}`,
        });
      }
    }

    // 3. Redis PING command latency at concurrency 1, 8, 24
    for (const conc of [1, 8, 24]) {
      const totalOps = conc * 50;
      const latencies: number[] = [];
      const cpu0 = process.cpuUsage();
      const hr0 = process.hrtime.bigint();
      const tStart = performance.now();

      for (let offset = 0; offset < totalOps; offset += conc) {
        const chunk = Math.min(conc, totalOps - offset);
        await Promise.all(
          Array.from({ length: chunk }, async () => {
            const t0 = performance.now();
            await redis.ping();
            latencies.push(performance.now() - t0);
          }),
        );
      }

      const wallMs = performance.now() - tStart;
      const dist = computeDistribution(latencies);
      const mem = process.memoryUsage();
      rows.push({
        phase: 'Redis PING',
        processRole: 'api',
        measurementType: 'direct',
        concurrency: conc,
        operations: totalOps,
        throughputOpsPerSec: round2((totalOps / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        wallClockMs: round2(wallMs),
        cpuPercent: measureCpuWindow(cpu0, hr0),
        rssMb: round2(mem.rss / 1024 ** 2),
        heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
        eventLoopP95Ms: null,
        notes: `Redis concurrency=${conc}`,
      });
    }

    // 4. Scheduler tick duration + dispatch throughput (batch=25)
    const org = await prisma.organisation.create({
      data: { name: `${runTag}-org`, maxActiveJobs: 500 },
    });
    createdOrgIds.push(org.id);

    const schedQueue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `${runTag}-sched-25`,
        schedulingPolicy: SchedulingPolicy.PRIORITY_AGING,
        concurrency: 25,
      },
    });
    const now = new Date();
    await prisma.job.createMany({
      data: Array.from({ length: 100 }, (_, i) => {
        const fields = buildInitialSchedulingFields(schedQueue, (i % 10) + 1, 0, now);
        return {
          queueId: schedQueue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: (i % 10) + 1,
          payload: { message: `sched-${i}` },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });

    {
      const tickLatencies: number[] = [];
      let totalDispatched = 0;
      const el = monitorEventLoopDelay({ resolution: 10 });
      el.enable();
      const cpu0 = process.cpuUsage();
      const hr0 = process.hrtime.bigint();
      const tStart = performance.now();

      for (let r = 0; r < 4; r++) {
        const t0 = performance.now();
        const batch = await scheduler.dispatchBatchWithAdapter(
          schedQueue,
          { claimerId: `${runTag}-disp-${r}`, limit: 25 },
          {
            dispatchClaimedJob: async () => ({ enqueued: true, deduplicated: false }),
          },
        );
        tickLatencies.push(performance.now() - t0);
        totalDispatched += batch.dispatched;
      }

      const wallMs = performance.now() - tStart;
      el.disable();
      const dist = computeDistribution(tickLatencies);
      const mem = process.memoryUsage();
      rows.push({
        phase: 'Scheduler Claim+Dispatch (batch=25)',
        processRole: 'scheduler',
        measurementType: 'direct',
        concurrency: 25,
        operations: totalDispatched,
        throughputOpsPerSec: round2((totalDispatched / wallMs) * 1000),
        p50Ms: dist.p50Ms,
        p95Ms: dist.p95Ms,
        p99Ms: dist.p99Ms,
        wallClockMs: round2(wallMs),
        cpuPercent: measureCpuWindow(cpu0, hr0),
        rssMb: round2(mem.rss / 1024 ** 2),
        heapUsedMb: round2(mem.heapUsed / 1024 ** 2),
        eventLoopP95Ms: round2(el.percentile(95) / 1e6),
        notes: '4 batches x 25 jobs with mock transport adapter',
      });
    }

    // 5. Separate Worker OS Process: real BullMQ + PostgreSQL job-processing throughput & queue drain time
    const workerQueue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `${runTag}-worker-drain`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 10,
      },
    });
    const drainJobCount = 60;
    await prisma.job.createMany({
      data: Array.from({ length: drainJobCount }, (_, i) => {
        const fields = buildInitialSchedulingFields(workerQueue, 5, 0, now);
        return {
          queueId: workerQueue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: `drain-${i}` },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
        };
      }),
    });

    const workerRes = await runSeparateWorkerProcess(workerQueue.id, drainJobCount);
    rows.push({
      phase: 'Worker OS Process Queue Drain (60 echo jobs)',
      processRole: 'worker_child',
      measurementType: 'direct',
      concurrency: 10,
      operations: workerRes.completedJobs,
      throughputOpsPerSec: workerRes.throughputJobsPerSec,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      wallClockMs: workerRes.drainWallClockMs,
      cpuPercent: workerRes.cpuPercent,
      rssMb: workerRes.rssMb,
      heapUsedMb: workerRes.heapUsedMb,
      eventLoopP95Ms: workerRes.eventLoopP95Ms,
      notes: `Separate OS worker pid=${workerRes.pid} (${workerRes.completedJobs}/${workerRes.targetJobs} completed)`,
    });

    // 6. Sustained 10-round hybrid claim workload (event-loop delay + heap growth)
    const sustainedQueue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `${runTag}-sustained`,
        schedulingPolicy: SchedulingPolicy.HYBRID_FAIR_DEADLINE,
        concurrency: 20,
      },
    });
    await prisma.job.createMany({
      data: Array.from({ length: 200 }, (_, i) => {
        const fields = buildInitialSchedulingFields(sustainedQueue, (i % 10) + 1, 0, now);
        return {
          queueId: sustainedQueue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: (i % 10) + 1,
          payload: { message: `sust-${i}` },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: now,
          virtualRankAt: fields.virtualRankAt,
          deadlineAt: new Date(now.getTime() + (i + 5) * 1000),
        };
      }),
    });

    const heapBeforeMb = round2(process.memoryUsage().heapUsed / 1024 ** 2);
    const elSustained = monitorEventLoopDelay({ resolution: 10 });
    elSustained.enable();
    const cpu0 = process.cpuUsage();
    const hr0 = process.hrtime.bigint();
    const tSustained = performance.now();
    const roundLatencies: number[] = [];

    for (let round = 0; round < 10; round++) {
      const t0 = performance.now();
      await scheduler.claimCandidatesForQueue({
        queueId: sustainedQueue.id,
        limit: 20,
        claimerId: `${runTag}-sustained-${round}`,
      });
      roundLatencies.push(performance.now() - t0);
    }

    const sustainedWallMs = performance.now() - tSustained;
    elSustained.disable();
    const heapAfterMb = round2(process.memoryUsage().heapUsed / 1024 ** 2);
    const sustainedDist = computeDistribution(roundLatencies);
    const memFinal = process.memoryUsage();

    rows.push({
      phase: 'Sustained 10-Round Hybrid Claim',
      processRole: 'scheduler',
      measurementType: 'direct',
      concurrency: 20,
      operations: 200,
      throughputOpsPerSec: round2((200 / sustainedWallMs) * 1000),
      p50Ms: sustainedDist.p50Ms,
      p95Ms: sustainedDist.p95Ms,
      p99Ms: sustainedDist.p99Ms,
      wallClockMs: round2(sustainedWallMs),
      cpuPercent: measureCpuWindow(cpu0, hr0),
      rssMb: round2(memFinal.rss / 1024 ** 2),
      heapUsedMb: heapAfterMb,
      eventLoopP95Ms: round2(elSustained.percentile(95) / 1e6),
      notes: `heapDeltaMb=${round2(heapAfterMb - heapBeforeMb)}`,
    });

    const pgActivity = await prisma.$queryRaw<Array<{ state: string | null; count: number }>>`
      SELECT state, COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `;

    const report = {
      environment: {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCores: os.cpus().length,
        totalMemoryGb: round2(os.totalmem() / 1024 ** 3),
        apiProcessPid: process.pid,
        workerChildPid: workerRes.pid,
      },
      diagnosticSnapshots: {
        measurementType: 'diagnostic_snapshot',
        postgresMaxConnections: pgMaxRows[0]?.max_connections ?? 'unknown',
        prismaPoolConfig: getDatabasePoolConfig(),
        postgresActiveConnectionsByState: pgActivity,
        redisUsedMemoryHuman: usedMemMatch?.[1]?.trim() ?? 'unknown',
        redisUsedMemoryRssHuman: usedRssMatch?.[1]?.trim() ?? 'unknown',
      },
      directMeasurements: rows,
    };

    let outputText: string;
    if (format === 'csv') {
      const headers = [
        'phase',
        'processRole',
        'measurementType',
        'concurrency',
        'operations',
        'throughputOpsPerSec',
        'p50Ms',
        'p95Ms',
        'p99Ms',
        'wallClockMs',
        'cpuPercent',
        'rssMb',
        'heapUsedMb',
        'eventLoopP95Ms',
        'notes',
      ];
      const csvLines = [
        headers.join(','),
        ...rows.map((r) =>
          [
            `"${r.phase}"`,
            r.processRole,
            r.measurementType,
            r.concurrency,
            r.operations,
            r.throughputOpsPerSec,
            r.p50Ms ?? '',
            r.p95Ms ?? '',
            r.p99Ms ?? '',
            r.wallClockMs,
            r.cpuPercent ?? '',
            r.rssMb,
            r.heapUsedMb,
            r.eventLoopP95Ms ?? '',
            `"${r.notes}"`,
          ].join(','),
        ),
      ];
      outputText = csvLines.join('\n');
    } else {
      outputText = JSON.stringify(report, null, 2);
    }

    if (outPath) {
      fs.writeFileSync(outPath, outputText, 'utf8');
      console.log(`Resource profile written to ${outPath}`);
    } else {
      console.log(outputText);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  console.error('Resource profile failed:', err);
  process.exit(1);
});

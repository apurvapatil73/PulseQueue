import http from 'node:http';
import readline from 'node:readline';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import express from 'express';
import { JobStatus } from '@prisma/client';
import {
  PrioritySchedulerService,
  bullMQService,
  connectRedis,
  createApp,
  createRateLimiter,
  disconnectDatabase,
  disconnectRedis,
  getInstanceIdentity,
  getRedisClient,
  healthService,
  prisma,
} from '@pulsequeue/backend';
import { WorkerManager } from '../src/runtime/workerManager.js';

const mode = process.argv[2];

function emit(tag: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${tag} ${JSON.stringify(payload)}\n`);
}

function waitForStopSignal(onStop: () => Promise<void>): void {
  let stopping = false;
  const trigger = () => {
    if (stopping) return;
    stopping = true;
    void onStop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'STOP') {
      rl.close();
      trigger();
    }
  });
  process.on('SIGTERM', trigger);
  process.on('SIGINT', trigger);
}

async function runApi(): Promise<void> {
  await connectRedis();
  const redis = getRedisClient();
  const identity = getInstanceIdentity();
  const rootApp = express();
  const rlName = process.env.MP_RL_NAME ?? 'mp-probe';
  const rlPrefix = process.env.MP_RL_PREFIX ?? 'pq:rl:mp';
  const rlMax = parseInt(process.env.MP_RL_MAX ?? '5', 10);

  rootApp.get(
    '/mp-probe',
    createRateLimiter({
      name: rlName,
      windowMs: 15_000,
      maxRequests: rlMax,
      failurePolicy: 'fail-closed',
      redisClient: redis,
      alwaysEnforce: true,
      keyPrefix: rlPrefix,
    }),
    (_req, res) => {
      res.status(200).json({ ok: true, pid: process.pid, instanceId: identity.instanceId });
    },
  );
  rootApp.use(createApp());
  rootApp.use(
    (
      err: { statusCode?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.statusCode ?? 500).json({ message: err.message ?? 'Internal error' });
    },
  );

  const server = http.createServer(rootApp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  emit('READY', {
    role: 'api',
    pid: process.pid,
    instanceId: identity.instanceId,
    port,
  });

  waitForStopSignal(async () => {
    healthService.markShuttingDown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await disconnectDatabase();
  });
}

async function runWorker(): Promise<void> {
  await connectRedis();
  const identity = getInstanceIdentity();
  const queueId = process.env.MP_QUEUE_ID;
  if (!queueId) {
    throw new Error('MP_QUEUE_ID is required for worker mode');
  }

  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) {
    throw new Error(`Queue ${queueId} not found`);
  }

  const workerManager = new WorkerManager({
    workerInstanceId: `mp-worker-${identity.instanceId}-${process.pid}`,
  });
  workerManager.registerWorker(queue);

  const scheduler = new PrioritySchedulerService();
  scheduler.start({
    intervalMs: 80,
    claimerId: identity.instanceId,
    staleAfterMs: 1200,
  });

  emit('READY', {
    role: 'worker',
    pid: process.pid,
    instanceId: identity.instanceId,
    workerInstanceId: workerManager.getWorkerInstanceId(),
  });

  waitForStopSignal(async () => {
    await scheduler.stopAndDrain(3000);
    await workerManager.closeAll();
    await bullMQService.closeAll();
    await disconnectDatabase();
    await disconnectRedis();
  });
}

async function runCrashClaimer(): Promise<void> {
  await connectRedis();
  const identity = getInstanceIdentity();
  const queueId = process.env.MP_QUEUE_ID;
  if (!queueId) {
    throw new Error('MP_QUEUE_ID is required for crash-claimer mode');
  }

  const scheduler = new PrioritySchedulerService();
  const res = await scheduler.claimCandidatesForQueue({
    queueId,
    limit: 1,
    claimerId: identity.instanceId,
  });

  emit('CLAIMED', {
    role: 'crash-claimer',
    pid: process.pid,
    instanceId: identity.instanceId,
    jobId: res.claimed[0]?.id ?? null,
  });

  // Intentionally hang until parent sends SIGKILL to simulate unexpected process crash
  setInterval(() => {}, 60_000);
}

async function runProfileWorker(): Promise<void> {
  await connectRedis();
  const identity = getInstanceIdentity();
  const queueId = process.env.MP_QUEUE_ID;
  const targetJobs = parseInt(process.env.MP_TARGET_JOBS ?? '60', 10);
  if (!queueId) {
    throw new Error('MP_QUEUE_ID is required for profile-worker mode');
  }

  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) {
    throw new Error(`Queue ${queueId} not found`);
  }

  const workerManager = new WorkerManager({
    workerInstanceId: `prof-worker-${identity.instanceId}-${process.pid}`,
  });
  workerManager.registerWorker(queue);

  const scheduler = new PrioritySchedulerService();
  const el = monitorEventLoopDelay({ resolution: 10 });
  el.enable();
  const cpu0 = process.cpuUsage();
  const hr0 = process.hrtime.bigint();
  const tStart = performance.now();

  scheduler.start({
    intervalMs: 50,
    claimerId: identity.instanceId,
    staleAfterMs: 5000,
  });

  // Poll until all targetJobs reach COMPLETED (bounded 30s timeout)
  const deadline = Date.now() + 30_000;
  let completed = 0;
  while (Date.now() < deadline) {
    completed = await prisma.job.count({
      where: { queueId, status: JobStatus.COMPLETED },
    });
    if (completed >= targetJobs) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const drainWallClockMs = performance.now() - tStart;
  el.disable();
  const elapsedUs = Number(process.hrtime.bigint() - hr0) / 1000;
  const cpuDelta = process.cpuUsage(cpu0);
  const cpuPercent =
    elapsedUs > 0
      ? Math.round(((cpuDelta.user + cpuDelta.system) / elapsedUs) * 100 * 100) / 100
      : null;
  const mem = process.memoryUsage();

  await scheduler.stopAndDrain(3000);
  await workerManager.closeAll();
  await bullMQService.closeAll();
  await disconnectDatabase();
  await disconnectRedis();

  emit('PROFILE_DONE', {
    pid: process.pid,
    instanceId: identity.instanceId,
    targetJobs,
    completedJobs: completed,
    drainWallClockMs: Math.round(drainWallClockMs * 100) / 100,
    throughputJobsPerSec: Math.round((completed / drainWallClockMs) * 1000 * 100) / 100,
    cpuPercent,
    rssMb: Math.round((mem.rss / 1024 ** 2) * 100) / 100,
    heapUsedMb: Math.round((mem.heapUsed / 1024 ** 2) * 100) / 100,
    eventLoopP95Ms: Math.round((el.percentile(95) / 1e6) * 100) / 100,
  });
  process.exit(0);
}

async function main(): Promise<void> {
  if (mode === 'api') {
    await runApi();
  } else if (mode === 'worker') {
    await runWorker();
  } else if (mode === 'crash-claimer') {
    await runCrashClaimer();
  } else if (mode === 'profile-worker') {
    await runProfileWorker();
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

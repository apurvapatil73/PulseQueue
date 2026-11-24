import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobDispatchState, JobStatus, SchedulingPolicy } from '@prisma/client';
import {
  buildInitialSchedulingFields,
  bullMQService,
  connectRedis,
  getRedisClient,
  prisma,
} from '@pulsequeue/backend';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CHILD_SCRIPT = path.join(REPO_ROOT, 'apps', 'worker', 'scripts', 'multiProcessChild.ts');

interface SpawnedReplica {
  child: ChildProcess;
  info: Record<string, unknown>;
}

function spawnReplica(
  mode: 'api' | 'worker' | 'crash-claimer',
  expectedTag: 'READY' | 'CLAIMED',
  extraEnv: Record<string, string>,
  timeoutMs = 20_000,
): Promise<SpawnedReplica> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CHILD_SCRIPT, mode], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    let stdoutBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new Error(
            `Timed out waiting for ${mode} (${expectedTag}) after ${timeoutMs}ms.\nstdout=${stdoutBuf}\nstderr=${stderrBuf}`,
          ),
        );
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(`${expectedTag} `)) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const info = JSON.parse(line.slice(expectedTag.length + 1)) as Record<string, unknown>;
            resolve({ child, info });
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `${mode} exited prematurely (code=${code}, signal=${signal}).\nstderr=${stderrBuf}`,
          ),
        );
      }
    });
  });
}

function stopReplicaGracefully(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Replica pid=${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin?.write('STOP\n');
  });
}

function httpGetJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(data) as Record<string, unknown>,
          });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: {} });
        }
      });
    });
    req.on('error', reject);
  });
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Phase 10.2 — Real Multi-Process OS Horizontal Scaling Integration', () => {
  const createdOrgIds: string[] = [];
  const rlPrefix = `pq:rl:mp:${Date.now()}`;
  const liveChildren: ChildProcess[] = [];

  beforeAll(async () => {
    await connectRedis();
  });

  afterAll(async () => {
    for (const child of liveChildren) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    const redis = getRedisClient();
    try {
      const keys = await redis.keys(`${rlPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // ignore
    }
    await bullMQService.closeAll().catch(() => {});
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
  });

  it('shares distributed Redis rate limits across two independent API OS processes with distinct PIDs and instanceIds', async () => {
    const rlName = `mp-api-rl-${Date.now()}`;
    const [api1, api2] = await Promise.all([
      spawnReplica('api', 'READY', {
        INSTANCE_ID: 'mp-api-1',
        MP_RL_NAME: rlName,
        MP_RL_PREFIX: rlPrefix,
        MP_RL_MAX: '5',
      }),
      spawnReplica('api', 'READY', {
        INSTANCE_ID: 'mp-api-2',
        MP_RL_NAME: rlName,
        MP_RL_PREFIX: rlPrefix,
        MP_RL_MAX: '5',
      }),
    ]);
    liveChildren.push(api1.child, api2.child);

    try {
      const pid1 = api1.info.pid as number;
      const pid2 = api2.info.pid as number;
      const port1 = api1.info.port as number;
      const port2 = api2.info.port as number;

      // Verify genuinely independent OS processes
      expect(pid1).toBeGreaterThan(0);
      expect(pid2).toBeGreaterThan(0);
      expect(pid1).not.toBe(pid2);
      expect(pid1).not.toBe(process.pid);
      expect(pid2).not.toBe(process.pid);
      expect(api1.info.instanceId).toBe('mp-api-1');
      expect(api2.info.instanceId).toBe('mp-api-2');

      // Verify /health/live reports each process's own PID and instanceId
      const [live1, live2] = await Promise.all([
        httpGetJson(`http://127.0.0.1:${port1}/health/live`),
        httpGetJson(`http://127.0.0.1:${port2}/health/live`),
      ]);
      expect(live1.status).toBe(200);
      expect(live2.status).toBe(200);
      expect(live1.body.pid).toBe(pid1);
      expect(live2.body.pid).toBe(pid2);
      expect(live1.body.instanceId).toBe('mp-api-1');
      expect(live2.body.instanceId).toBe('mp-api-2');

      // Send 8 concurrent requests split 4+4 across the two OS processes (shared max=5)
      const responses = await Promise.all([
        ...Array.from({ length: 4 }, () => httpGetJson(`http://127.0.0.1:${port1}/mp-probe`)),
        ...Array.from({ length: 4 }, () => httpGetJson(`http://127.0.0.1:${port2}/mp-probe`)),
      ]);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(3);
    } finally {
      const [code1, code2] = await Promise.all([
        stopReplicaGracefully(api1.child),
        stopReplicaGracefully(api2.child),
      ]);
      expect(code1).toBe(0);
      expect(code2).toBe(0);
    }
  }, 30_000);

  it('competes two independent worker/scheduler OS processes with zero duplicates, survives graceful shutdown of one, and recovers after SIGKILL crash', async () => {
    const org = await prisma.organisation.create({
      data: { name: `MP Worker Org ${Date.now()}`, maxActiveJobs: 20 },
    });
    createdOrgIds.push(org.id);

    const queue = await prisma.queue.create({
      data: {
        organisationId: org.id,
        name: `mp-worker-q-${Date.now()}`,
        schedulingPolicy: SchedulingPolicy.FIFO,
        concurrency: 6,
      },
    });

    const past = new Date(Date.now() - 2000);
    const seedBatch = async (count: number, prefix: string) => {
      await prisma.job.createMany({
        data: Array.from({ length: count }, (_, i) => {
          const fields = buildInitialSchedulingFields(queue, 5, 0, past);
          return {
            queueId: queue.id,
            name: 'echo',
            status: JobStatus.PENDING,
            priority: 5,
            payload: { message: `${prefix}-${i}` },
            dispatchState: JobDispatchState.QUEUED,
            readyAt: past,
            virtualRankAt: fields.virtualRankAt,
          };
        }),
      });
    };

    await seedBatch(12, 'batch1');

    const [w1, w2] = await Promise.all([
      spawnReplica('worker', 'READY', { INSTANCE_ID: 'mp-worker-1', MP_QUEUE_ID: queue.id }),
      spawnReplica('worker', 'READY', { INSTANCE_ID: 'mp-worker-2', MP_QUEUE_ID: queue.id }),
    ]);
    liveChildren.push(w1.child, w2.child);

    try {
      const pid1 = w1.info.pid as number;
      const pid2 = w2.info.pid as number;
      expect(pid1).not.toBe(pid2);
      expect(pid1).not.toBe(process.pid);
      expect(pid2).not.toBe(process.pid);

      // 1. Wait for both independent OS worker/scheduler processes to drain batch 1 (12 jobs)
      await waitForCondition(async () => {
        const done = await prisma.job.count({
          where: { queueId: queue.id, status: JobStatus.COMPLETED },
        });
        return done === 12;
      });

      // 2. Gracefully shut down Worker Process 1 while Worker Process 2 stays alive
      const w1ExitCode = await stopReplicaGracefully(w1.child);
      expect(w1ExitCode).toBe(0);

      // Seed 6 more jobs; Worker Process 2 alone must complete all of them
      await seedBatch(6, 'batch2');
      await waitForCondition(async () => {
        const done = await prisma.job.count({
          where: { queueId: queue.id, status: JobStatus.COMPLETED },
        });
        return done === 18;
      });

      // Shut down Worker Process 2 cleanly before the deterministic SIGKILL crash-recovery scenario
      expect(await stopReplicaGracefully(w2.child)).toBe(0);

      // 3. Unexpected OS crash recovery: seed 1 job, let crash-claimer OS process claim it into DISPATCHING, then SIGKILL it
      const crashQueue = await prisma.queue.create({
        data: {
          organisationId: org.id,
          name: `mp-crash-q-${Date.now()}`,
          schedulingPolicy: SchedulingPolicy.FIFO,
          concurrency: 2,
        },
      });
      const crashFields = buildInitialSchedulingFields(crashQueue, 5, 0, past);
      const crashJob = await prisma.job.create({
        data: {
          queueId: crashQueue.id,
          name: 'echo',
          status: JobStatus.PENDING,
          priority: 5,
          payload: { message: 'after-sigkill' },
          dispatchState: JobDispatchState.QUEUED,
          readyAt: past,
          virtualRankAt: crashFields.virtualRankAt,
        },
      });

      const crasher = await spawnReplica('crash-claimer', 'CLAIMED', {
        INSTANCE_ID: 'mp-crasher-3',
        MP_QUEUE_ID: crashQueue.id,
      });
      liveChildren.push(crasher.child);
      expect(crasher.info.jobId).toBe(crashJob.id);
      expect(crasher.info.pid).not.toBe(process.pid);

      // Force-kill the claiming OS process unexpectedly
      crasher.child.kill('SIGKILL');
      await new Promise<void>((resolve) => crasher.child.once('exit', () => resolve()));

      // Confirm job is stranded in DISPATCHING by the dead process
      const stranded = await prisma.job.findUnique({ where: { id: crashJob.id } });
      expect(stranded?.dispatchState).toBe(JobDispatchState.DISPATCHING);
      expect(stranded?.dispatchClaimedBy).toBe('mp-crasher-3');

      // Spawn a fresh Worker OS process on crashQueue (staleAfterMs=1200) -> must recover & complete the stranded job
      const wRecover = await spawnReplica('worker', 'READY', {
        INSTANCE_ID: 'mp-worker-recover',
        MP_QUEUE_ID: crashQueue.id,
      });
      liveChildren.push(wRecover.child);

      try {
        await waitForCondition(async () => {
          const row = await prisma.job.findUnique({ where: { id: crashJob.id } });
          return row?.status === JobStatus.COMPLETED;
        });
        const recoveredRow = await prisma.job.findUnique({ where: { id: crashJob.id } });
        expect(recoveredRow?.status).toBe(JobStatus.COMPLETED);
        expect(recoveredRow?.attemptsMade).toBe(1);
        expect(recoveredRow?.fencingToken).toBe(1);
      } finally {
        expect(await stopReplicaGracefully(wRecover.child)).toBe(0);
      }

      // Verify zero duplicate executions across all 18 jobs on the primary queue
      const allPrimary = await prisma.job.findMany({ where: { queueId: queue.id } });
      expect(allPrimary).toHaveLength(18);
      for (const j of allPrimary) {
        expect(j.status).toBe(JobStatus.COMPLETED);
        expect(j.attemptsMade).toBe(1);
        expect(j.fencingToken).toBe(1);
      }
    } finally {
      await stopReplicaGracefully(w2.child).catch(() => {});
    }
  }, 45_000);
});

import '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrioritySchedulerService } from '@pulsequeue/backend';
import { WorkerManager } from '../src/runtime/workerManager.js';
import { WorkerRuntime } from '../src/runtime/workerRunner.js';

function createBlockedScheduler() {
  const svc = new PrioritySchedulerService();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  svc.tickAllQueues = async () => {
    entered = true;
    await gate;
    return {
      queuesScanned: 0,
      delayedPromoted: 0,
      staleRecovered: 0,
      claimed: 0,
      dispatched: 0,
      released: 0,
      orgCapacityDenials: 0,
      durationMs: 1,
    };
  };

  svc.start({ intervalMs: 50, claimerId: 'shutdown-test' });
  const waitUntilEntered = async () => {
    const deadline = Date.now() + 2000;
    while (!entered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(entered).toBe(true);
  };

  return { svc, waitUntilEntered, release };
}

describe('Phase 10.2 — Bounded WorkerRuntime Shutdown & Escalation', () => {
  it('never disconnects dependencies underneath an active tick on timeout, and runs deferred cleanup once tick settles', async () => {
    const { svc, waitUntilEntered, release } = createBlockedScheduler();
    await waitUntilEntered();

    let disconnectCalls = 0;
    const runtime = new WorkerRuntime({
      workerManager: new WorkerManager({ workerInstanceId: `sd-timeout-${Date.now()}` }),
      schedulerService: svc,
      shutdownDrainTimeoutMs: 60,
      shutdownEscalationGraceMs: 60,
      disconnectDeps: async () => {
        disconnectCalls += 1;
      },
    });

    const result = await runtime.stop('SIGTERM');
    expect(result).toEqual({
      clean: false,
      schedulerDrained: false,
      escalated: true,
      timedOut: true,
      dependenciesClosed: false,
    });
    // Dependencies must NOT have been closed while the tick is still active
    expect(disconnectCalls).toBe(0);

    // Release the active tick -> deferred cleanup owned by WorkerRuntime runs strictly once
    release();
    await svc.whenDrained();
    // Allow microtask continuation of whenDrained().then(...) to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(disconnectCalls).toBe(1);
  });

  it('recovers cleanly during bounded escalation grace retry and closes dependencies once after tick finishes', async () => {
    const { svc, waitUntilEntered, release } = createBlockedScheduler();
    await waitUntilEntered();

    const events: string[] = [];
    const runtime = new WorkerRuntime({
      workerManager: new WorkerManager({ workerInstanceId: `sd-retry-${Date.now()}` }),
      schedulerService: svc,
      shutdownDrainTimeoutMs: 60,
      shutdownEscalationGraceMs: 400,
      disconnectDeps: async () => {
        events.push('deps_closed');
      },
    });

    // Release tick after Phase 1 (60ms) expires, during Phase 2 escalation window
    setTimeout(() => {
      events.push('tick_released');
      release();
    }, 110);

    const result = await runtime.stop('SIGTERM');
    expect(result).toEqual({
      clean: true,
      schedulerDrained: true,
      escalated: true,
      timedOut: false,
      dependenciesClosed: true,
    });
    expect(events).toEqual(['tick_released', 'deps_closed']);
  });

  it('deduplicates repeated concurrent shutdown signals so a second signal never exits early or double-closes', async () => {
    const { svc, waitUntilEntered, release } = createBlockedScheduler();
    await waitUntilEntered();

    let disconnectCalls = 0;
    let firstSettled = false;
    let secondSettled = false;

    const runtime = new WorkerRuntime({
      workerManager: new WorkerManager({ workerInstanceId: `sd-repeat-${Date.now()}` }),
      schedulerService: svc,
      shutdownDrainTimeoutMs: 500,
      shutdownEscalationGraceMs: 200,
      disconnectDeps: async () => {
        disconnectCalls += 1;
      },
    });

    const p1 = runtime.stop('SIGTERM').then((r) => {
      firstSettled = true;
      return r;
    });
    const p2 = runtime.stop('SIGINT').then((r) => {
      secondSettled = true;
      return r;
    });

    // Neither signal should settle while the tick is still blocked
    await new Promise((r) => setTimeout(r, 60));
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(disconnectCalls).toBe(0);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      clean: true,
      schedulerDrained: true,
      escalated: false,
      timedOut: false,
      dependenciesClosed: true,
    });
    expect(r2).toEqual(r1);
    expect(disconnectCalls).toBe(1);
  });
});

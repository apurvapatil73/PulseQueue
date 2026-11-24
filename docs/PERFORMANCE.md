# PulseQueue Performance Baseline & Optimization Guide

## 1. Test Environment & Hardware Metadata

All measurements below were collected locally against single-node Docker PostgreSQL and Redis using the reproducible Phase 10.1 benchmark harness. **These numbers are local single-node microbenchmarks for relative bottleneck comparison, not production-cluster capacity guarantees.**

- **CPU:** Intel Core i5-12450H (12 logical cores)
- **Memory:** 15.73 GiB RAM
- **Runtime:** Node.js `v22.19.0` (Windows)
- **PostgreSQL:** `16.16` (`max_connections=100`, `shared_buffers=128MB`, `work_mem=4MB`)
- **Redis:** `7.4.12` (`used_memory_human=6.80M`, `maxmemory=0B`)

## 2. Running Reproducible Benchmarks

```bash
# JSON output (default)
npm run benchmark:performance

# Machine-readable CSV export
npx tsx apps/backend/scripts/runPerformanceBenchmark.ts --format csv --out perf-baseline.csv

# Phase 8.4 fairness & deadline benchmark suite
npx tsx apps/backend/scripts/runFairDeadlineBenchmark.ts

# Bounded performance regression test suite
npx vitest run apps/backend/tests/performanceRegression.test.ts --config apps/backend/vitest.config.ts
```

## 3. Identified Bottlenecks (Measurement-Driven)

1. **N+1 Sequential `UPDATE jobs` Inside Advisory-Locked Claim Transaction (`priorityScheduler.service.ts`):**
   - **Evidence:** While PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` proved candidate selection (`SELECT ... LIMIT 25 FOR UPDATE SKIP LOCKED`) executed in `0.131 ms` via `jobs_sched_deadline_queued_idx`, `claimCandidatesForQueue(limit=25)` averaged `74–95 ms` per batch (`~263–335 jobs/s`) because each claimed job executed a separate `await tx.job.update(...)` round-trip while holding the per-org advisory lock.
2. **Sequential Transport Dispatch (`priorityScheduler.service.ts`):**
   - **Evidence:** `dispatchBatchWithAdapter` awaited `adapter.dispatchClaimedJob(...)` one job at a time sequentially instead of bounded-concurrency dispatch.
3. **Full Lua Script Transmission per Rate-Limit Check (`rateLimit.middleware.ts`):**
   - **Evidence:** Calling `redis.eval(ATOMIC_RATE_LIMIT_LUA, ...)` resent the full Lua script text on every rate-limited HTTP request instead of using `EVALSHA` with automatic `NOSCRIPT` fallback.

## 4. Optimizations Implemented

1. **Single Batched PostgreSQL `UPDATE` via `jsonb_to_recordset` (`priorityScheduler.service.ts`):**
   - Replaced the `for (const entry of selectedEntries) await tx.job.update(...)` loop with a single batched `UPDATE jobs ... FROM jsonb_to_recordset(...)` inside the exact same transaction, preserving atomic `QUEUED -> DISPATCHING` transitions, `schedulingDecision` JSON, and `deadlineMissedAt` semantics.
2. **Bounded-Concurrency Transport Dispatch (`priorityScheduler.service.ts`):**
   - Dispatched claimed batches in bounded parallel chunks of `8` via `Promise.all`, preserving exact `dispatchedIds`/`failedIds` reservation tracking.
3. **Redis `EVALSHA` Script Caching (`rateLimit.middleware.ts`):**
   - Precomputed SHA-1 digest of `ATOMIC_RATE_LIMIT_LUA` and switched `consumeRedisWindow` to `evalsha` with seamless `NOSCRIPT` fallback to `eval`.

## 5. Before vs. After Measurements (Identical Local Workloads)

| Workload / Policy                               | Jobs | Before Throughput (jobs/s) | After Throughput (jobs/s) |  Speedup  | Before p95 (ms) | After p95 (ms) |
| :---------------------------------------------- | :--: | :------------------------: | :-----------------------: | :-------: | :-------------: | :------------: |
| **W1: Small Submission (`LEGACY_BULLMQ`)**      |  20  |           35.22            |           43.04           |   1.22×   |      33.34      |     26.21      |
| **W1: Small Submission (`PRIORITY_AGING`)**     |  20  |           60.85            |           74.94           |   1.23×   |      18.48      |     14.77      |
| **W2: Claim Batch=25 (`FIFO`)**                 | 100  |           307.20           |       **1,556.59**        | **5.07×** |      95.72      |   **24.24**    |
| **W2: Claim Batch=25 (`STRICT_PRIORITY`)**      | 100  |           335.19           |       **1,997.68**        | **5.96×** |      77.08      |   **14.32**    |
| **W2: Claim Batch=25 (`PRIORITY_AGING`)**       | 100  |           289.97           |       **1,581.58**        | **5.45×** |      91.18      |   **18.88**    |
| **W2: Claim Batch=25 (`WEIGHTED_FAIR`)**        | 100  |           263.49           |       **1,212.86**        | **4.60×** |     102.41      |   **24.01**    |
| **W2: Claim Batch=25 (`DEADLINE_AWARE`)**       | 100  |           304.72           |       **2,116.32**        | **6.94×** |      89.31      |   **12.67**    |
| **W2: Claim Batch=25 (`HYBRID_FAIR_DEADLINE`)** | 100  |           282.87           |       **1,411.25**        | **4.99×** |      93.92      |   **18.68**    |
| **W3: Multi-Tenant Sweep (4 orgs × 4 queues)**  | 130  |           157.77           |        **327.82**         | **2.08×** |     255.96      |   **115.91**   |
| **W4: Mixed Payloads (128B/4KB/32KB)**          |  30  |           54.49            |           67.86           |   1.25×   |      25.11      |     17.11      |
| **W5: Redis Atomic Rate-Limit Lua\***           | 200  |          1,647.45          |         1,833.67          |   1.11×   |      1.12       |      0.97      |
| **W6: Sustained 10-Round Claim+Mark**           | 200  |           188.52           |        **738.06**         | **3.92×** |     127.80      |   **23.94**    |

- **\*W5 `EVALSHA` Limitation:** In `runPerformanceBenchmark.ts`, workload W5 invoked `redis.eval(...)` directly in both BEFORE and AFTER runs rather than exercising the rate-limit middleware's `evalsha` path. Do **not** interpret W5's 1.11× delta as a measured `EVALSHA` speedup; it reflects local run-to-run variance. `EVALSHA` execution and `NOSCRIPT` recovery after `SCRIPT FLUSH` are verified functionally in `apps/backend/tests/performanceRegression.test.ts`.
- **Single-Node Scope:** All measurements above reflect single-node local Docker execution and should not be cited as production multi-node throughput guarantees.
- **Sustained Memory Stability (W6):** Round 1 (`22.64 ms`) vs Round 10 (`21.04 ms`) showed zero latency degradation and `-3.87 MB` heap delta across 10 consecutive rounds.

## 6. Remaining Bottlenecks & Production Recommendations

- **Single-Job Submission Transaction Cost (~13–15 ms local):** Each `jobService.create` executes a durable PostgreSQL transaction (job + outbox + event); batch submission endpoints (`POST /jobs/batch`) can be introduced in a future milestone for high-ingestion producers.
- **PostgreSQL Tuning in Production:** Local Docker uses default `shared_buffers=128MB` and `work_mem=4MB`. Production deployments should size `shared_buffers` (~25% RAM), `effective_cache_size`, and PgBouncer transaction pooling for high replica counts.
- **Multi-Org Parallelism in `tickAllQueues`:** Currently sweeps queues sequentially per tick; partitioning queues across multiple horizontal scheduler replicas scales linearly using `FOR UPDATE SKIP LOCKED` and per-org advisory locks.

## 7. Phase 10.3 — Large-Scale Workloads, Worker Hot-Path Optimization & Stability

### Reproducing the Large-Scale Suite

```bash
# Full 1,000 / 5,000 / 10,000-job suite + live Worker OS drain + 6-policy fairness + 15s stability
NODE_ENV=test npm run benchmark:large-scale -- --jobs 1000,5000,10000 --worker-drain-jobs 300 --stability-sec 15

# CSV export
NODE_ENV=test npx tsx apps/backend/scripts/runLargeScaleBenchmark.ts --format csv --out large-scale.csv
```

### Workload Separation & Measurements (Local Single-Node Docker)

All numbers below are **local single-node Docker measurements** (Intel i5-12450H, 15.73 GiB RAM, Node.js `v22.19.0`, PostgreSQL `16.16`, Redis `7.4.12`), **not** production capacity guarantees. Three distinct workload tiers are measured separately:

1. **Tier A — High-Volume Scheduler + PostgreSQL Drain (`1,000` / `5,000` / `10,000` jobs):** Measures batched job submission, `PrioritySchedulerService` claim/dispatch (`batchLimit=100`, 4 tenants, mixed 128 B / 1 KB / 4 KB payloads, mock transport adapter), and batched PostgreSQL completion commit. **This does not represent 10,000 jobs executed through the live BullMQ Worker OS runtime.**
2. **Tier B — Live Worker OS End-to-End Execution (`300` `echo` jobs):** Measures a separate Node.js Worker OS process (`concurrency=20`) executing real jobs end-to-end through PostgreSQL claim → BullMQ enqueue → `markJobActive` → processor → `markJobCompleted` + `PlatformEvent`, verified from final PostgreSQL `COMPLETED`/`FAILED` counts.
3. **Tier C — 15-Second Sustained Stability (`5,575` jobs):** Continuous scheduler claim + PostgreSQL completion + Redis `PING` loop sampling heap, RSS, event-loop p95, PG connections, and Redis memory every 3 s.

| Tier / Workload                             | Completed / Target | Failed / Quarantined / Remaining | Submit (jobs/s) | Dispatch (jobs/s) | Completion (jobs/s) |  Drain (ms)  | Tick p95 (ms) | PG p95 (ms) | Redis p95 (ms) | RSS / Heap (MB) | EL p95 (ms) |
| :------------------------------------------ | :----------------: | :------------------------------: | :-------------: | :---------------: | :-----------------: | :----------: | :-----------: | :---------: | :------------: | :-------------: | :---------: |
| **Tier A: 1,000 Jobs (Scheduler+DB)**       |   1,000 / 1,000    |            0 / 0 / 0             |    1,547.24     |      937.57       |       863.62        |   1,157.91   |    115.36     |    3.05     |      2.03      | 126.53 / 24.30  |    16.65    |
| **Tier A: 5,000 Jobs (Scheduler+DB)**       |   5,000 / 5,000    |            0 / 0 / 0             |    1,828.64     |     1,059.65      |      1,005.23       |   4,973.97   |    115.50     |    2.66     |      2.29      | 133.90 / 33.34  |    18.99    |
| **Tier A: 10,000 Jobs (Scheduler+DB)**      |  10,000 / 10,000   |            0 / 0 / 0             |    1,956.97     |     1,017.56      |       970.56        |  10,303.37   |    122.92     |    3.03     |      2.55      | 142.94 / 32.67  |    19.92    |
| **Tier B: Live Worker OS Drain (300 echo)** |     300 / 300      |            0 / 0 / 0             |    2,255.53     |       44.11       |      **44.11**      | **6,801.34** |       —       |      —      |       —        | 149.31 / 55.26  |    19.12    |

### Evidence-Backed Worker Hot-Path Optimization (`apps/backend/src/services/job.service.ts`)

- **Bottleneck Identified:** On every worker job execution, `markJobActive` unconditionally ran `tx.jobDispatchOutbox.updateMany(...)` inside the interactive activation transaction even when the outbox was already `DISPATCHED`, and `markJobCompleted` unconditionally ran `db.scheduleExecution.updateMany(...)` sequentially before `eventService.record(...)` even for non-scheduled jobs.
- **Optimization Implemented:** Included `dispatchOutbox: { select: { status: true } }` in `markJobActive` to skip `jobDispatchOutbox.updateMany` unless `status === PENDING`; included `scheduleExecution: { select: { id: true } }` in `markJobCompleted` to skip `scheduleExecution.updateMany` on non-scheduled jobs while preserving strict causal ordering (`scheduleExecution.updateMany` awaited BEFORE `eventService.record`) for linked scheduled jobs.
- **Before vs. After (Identical Live Worker OS Process Drain — 300 `echo` Jobs, `concurrency=20`):**
  - **Before:** `300/300` completed in `8,618.94 ms` (`34.81 jobs/s`).
  - **After:** `300/300` completed in `6,801.34 ms` (`44.11 jobs/s`) — **+26.7% throughput improvement (−21.1% drain wall-clock time)** with all fencing, outbox-recovery, and schedule-telemetry guarantees preserved.

### 15-Second Sustained Stability Profile (`PRIORITY_AGING`, 5,575 Jobs Completed, 0 Errors)

| Elapsed (s) | Completed | Backlog | Errors | Heap (MB) | RSS (MB) | EL p95 (ms) | PG Conns | Redis Mem |
| :---------: | :-------: | :-----: | :----: | :-------: | :------: | :---------: | :------: | :-------: |
|    0.08     |    25     |    0    |   0    |   21.43   |  114.46  |    15.42    |    3     |   9.81M   |
|    3.10     |   1,075   |    0    |   0    |   26.00   |  114.93  |    18.01    |    3     |   9.81M   |
|    6.17     |   2,125   |    0    |   0    |   28.97   |  117.66  |    18.01    |    3     |   9.81M   |
|    9.17     |   3,300   |    0    |   0    |   29.77   |  127.02  |    17.69    |    3     |   9.81M   |
|    12.19    |   4,525   |    0    |   0    |   31.99   |  127.04  |    17.66    |    3     |   9.81M   |
|    15.02    |   5,575   |    0    |   0    |   30.95   |  129.67  |    17.55    |    3     |   9.81M   |

Heap plateaued around ~31 MB (young-gen fluctuation, no monotonic leak), PostgreSQL connections stayed flat at `3`, Redis memory stayed flat at `9.81M`, and event-loop p95 remained steady at `17.5–18.0 ms`.

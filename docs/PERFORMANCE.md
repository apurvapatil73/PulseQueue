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

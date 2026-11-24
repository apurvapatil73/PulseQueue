# PulseQueue Horizontal Scaling, Connection Pooling & Resource Profiling

## 1. Multi-Instance Architecture Overview

PulseQueue separates API, scheduler/outbox, and worker responsibilities so API and worker processes can scale horizontally against shared PostgreSQL and Redis infrastructure:

- **Stateless / Replica-Safe API Paths:** JWT verification, atomic refresh-token rotation, RBAC, Queue/Job CRUD, API idempotency (`(queueId, idempotencyKey)`), DLQ replay (`OPEN -> REPLAYED` conditional update), Redis `EVALSHA` distributed rate limiting, and SSE fan-out (`realtimeEventBus` via Redis Pub/Sub `pq:org:<orgId>:events`) all coordinate via PostgreSQL or Redis.
- **Distributed Background Coordination:**
  - `PrioritySchedulerService`: `pg_advisory_xact_lock` per organisation + `FOR UPDATE SKIP LOCKED` candidate claiming + `dispatchClaimedBy` conditional finalization + `recoverStaleReservations`.
  - `ScheduleDispatcherService`: `pg_advisory_xact_lock(hashtext('pulsequeue:schedule:' || id))` + `@@unique([scheduleId, scheduledFor])`.
  - `AlertEvaluatorService`: non-blocking `pg_try_advisory_xact_lock` per organisation.
  - `StalledJobRecoveryService`: atomic conditional `updateMany` guarded by `(id, status = ACTIVE, stalledCount, fencingToken)`.
  - `WorkerHealthService`: atomic `updateMany` on `status` transitions so stale-worker events fire once across replicas, with unique `workerInstanceId` per process.
  - `OutboxReconciler`: safe across concurrent replicas because BullMQ deduplicates by deterministic `jobId = job.id` and DB updates guard on `status = PENDING`.
- **Process-Local State (Caveat):**
  - `schedulerMetricsRegistry` (`/health/scheduler`, `/monitoring/scheduler`) holds per-process in-memory counters and histograms. In multi-replica deployments, each worker replica reports its own local scheduler counters, while API replicas without a scheduler loop report `loopRunning: false`.
  - `MetricsService` uses a 2-second per-process TTL cache (`DEFAULT_METRICS_CACHE_TTL_MS = 2000`), giving bounded eventual consistency across API replicas.

### Verification Scope (In-Process vs Real OS Processes)

- **Real Multi-Process OS Integration (`apps/worker/tests/multiProcessScaling.test.ts`):** Spawns independent Node.js OS child processes (`child_process.spawn`) with distinct PIDs and `INSTANCE_ID`s against shared PostgreSQL and Redis to verify cross-process Redis rate limiting, competing worker/scheduler processes with zero duplicate executions, graceful shutdown of one worker process while another continues draining, and `SIGKILL` crash recovery.
- **In-Process Multi-Instance Tests (`apps/backend/tests/multiInstanceScaling.test.ts`, `apps/worker/tests/multiInstanceWorker.test.ts`):** Exercise multiple service/app instances inside a single Vitest process for fast deterministic coverage of liveness/readiness, pool URL parsing, `stopAndDrain`, concurrent outbox reconciliation, and stale-worker detection.

## 2. Database & Prisma Connection-Pool Budgeting

There is a single `PrismaClient` instantiation across the monorepo (`apps/backend/src/config/database.ts`), shared by both `@pulsequeue/backend` and `@pulsequeue/worker`. Every process builds its pooled URL through `buildPooledDatabaseUrl(...)`:

- **Actual Default Behavior:**
  - **Explicit URL parameters (`?connection_limit=N&pool_timeout=S`):** Always preserved and never overwritten (`source: "url"`).
  - **Explicit env vars (`DATABASE_POOL_SIZE` 1–100, `DATABASE_POOL_TIMEOUT_SEC` 1–120):** Applied when not already in `DATABASE_URL` (`source: "env"`).
  - **Production default (`NODE_ENV=production` with no URL/env override):** Sets `connection_limit=10` (`source: "production_default"`).
  - **Development / Test default (`NODE_ENV !== production` with no URL/env override):** Leaves Prisma's built-in default (`num_physical_cpus * 2 + 1`, `source: "prisma_default"`).
- **Aggregate Connection Math (vs `max_connections = 100` in local Docker PostgreSQL):**

| Topology                              | Pool / Process (`connection_limit`) | Aggregate Max Connections |    Margin (vs `max_connections=100`)    |
| :------------------------------------ | :---------------------------------: | :-----------------------: | :-------------------------------------: |
| 1 API + 1 Worker (prod default)       |                 10                  |            20             |                +80 free                 |
| 2 API + 2 Workers (prod default)      |                 10                  |            40             |                +60 free                 |
| 4 API + 4 Workers (prod default)      |                 10                  |            80             | +20 free (reserve for migrations/admin) |
| 6 API + 6 Workers (without PgBouncer) |                  6                  |            72             |                +28 free                 |

- **Pool Exhaustion & Lock Contention:**
  - If concurrent DB queries exceed `connection_limit`, Prisma queues callers up to `pool_timeout` seconds before throwing `P2024`.
  - Long-running interactive transactions hold both a pool connection and per-organisation advisory locks (`pg_advisory_xact_lock`). PulseQueue bounds interactive claim/activation transactions with `maxWait: 10_000, timeout: 10_000` and batches claim updates via `jsonb_to_recordset`. Beyond 8–10 Node replicas, place PgBouncer (transaction pooling) in front of PostgreSQL or raise `max_connections`.

## 3. Running Multiple Local Instances (Existing Docker Setup)

Start shared PostgreSQL and Redis:

```bash
npm run docker:up
```

Start two API replicas on distinct ports with explicit instance IDs and bounded DB pools:

```bash
# Terminal 1 — API Replica 1
INSTANCE_ID=api-1 PORT=3001 DATABASE_POOL_SIZE=8 npm run dev:backend

# Terminal 2 — API Replica 2
INSTANCE_ID=api-2 PORT=3002 DATABASE_POOL_SIZE=8 npm run dev:backend
```

Start two Worker/Scheduler replicas:

```bash
# Terminal 3 — Worker Replica 1
INSTANCE_ID=worker-1 DATABASE_POOL_SIZE=8 npm run dev:worker

# Terminal 4 — Worker Replica 2
INSTANCE_ID=worker-2 DATABASE_POOL_SIZE=8 npm run dev:worker
```

Verify liveness and dependency readiness per replica:

- `GET /health/live` — returns `200` (`status: "alive"`) while running, `503` (`status: "shutting_down"`) once graceful shutdown starts.
- `GET /health/ready` — returns `200` (`ready: true`) only when not shutting down and both PostgreSQL and Redis respond; includes `instanceId`, `pid`, and effective `pool` configuration.
- `GET /health` — backward-compatible aggregate health endpoint.

## 4. Resource Profiling (Phase 10.2)

### Running the Profiler

```bash
# JSON report (stdout)
npm run benchmark:profile

# CSV export
npx tsx apps/backend/scripts/runResourceProfile.ts --format csv --out resource-profile.csv
```

### Methodology

- **Warm-up:** 15 iterations of `SELECT 1`, Redis `PING`, `GET /health/live`, and `GET /health/ready` before measurement.
- **Direct Measurements:**
  1. Direct PostgreSQL `SELECT 1` latency (50 ops).
  2. API `GET /health/live` and `GET /health/ready` at concurrency `1`, `8`, `24`.
  3. Redis `PING` command latency at concurrency `1`, `8`, `24`.
  4. `PrioritySchedulerService.dispatchBatchWithAdapter` (`batch=25`, 4 rounds = 100 jobs).
  5. **Separate Worker OS Process** (`apps/worker/scripts/multiProcessChild.ts` `profile-worker`) draining `60` real `echo` jobs through PostgreSQL + BullMQ + `WorkerManager` at `concurrency=10`, reporting separate worker PID, CPU %, RSS MB, heap MB, event-loop p95, and total drain time.
  6. Sustained 10-round `HYBRID_FAIR_DEADLINE` claim workload (`200` jobs) measuring heap delta and event-loop p95 delay.
- **Diagnostic Snapshots (Point-in-Time):** `SHOW max_connections`, `getDatabasePoolConfig()`, `pg_stat_activity` counts by state, and Redis `INFO memory`.
- **Cleanup:** Deletes all seeded organisations/jobs and closes HTTP, BullMQ, Redis, and Prisma connections in `finally`.

### Measured Local Baseline (Single-Node Docker, Isolated Run)

- **Hardware / Software:** Intel Core i5-12450H (12 logical cores), 15.73 GiB RAM, Node.js `v22.19.0` (Windows), PostgreSQL `16.16` (`max_connections=100`), Redis `7.4.12` (`used_memory_human=7.99M`, `used_memory_rss_human=15.94M`).
- **Process Separation:** API/Scheduler parent `pid=29012`; separate Worker child OS process `pid=12056`.
- **Diagnostic Snapshot:** `pg_stat_activity` showed `1` active and `4` idle connections (`prisma_default` in `NODE_ENV=test`).
- **Caveat:** These are **local single-node microbenchmark measurements** for relative profiling, **not** production-cluster capacity guarantees.

| Phase                        |  Process  | Concurrency |  Ops  | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | CPU %  | RSS (MB) | Heap (MB) | EL p95 (ms) |
| :--------------------------- | :-------: | :---------: | :---: | :----------------: | :------: | :------: | :------: | :----: | :------: | :-------: | :---------: |
| PostgreSQL `SELECT 1`        |    API    |      1      |  50   |      1,237.16      |   0.68   |   1.54   |   1.86   | 114.87 |  135.39  |   31.66   |      —      |
| API `GET /health/live`       |    API    |      1      |  20   |      1,581.92      |   0.56   |   0.94   |   1.36   |  0.00  |  135.84  |   33.19   |    0.00     |
| API `GET /health/live`       |    API    |      8      |  160  |      2,075.47      |   2.97   |   5.88   |   7.30   | 141.23 |  138.10  |   33.63   |    12.42    |
| API `GET /health/live`       |    API    |     24      |  480  |      2,940.11      |   6.92   |   9.60   |  13.75   | 124.20 |  141.12  |   41.18   |    14.87    |
| API `GET /health/ready`      |    API    |      1      |  20   |       197.16       |   4.72   |   6.41   |   6.83   | 46.30  |  142.37  |   46.08   |    10.83    |
| API `GET /health/ready`\*    |    API    |      8      |  160  |       67.56        |  15.18   |  23.07   | 2,049.07 | 21.11  |  139.16  |   43.56   |    22.51    |
| API `GET /health/ready`      |    API    |     24      |  480  |       567.10       |  40.15   |  48.13   |  48.71   | 147.65 |  140.39  |   42.81   |    19.22    |
| Redis `PING`                 |    API    |      1      |  50   |      1,836.62      |   0.45   |   1.03   |   1.28   |  0.00  |  140.64  |   43.11   |      —      |
| Redis `PING`                 |    API    |      8      |  400  |      9,675.02      |   0.62   |   1.30   |   1.57   | 187.99 |  140.78  |   44.28   |      —      |
| Redis `PING`                 |    API    |     24      | 1,200 |     27,130.35      |   0.62   |   1.22   |   1.47   | 105.44 |  140.71  |   47.19   |      —      |
| Scheduler Claim+Dispatch     | Scheduler |     25      |  100  |       606.29       |  34.46   |  58.99   |  62.43   | 46.66  |  144.34  |   40.60   |    12.44    |
| Worker Queue Drain (60 echo) | Worker OS |     10      |  60   |       18.65        |    —     |    —     |    —     | 42.74  |  148.55  |   37.64   |    20.40    |
| Sustained 10-Round Hybrid    | Scheduler |     20      |  200  |       695.61       |  28.86   |  32.20   |  32.76   | 37.90  |  145.84  |   46.70   |    12.01    |

- **\*Concurrency-8 `/health/ready` Anomaly (Controlled Cold vs. Warm Pool Reproduction):** Reproduced in two fresh OS processes (`NODE_ENV=test`, `DATABASE_POOL_SIZE=12`, `160` `GET /health/ready` requests at concurrency `8`) via `npx tsx apps/backend/scripts/runResourceProfile.ts --pool-experiment cold|warm`:

  | Pool Mode                                |   PID   | `pg_stat_activity` Before  |  `pg_stat_activity` After  | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) |  Max (ms)  |
  | :--------------------------------------- | :-----: | :------------------------: | :------------------------: | :----------------: | :------: | :------: | :------: | :--------: |
  | **Cold** (1 sequential `SELECT 1`)       | `3056`  |      `1` (`1` active)      | `3` (`1` active, `2` idle) |      `28.19`       | `72.65`  | `181.42` | `964.42` | `2,096.32` |
  | **Warm** (8 concurrent `pg_sleep(0.05)`) | `25752` | `8` (`1` active, `7` idle) | `8` (`1` active, `7` idle) |      `108.54`      | `67.25`  | `95.64`  | `123.55` |  `123.86`  |

  Direct evidence confirms that pre-warming the Prisma pool to the target concurrency (`8` connections before and after) eliminated the ~2 s connection-establishment tail (`max: 2,096.32 ms -> 123.86 ms`, `p99: 964.42 ms -> 123.55 ms`, `3.85×` throughput increase).

- **Bounded Worker Shutdown Policy (`WorkerRuntime.stop()`):**
  1. Deduplicates repeated `SIGTERM`/`SIGINT` signals via a shared `shutdownPromise` so a second signal cannot exit prematurely while draining.
  2. Runs a 2-stage bounded scheduler drain (`shutdownDrainTimeoutMs = 5000 ms`, followed by `shutdownEscalationGraceMs = 5000 ms` if a tick is still active).
  3. Never disconnects BullMQ/Prisma/Redis underneath an active tick: if still active after bounded escalation, `WorkerRuntime` attaches idempotent deferred cleanup to `PrioritySchedulerService.whenDrained()` and returns `{ clean: false, timedOut: true }`, causing the CLI signal handler to exit with code `1` (bounded by a 15 s hard `forceExitTimer`).
- **Sustained Heap Delta:** `+4.19 MB` over 10 consecutive `HYBRID_FAIR_DEADLINE` claim rounds (`200` jobs) with `12.01 ms` p95 event-loop delay.

## 5. Phase 10.3 — Multi-Tenant Fairness & Fault-Injection Verification

### Multi-Tenant Fairness Across All 6 Policies (`npm run benchmark:large-scale`)

Evaluated under **saturated contention** (6 rounds, 2 competing `PrioritySchedulerService` instances, `drrBaseQuantum=2`, DB-verified `COMPLETED` counts, `res.policy === policy` asserted): `heavy-w1-c1` (`weight=1, cost=1, maxActive=10, 80 jobs`), `costly-w2-c2` (`weight=2, cost=2, maxActive=10, 80 jobs`), and `rejoin-w4-c1` (`weight=4, cost=1, maxActive=12`, idle rounds 0–1, joins round 2 with `80` jobs):

| Policy                 | `heavy-w1-c1` Completed | `costly-w2-c2` Completed | `rejoin-w4-c1` Completed | Jain's (Unweighted) | Jain's (Cost/Weight Normalized) | Starved / Violations | EDF Order |
| :--------------------- | :---------------------: | :----------------------: | :----------------------: | :-----------------: | :-----------------------------: | :------------------: | :-------: |
| `FIFO`                 |    60 (maxActive=10)    |    60 (maxActive=10)     |    48 (maxActive=12)     |       0.9899        |             0.7908              |        0 / 0         |     —     |
| `STRICT_PRIORITY`      |    60 (maxActive=10)    |    60 (maxActive=10)     |    48 (maxActive=12)     |       0.9899        |             0.7908              |        0 / 0         |     —     |
| `PRIORITY_AGING`       |    60 (maxActive=10)    |    60 (maxActive=10)     |    48 (maxActive=12)     |       0.9899        |             0.7908              |        0 / 0         |     —     |
| `WEIGHTED_FAIR`        |    12 (maxActive=2)     |     12 (maxActive=2)     |     32 (maxActive=8)     |       0.7967        |           **0.9697**            |        0 / 0         |     —     |
| `DEADLINE_AWARE`       |    60 (maxActive=10)    |    60 (maxActive=10)     |    48 (maxActive=12)     |       0.9899        |             0.7908              |        0 / 0         | **true**  |
| `HYBRID_FAIR_DEADLINE` |    12 (maxActive=2)     |     12 (maxActive=2)     |     32 (maxActive=8)     |       0.7967        |           **0.9697**            |        0 / 0         | **true**  |

### Fault-Injection & Recovery Matrix (`apps/backend/tests/faultInjectionAndScale.test.ts` & `multiProcessScaling.test.ts`)

| Fault Scenario                                                              | Verified Outcome                                                                                                                                                                                                      |
| :-------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled PostgreSQL backend termination (`pg_terminate_backend`)          | Dedicated `PrismaClient` backend PID terminated server-side; client reconnected on a new backend PID with durable job state intact, claimed, activated, and completed cleanly.                                        |
| Simulated Redis outage during multi-tenant outbox dispatch                  | All 8 jobs across Org A & Org B remained durable (`OutboxStatus.PENDING`); recovered to `DISPATCHED` on Redis restoration with zero cross-tenant leakage or duplicates.                                               |
| Significant multi-tenant outbox backlog (120 jobs, `batchSize=40`)          | Reconciled across 3 bounded passes (`60` Org A + `60` Org B), `0` remaining `PENDING` rows, zero duplicates.                                                                                                          |
| Delayed job delivery & `markJobActive`/`markJobCompleted` hot-path          | `DELAYED + QUEUED` job never claimed before `readyAt`; promoted & completed after `readyAt`; `PENDING` outbox synced by `markJobActive`; `ScheduleExecution` telemetry updated before `JOB_COMPLETED` event emission. |
| Worker termination during `ACTIVE` execution (expired lease)                | `StalledJobRecoveryService` incremented `fencingToken` (`1 -> 2`), returned job to `PENDING`/`QUEUED`; healthy Worker B completed (`fencingToken = 3`); stale Worker A rejected with `stale_fencing_token`.           |
| Scheduler OS process `SIGKILL` mid-dispatch (`multiProcessScaling.test.ts`) | Claimed `DISPATCHING` job stranded by killed PID was reclaimed by another OS worker process and completed (`attemptsMade = 1`, `fencingToken = 1`).                                                                   |
| Poison-job quarantine & repeated scheduler `start -> stopAndDrain` cycles   | Quarantined jobs never re-claimed; 3 consecutive restart cycles drained cleanly with zero leaked timers or stranded rows.                                                                                             |

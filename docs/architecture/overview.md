# PulseQueue System Architecture Overview

This document describes the **implemented** architecture of PulseQueue across `apps/backend`, `apps/worker`, `apps/frontend`, PostgreSQL 16, and Redis 7.

---

## 1. Architectural Principles

1. **PostgreSQL as the Single Source of Truth:** All durable state—organisations, users, memberships, API keys, queues, jobs, scheduling metadata, outbox records, execution leases, schedules, DLQ entries, alert rules, and platform events—lives in PostgreSQL via Prisma (17 migrations).
2. **Separation of Scheduling Control Plane and Execution Transport:** The custom PostgreSQL `PrioritySchedulerService` decides _which_ job runs next (enforcing priority, aging, DRR fairness, EDF deadlines, and tenant active-job caps). **Redis + BullMQ** act strictly as the low-latency worker dispatch transport, distributed rate-limiting store, and real-time pub/sub bus.
3. **Zero Silent Data Loss & Split-Brain Prevention:** Transactional outbox records, monotonic fencing tokens, execution leases, and conditional SQL/Prisma updates ensure crashes, duplicate deliveries, or concurrent replicas never cause lost jobs or corrupted state.
4. **Stateless API Replicas & Competing Worker Replicas:** Both API servers and worker/scheduler runtimes scale horizontally against shared PostgreSQL and Redis using PostgreSQL row locks (`FOR UPDATE SKIP LOCKED`), advisory locks (`pg_advisory_xact_lock`), and Redis atomic scripts.

---

## 2. High-Level System Architecture

```mermaid
flowchart TB
    subgraph Clients["Clients"]
        UI["React 18 Operations UI\n(Vite + TanStack Query + SSE)"]
        SDK["External API Clients\n(JWT or Scoped pq_live_ API Key)"]
    end

    subgraph APIPool["Stateless API Replicas (apps/backend)"]
        MW["Security & Governance Middleware\nHelmet, CORS, TRUST_PROXY,\nRedis EVALSHA Rate Limiter,\nJWT / API Key Auth, RBAC"]
        Routes["REST API (/api/v1/*)\nQueues, Jobs, Schedules, DLQ,\nMonitoring, Alerts, Governance, API Keys"]
        SSE["SSE Stream Controller\n(realtimeEventBus subscriber)"]
    end

    subgraph Data["Shared Infrastructure"]
        PG[("PostgreSQL 16\nPrisma Singleton Pool\n(DATABASE_POOL_SIZE)")]
        Redis[("Redis 7\nBullMQ Transport,\nEVALSHA Rate Limits,\nPub/Sub pq:org:id:events")]
    end

    subgraph WorkerPool["Worker & Scheduler Replicas (apps/worker)"]
        Runtime["WorkerRuntime\n(2-Stage Bounded Shutdown)"]
        Sched["PrioritySchedulerService\n(6 Custom Policies +\njsonb_to_recordset Claim)"]
        BG["Background Loops\nOutboxReconciler, ScheduleDispatcher,\nStalledJobRecovery, WorkerHealth,\nAlertEvaluator, EventRetention"]
        WM["WorkerManager\n(BullMQ Workers + Job Handlers\n+ Lease Heartbeats)"]
    end

    UI -->|HTTPS REST + SSE| MW
    SDK -->|HTTPS REST| MW
    MW --> Routes
    MW --> SSE
    Routes -->|Prisma Queries & Transactions| PG
    MW -->|EVALSHA| Redis
    Redis -->|Pub/Sub Fan-Out| SSE

    Runtime --> Sched
    Runtime --> BG
    Runtime --> WM

    Sched -->|FOR UPDATE SKIP LOCKED +\npg_advisory_xact_lock| PG
    Sched -->|Bounded Parallel Enqueue (chunk=8)| Redis
    BG -->|Advisory Locks & Conditional Updates| PG
    BG -->|Idempotent Enqueue| Redis
    Redis -->|BullMQ Job Delivery| WM
    WM -->|Verify Fencing Token & Commit| PG
    WM -->|Publish Events| Redis
```

---

## 3. Component Responsibilities

### 3.1 React Frontend (`apps/frontend`)

- Single-page application built with React 18, TypeScript, Vite 6, React Router v6, TanStack Query, Tailwind CSS, and Recharts.
- Exposes 11 authenticated routes (`/dashboard`, `/queues`, `/queues/:queueId`, `/jobs`, `/jobs/:jobId`, `/schedules`, `/schedules/:scheduleId`, `/monitoring`, `/alerts`, `/dlq`, `/settings`) plus `/login` and `/register`.
- Communicates exclusively over REST (`/api/v1/*`) and Server-Sent Events (SSE). Never stores JWTs in `localStorage` (uses HttpOnly refresh cookies + in-memory access token lifecycle).
- **Scope boundary:** API Key CRUD (`/api-keys`), tenant governance quota updates (`/governance`), and queue/job DRR/deadline creation parameters (`schedulingPolicy`, `deadlineAt`, `schedulingCost`) are currently API-first; `SchedulerObservabilitySection` surfaces live DRR/EDF metrics in the Monitoring view.

### 3.2 REST API & Security Layer (`apps/backend`)

Mounted in `apps/backend/src/routes/index.ts`:

- `/health` (`GET /health`, `/health/live`, `/health/ready`, `/health/scheduler`): Liveness, PostgreSQL/Redis readiness, process identity (`INSTANCE_ID`, PID), and effective Prisma pool config.
- `/api/v1/auth`: Registration, login, atomic rotating refresh tokens with reuse-detection revocation, and logout.
- `/api/v1/organisations/:organisationId/api-keys`: Scoped HMAC-SHA256 tenant API keys (`pq_live_...`), gated to JWT `ADMIN`/`OWNER`.
- `/api/v1/organisations/:organisationId/queues` & `.../queues/:queueId/jobs` & `.../jobs`: Queue lifecycle, job submission (with idempotency keys `(queueId, idempotencyKey)`), inspection, and cancellation.
- `/api/v1/organisations/:organisationId/governance`: Per-tenant active-job quotas, rate caps, backpressure, retry budgets, and poison-job quarantine inspection.
- `/api/v1/organisations/:organisationId/schedules`: Cron and one-time schedule definitions with timezone/DST awareness, misfire policies, and max concurrent run limits.
- `/api/v1/organisations/:organisationId/dlq`: Dead Letter Queue inspection and atomic conditional replay (`OPEN -> REPLAYED`).
- `/api/v1/organisations/:organisationId/monitoring`, `/alert-rules`, `/alerts`, `/notifications`: Metrics (2 s per-process TTL cache), worker health, persisted platform events, alert evaluation, and SSE streaming.

### 3.3 PostgreSQL & Prisma Connection Pooling (`apps/backend/src/config/database.ts`)

- Single `PrismaClient` singleton shared across `@pulsequeue/backend` and `@pulsequeue/worker`.
- `buildPooledDatabaseUrl(...)` enforces explicit `DATABASE_URL` query params first, then `DATABASE_POOL_SIZE` / `DATABASE_POOL_TIMEOUT_SEC`, defaulting to `connection_limit=10` in `NODE_ENV=production` to stay within PostgreSQL `max_connections` across multiple replicas.

### 3.4 Redis & BullMQ Integration

Redis 7 serves three distinct, non-overlapping roles:

1. **BullMQ Execution Transport:** Receives dispatched job envelopes (`jobId = job.id` for idempotent deduplication) and delivers them to active `WorkerManager` consumers. Queues configured as `LEGACY_BULLMQ` enqueue via transactional outbox; queues configured with any of the 6 custom policies are claimed and dispatched by `PrioritySchedulerService` and still executed by BullMQ workers.
2. **Distributed Rate Limiting (`rateLimit.middleware.ts`):** Executes atomic Lua rate-limit windows via `EVALSHA` (with automatic `NOSCRIPT` fallback to `EVAL`), sharing limits consistently across all API replicas.
3. **Real-Time Event Pub/Sub (`realtimeEventBus`):** Publishes organisation-scoped events to `pq:org:<orgId>:events` so any API replica holding an SSE client connection receives live updates regardless of which worker executed the job.

### 3.5 Custom PostgreSQL Scheduler (`PrioritySchedulerService`)

Supports **six custom scheduling policies** (plus `LEGACY_BULLMQ`):

- `FIFO` — strict creation-time ordering.
- `STRICT_PRIORITY` — highest priority first.
- `PRIORITY_AGING` — dynamic priority boost proportional to wait time to prevent starvation.
- `WEIGHTED_FAIR` — Deficit Round-Robin (DRR) using tenant weights and per-job `schedulingCost`.
- `DEADLINE_AWARE` — Earliest Deadline First (EDF) using `deadlineAt`, recording `deadlineMissedAt` when breached.
- `HYBRID_FAIR_DEADLINE` — combines DRR fairness accounting with EDF deadline urgency.

**Claiming & Dispatch Mechanics:**

1. Acquires a per-organisation transaction-scoped advisory lock (`pg_advisory_xact_lock`) to serialize tenant deficit updates and active-job reservation checks without blocking other organisations.
2. Selects eligible `QUEUED` (or matured `DELAYED`) candidates using `FOR UPDATE SKIP LOCKED` so concurrent scheduler replicas never claim the same job.
3. Executes a single batched PostgreSQL `UPDATE jobs ... FROM jsonb_to_recordset(...)` inside the same transaction, atomically transitioning `QUEUED -> DISPATCHING`, incrementing the monotonic `fencingToken`, persisting `schedulingDecision` and `deadlineMissedAt`, updating DRR deficit counters, and reserving tenant active-job capacity. If any assertion fails, the entire transaction rolls back cleanly.
4. Dispatches claimed jobs to BullMQ in bounded parallel chunks of `8`, finalizing `DISPATCHING -> DISPATCHED` (or releasing reservations on transport failure).

### 3.6 Worker Runtime (`apps/worker/src/runtime/workerRunner.ts`)

Each worker OS process runs `WorkerRuntime`, coordinating:

- `WorkerManager` (dynamic BullMQ workers per active queue)
- `PrioritySchedulerService` loop
- `OutboxReconciler` loop
- `ScheduleDispatcherService` loop (`pg_advisory_xact_lock(hashtext('pulsequeue:schedule:' || id))` + `@@unique([scheduleId, scheduledFor])`)
- `StalledJobRecoveryService` loop
- `WorkerHealthService` heartbeats & stale-worker detection
- `AlertEvaluatorService` (`pg_try_advisory_xact_lock` per org) & `EventRetentionService`

**Bounded Graceful Shutdown (`WorkerRuntime.stop()`):**

- Deduplicates repeated `SIGTERM`/`SIGINT` signals via a shared `shutdownPromise`.
- Stops accepting new BullMQ work and runs a 2-stage bounded scheduler drain (`shutdownDrainTimeoutMs` + `shutdownEscalationGraceMs`).
- Never disconnects Prisma/Redis underneath an active scheduler tick; if still busy after bounded escalation, attaches idempotent deferred cleanup to `PrioritySchedulerService.whenDrained()` and exits non-zero under a hard force-exit timer.

---

## 4. Job Submission and Dispatch Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant API as Express API Replica
    participant PG as PostgreSQL 16
    participant Sched as PrioritySchedulerService
    participant Redis as Redis / BullMQ

    Client->>API: POST /api/v1/organisations/:orgId/queues/:queueId/jobs
    API->>Redis: EVALSHA rate-limit check
    API->>PG: Validate tenant quotas, idempotencyKey, persist Job (QUEUED/DELAYED)
    Note over API,PG: LEGACY_BULLMQ queues also insert a PENDING JobDispatchOutbox row atomically
    API-->>Client: 201 Created (jobId, status)

    loop Scheduler Tick (Custom Policies)
        Sched->>PG: BEGIN; pg_advisory_xact_lock(orgId)
        Sched->>PG: SELECT eligible jobs ... FOR UPDATE SKIP LOCKED
        Sched->>PG: Batched UPDATE via jsonb_to_recordset\n(QUEUED -> DISPATCHING, fencingToken++, DRR deficit, tenant reservation)
        Sched->>PG: COMMIT
        Sched->>Redis: Enqueue batch to BullMQ (bounded concurrency = 8, jobId = job.id)
        alt Enqueue Succeeded
            Sched->>PG: markDispatched (guarded by dispatchClaimedBy & fencingToken)
        else Enqueue Failed
            Sched->>PG: releaseReservations (return eligible job, release tenant capacity)
        end
    end
```

---

## 5. Worker Execution and Failure Recovery Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Redis as Redis / BullMQ
    participant Worker as WorkerManager (OS Process)
    participant PG as PostgreSQL 16
    participant Recovery as StalledJobRecovery / OutboxReconciler
    participant PubSub as Redis Pub/Sub -> SSE

    Redis->>Worker: Deliver job envelope (jobId, fencingToken)
    Worker->>PG: markJobActive(jobId, fencingToken, workerInstanceId)
    alt Stale Fencing Token or Invalid State
        PG-->>Worker: Reject activation (no state mutated)
        Worker-->>Redis: Drop stale delivery safely
    else Valid Claim
        PG-->>Worker: Lease acquired (status = ACTIVE, leaseExpiresAt)
        Worker->>PubSub: Publish job.active event
        loop Heartbeat while running
            Worker->>PG: Renew execution lease
        end
        alt Handler Succeeds
            Worker->>PG: markJobCompleted (guarded by fencingToken; update scheduleExecution if linked)
            Worker->>PubSub: Publish job.completed event
        else Handler Throws Error
            Worker->>PG: markJobFailed (retry with backoff OR move to DLQ / Poison Quarantine)
            Worker->>PubSub: Publish job.failed / job.dlq event
        end
    end

    Note over Recovery,PG: Background Failure Recovery (Safe Across Multiple Replicas)
    Recovery->>PG: recoverStaleReservations (DISPATCHING timeout -> requeue)
    Recovery->>PG: StalledJobRecovery (ACTIVE with expired lease, guarded by stalledCount & fencingToken)
    Recovery->>PG: OutboxReconciler (PENDING outbox -> idempotent BullMQ enqueue)
```

---

## 6. Distributed Coordination Summary

| Subsystem             | Coordination Mechanism                                                     | Multi-Replica Guarantee                                             |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| API Rate Limiting     | Redis `EVALSHA` Lua window                                                 | Shared request budget across all API processes                      |
| Job Idempotency       | PostgreSQL unique `(queueId, idempotencyKey)`                              | Duplicate HTTP submissions return existing job                      |
| Scheduler Claiming    | `pg_advisory_xact_lock(org)` + `FOR UPDATE SKIP LOCKED`                    | Zero duplicate claims across competing worker/scheduler processes   |
| Worker Execution      | Monotonic `fencingToken` + conditional `updateMany`                        | Stale deliveries or crashed workers cannot overwrite newer attempts |
| Outbox Reconciliation | Conditional `status = PENDING` + BullMQ `jobId = job.id`                   | At-least-once dispatch with transport deduplication                 |
| Schedule Dispatch     | `pg_advisory_xact_lock(schedule)` + `@@unique([scheduleId, scheduledFor])` | Exactly-once schedule firing per scheduled timestamp                |
| Alert Evaluation      | Non-blocking `pg_try_advisory_xact_lock(org)`                              | Prevents duplicate concurrent alert evaluations per tenant          |
| DLQ Replay            | Conditional `OPEN -> REPLAYED` update                                      | Concurrent replay requests cannot double-enqueue                    |
| SSE Live Events       | Redis Pub/Sub `pq:org:<orgId>:events`                                      | All API replicas fan out worker events to connected browsers        |

---

## 7. Multi-Tenant Security Boundaries

1. **Authentication Boundary:** Every `/api/v1/*` route (except `/auth/register`, `/auth/login`, `/auth/refresh`) requires either a valid signed JWT (`JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`) or a valid scoped tenant API key (`x-api-key: pq_live_...`, verified via constant-time HMAC-SHA256 using `API_KEY_SECRET`).
2. **Tenant Isolation Boundary:** All organisation-scoped routes enforce membership validation against `:organisationId`; API keys are strictly bound to their owning organisation and cannot access cross-tenant resources or manage API keys.
3. **RBAC Boundary:** Role checks (`OWNER`, `ADMIN`, `MEMBER`) gate destructive actions, queue/schedule mutations, DLQ replays, governance changes, and API key administration.
4. **Network & Edge Hardening:** Strict `TRUST_PROXY` validation forbids unrestricted `true` to prevent `X-Forwarded-For` rate-limit spoofing; Helmet security headers and explicit `CORS_ALLOWED_ORIGINS` protect browser sessions.

# PulseQueue REST & SSE API Reference

This document is the verified API reference for all route modules mounted in `apps/backend/src/routes/index.ts`.

- **Default Local Base URL:** `http://localhost:3000`
- **API Version Prefix:** `/api/v1` (health probes are mounted at `/health`)
- **Content Type:** `application/json` (except SSE streaming at `GET .../monitoring/stream`, which returns `text/event-stream; charset=utf-8`)
- **Request Body Limits:** `16kb` on `/api/v1/auth`, `1mb` on all other routes (`payload` fields inside jobs/schedules/DLQ replay are additionally capped at `65,536` bytes serialized UTF-8).

---

## 1. Response Envelope, Pagination & Error Semantics

### Success Envelope (`sendSuccess`)

```json
{
  "success": true,
  "data": {},
  "timestamp": "2026-11-24T12:00:00.000Z"
}
```

### Error Envelope (`sendError`)

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  },
  "timestamp": "2026-11-24T12:00:00.000Z"
}
```

### Standard HTTP Status Codes

- `200 OK` / `201 Created`: Request succeeded.
- `400 Bad Request`: Zod schema validation failure or malformed input.
- `401 Unauthorized`: Missing, invalid, expired, or revoked JWT or API key.
- `403 Forbidden`: Authenticated caller lacks the required RBAC role or API-key scope.
- `404 Not Found`: Resource not found, invalid UUID parameter, or caller is not a member of `:organisationId` (non-members receive `404` rather than `403` to prevent organisation enumeration).
- `409 Conflict`: Uniqueness conflict (e.g., duplicate email, duplicate queue name, duplicate active invitation, or already-replayed DLQ entry).
- `429 Too Many Requests`: Redis distributed rate limit exceeded (`auth`, `write`, `dlq-replay`, or `general`) or SSE connection limit exceeded.

### Pagination

Paginated list endpoints (jobs, DLQ entries, schedules, schedule executions, events, alerts, notifications) accept `page` (integer `>= 1`, default `1`) and `limit` (integer `1..100`, default `20`).

---

## 2. Authentication, Sessions, API Keys & Tenant Isolation

### 2.1 JWT Bearer Authentication & HttpOnly Refresh Cookie Flow

- Pass the short-lived JWT access token via `Authorization: Bearer <accessToken>`.
- `POST /api/v1/auth/login` and `POST /api/v1/auth/refresh` issue a new access token and set an **HttpOnly refresh cookie**.
- `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout` read the refresh token from the HttpOnly cookie (or optionally from `req.body.refreshToken` for non-browser clients).
- Refresh tokens rotate atomically on every refresh; replaying an already-rotated token triggers reuse detection and revokes the token family.

### 2.2 Scoped Tenant API Keys (`pq_live_...`)

- Supply a tenant API key using either:
  - `X-API-Key: pq_live_...`
  - `Authorization: ApiKey pq_live_...`
- **One-Time Plaintext Display:** The raw `pq_live_...` secret is returned **only once** upon creation (`POST .../api-keys`) or rotation (`POST .../api-keys/:apiKeyId/rotate`). PulseQueue persists only an HMAC-SHA256 digest (`API_KEY_SECRET` pepper).
- **Strict Tenant Isolation:** An API key is permanently bound to its owning `organisationId`. Requests targeting any other `:organisationId` return `404 Organisation not found`.
- **Least-Privilege Scopes (`API_KEY_SCOPES`):**
  `queues:read`, `queues:write`, `jobs:read`, `jobs:write`, `jobs:cancel`, `dlq:read`, `dlq:replay`, `schedules:read`, `schedules:write`, `monitoring:read`, `governance:read`.
- **JWT-Only Operations:** Endpoints without an explicit API-key scope (including organisation CRUD, member/invitation management, API-key management, governance quota mutations, queue/schedule deletion, alerts/notifications, and SSE streaming) always return `403` when called with an API key.

### 2.3 RBAC Role Hierarchy

`OWNER` (3) > `ADMIN` (2) > `MEMBER` (1). Role checks are always resolved from PostgreSQL membership records—never from client-supplied claims.

---

## 3. Health & Readiness (`/health`)

All health endpoints are unauthenticated.

| Method | Path                | Purpose                                                                                                                                            |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`           | Aggregate health status (PostgreSQL + Redis)                                                                                                       |
| `GET`  | `/health/live`      | Liveness probe (`200` while running, `503` during graceful shutdown)                                                                               |
| `GET`  | `/health/ready`     | Readiness probe (`200` only when not shutting down and PostgreSQL + Redis respond; includes `instanceId`, `pid`, and effective Prisma pool config) |
| `GET`  | `/health/scheduler` | Privacy-safe global aggregate scheduler metrics (zero tenant data)                                                                                 |

```bash
curl -s http://localhost:3000/health/ready | jq
```

---

## 4. Authentication & Sessions (`/api/v1/auth`)

`register`, `login`, and `refresh` are protected by `authRateLimiter` (`RATE_LIMIT_AUTH_MAX`, default `20/min`).

| Method | Path                    | Auth           | Key Request Fields                                                        |
| ------ | ----------------------- | -------------- | ------------------------------------------------------------------------- |
| `POST` | `/api/v1/auth/register` | Public         | `name` (2–100), `email`, `password` (8–100, upper+lower+digit)            |
| `POST` | `/api/v1/auth/login`    | Public         | `email`, `password` (sets HttpOnly refresh cookie + returns access token) |
| `POST` | `/api/v1/auth/refresh`  | Cookie or body | Optional `{ "refreshToken": "..." }` if not using HttpOnly cookie         |
| `POST` | `/api/v1/auth/logout`   | Cookie or body | Revokes refresh token and clears cookie                                   |
| `GET`  | `/api/v1/auth/me`       | JWT            | Returns authenticated user profile                                        |

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"email":"admin@example.com","password":"Password123"}'
```

---

## 5. API Key Management (`/api/v1/organisations/:organisationId/api-keys`)

**JWT-only** (`ADMIN` or `OWNER`). API keys cannot create, list, revoke, or rotate API keys. Currently an **API-first** feature (no frontend configuration form yet).

| Method | Path                                                              | Min Role | API Key Scope   | Notes                                                                                                                                                    |
| ------ | ----------------------------------------------------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/organisations/:organisationId/api-keys`                  | `ADMIN`  | None (JWT only) | Body: `name` (2–100), `scopes` (1+ from `API_KEY_SCOPES`), optional `expiresAt` (ISO-8601), optional `metadata` (<=16 keys). Returns plaintext key once. |
| `GET`  | `/api/v1/organisations/:organisationId/api-keys`                  | `ADMIN`  | None (JWT only) | Lists key metadata (prefix, scopes, expiry, revocation status; never plaintext).                                                                         |
| `POST` | `/api/v1/organisations/:organisationId/api-keys/:apiKeyId/revoke` | `ADMIN`  | None (JWT only) | Immediately revokes the key.                                                                                                                             |
| `POST` | `/api/v1/organisations/:organisationId/api-keys/:apiKeyId/rotate` | `ADMIN`  | None (JWT only) | Atomically revokes old key and issues replacement (optional `name`, `scopes`, `expiresAt`); returns new plaintext key once.                              |

```bash
curl -s -X POST "http://localhost:3000/api/v1/organisations/${ORG_ID}/api-keys" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"ci-producer","scopes":["jobs:write","jobs:read","queues:read"]}'
```

---

## 6. Organisations, Members & Invitations (`/api/v1/organisations` & `/api/v1/invitations`)

**JWT-only** (no API-key scopes assigned).

| Method   | Path                                                              | Min Role          | Notes                                                              |
| -------- | ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `POST`   | `/api/v1/organisations`                                           | Authenticated JWT | Body: `{ "name": "Acme" }` (creator becomes `OWNER`)               |
| `GET`    | `/api/v1/organisations`                                           | Authenticated JWT | Lists caller's organisations                                       |
| `GET`    | `/api/v1/organisations/:organisationId`                           | `MEMBER`          | Organisation details                                               |
| `PATCH`  | `/api/v1/organisations/:organisationId`                           | `ADMIN`           | Body: `{ "name": "..." }`                                          |
| `DELETE` | `/api/v1/organisations/:organisationId`                           | `OWNER`           | Deletes organisation                                               |
| `POST`   | `/api/v1/organisations/:organisationId/transfer-ownership`        | `OWNER`           | Body: `{ "targetUserId": "<uuid>" }`                               |
| `GET`    | `/api/v1/organisations/:organisationId/members`                   | `MEMBER`          | Lists organisation members                                         |
| `PATCH`  | `/api/v1/organisations/:organisationId/members/:userId/role`      | `ADMIN`           | Body: `{ "role": "OWNER" \| "ADMIN" \| "MEMBER" }`                 |
| `DELETE` | `/api/v1/organisations/:organisationId/members/:userId`           | `ADMIN`           | Removes member                                                     |
| `POST`   | `/api/v1/organisations/:organisationId/invitations`               | `ADMIN`           | Body: `{ "email": "...", "role": "ADMIN" \| "MEMBER" \| "OWNER" }` |
| `GET`    | `/api/v1/organisations/:organisationId/invitations`               | `ADMIN`           | Lists invitations                                                  |
| `DELETE` | `/api/v1/organisations/:organisationId/invitations/:invitationId` | `ADMIN`           | Revokes pending invitation                                         |
| `POST`   | `/api/v1/invitations/accept`                                      | Authenticated JWT | Standalone mount; Body: `{ "token": "<invite-token>" }`            |

---

## 7. Queues (`/api/v1/organisations/:organisationId/queues`)

| Method   | Path                                                           | Min Role | API Key Scope   | Notes                         |
| -------- | -------------------------------------------------------------- | -------- | --------------- | ----------------------------- |
| `POST`   | `/api/v1/organisations/:organisationId/queues`                 | `ADMIN`  | `queues:write`  | Creates queue                 |
| `GET`    | `/api/v1/organisations/:organisationId/queues`                 | `MEMBER` | `queues:read`   | Lists organisation queues     |
| `GET`    | `/api/v1/organisations/:organisationId/queues/:queueId`        | `MEMBER` | `queues:read`   | Queue details                 |
| `PATCH`  | `/api/v1/organisations/:organisationId/queues/:queueId`        | `ADMIN`  | `queues:write`  | Updates queue config/policy   |
| `DELETE` | `/api/v1/organisations/:organisationId/queues/:queueId`        | `OWNER`  | None (JWT only) | Deletes queue                 |
| `POST`   | `/api/v1/organisations/:organisationId/queues/:queueId/pause`  | `ADMIN`  | `queues:write`  | Pauses queue dispatch         |
| `POST`   | `/api/v1/organisations/:organisationId/queues/:queueId/resume` | `ADMIN`  | `queues:write`  | Resumes queue dispatch        |
| `GET`    | `/api/v1/organisations/:organisationId/queues/:queueId/stats`  | `MEMBER` | `queues:read`   | Queue counts and health stats |

### Queue Request Fields & Scheduling Policies

- `name`: required lowercase slug (`^[a-z0-9][a-z0-9._-]{1,63}$`, no colons/spaces).
- `concurrency` (`1..100`, default `5`), `defaultPriority` (`1..20`, default `5`), `maxRetries` (`0..20`, default `3`), `backoffMs` (`0..300000`, default `1000`).
- **Governance/Safety fields:** `maxQueueDepth` (`1..1000000`), `backpressureMaxAgeMs` (`100..86400000`), `retryBudgetMaxRetries` (`0..100000`), `retryBudgetWindowSeconds` (`10..86400`), `poisonFailureThreshold` (`2..20`).
- **`schedulingPolicy`:** `FIFO` | `STRICT_PRIORITY` | `PRIORITY_AGING` | `WEIGHTED_FAIR` | `DEADLINE_AWARE` | `HYBRID_FAIR_DEADLINE` | `LEGACY_BULLMQ`.
- **Policy tuning (API-first):** `agingRatePerSec` (`0.001..10.0`), `maxEffectivePriority` (`20..100`), `starvationThresholdSec` (`10..86400`), `schedulingWeight` (`1..100`), `deadlineUrgencyWindowSec` (`5..86400`).

```bash
curl -s -X POST "http://localhost:3000/api/v1/organisations/${ORG_ID}/queues" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name":"billing-events","concurrency":10,"schedulingPolicy":"HYBRID_FAIR_DEADLINE","schedulingWeight":5,"deadlineUrgencyWindowSec":30}'
```

---

## 8. Governance, Quotas & Quarantine (`/api/v1/organisations/:organisationId/governance`)

Currently an **API-first** feature.

| Method  | Path                                                      | Min Role | API Key Scope     | Notes                                                                       |
| ------- | --------------------------------------------------------- | -------- | ----------------- | --------------------------------------------------------------------------- |
| `GET`   | `/api/v1/organisations/:organisationId/governance`        | `MEMBER` | `governance:read` | Returns current quotas, retry budgets, DRR settings, and quarantine summary |
| `PATCH` | `/api/v1/organisations/:organisationId/governance/quotas` | `ADMIN`  | None (JWT only)   | Updates tenant quotas, retry budgets, or DRR fairness parameters            |

### Updatable Governance Fields (`PATCH .../governance/quotas`)

At least one field required (`.strict()`): `maxOutstandingJobs` (`1..1000000`), `maxActiveJobs` (`1..100000`), `maxQueuedJobs` (`1..1000000`), `maxDelayedJobs` (`1..1000000`), `maxPayloadBytes` (`128..65536`), `retryBudgetMaxRetries` (`0..100000`), `retryBudgetWindowSeconds` (`10..86400`), `schedulingWeight` (`1..100`), `drrBaseQuantum` (`1..1000`), `drrMaxDeficit` (`100..10000`).

---

## 9. Jobs (`/api/v1/organisations/:organisationId/queues/:queueId/jobs` & `.../jobs`)

`POST .../jobs` is additionally protected by `jobSubmitRateLimiter`.

| Method | Path                                                                       | Min Role | API Key Scope | Notes                                                                                                                |
| ------ | -------------------------------------------------------------------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/v1/organisations/:organisationId/queues/:queueId/jobs`               | `MEMBER` | `jobs:write`  | Submit job (idempotent when `idempotencyKey` supplied)                                                               |
| `GET`  | `/api/v1/organisations/:organisationId/queues/:queueId/jobs`               | `MEMBER` | `jobs:read`   | Query: `status`, `page` (default `1`), `limit` (`1..100`, default `20`), `sortOrder` (`asc`\|`desc`, default `desc`) |
| `GET`  | `/api/v1/organisations/:organisationId/queues/:queueId/jobs/:jobId`        | `MEMBER` | `jobs:read`   | Job details + execution history                                                                                      |
| `POST` | `/api/v1/organisations/:organisationId/queues/:queueId/jobs/:jobId/cancel` | `ADMIN`  | `jobs:cancel` | Cancels eligible non-terminal job                                                                                    |
| `GET`  | `/api/v1/organisations/:organisationId/jobs/:jobId`                        | `MEMBER` | `jobs:read`   | Direct org-scoped job lookup                                                                                         |
| `POST` | `/api/v1/organisations/:organisationId/jobs/:jobId/cancel`                 | `ADMIN`  | `jobs:cancel` | Direct org-scoped job cancellation                                                                                   |

### Job Submission Fields

- `name` (required, 2–128 chars), `payload` (JSON object, max `65,536` bytes, default `{}`).
- `priority` (`1..20`), `maxRetries` (`0..20`), `backoffMs` (`0..300000`), `delayMs` (`0..86400000`, default `0`).
- `idempotencyKey` (optional, 1–128 chars; unique per `(queueId, idempotencyKey)`).
- **DRR & EDF fields (API-first):** `schedulingCost` (`1..100`, default `1`), `deadlineAt` (optional ISO-8601 timestamp with offset, or `null`).

```bash
curl -s -X POST "http://localhost:3000/api/v1/organisations/${ORG_ID}/queues/${QUEUE_ID}/jobs" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name":"invoice.render","payload":{"invoiceId":"inv_1042"},"priority":10,"maxRetries":3,"backoffMs":2000,"delayMs":0,"schedulingCost":4,"deadlineAt":"2026-11-24T19:00:00Z","idempotencyKey":"inv-1042-v1"}'
```

---

## 10. Schedules (`/api/v1/organisations/:organisationId/schedules`)

| Method   | Path                                                                     | Min Role | API Key Scope     | Notes                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------ | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/organisations/:organisationId/schedules`                        | `ADMIN`  | `schedules:write` | Creates `ONE_TIME` or `RECURRING` schedule (`queueId`, `name`, `type`, `jobName`, `payload`, cron/interval/runAt, IANA `timezone`, misfire policy, max concurrent runs) |
| `GET`    | `/api/v1/organisations/:organisationId/schedules`                        | `MEMBER` | `schedules:read`  | Lists schedules                                                                                                                                                         |
| `POST`   | `/api/v1/organisations/:organisationId/schedules/reconcile`              | `ADMIN`  | `schedules:write` | Triggers immediate schedule reconciliation sweep                                                                                                                        |
| `GET`    | `/api/v1/organisations/:organisationId/schedules/:scheduleId`            | `MEMBER` | `schedules:read`  | Schedule details                                                                                                                                                        |
| `PATCH`  | `/api/v1/organisations/:organisationId/schedules/:scheduleId`            | `ADMIN`  | `schedules:write` | Updates schedule configuration                                                                                                                                          |
| `POST`   | `/api/v1/organisations/:organisationId/schedules/:scheduleId/pause`      | `ADMIN`  | `schedules:write` | Pauses schedule                                                                                                                                                         |
| `POST`   | `/api/v1/organisations/:organisationId/schedules/:scheduleId/resume`     | `ADMIN`  | `schedules:write` | Resumes schedule                                                                                                                                                        |
| `POST`   | `/api/v1/organisations/:organisationId/schedules/:scheduleId/cancel`     | `ADMIN`  | `schedules:write` | Permanently cancels schedule                                                                                                                                            |
| `DELETE` | `/api/v1/organisations/:organisationId/schedules/:scheduleId`            | `OWNER`  | None (JWT only)   | Deletes schedule                                                                                                                                                        |
| `GET`    | `/api/v1/organisations/:organisationId/schedules/:scheduleId/executions` | `MEMBER` | `schedules:read`  | Paginated execution history                                                                                                                                             |
| `GET`    | `/api/v1/organisations/:organisationId/schedules/:scheduleId/next-run`   | `MEMBER` | `schedules:read`  | Computes next scheduled timestamp(s)                                                                                                                                    |
| `GET`    | `/api/v1/organisations/:organisationId/schedules/:scheduleId/stats`      | `MEMBER` | `schedules:read`  | Execution & misfire statistics                                                                                                                                          |

---

## 11. Dead Letter Queue (`/api/v1/organisations/:organisationId/dlq`)

Jobs that exhaust retries, breach tenant retry budgets, or hit `poisonFailureThreshold` (poison-job quarantine) are persisted in the DLQ. Replay uses an atomic conditional `OPEN -> REPLAYED` transition so concurrent replay calls cannot double-enqueue, and is rate-limited via `dlqReplayRateLimiter` (`RATE_LIMIT_DLQ_REPLAY_MAX`, default `60/min`).

| Method | Path                                                      | Min Role | API Key Scope | Notes                                                                               |
| ------ | --------------------------------------------------------- | -------- | ------------- | ----------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/organisations/:organisationId/dlq`               | `MEMBER` | `dlq:read`    | Query: `status` (`DeadLetterStatus`), `queueId`, `page`, `limit` (`1..100`)         |
| `GET`  | `/api/v1/organisations/:organisationId/dlq/:dlqId`        | `MEMBER` | `dlq:read`    | Full failure reason, stack/attempts, and poison quarantine metadata                 |
| `POST` | `/api/v1/organisations/:organisationId/dlq/:dlqId/replay` | `ADMIN`  | `dlq:replay`  | Optional override body: `payload` (<=64 KiB), `priority`, `maxRetries`, `backoffMs` |

```bash
curl -s -X POST "http://localhost:3000/api/v1/organisations/${ORG_ID}/dlq/${DLQ_ID}/replay" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"priority":15,"maxRetries":2}'
```

---

## 12. Monitoring & Real-Time SSE Streaming (`/api/v1/organisations/:organisationId/monitoring`)

| Method | Path                                                                  | Min Role | API Key Scope     | Notes                                                                                     |
| ------ | --------------------------------------------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/metrics`            | `MEMBER` | `monitoring:read` | Query: `windowMinutes` (`1..10080`, default `60`). Backed by a 2 s per-process TTL cache. |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/metrics/timeseries` | `MEMBER` | `monitoring:read` | Query: `windowMinutes` (`5..10080`, default `60`), `bucketMinutes` (`1 \| 5 \| 15 \| 60`) |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/scheduler`          | `MEMBER` | `monitoring:read` | Policy distribution, DRR/EDF fairness & deadline metrics, starvation & latency            |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/workers`            | `MEMBER` | `monitoring:read` | Registered worker instances, heartbeats, active status                                    |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/events`             | `MEMBER` | `monitoring:read` | Paginated persisted `PlatformEvent` audit stream                                          |
| `GET`  | `/api/v1/organisations/:organisationId/monitoring/stream`             | `MEMBER` | None (JWT only)   | Server-Sent Events (SSE) stream backed by Redis Pub/Sub                                   |
| `POST` | `/api/v1/organisations/:organisationId/monitoring/recover-stalled`    | `ADMIN`  | None (JWT only)   | Manually triggers stalled-job lease recovery sweep                                        |

### SSE Event Streaming & Redis Pub/Sub Behavior (`GET .../monitoring/stream`)

- **Connection Limits:** Per-user, per-organisation, and global SSE limits are enforced _before_ flushing SSE headers; over-limit requests receive a standard JSON `429 Too Many Requests` response.
- **Zero-Gap Redis Pub/Sub Fan-Out:** The API replica subscribes to Redis Pub/Sub channel `pq:org:<organisationId>:events` _before_ replaying missed PostgreSQL events, guaranteeing no events are lost across multi-replica deployments.
- **Control Events & Cursor Replay:**
  - Sends an initial `connected` event (`organisationId`, `connectedAt`, `heartbeatIntervalMs`).
  - Clients reconnecting with a `Last-Event-ID` header receive missed events replayed from PostgreSQL (up to `DEFAULT_MAX_REPLAY_EVENTS`); if the cursor is invalid, missing, or expired, the server emits a `resync` control event so the client refreshes state cleanly.

```bash
curl -N "http://localhost:3000/api/v1/organisations/${ORG_ID}/monitoring/stream" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Accept: text/event-stream"
```

---

## 13. Alert Rules & Alerts (`/alert-rules` & `/alerts`)

**JWT-only** (no API-key scopes assigned).

### Alert Rules (`/api/v1/organisations/:organisationId/alert-rules`)

| Method   | Path                                                               | Min Role | Notes                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/v1/organisations/:organisationId/alert-rules`                | `MEMBER` | Lists configured alert rules                                                                                                                                                                                             |
| `GET`    | `/api/v1/organisations/:organisationId/alert-rules/:ruleId`        | `MEMBER` | Single alert rule                                                                                                                                                                                                        |
| `POST`   | `/api/v1/organisations/:organisationId/alert-rules`                | `ADMIN`  | Body: `name`, `type` (`AlertType`), `threshold`, optional `operator`, `windowMinutes` (`1..1440`), `cooldownSeconds` (`0..86400`), `queueId` (forbidden for `WORKER_STALE`/`SCHEDULE_MISFIRES`), `severity`, `isEnabled` |
| `PATCH`  | `/api/v1/organisations/:organisationId/alert-rules/:ruleId`        | `ADMIN`  | Updates alert rule                                                                                                                                                                                                       |
| `PATCH`  | `/api/v1/organisations/:organisationId/alert-rules/:ruleId/toggle` | `ADMIN`  | Toggles rule enabled/disabled state                                                                                                                                                                                      |
| `DELETE` | `/api/v1/organisations/:organisationId/alert-rules/:ruleId`        | `ADMIN`  | Deletes alert rule                                                                                                                                                                                                       |

### Alerts (`/api/v1/organisations/:organisationId/alerts`)

| Method | Path                                                                | Min Role | Notes                           |
| ------ | ------------------------------------------------------------------- | -------- | ------------------------------- |
| `GET`  | `/api/v1/organisations/:organisationId/alerts`                      | `MEMBER` | Lists triggered alerts          |
| `GET`  | `/api/v1/organisations/:organisationId/alerts/stats`                | `MEMBER` | Alert counts by status/severity |
| `GET`  | `/api/v1/organisations/:organisationId/alerts/:alertId`             | `MEMBER` | Single alert details            |
| `POST` | `/api/v1/organisations/:organisationId/alerts/:alertId/acknowledge` | `MEMBER` | Acknowledges alert              |
| `POST` | `/api/v1/organisations/:organisationId/alerts/:alertId/resolve`     | `ADMIN`  | Resolves alert                  |

---

## 14. In-App Notifications (`/api/v1/organisations/:organisationId/notifications`)

**JWT-only** (no API-key scopes assigned).

| Method  | Path                                                                       | Min Role | Notes                                                    |
| ------- | -------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| `GET`   | `/api/v1/organisations/:organisationId/notifications`                      | `MEMBER` | Lists caller's in-app notifications for the organisation |
| `GET`   | `/api/v1/organisations/:organisationId/notifications/unread-count`         | `MEMBER` | Returns unread notification count                        |
| `POST`  | `/api/v1/organisations/:organisationId/notifications/read-all`             | `MEMBER` | Marks all notifications read                             |
| `PATCH` | `/api/v1/organisations/:organisationId/notifications/:notificationId/read` | `MEMBER` | Marks a single notification read                         |

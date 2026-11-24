# PulseQueue Security Architecture

## 1. Authentication & Password Handling

- **Password Hashing:** `bcryptjs` with work factor `12` (`BCRYPT_SALT_ROUNDS = 12`). Plaintext passwords and hashes are never logged or returned in API responses.
- **Constant-Time Login:** `AuthService.login` compares against a precomputed dummy bcrypt(12) hash when an email is not found, eliminating timing-based account enumeration.
- **Access Tokens (JWT):**
  - Signed with `HS256` using `JWT_SECRET` and a `15m` expiration (`ACCESS_TOKEN_EXPIRATION = '15m'`).
  - Verification enforces `algorithms: ['HS256']`, `issuer: JWT_ISSUER`, `audience: JWT_AUDIENCE`, expiration (`exp`), valid UUID `sub`, and non-empty `email`.
  - Delivered via `Authorization: Bearer <token>` header; tokens are never accepted via URL query strings.
- **Refresh Tokens & Rotation:**
  - 32-byte cryptographically random tokens (`crypto.randomBytes(32)`) stored only as deterministic SHA-256 hashes in PostgreSQL (`refresh_tokens`), with a `7d` TTL.
  - Delivered via `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth` cookie (`Secure` enabled in `production`) and supported in request body for non-browser clients.
  - **Atomic Single-Use Rotation:** `AuthService.refreshToken` atomically revokes the presented token via conditional `updateMany({ where: { id, isRevoked: false }, data: { isRevoked: true } })` inside a PostgreSQL transaction. Presenting an already-revoked or concurrently raced token immediately revokes **all** active refresh tokens for that user.

## 2. Tenant-Scoped API Keys & Scope Model

- **Key Format & Storage:** Generated as `pq_live_<8hex_prefix>_<48hex_secret>` (192 bits of entropy via `crypto.randomBytes`). Only `HMAC-SHA256(API_KEY_SECRET, plaintextKey)` is stored in PostgreSQL (`api_keys.key_hash`). Plaintext keys are returned **strictly once** on creation or rotation and verified with `crypto.timingSafeEqual`.
- **Headers Supported:** `X-API-Key: pq_live_...` or `Authorization: ApiKey pq_live_...`.
- **Least-Privilege Scopes:**
  - `queues:read`, `queues:write`
  - `jobs:read`, `jobs:write`, `jobs:cancel`
  - `dlq:read`, `dlq:replay`
  - `schedules:read`, `schedules:write`
  - `monitoring:read`, `governance:read`
- **Hard Privilege Ceiling:** API keys **never** grant `OWNER` or unrestricted `ADMIN` privileges. They cannot delete organisations, transfer ownership, delete queues/schedules, modify governance quotas, manage members/invitations, or manage API keys.
- **Lifecycle & Audit Endpoints (JWT `ADMIN`/`OWNER` only):**
  - `POST /api/v1/organisations/:organisationId/api-keys` (`API_KEY_CREATED`)
  - `GET /api/v1/organisations/:organisationId/api-keys` (redacted; never returns plaintext or hash)
  - `POST /api/v1/organisations/:organisationId/api-keys/:apiKeyId/revoke` (`API_KEY_REVOKED`)
  - `POST /api/v1/organisations/:organisationId/api-keys/:apiKeyId/rotate` (atomic revoke + issue replacement; `API_KEY_ROTATED`)

## 3. Distributed Rate Limiting & Redis Failure Policy

- **Architecture:** All API instances share rate-limit state in Redis via an atomic single-roundtrip Lua script (`INCR` + `PEXPIRE` + `PTTL`), eliminating GET/INCR/EXPIRE race conditions across horizontally scaled replicas.
- **Key Privacy & Bounded Growth:** Redis keys use `pq:rl:<policy>:<sha256_prefix_24(identity)>` (never storing raw IPs, emails, or tokens) and always attach a `PEXPIRE` TTL.
- **Response Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` on `429 Too Many Requests`. Tenant-scoped `SECURITY_RATE_LIMIT_EXCEEDED` audit events are recorded asynchronously.
- **Explicit Redis Failure Policy:**

| Endpoint Category                                       | Policy Name  | Default Limit / Window |   Redis Outage Behavior   | Rationale                                                                 |
| :------------------------------------------------------ | :----------- | :--------------------: | :-----------------------: | :------------------------------------------------------------------------ |
| Authentication (`/auth/login`, `/register`, `/refresh`) | `auth`       |      `20` / `60s`      | **`fail-closed` (`503`)** | Prevents credential stuffing / brute-force during Redis outage.           |
| DLQ Replay (`POST /dlq/:dlqId/replay`)                  | `dlq_replay` |      `60` / `60s`      | **`fail-closed` (`503`)** | Prevents unthrottled replay storms during Redis outage.                   |
| Job Submission (`POST /queues/:queueId/jobs`)           | `job_submit` |     `300` / `60s`      |      **`fail-open`**      | Preserves durable PostgreSQL transactional outbox ingestion.              |
| General API (`/api/v1/*`)                               | `general`    |     `600` / `60s`      |      **`fail-open`**      | Keeps read/monitoring endpoints available during transient Redis hiccups. |

Redis connection strings, passwords, and internal hostnames are never exposed in `503` responses or structured logs.

## 4. RBAC Permission Matrix & Tenant Isolation

All organisation-scoped routes require `authenticate` followed by `requireOrgRole(minRole, requiredScope?)`:

| Operation Category                                               | `MEMBER` | `ADMIN` | `OWNER` | Scoped API Key | Non-Member / Cross-Org Key |
| :--------------------------------------------------------------- | :------: | :-----: | :-----: | :------------: | :------------------------: |
| Read org, queues, jobs, schedules, DLQ, metrics, governance      |  Allow   |  Allow  |  Allow  |   If scoped    |           `404`            |
| Submit jobs (`jobs:write`)                                       |  Allow   |  Allow  |  Allow  |   If scoped    |           `404`            |
| Manage queues, cancel jobs, replay DLQ, manage schedules         |  `403`   |  Allow  |  Allow  |   If scoped    |           `404`            |
| Manage members, invitations, governance quotas, API keys         |  `403`   |  Allow  |  Allow  |   **`403`**    |           `404`            |
| Delete organisation, transfer ownership, delete queues/schedules |  `403`   |  `403`  |  Allow  |   **`403`**    |           `404`            |

- **Strict Input Validation & Mass-Assignment Prevention:** Auth, organisation, membership/invitation, governance, and API key schemas enforce Zod `.strict()` (`400` on unexpected fields). Queue and job schemas safely strip unknown fields (`organisationId`, `isPaused`, `status`, `fencingToken`) for backward compatibility.
- **Route Body Limits:** `/api/v1/auth` enforces a tight `16kb` JSON body cap; general API routes enforce `1mb`.

## 5. Trusted Proxy, Secrets Management & Production Deployment

| Variable                                            | Required  | Default                                | Security Notes                                                                                                                                                                                   |
| :-------------------------------------------------- | :-------: | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                          |    No     | `development`                          | Set to `production` in deployed environments (`Secure` cookies, error stack redaction, strict secret checks).                                                                                    |
| `DATABASE_URL`                                      |    Yes    | —                                      | PostgreSQL connection string; redacted from logs.                                                                                                                                                |
| `REDIS_URL`                                         |    Yes    | —                                      | Redis connection string (`rediss://` for TLS in production); credentials masked via `sanitizeRedisUrl`.                                                                                          |
| `JWT_SECRET`                                        |    Yes    | —                                      | Min 16 chars in dev/test; **min 32 chars in `production`**.                                                                                                                                      |
| `API_KEY_SECRET`                                    | Prod only | Dev default                            | Dedicated HMAC pepper for API key hashing; **must be explicitly set (>= 32 chars) and distinct from `JWT_SECRET` in `production`**.                                                              |
| `JWT_ISSUER` / `JWT_AUDIENCE`                       |    No     | `pulsequeue-api` / `pulsequeue-client` | Enforced on JWT sign and verify.                                                                                                                                                                 |
| `CORS_ALLOWED_ORIGINS`                              | Prod rec. | Local dev origins                      | Comma-separated allowlist; arbitrary origins are never reflected with credentials.                                                                                                               |
| `TRUST_PROXY`                                       |    No     | `false`                                | Allowed values: `false`, `loopback`, `linklocal`, `uniquelocal`, or hop count `1..5`. Unrestricted `true` is rejected at startup so spoofed `X-Forwarded-For` headers cannot bypass rate limits. |
| `RATE_LIMIT_WINDOW_MS`                              |    No     | `60000`                                | Window duration in ms (`1000..3600000`).                                                                                                                                                         |
| `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_DLQ_REPLAY_MAX` |    No     | `20` / `60`                            | Fail-closed limits per window.                                                                                                                                                                   |
| `RATE_LIMIT_WRITE_MAX` / `RATE_LIMIT_GENERAL_MAX`   |    No     | `300` / `600`                          | Fail-open limits per window.                                                                                                                                                                     |

### Credential Rotation & Secret Injection Guidance

- Inject secrets exclusively via your deployment platform's secret manager (Kubernetes Secrets / External Secrets Operator, AWS Secrets Manager, GCP Secret Manager, Vault) as environment variables — never commit `.env` files.
- **API Key Rotation:** Use `POST /api/v1/organisations/:orgId/api-keys/:apiKeyId/rotate` to atomically revoke the old key and issue a replacement without downtime across other keys.
- **JWT Secret Rotation:** Rolling `JWT_SECRET` invalidates existing 15-minute access tokens immediately; clients automatically refresh via their HttpOnly refresh token cookie.

## 6. Security Test Coverage & Dependency Audit

### Automated Security Suites

- `apps/backend/tests/securityHardening.test.ts` (Phase 9.1): JWT claim/algorithm enforcement, production secret floor, RBAC boundaries, cross-org IDOR, mass assignment, strict CORS allowlist, atomic refresh rotation, and rate-limit headers.
- `apps/backend/tests/distributedSecurity.test.ts` (Phase 9.2): Multi-instance Redis Lua rate limiting, concurrent burst atomicity, window reset, fail-closed/fail-open outage policies, trusted-proxy anti-spoofing, API key lifecycle/scopes/rotation, and tenant-scoped audit events.
- `apps/backend/tests/securityPenetrationAndFaults.test.ts` (Phase 9.3): Revoked-session reuse chains, 16 KiB auth payload cap, global `/health` privacy, `schedules:read` & `dlq:replay` API-key scope enforcement, query-param IDOR probes, concurrent API-key rotation races, Redis timeout/script fault injection & recovery, bounded Redis PTTL checks, concurrent idempotency & DLQ replay races, and audit-write outage resilience.

### Production Dependency Audit (`npm audit --omit=dev`)

Inspected via `npm audit --omit=dev` and `npm ls` against 216 production dependencies (`0 critical`, `5 high`, `2 moderate`, `0 low`). `npm audit fix --dry-run --omit=dev` confirmed that **zero** non-breaking patch/minor fixes exist for these 7 advisories; all require breaking semver-major migrations:

| Package (Installed)                                                                 | Advisory                                                                   | Severity | Direct / Transitive                                                       | Fixed In                                                            | Reachability & Classification                                                                                                                                                                                                                                                                                                                                                     |
| :---------------------------------------------------------------------------------- | :------------------------------------------------------------------------- | :------: | :------------------------------------------------------------------------ | :------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zod@3.25.76`                                                                       | `GHSA-mrhx-c7xc-m3w5` (CWE-770, CVSS 7.5)                                  |   High   | Direct (`backend`, `frontend`, `worker`)                                  | `zod@4.6.6+` (major)                                                | **Reachable on API validators; mitigated + major upgrade deferred.** Mitigated by `16kb`/`1mb` Express JSON body limits, `64 KiB` job payload cap, bounded collection sizes (`scopes <= 11`, `metadata <= 16 keys`), and Redis distributed rate limiting. Upgrading to `zod@4` requires a dedicated migration across `.flatten()`, `errorMap`, and `@hookform/resolvers`.         |
| `prisma@6.19.3` -> `@prisma/config@6.19.3` -> `deepmerge-ts@7.1.5`, `effect@3.21.0` | `GHSA-ggr8-5vv4-36mx` (CWE-674), `GHSA-7589-6fvf-x4pw` (CWE-1333)          |   High   | Transitive (`devDependencies` + optional peer of `@prisma/client@6.19.3`) | `prisma@7.11+` / `8.x` (major), `deepmerge-ts@8+`, `effect@3.22.1+` | **Not reachable in deployed runtime + major upgrade deferred.** Zero imports of `@prisma/config`, `deepmerge-ts`, or `effect` exist in `apps/backend/src` or `apps/worker/src`; `@prisma/client` does not load `@prisma/config` at runtime. Remains present in CLI toolchain (`prisma generate`/`migrate`) until dedicated Prisma 7/8 migration.                                  |
| `react-router-dom@6.30.6` -> `react-router@6.30.6`                                  | `GHSA-wrjc-x8rr-h8h6` (CWE-601), `GHSA-337j-9hxr-rhxg` (CWE-470, CVSS 6.1) | Moderate | Direct (`frontend`) / Transitive                                          | `react-router-dom@7.18.6` (`react-router@7.18.0+`, major)           | **`GHSA-337j-9hxr-rhxg` not reachable** (pure client-side Vite SPA with zero SSR hydration). **`GHSA-wrjc-x8rr-h8h6` mitigated in code + major upgrade deferred:** `LoginPage.tsx` sanitizes `location.state.from.pathname` via `sanitizeRedirectPath()` rejecting `\\`, `//`, and non-leading-`/` targets; all other `<Link>`/`useNavigate` calls use hardcoded internal routes. |

## 7. Failure Behavior, Recovery & Production Security Checklist

### Failure & Recovery Procedures

- **Redis Outage:** `auth` and `dlq_replay` fail closed (`503`); `job_submit` and `general` fail open while PostgreSQL transactional outbox preserves all submitted jobs. Once Redis recovers, `OutboxReconcilerService` and `PrioritySchedulerService` resume dispatch automatically and rate-limit Lua scripts self-heal TTLs.
- **PostgreSQL / Audit Write Outage:** Security controls (`401`/`403`/`429`) never fall open on audit-event write errors; failed audit writes are caught and logged without exposing credentials.
- **Worker Crash / Lost Heartbeat:** Execution leases (`leaseExpiresAt`) and monotonic `fencingToken` values ensure stale workers cannot overwrite newer state; `StalledJobRecoveryService` and `PrioritySchedulerService.recoverStaleReservations` recover orphaned work safely.

### Production Security Checklist

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` set via secret manager (>= 32 random chars)
- [ ] `API_KEY_SECRET` set via secret manager (>= 32 random chars, distinct from `JWT_SECRET`)
- [ ] `CORS_ALLOWED_ORIGINS` restricted to exact production frontend origin(s)
- [ ] `TRUST_PROXY` set to exact hop count (`1`..`5`) or `loopback`/`uniquelocal` (never `true`)
- [ ] PostgreSQL (`sslmode=require`) and Redis (`rediss://`) TLS + authentication enabled
- [ ] Worker runtime isolated on private network segment

## 8. Known Limitations

- **Pepper Rotation (`API_KEY_SECRET`):** Rotating `API_KEY_SECRET` invalidates existing HMAC-hashed API keys; plan coordinated tenant key rotation when rotating the global pepper.
- **Worker Runtime Trust Boundary:** The worker runtime (`apps/worker`) connects directly to PostgreSQL and Redis inside the private network; enforce TLS and network segmentation in production.

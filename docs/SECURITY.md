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

## 6. Known Limitations

- **Pepper Rotation (`API_KEY_SECRET`):** Rotating `API_KEY_SECRET` invalidates existing HMAC-hashed API keys; plan coordinated tenant key rotation when rotating the global pepper.
- **Worker Runtime Trust Boundary:** The worker runtime (`apps/worker`) connects directly to PostgreSQL and Redis inside the private network; enforce TLS and network segmentation in production.

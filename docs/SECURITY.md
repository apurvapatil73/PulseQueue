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

## 2. RBAC Permission Matrix

All organisation-scoped routes require `authenticate` followed by `requireOrgRole(minRole)`, which resolves membership directly from PostgreSQL (never trusting client-supplied roles):

| Operation Category                                                                                                                                                                         | `MEMBER` | `ADMIN` | `OWNER` | Non-Member |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------: | :-----: | :-----: | :--------: |
| Read org, members, queues, jobs, schedules, DLQ, alerts, governance, metrics, SSE stream                                                                                                   |  Allow   |  Allow  |  Allow  |   `404`    |
| Submit jobs, acknowledge alerts, manage own notifications                                                                                                                                  |  Allow   |  Allow  |  Allow  |   `404`    |
| Create/update/pause/resume queues, cancel jobs, replay DLQ, create/update/pause/cancel schedules, manage alert rules, update governance quotas & DRR weights, manage invitations & members |  `403`   |  Allow  |  Allow  |   `404`    |
| Delete organisation, transfer ownership, delete queues, delete schedules                                                                                                                   |  `403`   |  `403`  |  Allow  |   `404`    |

Non-members receive `404 Not Found` rather than `403 Forbidden` to prevent cross-tenant organisation enumeration.

## 3. Tenant Isolation Strategy

- **PostgreSQL Authoritative Scoping:** Every tenant-scoped read, update, and delete filters by `req.membership.organisationId` (resolved server-side). Nested resources (e.g., `/organisations/:orgId/queues/:queueId/jobs/:jobId`) verify both organisation and queue ownership.
- **BullMQ Transport Isolation:** Physical Redis/BullMQ queue names are prefixed with `org_<organisationId>__<queueName>`, isolating transport keys across tenants.
- **Realtime SSE & Monitoring Isolation:** `GET /monitoring/stream` binds each SSE client to `req.membership.organisationId` and only subscribes to and replays events for that organisation. Global process-level metrics never include `organisationId`, `jobId`, or arbitrary queue names as labels.
- **Strict Input Validation & Mass-Assignment Prevention:** Authentication, organisation, membership/invitation, and governance mutation schemas enforce Zod `.strict()` mode (rejecting unexpected fields with `400 Bad Request`). Queue and job schemas use Zod's safe strip mode so unknown/protected fields (`organisationId`, `isPaused`, `status`, `fencingToken`) are stripped before reaching services while preserving backward compatibility.

## 4. Environment Variables & Secret Requirements

| Variable               | Required | Default             | Security Notes                                                                                                             |
| :--------------------- | :------: | :------------------ | :------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             |    No    | `development`       | Set to `production` in deployed environments (`Secure` cookies, error stack redaction, 32-char JWT secret enforcement).    |
| `DATABASE_URL`         |   Yes    | —                   | PostgreSQL connection string; redacted from logs.                                                                          |
| `REDIS_URL`            |   Yes    | —                   | Redis connection string; redacted from logs.                                                                               |
| `JWT_SECRET`           |   Yes    | —                   | Minimum 16 chars in dev/test; **minimum 32 chars enforced in `production`**. Rotate via environment secrets manager.       |
| `JWT_ISSUER`           |    No    | `pulsequeue-api`    | Enforced on JWT sign and verify.                                                                                           |
| `JWT_AUDIENCE`         |    No    | `pulsequeue-client` | Enforced on JWT sign and verify.                                                                                           |
| `CORS_ALLOWED_ORIGINS` |    No    | Local dev origins   | Comma-separated origin allowlist (e.g. `https://app.example.com`). Arbitrary origins are never reflected with credentials. |
| `RATE_LIMIT_WINDOW_MS` |    No    | `60000`             | Fixed window duration in milliseconds (`1000..3600000`).                                                                   |
| `RATE_LIMIT_AUTH_MAX`  |    No    | `20`                | Max requests per window on `/auth/register`, `/auth/login`, `/auth/refresh`.                                               |
| `RATE_LIMIT_WRITE_MAX` |    No    | `300`               | Max requests per window on `POST /queues/:queueId/jobs` and `POST /dlq/:dlqId/replay`.                                     |

Never commit real `.env` files, JWT secrets, or database credentials to source control.

## 5. Known Limitations & Operational Recommendations

- **In-Process Rate Limiter:** The built-in rate limiter uses per-instance memory buckets. In multi-replica deployments behind a load balancer, pair with Redis-backed or ingress/API-gateway rate limiting for strict cluster-wide caps.
- **Worker Runtime Trust Boundary:** The worker runtime (`apps/worker`) connects directly to PostgreSQL and Redis inside the private network; isolate worker and backend network segments and enforce TLS/ACL authentication on PostgreSQL and Redis in production.
- **Reverse Proxy `trust proxy`:** When deploying behind a reverse proxy (Nginx, ALB, Cloudflare), configure Express `trust proxy` appropriately so `req.ip` reflects the client IP for rate limiting and audit logs.

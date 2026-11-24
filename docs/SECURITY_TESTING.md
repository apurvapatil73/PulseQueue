# PulseQueue Security & Fault-Injection Testing Guide

All security, penetration-style, and fault-injection tests run strictly against **local** Docker PostgreSQL (`localhost:5432`) and Redis (`localhost:6379`) using synthetic test fixtures. Never point test runs at production databases or external services.

## Prerequisites

1. Start local infrastructure:
   ```bash
   docker compose up -d postgres redis
   ```
2. Apply Prisma migrations:
   ```bash
   npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
   ```

## Targeted Security Test Suites

Run all Phase 9.1, 9.2, and 9.3 security & fault-injection suites together:

```bash
npx vitest run \
  apps/backend/tests/securityHardening.test.ts \
  apps/backend/tests/distributedSecurity.test.ts \
  apps/backend/tests/securityPenetrationAndFaults.test.ts \
  --config apps/backend/vitest.config.ts \
  --fileParallelism=false
```

### Suite Breakdown

| Suite                                                   | Focus Areas                                                                                                                                                                                                                                                                                                            |
| :------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/securityHardening.test.ts`                       | JWT signature/algorithm/claim checks, production secret floor, RBAC boundaries, cross-org IDOR, mass assignment, CORS allowlist, atomic refresh-token rotation, rate-limit `429` headers.                                                                                                                              |
| `tests/distributedSecurity.test.ts`                     | Two independent Express instances sharing live Redis Lua rate-limit buckets, concurrent burst atomicity, window reset, `fail-closed` (`503`) vs `fail-open` (`200`), trusted-proxy anti-spoofing, API key lifecycle/scopes/rotation, tenant-scoped audit events.                                                       |
| `tests/securityPenetrationAndFaults.test.ts`            | Revoked-session reuse chains, 16 KiB auth body cap, `/health` privacy, `schedules:read` & `dlq:replay` API-key scope enforcement, query-param IDOR, concurrent key-rotation races, Redis timeout/Lua-fault recovery, bounded Redis key PTTL, concurrent idempotency & DLQ replay races, audit-write outage resilience. |
| `tests/leases-fencing.test.ts` & `tests/outbox.test.ts` | Fencing-token rejection, lease expiry recovery, and Redis outage outbox reconciliation.                                                                                                                                                                                                                                |
| `apps/worker/tests/worker.test.ts`                      | Worker crashes, duplicate delivery idempotency, DLQ routing, and schedule timeout enforcement.                                                                                                                                                                                                                         |

## Dependency Security Audit

```bash
npm audit --omit=dev
npm ls zod prisma @prisma/config deepmerge-ts effect react-router react-router-dom
```

All currently reported advisories (`zod@3.25.76`, `prisma@6.19.3` transitive CLI packages, `react-router-dom@6.30.6`) require breaking semver-major upgrades and are tracked with explicit mitigations in [docs/SECURITY.md](./SECURITY.md).

## Full Monorepo Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run build:frontend
npm run --workspace=@pulsequeue/backend test -- --fileParallelism=false
npm run --workspace=@pulsequeue/worker test -- --fileParallelism=false
npm run --workspace=@pulsequeue/frontend test
```

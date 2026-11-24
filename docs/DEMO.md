# PulseQueue End-to-End Demo Guide (Windows PowerShell)

This guide walks through a complete, repeatable local demonstration of PulseQueue on **Windows PowerShell** using the existing implementation: infrastructure startup, multi-terminal runtime, immediate execution, delayed execution, one-time scheduling, transient retry recovery, permanent failure into the Dead Letter Queue (DLQ), DLQ replay, API and UI verification, and safe scoped cleanup.

> **Verification Note:** Every endpoint, payload field, status transition, and response property below is verified directly against the source code (`apps/backend`, `apps/worker`, `apps/frontend`, `docker-compose.yml`, and `.env.example`). Live execution of this full sequence against Docker Desktop was not run during the documentation pass and should be verified once on your local Docker daemon before presenting.

---

## 1. Prerequisites & Infrastructure Setup

Required tools on Windows:

- **Node.js 22.x** and **npm**
- **Docker Desktop** (running, with Linux containers enabled)
- **Windows PowerShell** (5.1 or PowerShell 7+)

Run in **Terminal 1** from the repository root:

```powershell
# 1. Install dependencies
npm ci

# 2. Create local .env (pre-aligned with docker-compose.yml defaults)
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

# 3. Start PostgreSQL 16 (127.0.0.1:5432) and Redis 7 (127.0.0.1:6379)
npm run docker:up
npm run docker:ps

# 4. Generate Prisma Client and apply committed migrations non-interactively
npm run prisma:generate
npm exec --workspace=@pulsequeue/backend -- prisma migrate deploy

# 5. Build workspace packages (required so @pulsequeue/worker resolves @pulsequeue/backend/dist)
npm run build
```

---

## 2. Start Services (Three PowerShell Terminals)

Start services in this exact order, each in its own PowerShell terminal:

1. **Terminal 1 - Backend API (`http://localhost:3000`):**
   ```powershell
   npm run dev:backend
   ```
2. **Terminal 2 - Worker & Scheduler Runtime:**
   ```powershell
   npm run dev:worker
   ```
3. **Terminal 3 - React Operations Console (`http://localhost:5173`, proxies `/api` and `/health` to `:3000`):**
   ```powershell
   npm run dev:frontend
   ```

In **Terminal 4 (Demo Runner)**, verify backend readiness before proceeding:

```powershell
Invoke-RestMethod http://localhost:3000/health/ready | ConvertTo-Json -Depth 5
# Expected: HTTP 200, success = true, data.ready = true
```

---

## 3. Create an Isolated Demo Tenant & Queue (Terminal 4)

Using a timestamped email and organisation name keeps every demo run isolated from existing data and prevents `409 Conflict` collisions on repeat runs.

```powershell
$base = "http://localhost:3000"
$demoTag = Get-Date -Format "yyyyMMddHHmmss"
$email = "demo+$demoTag@pulsequeue.local"
$password = "DemoPass123"

# 1. Register demo user (Expected: HTTP 201, data.user.id)
Invoke-RestMethod -Method Post "$base/api/v1/auth/register" `
  -ContentType "application/json" `
  -Body (@{ name = "Demo User"; email = $email; password = $password } | ConvertTo-Json) | Out-Null

# 2. Login and capture JWT access token (Expected: HTTP 200, data.accessToken)
$login = Invoke-RestMethod -Method Post "$base/api/v1/auth/login" `
  -ContentType "application/json" `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.data.accessToken)" }

# 3. Create isolated demo organisation (caller becomes OWNER; Expected: HTTP 201, data.organisation.id)
$org = Invoke-RestMethod -Method Post "$base/api/v1/organisations" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{ name = "Demo Org $demoTag" } | ConvertTo-Json)
$orgId = $org.data.organisation.id

# 4. Create queue with PRIORITY_AGING policy (ADMIN/OWNER; Expected: HTTP 201, data.queue.id)
$queue = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name             = "demo-queue"
    concurrency      = 5
    schedulingPolicy = "PRIORITY_AGING"
    maxRetries       = 2
    backoffMs        = 500
  } | ConvertTo-Json)
$queueId = $queue.data.queue.id

Write-Host "Demo credentials: $email / $password"
Write-Host "Org ID: $orgId | Queue ID: $queueId"
```

> **Worker Discovery Timing Note:** `WorkerRuntime` syncs newly created queues from PostgreSQL every `10,000 ms` (`queueSyncIntervalMs` in `apps/worker/src/runtime/workerRunner.ts`). Allow up to 10-15 seconds for the worker to attach to a brand-new queue on the first run.

---

## 4. Submit End-to-End Demo Workloads (Terminal 4)

PulseQueue's default worker registers four built-in processors (`echo`, `math.sum`, `transform.json`, and `test.fail`).

### 4.1 Immediate Success (`echo` and `math.sum`)

```powershell
# Expected: HTTP 201 -> transitions PENDING -> ACTIVE -> COMPLETED
$echoJob = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues/$queueId/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name     = "echo"
    payload  = @{ message = "Hello PulseQueue"; metadata = @{ source = "demo" } }
    priority = 10
  } | ConvertTo-Json -Depth 4)

# Expected: HTTP 201 -> COMPLETED with sum=150, count=5, min=10, max=50, average=30
$mathJob = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues/$queueId/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name    = "math.sum"
    payload = @{ numbers = @(10, 20, 30, 40, 50) }
  } | ConvertTo-Json -Depth 4)
```

### 4.2 Delayed Job (`transform.json`)

```powershell
# Expected: HTTP 201 (initial status DELAYED) -> ACTIVE -> COMPLETED after 3s delay
$delayedJob = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues/$queueId/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name    = "transform.json"
    payload = @{ records = @{ env = "demo"; version = 1 }; uppercaseKeys = $true }
    delayMs = 3000
  } | ConvertTo-Json -Depth 4)
```

### 4.3 One-Time Scheduled Job (`echo`)

```powershell
# Fires ~10 seconds from now (ADMIN/OWNER; Expected: HTTP 201, data.schedule.id)
$runAtUtc = (Get-Date).ToUniversalTime().AddSeconds(10).ToString("o")
$schedule = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/schedules" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    queueId  = $queueId
    name     = "demo-one-time-schedule"
    type     = "ONE_TIME"
    jobName  = "echo"
    payload  = @{ message = "Fired by one-time schedule" }
    timezone = "UTC"
    runAt    = $runAtUtc
  } | ConvertTo-Json -Depth 4)
$scheduleId = $schedule.data.schedule.id
```

### 4.4 Transient Retry & Automatic Recovery (`test.fail` with `failUntilAttempt`)

```powershell
# Fails attempt 1 (ACTIVE -> DELAYED backoff 500ms), then succeeds on attempt 2 (ACTIVE -> COMPLETED)
# Expected output: { recovered: true, recoveredOnAttempt: 2, maxAttempts: 3 }
$retryJob = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues/$queueId/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name       = "test.fail"
    payload    = @{ reason = "Transient upstream timeout"; failUntilAttempt = 1 }
    maxRetries = 2
    backoffMs  = 500
  } | ConvertTo-Json -Depth 4)
```

### 4.5 Permanent Failure & Dead Letter Queue (`test.fail` without `failUntilAttempt`)

```powershell
# Exhausts retries (1 initial + 1 retry) -> terminal JobStatus.FAILED + DeadLetterJob (status = OPEN)
$dlqJob = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/queues/$queueId/jobs" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    name       = "test.fail"
    payload    = @{ reason = "Permanent downstream failure" }
    maxRetries = 1
    backoffMs  = 500
  } | ConvertTo-Json -Depth 4)
```

---

## 5. Verify Execution, Schedules, DLQ Replay & Monitoring

Wait ~15 seconds for queue discovery, the 3 s delay, retries, and the 10 s one-time schedule to complete:

```powershell
Start-Sleep -Seconds 15

# 1. Inspect all 5 submitted jobs
foreach ($j in @($echoJob, $mathJob, $delayedJob, $retryJob, $dlqJob)) {
  $res = Invoke-RestMethod "$base/api/v1/organisations/$orgId/jobs/$($j.data.job.id)" -Headers $headers
  [PSCustomObject]@{
    Name     = $res.data.job.name
    Status   = $res.data.job.status
    Attempts = $res.data.job.attemptsMade
  }
}
# Expected statuses: echo=COMPLETED, math.sum=COMPLETED, transform.json=COMPLETED,
# test.fail (retry)=COMPLETED (attempts=2), test.fail (permanent)=FAILED (attempts=2)

# 2. Verify one-time schedule execution history
$schedExecs = Invoke-RestMethod "$base/api/v1/organisations/$orgId/schedules/$scheduleId/executions" -Headers $headers
$schedExecs.data | ConvertTo-Json -Depth 4

# 3. Inspect Dead Letter Queue (Expected: 1 OPEN entry for test.fail)
$dlq = Invoke-RestMethod "$base/api/v1/organisations/$orgId/dlq" -Headers $headers
$dlq.data.items | Select-Object id, jobName, status, attemptsMade, failureReason
$dlqId = $dlq.data.items[0].id

# 4. Replay DLQ entry with fixed payload override (ADMIN/OWNER; Expected: HTTP 201)
# Passes failUntilAttempt=1 with maxRetries=2 so the replayed job recovers and completes cleanly
$replay = Invoke-RestMethod -Method Post "$base/api/v1/organisations/$orgId/dlq/$dlqId/replay" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    payload    = @{ reason = "Replayed with transient recovery"; failUntilAttempt = 1 }
    priority   = 15
    maxRetries = 2
    backoffMs  = 500
  } | ConvertTo-Json -Depth 4)

Write-Host "DLQ status after replay: $($replay.data.deadLetterJob.status) | Replayed Job ID: $($replay.data.replayedJob.id)"
# Expected: DLQ status = REPLAYED

# 5. Verify replayed job succeeds
Start-Sleep -Seconds 5
$replayedCheck = Invoke-RestMethod "$base/api/v1/organisations/$orgId/jobs/$($replay.data.replayedJob.id)" -Headers $headers
$replayedCheck.data.job | Select-Object id, name, status, attemptsMade, replayedFromDlqId
# Expected: status = COMPLETED

# 6. Verify monitoring metrics & active worker heartbeats
Invoke-RestMethod "$base/api/v1/organisations/$orgId/monitoring/metrics" -Headers $headers | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/api/v1/organisations/$orgId/monitoring/workers" -Headers $headers | ConvertTo-Json -Depth 4
```

### Dashboard Verification (`http://localhost:5173`)

1. Open `http://localhost:5173` in your browser and sign in with the printed `$email` and `$password`.
2. Inspect:
   - **`/dashboard`**: Organisation overview, job counts, and recent events.
   - **`/queues`**: `demo-queue` statistics and controls.
   - **`/jobs`**: Completed `echo`, `math.sum`, `transform.json`, recovered `test.fail`, failed `test.fail`, and replayed job details/outputs.
   - **`/schedules`**: `demo-one-time-schedule` status and execution history.
   - **`/dlq`**: Original failed `test.fail` entry marked `REPLAYED` with link to the replayed job.
   - **`/monitoring`**: Active worker heartbeat, latency percentiles, scheduler observability, and live SSE event stream.

---

## 6. Safe Scoped Cleanup

Deleting **only** the demo organisation removes all tenant-scoped records via PostgreSQL `ON DELETE CASCADE` (`ApiKey`, `Membership`, `Invitation`, `Queue`, `Job`, `JobDispatchOutbox`, `DeadLetterJob`, `Schedule`, `ScheduleExecution`, `AlertRule`, `Alert`, `Notification`) without affecting any other organisation or wiping Docker volumes:

```powershell
# Deletes ONLY the isolated demo organisation created in Section 3 (OWNER role, JWT only)
Invoke-RestMethod -Method Delete "$base/api/v1/organisations/$orgId" -Headers $headers
```

To stop the local services cleanly:

1. Press `Ctrl+C` in Terminals 1, 2, and 3 (`dev:worker` runs its bounded graceful shutdown).
2. Stop Docker containers while preserving database volumes:
   ```powershell
   npm run docker:down
   ```

> **Warning:** Do **not** run `npm run docker:down:volumes` unless you intentionally want to erase all local PostgreSQL and Redis data across every organisation. Note also that deleting the demo organisation leaves the harmless `demo+<timestamp>@pulsequeue.local` row in the `users` table.

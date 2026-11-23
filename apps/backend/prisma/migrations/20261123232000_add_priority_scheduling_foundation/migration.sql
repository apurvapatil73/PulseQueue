-- CreateEnum
CREATE TYPE "SchedulingPolicy" AS ENUM ('LEGACY_BULLMQ', 'FIFO', 'STRICT_PRIORITY', 'PRIORITY_AGING');

-- CreateEnum
CREATE TYPE "JobDispatchState" AS ENUM ('QUEUED', 'DISPATCHING', 'DISPATCHED');

-- AlterTable: queues
ALTER TABLE "queues"
  ADD COLUMN "scheduling_policy" "SchedulingPolicy" NOT NULL DEFAULT 'LEGACY_BULLMQ',
  ADD COLUMN "aging_rate_per_sec" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
  ADD COLUMN "max_effective_priority" DOUBLE PRECISION NOT NULL DEFAULT 25.0,
  ADD COLUMN "starvation_threshold_sec" INTEGER DEFAULT 300;

-- AlterTable: jobs
ALTER TABLE "jobs"
  ADD COLUMN "dispatch_state" "JobDispatchState" NOT NULL DEFAULT 'DISPATCHED',
  ADD COLUMN "dispatch_claimed_at" TIMESTAMP(3),
  ADD COLUMN "dispatch_claimed_by" TEXT,
  ADD COLUMN "ready_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "virtual_rank_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill ready_at and virtual_rank_at for existing jobs conservatively
UPDATE "jobs"
SET
  "ready_at" = "created_at" + ("delay_ms" * INTERVAL '1 millisecond'),
  "virtual_rank_at" = ("created_at" + ("delay_ms" * INTERVAL '1 millisecond')) - (("priority"::double precision / 0.05) * INTERVAL '1 second')
WHERE "status" IN ('PENDING', 'DELAYED', 'PAUSED');

-- Partial composite indexes for O(log N + K) custom scheduling scans
-- Only index QUEUED/DISPATCHING rows so legacy and terminal jobs add zero index bloat
CREATE INDEX "jobs_sched_aging_queued_idx"
  ON "jobs" ("queue_id", "virtual_rank_at" ASC, "ready_at" ASC, "id" ASC)
  WHERE "status" = 'PENDING' AND "dispatch_state" = 'QUEUED' AND "is_quarantined" = false;

CREATE INDEX "jobs_sched_fifo_queued_idx"
  ON "jobs" ("queue_id", "ready_at" ASC, "id" ASC)
  WHERE "status" = 'PENDING' AND "dispatch_state" = 'QUEUED' AND "is_quarantined" = false;

CREATE INDEX "jobs_sched_priority_queued_idx"
  ON "jobs" ("queue_id", "priority" DESC, "ready_at" ASC, "id" ASC)
  WHERE "status" = 'PENDING' AND "dispatch_state" = 'QUEUED' AND "is_quarantined" = false;

CREATE INDEX "jobs_sched_dispatching_idx"
  ON "jobs" ("queue_id", "dispatch_claimed_at" ASC)
  WHERE "dispatch_state" = 'DISPATCHING';

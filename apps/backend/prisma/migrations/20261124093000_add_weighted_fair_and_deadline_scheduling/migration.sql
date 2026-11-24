-- AlterEnum
ALTER TYPE "SchedulingPolicy" ADD VALUE 'WEIGHTED_FAIR';
ALTER TYPE "SchedulingPolicy" ADD VALUE 'DEADLINE_AWARE';
ALTER TYPE "SchedulingPolicy" ADD VALUE 'HYBRID_FAIR_DEADLINE';

-- AlterTable: organisations (Weighted Fair DRR configuration & distributed state)
ALTER TABLE "organisations"
  ADD COLUMN "scheduling_weight" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "drr_base_quantum" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
  ADD COLUMN "drr_max_deficit" DOUBLE PRECISION NOT NULL DEFAULT 200.0,
  ADD COLUMN "scheduling_deficit" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  ADD COLUMN "drr_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "drr_last_round_at" TIMESTAMP(3);

-- AlterTable: queues (Queue-level weight & deadline urgency window)
ALTER TABLE "queues"
  ADD COLUMN "scheduling_weight" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deadline_urgency_window_sec" INTEGER NOT NULL DEFAULT 60;

-- AlterTable: jobs (Scheduling cost, optional UTC deadline, miss tracking, explainability)
ALTER TABLE "jobs"
  ADD COLUMN "scheduling_cost" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "deadline_at" TIMESTAMP(3),
  ADD COLUMN "deadline_missed_at" TIMESTAMP(3),
  ADD COLUMN "scheduling_decision" JSONB;

-- Partial composite index for O(log N + K) Earliest Deadline First & Hybrid deadline scans
CREATE INDEX "jobs_sched_deadline_queued_idx"
  ON "jobs" ("queue_id", "deadline_at" ASC, "priority" DESC, "ready_at" ASC, "id" ASC)
  WHERE "status" = 'PENDING' AND "dispatch_state" = 'QUEUED' AND "is_quarantined" = false AND "deadline_at" IS NOT NULL;

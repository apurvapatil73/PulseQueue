-- AlterEnum
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_ADMISSION_REJECTED';
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_RETRY_BUDGET_EXHAUSTED';
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_QUARANTINED';
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_QUARANTINE_RELEASED';

-- AlterTable: organisations
ALTER TABLE "organisations"
  ADD COLUMN "max_outstanding_jobs" INTEGER,
  ADD COLUMN "max_active_jobs" INTEGER,
  ADD COLUMN "max_queued_jobs" INTEGER,
  ADD COLUMN "max_delayed_jobs" INTEGER,
  ADD COLUMN "max_payload_bytes" INTEGER,
  ADD COLUMN "retry_budget_max_retries" INTEGER,
  ADD COLUMN "retry_budget_window_seconds" INTEGER NOT NULL DEFAULT 300;

-- AlterTable: queues
ALTER TABLE "queues"
  ADD COLUMN "max_queue_depth" INTEGER,
  ADD COLUMN "backpressure_max_age_ms" INTEGER,
  ADD COLUMN "retry_budget_max_retries" INTEGER,
  ADD COLUMN "retry_budget_window_seconds" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN "poison_failure_threshold" INTEGER NOT NULL DEFAULT 3;

-- AlterTable: jobs
ALTER TABLE "jobs"
  ADD COLUMN "failure_signature" TEXT,
  ADD COLUMN "consecutive_same_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "is_quarantined" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quarantined_at" TIMESTAMP(3),
  ADD COLUMN "quarantine_reason" TEXT;

-- AlterTable: dead_letter_jobs
ALTER TABLE "dead_letter_jobs"
  ADD COLUMN "is_quarantined" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quarantine_reason" TEXT,
  ADD COLUMN "failure_signature" TEXT;

-- CreateIndex
CREATE INDEX "jobs_queue_id_is_quarantined_idx" ON "jobs"("queue_id", "is_quarantined");

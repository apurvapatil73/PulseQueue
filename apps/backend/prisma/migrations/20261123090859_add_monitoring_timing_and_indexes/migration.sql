-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "first_started_at" TIMESTAMP(3);

-- Backfill first_started_at from earliest JOB_STARTED lifecycle event, falling back to started_at
UPDATE "jobs" AS j
SET "first_started_at" = COALESCE(
  (
    SELECT MIN(pe."created_at")
    FROM "platform_events" pe
    WHERE pe."job_id" = j."id"
      AND pe."type" = 'JOB_STARTED'
  ),
  j."started_at"
)
WHERE j."first_started_at" IS NULL
  AND j."started_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "jobs_queue_id_completed_at_idx" ON "jobs"("queue_id", "completed_at");

-- CreateIndex
CREATE INDEX "jobs_queue_id_failed_at_idx" ON "jobs"("queue_id", "failed_at");

-- CreateIndex
CREATE INDEX "jobs_last_worker_id_status_idx" ON "jobs"("last_worker_id", "status");

-- CreateIndex
CREATE INDEX "platform_events_created_at_idx" ON "platform_events"("created_at");

-- CreateIndex
CREATE INDEX "schedule_executions_status_created_at_idx" ON "schedule_executions"("status", "created_at");

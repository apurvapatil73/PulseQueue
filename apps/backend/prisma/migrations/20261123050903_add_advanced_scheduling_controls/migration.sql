-- CreateEnum
CREATE TYPE "MisfirePolicy" AS ENUM ('SKIP_MISSED', 'FIRE_ONCE', 'CATCH_UP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScheduleExecutionStatus" ADD VALUE 'MISSED';
ALTER TYPE "ScheduleExecutionStatus" ADD VALUE 'SKIPPED_CONCURRENCY';
ALTER TYPE "ScheduleExecutionStatus" ADD VALUE 'SKIPPED_MIN_INTERVAL';
ALTER TYPE "ScheduleExecutionStatus" ADD VALUE 'SKIPPED_MAX_RUNS';

-- AlterTable
ALTER TABLE "schedule_executions" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "dispatched_at" TIMESTAMP(3),
ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "final_job_status" "JobStatus",
ADD COLUMN     "is_catch_up" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "started_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "last_dispatched_at" TIMESTAMP(3),
ADD COLUMN     "max_catch_up_runs" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "max_concurrent_runs" INTEGER,
ADD COLUMN     "max_duration_ms" INTEGER,
ADD COLUMN     "max_total_runs" INTEGER,
ADD COLUMN     "min_interval_ms" INTEGER,
ADD COLUMN     "misfire_grace_ms" INTEGER NOT NULL DEFAULT 60000,
ADD COLUMN     "misfire_policy" "MisfirePolicy" NOT NULL DEFAULT 'SKIP_MISSED';

-- CreateIndex
CREATE INDEX "schedule_executions_schedule_id_status_scheduled_for_idx" ON "schedule_executions"("schedule_id", "status", "scheduled_for");

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('ONE_TIME', 'RECURRING');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduleExecutionStatus" AS ENUM ('SCHEDULED', 'DISPATCHED', 'SKIPPED_OVERLAP', 'CANCELLED');

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ScheduleType" NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "job_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER,
    "max_retries" INTEGER,
    "backoff_ms" INTEGER,
    "cron_expression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "prevent_overlap" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_executions" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "job_id" UUID,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "ScheduleExecutionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_status_next_run_at_idx" ON "schedules"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "schedules_organisation_id_status_idx" ON "schedules"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "schedules_organisation_id_queue_id_idx" ON "schedules"("organisation_id", "queue_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_organisation_id_name_key" ON "schedules"("organisation_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_executions_job_id_key" ON "schedule_executions"("job_id");

-- CreateIndex
CREATE INDEX "schedule_executions_schedule_id_created_at_idx" ON "schedule_executions"("schedule_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_executions_schedule_id_scheduled_for_key" ON "schedule_executions"("schedule_id", "scheduled_for");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_executions" ADD CONSTRAINT "schedule_executions_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_executions" ADD CONSTRAINT "schedule_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

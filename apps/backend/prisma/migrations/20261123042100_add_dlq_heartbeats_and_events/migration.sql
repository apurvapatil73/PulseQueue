-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REPLAYED');

-- CreateEnum
CREATE TYPE "WorkerHealthStatus" AS ENUM ('ONLINE', 'DEGRADED', 'STALE', 'STOPPED');

-- CreateEnum
CREATE TYPE "PlatformEventType" AS ENUM ('JOB_SUBMITTED', 'JOB_STARTED', 'JOB_COMPLETED', 'JOB_FAILED', 'JOB_RETRIED', 'JOB_STALLED', 'JOB_RECOVERED', 'JOB_MOVED_TO_DLQ', 'JOB_REPLAYED', 'WORKER_STARTED', 'WORKER_STOPPED', 'WORKER_HEARTBEAT_STALE');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "last_recovered_at" TIMESTAMP(3),
ADD COLUMN     "last_worker_id" TEXT,
ADD COLUMN     "replayed_from_dlq_id" UUID,
ADD COLUMN     "stalled_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" UUID NOT NULL,
    "original_job_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "queue_name" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "payload_summary" JSONB NOT NULL DEFAULT '{}',
    "failure_reason" TEXT NOT NULL,
    "attempts_made" INTEGER NOT NULL,
    "max_retries" INTEGER NOT NULL,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
    "failed_at" TIMESTAMP(3) NOT NULL,
    "replayed_at" TIMESTAMP(3),
    "replayed_by_id" UUID,
    "replayed_job_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" UUID NOT NULL,
    "worker_instance_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "registered_queues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "organisation_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "WorkerHealthStatus" NOT NULL DEFAULT 'ONLINE',
    "jobs_processed" INTEGER NOT NULL DEFAULT 0,
    "jobs_succeeded" INTEGER NOT NULL DEFAULT 0,
    "jobs_failed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_events" (
    "id" UUID NOT NULL,
    "type" "PlatformEventType" NOT NULL,
    "organisation_id" UUID,
    "queue_id" UUID,
    "job_id" UUID,
    "worker_id" TEXT,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_jobs_original_job_id_key" ON "dead_letter_jobs"("original_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_jobs_replayed_job_id_key" ON "dead_letter_jobs"("replayed_job_id");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_organisation_id_status_created_at_idx" ON "dead_letter_jobs"("organisation_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "dead_letter_jobs_organisation_id_queue_id_idx" ON "dead_letter_jobs"("organisation_id", "queue_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_heartbeats_worker_instance_id_key" ON "worker_heartbeats"("worker_instance_id");

-- CreateIndex
CREATE INDEX "worker_heartbeats_status_last_heartbeat_at_idx" ON "worker_heartbeats"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "platform_events_organisation_id_created_at_idx" ON "platform_events"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "platform_events_organisation_id_type_created_at_idx" ON "platform_events"("organisation_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "platform_events_job_id_created_at_idx" ON "platform_events"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_status_started_at_idx" ON "jobs"("status", "started_at");

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_original_job_id_fkey" FOREIGN KEY ("original_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'CANCELLED');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "attempts_made" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "failed_at" TIMESTAMP(3),
ADD COLUMN     "result" JSONB,
ADD COLUMN     "started_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "job_dispatch_outbox" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_dispatch_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_dispatch_outbox_job_id_key" ON "job_dispatch_outbox"("job_id");

-- CreateIndex
CREATE INDEX "job_dispatch_outbox_status_next_attempt_at_idx" ON "job_dispatch_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "job_dispatch_outbox_organisation_id_idx" ON "job_dispatch_outbox"("organisation_id");

-- AddForeignKey
ALTER TABLE "job_dispatch_outbox" ADD CONSTRAINT "job_dispatch_outbox_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

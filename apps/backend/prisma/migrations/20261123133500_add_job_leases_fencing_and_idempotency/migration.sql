-- AlterEnum
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_LEASE_EXPIRED';
ALTER TYPE "PlatformEventType" ADD VALUE 'JOB_FENCING_REJECTED';

-- AlterTable
ALTER TABLE "jobs"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "fencing_token" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_queue_id_idempotency_key_key" ON "jobs"("queue_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "backoff_ms" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "delay_ms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "max_retries" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "jobs_queue_id_status_created_at_idx" ON "jobs"("queue_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

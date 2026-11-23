-- DropIndex
DROP INDEX "queues_name_key";

-- AlterTable
ALTER TABLE "queues" ADD COLUMN     "backoff_ms" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "concurrency" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "default_priority" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "max_retries" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "organisation_id" UUID NOT NULL,
ADD COLUMN     "paused_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "queues_organisation_id_idx" ON "queues"("organisation_id");

-- CreateIndex
CREATE INDEX "queues_organisation_id_is_paused_idx" ON "queues"("organisation_id", "is_paused");

-- CreateIndex
CREATE UNIQUE INDEX "queues_organisation_id_name_key" ON "queues"("organisation_id", "name");

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

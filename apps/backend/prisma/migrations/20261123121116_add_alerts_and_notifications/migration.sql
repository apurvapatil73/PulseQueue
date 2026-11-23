-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('QUEUE_BACKLOG', 'QUEUE_WAIT_TIME', 'JOB_FAILURE_RATE', 'JOB_RETRY_RATE', 'DLQ_COUNT', 'WORKER_STALE', 'JOB_LATENCY_P95', 'SCHEDULE_MISFIRES');

-- CreateEnum
CREATE TYPE "AlertComparisonOperator" AS ENUM ('GT', 'GTE', 'LT', 'LTE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('FIRING', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlatformEventType" ADD VALUE 'ALERT_FIRED';
ALTER TYPE "PlatformEventType" ADD VALUE 'ALERT_ACKNOWLEDGED';
ALTER TYPE "PlatformEventType" ADD VALUE 'ALERT_RESOLVED';

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "queue_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "AlertType" NOT NULL,
    "operator" "AlertComparisonOperator" NOT NULL DEFAULT 'GT',
    "threshold" DOUBLE PRECISION NOT NULL,
    "window_minutes" INTEGER NOT NULL DEFAULT 60,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 300,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "rule_id" UUID,
    "queue_id" UUID,
    "dedup_key" TEXT NOT NULL,
    "rule_name" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'FIRING',
    "message" TEXT NOT NULL,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "first_triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    "resolution_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "alert_id" UUID,
    "event_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_organisation_id_is_enabled_idx" ON "alert_rules"("organisation_id", "is_enabled");

-- CreateIndex
CREATE INDEX "alert_rules_organisation_id_queue_id_idx" ON "alert_rules"("organisation_id", "queue_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_organisation_id_name_key" ON "alert_rules"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "alerts_organisation_id_status_created_at_idx" ON "alerts"("organisation_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "alerts_organisation_id_severity_status_idx" ON "alerts"("organisation_id", "severity", "status");

-- CreateIndex
CREATE INDEX "alerts_organisation_id_dedup_key_status_idx" ON "alerts"("organisation_id", "dedup_key", "status");

-- CreateIndex
CREATE INDEX "alerts_rule_id_status_idx" ON "alerts"("rule_id", "status");

-- CreateIndex
CREATE INDEX "notifications_organisation_id_user_id_is_read_created_at_idx" ON "notifications"("organisation_id", "user_id", "is_read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_organisation_id_user_id_created_at_idx" ON "notifications"("organisation_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_event_key_key" ON "notifications"("user_id", "event_key");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique index guaranteeing at most one active (FIRING or ACKNOWLEDGED) alert per (organisation_id, dedup_key)
CREATE UNIQUE INDEX "alerts_active_dedup_key_idx" ON "alerts"("organisation_id", "dedup_key") WHERE "status" IN ('FIRING', 'ACKNOWLEDGED');

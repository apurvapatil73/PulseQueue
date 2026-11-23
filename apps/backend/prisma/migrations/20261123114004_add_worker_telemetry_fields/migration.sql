-- AlterTable
ALTER TABLE "worker_heartbeats" ADD COLUMN     "configured_concurrency" INTEGER,
ADD COLUMN     "cpu_usage_percent" DOUBLE PRECISION,
ADD COLUMN     "memory_rss_bytes" BIGINT,
ADD COLUMN     "uptime_seconds" INTEGER;

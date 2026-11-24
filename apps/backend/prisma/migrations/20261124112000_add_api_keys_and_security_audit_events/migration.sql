-- Phase 9.2: Additive migration for tenant-scoped API keys and security audit event types

ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'API_KEY_CREATED';
ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'API_KEY_REVOKED';
ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'API_KEY_ROTATED';
ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'SECURITY_RATE_LIMIT_EXCEEDED';
ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'SECURITY_AUTH_FAILURE_BURST';
ALTER TYPE "PlatformEventType" ADD VALUE IF NOT EXISTS 'SECURITY_CONFIG_UPDATED';

CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by_id" UUID,
    "rotated_from_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_organisation_id_revoked_at_idx" ON "api_keys"("organisation_id", "revoked_at");
CREATE INDEX "api_keys_organisation_id_created_at_idx" ON "api_keys"("organisation_id", "created_at");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organisation_id_fkey"
  FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

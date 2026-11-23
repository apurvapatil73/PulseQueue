-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "invited_email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organisation_id_invited_email_status_idx" ON "invitations"("organisation_id", "invited_email", "status");

-- CreateIndex
CREATE INDEX "invitations_organisation_id_idx" ON "invitations"("organisation_id");

-- CreateIndex
CREATE INDEX "invitations_invited_email_idx" ON "invitations"("invited_email");

-- CreateIndex
CREATE INDEX "invitations_token_hash_idx" ON "invitations"("token_hash");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

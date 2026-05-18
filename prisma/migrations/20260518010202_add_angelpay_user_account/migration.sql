-- CreateEnum
CREATE TYPE "public"."AngelPayAccountStatus" AS ENUM ('PENDING_PIN', 'ACTIVE', 'PIN_ROTATION_REQUIRED', 'SUSPENDED', 'DELETED');

-- CreateTable
CREATE TABLE "public"."AngelPayUserAccount" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "pinEncrypted" JSONB,
    "environment" TEXT NOT NULL DEFAULT 'QA',
    "status" "public"."AngelPayAccountStatus" NOT NULL DEFAULT 'PENDING_PIN',
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedBy" TEXT,
    "statusReason" TEXT,
    "externalUserId" INTEGER,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationErr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "AngelPayUserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AngelPayUserAccount_venueId_key" ON "public"."AngelPayUserAccount"("venueId");

-- CreateIndex
CREATE INDEX "AngelPayUserAccount_status_idx" ON "public"."AngelPayUserAccount"("status");

-- AddForeignKey
ALTER TABLE "public"."AngelPayUserAccount" ADD CONSTRAINT "AngelPayUserAccount_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "public"."SerializedItemCustodyState" AS ENUM ('ADMIN_HELD', 'SUPERVISOR_HELD', 'PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED', 'SOLD');

-- CreateEnum
CREATE TYPE "public"."SerializedItemCollectionReason" AS ENUM ('STAFF_TERMINATED', 'DAMAGED_SIM');

-- CreateEnum
CREATE TYPE "public"."SerializedItemCustodyEventType" AS ENUM ('ASSIGNED_TO_SUPERVISOR', 'ASSIGNED_TO_PROMOTER', 'ACCEPTED_BY_PROMOTER', 'REJECTED_BY_PROMOTER', 'COLLECTED_FROM_PROMOTER', 'COLLECTED_FROM_SUPERVISOR', 'MARKED_SOLD');

-- AlterTable
ALTER TABLE "public"."SerializedItem" ADD COLUMN     "assignedPromoterAt" TIMESTAMP(3),
ADD COLUMN     "assignedPromoterId" TEXT,
ADD COLUMN     "assignedSupervisorAt" TIMESTAMP(3),
ADD COLUMN     "assignedSupervisorId" TEXT,
ADD COLUMN     "custodyState" "public"."SerializedItemCustodyState" NOT NULL DEFAULT 'ADMIN_HELD',
ADD COLUMN     "custodyVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promoterAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "promoterRejectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."SerializedItemCustodyEvent" (
    "id" TEXT NOT NULL,
    "serializedItemId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "eventType" "public"."SerializedItemCustodyEventType" NOT NULL,
    "fromState" "public"."SerializedItemCustodyState",
    "toState" "public"."SerializedItemCustodyState" NOT NULL,
    "fromStaffId" TEXT,
    "toStaffId" TEXT,
    "actorStaffId" TEXT NOT NULL,
    "reason" "public"."SerializedItemCollectionReason",
    "idempotencyRequestId" TEXT,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerializedItemCustodyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IdempotencyRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorStaffId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SerializedItemCustodyEvent_serializedItemId_createdAt_idx" ON "public"."SerializedItemCustodyEvent"("serializedItemId", "createdAt");

-- CreateIndex
CREATE INDEX "SerializedItemCustodyEvent_serialNumber_createdAt_idx" ON "public"."SerializedItemCustodyEvent"("serialNumber", "createdAt");

-- CreateIndex
CREATE INDEX "SerializedItemCustodyEvent_idempotencyRequestId_idx" ON "public"."SerializedItemCustodyEvent"("idempotencyRequestId");

-- CreateIndex
CREATE INDEX "IdempotencyRequest_expiresAt_idx" ON "public"."IdempotencyRequest"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRequest_organizationId_actorStaffId_endpoint_ide_key" ON "public"."IdempotencyRequest"("organizationId", "actorStaffId", "endpoint", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SerializedItem_assignedSupervisorId_custodyState_idx" ON "public"."SerializedItem"("assignedSupervisorId", "custodyState");

-- CreateIndex
CREATE INDEX "SerializedItem_assignedPromoterId_custodyState_idx" ON "public"."SerializedItem"("assignedPromoterId", "custodyState");

-- AddForeignKey
ALTER TABLE "public"."SerializedItem" ADD CONSTRAINT "SerializedItem_assignedSupervisorId_fkey" FOREIGN KEY ("assignedSupervisorId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SerializedItem" ADD CONSTRAINT "SerializedItem_assignedPromoterId_fkey" FOREIGN KEY ("assignedPromoterId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SerializedItemCustodyEvent" ADD CONSTRAINT "SerializedItemCustodyEvent_serializedItemId_fkey" FOREIGN KEY ("serializedItemId") REFERENCES "public"."SerializedItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: existing SOLD items mirror custody state
UPDATE "public"."SerializedItem"
SET "custodyState" = 'SOLD'
WHERE "status" = 'SOLD' AND "custodyState" = 'ADMIN_HELD';

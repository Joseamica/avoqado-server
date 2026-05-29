-- CreateEnum
CREATE TYPE "public"."SimRegistrationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "public"."SimRegistrationItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "public"."SimRegistrationRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "registeredFromVenueId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "proposedCategoryId" TEXT,
    "status" "public"."SimRegistrationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SimRegistrationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SimRegistrationRequestItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "status" "public"."SimRegistrationItemStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "createdSerializedItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimRegistrationRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimRegistrationRequest_organizationId_status_idx" ON "public"."SimRegistrationRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SimRegistrationRequest_requestedByStaffId_idx" ON "public"."SimRegistrationRequest"("requestedByStaffId");

-- CreateIndex
CREATE INDEX "SimRegistrationRequestItem_serialNumber_idx" ON "public"."SimRegistrationRequestItem"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SimRegistrationRequestItem_requestId_serialNumber_key" ON "public"."SimRegistrationRequestItem"("requestId", "serialNumber");

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequest" ADD CONSTRAINT "SimRegistrationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequest" ADD CONSTRAINT "SimRegistrationRequest_registeredFromVenueId_fkey" FOREIGN KEY ("registeredFromVenueId") REFERENCES "public"."Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequest" ADD CONSTRAINT "SimRegistrationRequest_requestedByStaffId_fkey" FOREIGN KEY ("requestedByStaffId") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequest" ADD CONSTRAINT "SimRegistrationRequest_proposedCategoryId_fkey" FOREIGN KEY ("proposedCategoryId") REFERENCES "public"."ItemCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequest" ADD CONSTRAINT "SimRegistrationRequest_reviewedByStaffId_fkey" FOREIGN KEY ("reviewedByStaffId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SimRegistrationRequestItem" ADD CONSTRAINT "SimRegistrationRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."SimRegistrationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

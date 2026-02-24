-- CreateEnum
CREATE TYPE "public"."ClassSessionStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- AlterEnum
ALTER TYPE "public"."ProductType" ADD VALUE 'CLASS';

-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "maxParticipants" INTEGER;

-- AlterTable
ALTER TABLE "public"."Reservation" ADD COLUMN     "classSessionId" TEXT;

-- CreateTable
CREATE TABLE "public"."ClassSession" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "assignedStaffId" TEXT,
    "status" "public"."ClassSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "internalNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassSession_venueId_startsAt_idx" ON "public"."ClassSession"("venueId", "startsAt");

-- CreateIndex
CREATE INDEX "ClassSession_venueId_productId_startsAt_idx" ON "public"."ClassSession"("venueId", "productId", "startsAt");

-- CreateIndex
CREATE INDEX "ClassSession_venueId_status_startsAt_idx" ON "public"."ClassSession"("venueId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_venueId_classSessionId_idx" ON "public"."Reservation"("venueId", "classSessionId");

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "public"."ClassSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClassSession" ADD CONSTRAINT "ClassSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClassSession" ADD CONSTRAINT "ClassSession_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClassSession" ADD CONSTRAINT "ClassSession_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClassSession" ADD CONSTRAINT "ClassSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

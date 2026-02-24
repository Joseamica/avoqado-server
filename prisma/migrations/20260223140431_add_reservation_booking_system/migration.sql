-- CreateEnum
CREATE TYPE "public"."ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "public"."ReservationChannel" AS ENUM ('DASHBOARD', 'WEB', 'PHONE', 'WHATSAPP', 'APP', 'WALK_IN', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "public"."DepositStatus" AS ENUM ('PENDING', 'CARD_HOLD', 'PAID', 'REFUNDED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "public"."WaitlistStatus" AS ENUM ('WAITING', 'NOTIFIED', 'PROMOTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."Reservation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "cancelSecret" TEXT NOT NULL,
    "status" "public"."ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "public"."ReservationChannel" NOT NULL DEFAULT 'DASHBOARD',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "customerId" TEXT,
    "guestName" TEXT,
    "guestPhone" TEXT,
    "guestEmail" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "tableId" TEXT,
    "productId" TEXT,
    "assignedStaffId" TEXT,
    "depositAmount" DECIMAL(10,2),
    "depositStatus" "public"."DepositStatus",
    "depositProcessorRef" TEXT,
    "depositPaidAt" TIMESTAMP(3),
    "depositRefundedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "checkedInAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "noShowAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancellationReason" TEXT,
    "specialRequests" TEXT,
    "internalNotes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "statusLog" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReservationWaitlistEntry" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT,
    "guestName" TEXT,
    "guestPhone" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "desiredStartAt" TIMESTAMP(3) NOT NULL,
    "desiredEndAt" TIMESTAMP(3),
    "status" "public"."WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "position" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "responseDeadline" TIMESTAMP(3),
    "promotedReservationId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reservation_venueId_status_startsAt_idx" ON "public"."Reservation"("venueId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_venueId_startsAt_endsAt_idx" ON "public"."Reservation"("venueId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Reservation_venueId_tableId_startsAt_idx" ON "public"."Reservation"("venueId", "tableId", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_venueId_productId_startsAt_idx" ON "public"."Reservation"("venueId", "productId", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_venueId_assignedStaffId_startsAt_idx" ON "public"."Reservation"("venueId", "assignedStaffId", "startsAt");

-- CreateIndex
CREATE INDEX "Reservation_customerId_idx" ON "public"."Reservation"("customerId");

-- CreateIndex
CREATE INDEX "Reservation_cancelSecret_idx" ON "public"."Reservation"("cancelSecret");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_venueId_confirmationCode_key" ON "public"."Reservation"("venueId", "confirmationCode");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationWaitlistEntry_promotedReservationId_key" ON "public"."ReservationWaitlistEntry"("promotedReservationId");

-- CreateIndex
CREATE INDEX "ReservationWaitlistEntry_venueId_status_desiredStartAt_idx" ON "public"."ReservationWaitlistEntry"("venueId", "status", "desiredStartAt");

-- CreateIndex
CREATE INDEX "ReservationWaitlistEntry_venueId_status_partySize_idx" ON "public"."ReservationWaitlistEntry"("venueId", "status", "partySize");

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "public"."Table"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_assignedStaffId_fkey" FOREIGN KEY ("assignedStaffId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationWaitlistEntry" ADD CONSTRAINT "ReservationWaitlistEntry_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationWaitlistEntry" ADD CONSTRAINT "ReservationWaitlistEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationWaitlistEntry" ADD CONSTRAINT "ReservationWaitlistEntry_promotedReservationId_fkey" FOREIGN KEY ("promotedReservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ==========================================
-- EXCLUSION CONSTRAINTS (belt-and-suspenders with app-level checks)
-- Prevents double-booking at the DB level even if app logic has bugs.
-- Uses tsrange (not tstzrange) because Prisma columns are TIMESTAMP(3) without timezone.
-- Prisma stores real UTC, so range comparisons are correct.
-- ==========================================

-- Required for GiST-based exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Prevent overlapping reservations for the same table
ALTER TABLE "public"."Reservation" ADD CONSTRAINT reservation_table_no_overlap
  EXCLUDE USING gist (
    "venueId" WITH =,
    "tableId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  ) WHERE (
    "status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    AND "tableId" IS NOT NULL
  );

-- Prevent overlapping reservations for the same staff member
ALTER TABLE "public"."Reservation" ADD CONSTRAINT reservation_staff_no_overlap
  EXCLUDE USING gist (
    "venueId" WITH =,
    "assignedStaffId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  ) WHERE (
    "status" IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    AND "assignedStaffId" IS NOT NULL
  );

-- NOTE: Product/class capacity (e.g., max 12 per Lagree class) is a COUNT invariant,
-- not an overlap invariant. Protected by app-level COUNT + FOR UPDATE inside
-- Serializable transactions (Layer 3 in Section 9 of the plan).

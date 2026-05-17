-- CreateEnum
CREATE TYPE "public"."CalendarSyncOperation" AS ENUM ('CREATE', 'UPDATE', 'CANCEL', 'UPDATE_ROSTER');

-- CreateEnum
CREATE TYPE "public"."CalendarSyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'DEAD_LETTER', 'SKIPPED');

-- AlterTable
ALTER TABLE "public"."ReservationSettings" ADD COLUMN     "googleCalendarClassRosterInDescription" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "googleCalendarDualWrite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleCalendarEventDetailLevel" TEXT NOT NULL DEFAULT 'FULL',
ADD COLUMN     "googleCalendarPushEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "googleCalendarRemoveCancelled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."CalendarSyncOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "reservationId" TEXT,
    "classSessionId" TEXT,
    "operation" "public"."CalendarSyncOperation" NOT NULL,
    "targetConnectionId" TEXT NOT NULL,
    "syncKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "public"."CalendarSyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "debounceUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReservationGoogleEventMapping" (
    "reservationId" TEXT,
    "classSessionId" TEXT,
    "connectionId" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "lastPushedAt" TIMESTAMP(3) NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationGoogleEventMapping_pkey" PRIMARY KEY ("connectionId","googleEventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSyncOutbox_idempotencyKey_key" ON "public"."CalendarSyncOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_status_scheduledAt_idx" ON "public"."CalendarSyncOutbox"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_venueId_status_idx" ON "public"."CalendarSyncOutbox"("venueId", "status");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_syncKey_status_createdAt_idx" ON "public"."CalendarSyncOutbox"("syncKey", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_reservationId_idx" ON "public"."CalendarSyncOutbox"("reservationId");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_classSessionId_idx" ON "public"."CalendarSyncOutbox"("classSessionId");

-- CreateIndex
CREATE INDEX "CalendarSyncOutbox_targetConnectionId_idx" ON "public"."CalendarSyncOutbox"("targetConnectionId");

-- CreateIndex
CREATE INDEX "ReservationGoogleEventMapping_reservationId_idx" ON "public"."ReservationGoogleEventMapping"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationGoogleEventMapping_classSessionId_idx" ON "public"."ReservationGoogleEventMapping"("classSessionId");

-- AddForeignKey
ALTER TABLE "public"."CalendarSyncOutbox" ADD CONSTRAINT "CalendarSyncOutbox_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CalendarSyncOutbox" ADD CONSTRAINT "CalendarSyncOutbox_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CalendarSyncOutbox" ADD CONSTRAINT "CalendarSyncOutbox_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "public"."ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CalendarSyncOutbox" ADD CONSTRAINT "CalendarSyncOutbox_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "public"."GoogleCalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationGoogleEventMapping" ADD CONSTRAINT "ReservationGoogleEventMapping_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationGoogleEventMapping" ADD CONSTRAINT "ReservationGoogleEventMapping_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "public"."ClassSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationGoogleEventMapping" ADD CONSTRAINT "ReservationGoogleEventMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."GoogleCalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 2 invariants not expressible in Prisma schema:
--
-- 1. Exactly one of (reservationId, classSessionId) must be set on every
--    ReservationGoogleEventMapping row. Same pattern as Phase 1's
--    GoogleCalendarConnection (venueId XOR staffId).
-- 2. Same XOR on CalendarSyncOutbox — a row points at either a reservation or
--    a class session, never both, never neither.
-- 3. Partial unique indexes enforce "one Google event per source per target
--    connection" while allowing the column to be NULL for the other side
--    (Postgres unique indexes treat NULLs as distinct, so the partial-index
--    form is required).
ALTER TABLE "public"."ReservationGoogleEventMapping"
  ADD CONSTRAINT "rgem_source_xor"
  CHECK (("reservationId" IS NOT NULL)::int + ("classSessionId" IS NOT NULL)::int = 1);

ALTER TABLE "public"."CalendarSyncOutbox"
  ADD CONSTRAINT "calendar_sync_outbox_source_xor"
  CHECK (("reservationId" IS NOT NULL)::int + ("classSessionId" IS NOT NULL)::int = 1);

CREATE UNIQUE INDEX "rgem_reservation_conn"
  ON "public"."ReservationGoogleEventMapping"("reservationId", "connectionId")
  WHERE "reservationId" IS NOT NULL;

CREATE UNIQUE INDEX "rgem_classsession_conn"
  ON "public"."ReservationGoogleEventMapping"("classSessionId", "connectionId")
  WHERE "classSessionId" IS NOT NULL;

-- Multi-service appointments + slot hold mechanism for the public booking flow.
-- See schema.prisma for the rationale on each field.

-- AlterTable: Reservation gains productIds for multi-service bookings. Empty
-- array preserves the existing single-service behavior; productId stays as the
-- lead service for back-compat with all existing queries.
ALTER TABLE "public"."Reservation" ADD COLUMN "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable: SlotHold backs the "Cita reservada durante 9:56" countdown.
-- TTL'd row that gets deleted transactionally when the customer commits a
-- reservation, or lazily swept after expiresAt.
CREATE TABLE "public"."SlotHold" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "classSessionId" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: hot path is getAvailability filtering by venueId + window
CREATE INDEX "SlotHold_venueId_startsAt_endsAt_idx" ON "public"."SlotHold"("venueId", "startsAt", "endsAt");

-- CreateIndex: secondary path for ttl + venue scoping
CREATE INDEX "SlotHold_venueId_expiresAt_idx" ON "public"."SlotHold"("venueId", "expiresAt");

-- CreateIndex: lazy cleanup sweep
CREATE INDEX "SlotHold_expiresAt_idx" ON "public"."SlotHold"("expiresAt");

-- CreateIndex: class booking holds compete against ClassSession capacity
CREATE INDEX "SlotHold_venueId_classSessionId_idx" ON "public"."SlotHold"("venueId", "classSessionId");

-- AddForeignKey
ALTER TABLE "public"."SlotHold" ADD CONSTRAINT "SlotHold_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SlotHold" ADD CONSTRAINT "SlotHold_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "public"."ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

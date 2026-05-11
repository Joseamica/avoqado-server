-- Reminder + auto-no-show worker support.
-- See schema.prisma for the rationale on each field.
--
-- 1) Reservation gains two columns the auto-no-show worker writes when a
--    venue's noShowFeePercent policy is active. Capture is deferred to the
--    Stripe webhook path; the worker only records the fee intent for now.
-- 2) ReservationReminderSent is the idempotent ledger that prevents the
--    reminder worker from double-sending across retries / parallel ticks.

-- AlterTable: no-show fee bookkeeping
ALTER TABLE "public"."Reservation" ADD COLUMN "noShowFeeAmount" DECIMAL(10, 2);
ALTER TABLE "public"."Reservation" ADD COLUMN "noShowFeeCapturedAt" TIMESTAMP(3);

-- CreateTable: idempotent reminder ledger
CREATE TABLE "public"."ReservationReminderSent" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "offsetMinutes" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "errorMessage" TEXT,

    CONSTRAINT "ReservationReminderSent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotency contract — one row per (reservation, offset, channel)
CREATE UNIQUE INDEX "ReservationReminderSent_reservationId_offsetMinutes_channel_key" ON "public"."ReservationReminderSent"("reservationId", "offsetMinutes", "channel");

-- CreateIndex: lookup by reservation
CREATE INDEX "ReservationReminderSent_reservationId_idx" ON "public"."ReservationReminderSent"("reservationId");

-- CreateIndex: time-based pruning / audit
CREATE INDEX "ReservationReminderSent_sentAt_idx" ON "public"."ReservationReminderSent"("sentAt");

-- AddForeignKey
ALTER TABLE "public"."ReservationReminderSent" ADD CONSTRAINT "ReservationReminderSent_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

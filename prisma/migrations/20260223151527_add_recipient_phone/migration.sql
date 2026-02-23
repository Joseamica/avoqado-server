-- AlterTable
ALTER TABLE "public"."DigitalReceipt" ADD COLUMN     "recipientPhone" TEXT;

-- CreateTable
CREATE TABLE "public"."ReservationSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "slotIntervalMin" INTEGER NOT NULL DEFAULT 15,
    "defaultDurationMin" INTEGER NOT NULL DEFAULT 60,
    "autoConfirm" BOOLEAN NOT NULL DEFAULT true,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 60,
    "minNoticeMin" INTEGER NOT NULL DEFAULT 60,
    "noShowGraceMin" INTEGER NOT NULL DEFAULT 15,
    "pacingMaxPerSlot" INTEGER,
    "onlineCapacityPercent" INTEGER NOT NULL DEFAULT 100,
    "depositMode" TEXT NOT NULL DEFAULT 'none',
    "depositFixedAmount" DECIMAL(10,2),
    "depositPercentage" INTEGER,
    "depositPartySizeGte" INTEGER,
    "depositPaymentWindow" INTEGER,
    "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "waitlistMaxSize" INTEGER NOT NULL DEFAULT 50,
    "waitlistPriorityMode" TEXT NOT NULL DEFAULT 'fifo',
    "waitlistNotifyWindow" INTEGER NOT NULL DEFAULT 30,
    "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requirePhone" BOOLEAN NOT NULL DEFAULT true,
    "requireEmail" BOOLEAN NOT NULL DEFAULT false,
    "allowCustomerCancel" BOOLEAN NOT NULL DEFAULT true,
    "minHoursBeforeCancel" INTEGER DEFAULT 2,
    "forfeitDeposit" BOOLEAN NOT NULL DEFAULT false,
    "noShowFeePercent" INTEGER,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderChannels" TEXT[] DEFAULT ARRAY['EMAIL']::TEXT[],
    "reminderMinBefore" INTEGER[] DEFAULT ARRAY[1440, 120]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationSettings_venueId_key" ON "public"."ReservationSettings"("venueId");

-- AddForeignKey
ALTER TABLE "public"."ReservationSettings" ADD CONSTRAINT "ReservationSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

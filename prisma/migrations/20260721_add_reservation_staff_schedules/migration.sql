-- AlterTable
ALTER TABLE "ReservationSettings" ADD COLUMN     "capacityMode" TEXT NOT NULL DEFAULT 'pacing',
ADD COLUMN     "showStaffPicker" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SlotHold" ADD COLUMN     "heldForReservationId" TEXT,
ADD COLUMN     "staffId" TEXT,
ADD COLUMN     "windowSemantics" TEXT;

-- CreateTable
CREATE TABLE "StaffSchedule" (
    "id" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "weekly" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffScheduleException" (
    "id" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStaff" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStaff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffSchedule_staffVenueId_key" ON "StaffSchedule"("staffVenueId");

-- CreateIndex
CREATE INDEX "StaffSchedule_venueId_idx" ON "StaffSchedule"("venueId");

-- CreateIndex
CREATE INDEX "StaffScheduleException_staffVenueId_startDate_endDate_idx" ON "StaffScheduleException"("staffVenueId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "StaffScheduleException_venueId_startDate_idx" ON "StaffScheduleException"("venueId", "startDate");

-- CreateIndex
CREATE INDEX "ProductStaff_venueId_productId_idx" ON "ProductStaff"("venueId", "productId");

-- CreateIndex
CREATE INDEX "ProductStaff_staffVenueId_idx" ON "ProductStaff"("staffVenueId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStaff_productId_staffVenueId_key" ON "ProductStaff"("productId", "staffVenueId");

-- CreateIndex
CREATE INDEX "ClassSession_assignedStaffId_startsAt_endsAt_idx" ON "ClassSession"("assignedStaffId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "Reservation_assignedStaffId_startsAt_endsAt_idx" ON "Reservation"("assignedStaffId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "SlotHold_venueId_staffId_startsAt_idx" ON "SlotHold"("venueId", "staffId", "startsAt");

-- CreateIndex
CREATE INDEX "SlotHold_staffId_startsAt_endsAt_idx" ON "SlotHold"("staffId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "SlotHold_heldForReservationId_expiresAt_idx" ON "SlotHold"("heldForReservationId", "expiresAt");

-- AddForeignKey
ALTER TABLE "StaffSchedule" ADD CONSTRAINT "StaffSchedule_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleException" ADD CONSTRAINT "StaffScheduleException_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStaff" ADD CONSTRAINT "ProductStaff_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStaff" ADD CONSTRAINT "ProductStaff_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotHold" ADD CONSTRAINT "SlotHold_heldForReservationId_fkey" FOREIGN KEY ("heldForReservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

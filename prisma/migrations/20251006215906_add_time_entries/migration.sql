-- CreateEnum
CREATE TYPE "public"."TimeEntryStatus" AS ENUM ('CLOCKED_IN', 'ON_BREAK', 'CLOCKED_OUT', 'ADMIN_EDITED');

-- CreateTable
CREATE TABLE "public"."time_entries" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "clockInTime" TIMESTAMP(3) NOT NULL,
    "clockOutTime" TIMESTAMP(3),
    "jobRole" TEXT,
    "totalHours" DECIMAL(5,2),
    "breakMinutes" INTEGER DEFAULT 0,
    "status" "public"."TimeEntryStatus" NOT NULL DEFAULT 'CLOCKED_IN',
    "notes" TEXT,
    "editedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."time_entry_breaks" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_entry_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entries_staffId_venueId_idx" ON "public"."time_entries"("staffId", "venueId");

-- CreateIndex
CREATE INDEX "time_entries_venueId_clockInTime_idx" ON "public"."time_entries"("venueId", "clockInTime");

-- CreateIndex
CREATE INDEX "time_entries_status_idx" ON "public"."time_entries"("status");

-- CreateIndex
CREATE INDEX "time_entry_breaks_timeEntryId_idx" ON "public"."time_entry_breaks"("timeEntryId");

-- AddForeignKey
ALTER TABLE "public"."time_entries" ADD CONSTRAINT "time_entries_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."time_entries" ADD CONSTRAINT "time_entries_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."time_entry_breaks" ADD CONSTRAINT "time_entry_breaks_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "public"."time_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

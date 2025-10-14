/*
  Warnings:

  - You are about to drop the column `pin` on the `Staff` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[venueId,pin]` on the table `StaffVenue` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Staff_pin_idx";

-- AlterTable
ALTER TABLE "Staff" DROP COLUMN "pin";

-- AlterTable
ALTER TABLE "StaffVenue" ADD COLUMN     "pin" TEXT;

-- CreateIndex
CREATE INDEX "StaffVenue_pin_idx" ON "StaffVenue"("pin");

-- CreateIndex
CREATE UNIQUE INDEX "StaffVenue_venueId_pin_key" ON "StaffVenue"("venueId", "pin");

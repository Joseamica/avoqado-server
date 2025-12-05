/*
  Warnings:

  - A unique constraint covering the columns `[venueId,email]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[venueId,phone]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."Customer_email_idx";

-- DropIndex
DROP INDEX "public"."Customer_email_key";

-- DropIndex
DROP INDEX "public"."Customer_phone_idx";

-- DropIndex
DROP INDEX "public"."Customer_phone_key";

-- DropIndex
DROP INDEX "public"."Customer_venueId_email_idx";

-- DropIndex
DROP INDEX "public"."Customer_venueId_phone_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Customer_venueId_email_key" ON "public"."Customer"("venueId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_venueId_phone_key" ON "public"."Customer"("venueId", "phone");

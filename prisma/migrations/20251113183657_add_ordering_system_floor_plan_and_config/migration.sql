/*
  Warnings:

  - A unique constraint covering the columns `[currentOrderId]` on the table `Table` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."TableShape" AS ENUM ('SQUARE', 'ROUND', 'RECTANGLE');

-- CreateEnum
CREATE TYPE "public"."TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING');

-- CreateEnum
CREATE TYPE "public"."PaymentTiming" AS ENUM ('PAY_BEFORE', 'PAY_AFTER');

-- CreateEnum
CREATE TYPE "public"."InventoryDeduction" AS ENUM ('ON_ORDER_CREATE', 'ON_PAYMENT');

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "covers" INTEGER,
ADD COLUMN     "customerIdentifier" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."Table" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currentOrderId" TEXT,
ADD COLUMN     "positionX" DOUBLE PRECISION,
ADD COLUMN     "positionY" DOUBLE PRECISION,
ADD COLUMN     "rotation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shape" "public"."TableShape" NOT NULL DEFAULT 'SQUARE',
ADD COLUMN     "status" "public"."TableStatus" NOT NULL DEFAULT 'AVAILABLE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "inventoryDeduction" "public"."InventoryDeduction" NOT NULL DEFAULT 'ON_ORDER_CREATE',
ADD COLUMN     "paymentTiming" "public"."PaymentTiming" NOT NULL DEFAULT 'PAY_AFTER';

-- CreateIndex
CREATE INDEX "Order_venueId_tableId_paymentStatus_idx" ON "public"."Order"("venueId", "tableId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Order_venueId_customerIdentifier_paymentStatus_idx" ON "public"."Order"("venueId", "customerIdentifier", "paymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Table_currentOrderId_key" ON "public"."Table"("currentOrderId");

-- CreateIndex
CREATE INDEX "Table_venueId_status_idx" ON "public"."Table"("venueId", "status");

-- AddForeignKey
ALTER TABLE "public"."Table" ADD CONSTRAINT "Table_currentOrderId_fkey" FOREIGN KEY ("currentOrderId") REFERENCES "public"."Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

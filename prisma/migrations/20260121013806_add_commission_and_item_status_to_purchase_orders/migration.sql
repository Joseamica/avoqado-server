-- CreateEnum
CREATE TYPE "public"."PurchaseOrderItemStatus" AS ENUM ('PENDING', 'RECEIVED', 'DAMAGED', 'NOT_PROCESSED');

-- AlterTable
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN     "commission" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "commissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."PurchaseOrderItem" ADD COLUMN     "receiveStatus" "public"."PurchaseOrderItemStatus" NOT NULL DEFAULT 'PENDING';

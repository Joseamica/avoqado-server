-- CreateEnum
CREATE TYPE "public"."ShippingAddressType" AS ENUM ('VENUE', 'CUSTOM');

-- AlterTable
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN     "shippingAddress" TEXT,
ADD COLUMN     "shippingAddressType" "public"."ShippingAddressType" NOT NULL DEFAULT 'VENUE',
ADD COLUMN     "shippingCity" TEXT,
ADD COLUMN     "shippingState" TEXT,
ADD COLUMN     "shippingZipCode" TEXT;

-- CreateEnum
CREATE TYPE "public"."PaymentLinkPurpose" AS ENUM ('PAYMENT', 'ITEM', 'DONATION');

-- AlterEnum
ALTER TYPE "public"."OrderSource" ADD VALUE 'PAYMENT_LINK';

-- AlterTable
ALTER TABLE "public"."PaymentLink" ADD COLUMN     "productId" TEXT,
ADD COLUMN     "purpose" "public"."PaymentLinkPurpose" NOT NULL DEFAULT 'PAYMENT';

-- AddForeignKey
ALTER TABLE "public"."PaymentLink" ADD CONSTRAINT "PaymentLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

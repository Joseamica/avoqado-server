-- AlterTable
ALTER TABLE "public"."PaymentLink" ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "tippingConfig" JSONB;

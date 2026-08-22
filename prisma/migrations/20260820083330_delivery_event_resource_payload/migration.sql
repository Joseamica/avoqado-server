-- AlterTable
ALTER TABLE "DeliveryOrderEvent" ADD COLUMN     "resourceFetchedAt" TIMESTAMP(3),
ADD COLUMN     "resourcePayload" JSONB;


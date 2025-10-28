-- AlterTable
ALTER TABLE "public"."VenueFeature" ADD COLUMN     "gracePeriodEndsAt" TIMESTAMP(3),
ADD COLUMN     "lastPaymentAttempt" TIMESTAMP(3),
ADD COLUMN     "paymentFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

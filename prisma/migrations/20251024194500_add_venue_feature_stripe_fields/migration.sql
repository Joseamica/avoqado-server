-- AlterTable
ALTER TABLE "public"."VenueFeature" ADD COLUMN     "stripeSubscriptionItemId" TEXT,
ADD COLUMN     "trialEndDate" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "VenueFeature_stripeSubscriptionItemId_key" ON "public"."VenueFeature"("stripeSubscriptionItemId");

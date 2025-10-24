-- AlterTable Organization: Add Stripe Customer ID
ALTER TABLE "Organization" ADD COLUMN "stripeCustomerId" TEXT;

-- AlterTable Feature: Add Stripe Product and Price IDs
ALTER TABLE "Feature" ADD COLUMN "stripeProductId" TEXT;
ALTER TABLE "Feature" ADD COLUMN "stripePriceId" TEXT;

-- AlterTable VenueFeature: Add Stripe Subscription and Price IDs
ALTER TABLE "VenueFeature" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "VenueFeature" ADD COLUMN "stripePriceId" TEXT;

-- CreateIndex: Unique constraints for Stripe IDs
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");
CREATE UNIQUE INDEX "Feature_stripeProductId_key" ON "Feature"("stripeProductId");
CREATE UNIQUE INDEX "Feature_stripePriceId_key" ON "Feature"("stripePriceId");
CREATE UNIQUE INDEX "VenueFeature_stripeSubscriptionId_key" ON "VenueFeature"("stripeSubscriptionId");

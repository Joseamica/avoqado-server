-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "tpvDefaultTipPercentage" INTEGER,
ADD COLUMN     "tpvShowReceiptScreen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tpvShowReviewScreen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tpvShowTipScreen" BOOLEAN NOT NULL DEFAULT true;

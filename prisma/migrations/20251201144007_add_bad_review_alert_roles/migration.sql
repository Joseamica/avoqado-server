-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "badReviewAlertRoles" TEXT[] DEFAULT ARRAY['OWNER', 'ADMIN', 'MANAGER']::TEXT[];

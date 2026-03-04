-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "hiddenSidebarItems" TEXT[] DEFAULT ARRAY[]::TEXT[];

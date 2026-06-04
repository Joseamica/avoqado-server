-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'es';

-- AlterTable
ALTER TABLE "public"."VenueFeature" ADD COLUMN     "renewalReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "winbackSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."SerializedItem" ADD COLUMN     "registeredFromVenueId" TEXT;

-- AddForeignKey
ALTER TABLE "public"."SerializedItem" ADD CONSTRAINT "SerializedItem_registeredFromVenueId_fkey" FOREIGN KEY ("registeredFromVenueId") REFERENCES "public"."Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

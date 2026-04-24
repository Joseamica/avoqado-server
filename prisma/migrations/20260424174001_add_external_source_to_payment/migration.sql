-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "externalSource" VARCHAR(50);

-- CreateIndex
CREATE INDEX "Payment_venueId_externalSource_idx" ON "public"."Payment"("venueId", "externalSource");

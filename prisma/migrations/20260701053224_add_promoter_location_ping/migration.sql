-- CreateEnum
CREATE TYPE "public"."PromoterLocationSource" AS ENUM ('PERIODIC', 'CLOCK_IN', 'CLOCK_OUT');

-- CreateTable
CREATE TABLE "public"."promoter_location_pings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "latitude" DECIMAL(10,8) NOT NULL,
    "longitude" DECIMAL(11,8) NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "source" "public"."PromoterLocationSource" NOT NULL DEFAULT 'PERIODIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promoter_location_pings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promoter_location_pings_venueId_staffId_capturedAt_idx" ON "public"."promoter_location_pings"("venueId", "staffId", "capturedAt");

-- CreateIndex
CREATE INDEX "promoter_location_pings_capturedAt_idx" ON "public"."promoter_location_pings"("capturedAt");

-- AddForeignKey
ALTER TABLE "public"."promoter_location_pings" ADD CONSTRAINT "promoter_location_pings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."promoter_location_pings" ADD CONSTRAINT "promoter_location_pings_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

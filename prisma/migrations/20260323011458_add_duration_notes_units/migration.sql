-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "durationMinutes" INTEGER;

-- CreateTable
CREATE TABLE "public"."MeasurementUnit" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeasurementUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeasurementUnit_venueId_idx" ON "public"."MeasurementUnit"("venueId");

-- AddForeignKey
ALTER TABLE "public"."MeasurementUnit" ADD CONSTRAINT "MeasurementUnit_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "public"."MerchantAccount" ADD COLUMN     "aggregatorId" TEXT;

-- CreateTable
CREATE TABLE "public"."Aggregator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venueId" TEXT,
    "baseFees" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Aggregator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VenueCommission" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "referredBy" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Aggregator_name_key" ON "public"."Aggregator"("name");

-- CreateIndex
CREATE INDEX "Aggregator_active_idx" ON "public"."Aggregator"("active");

-- CreateIndex
CREATE UNIQUE INDEX "VenueCommission_venueId_key" ON "public"."VenueCommission"("venueId");

-- CreateIndex
CREATE INDEX "VenueCommission_aggregatorId_idx" ON "public"."VenueCommission"("aggregatorId");

-- CreateIndex
CREATE INDEX "VenueCommission_active_idx" ON "public"."VenueCommission"("active");

-- AddForeignKey
ALTER TABLE "public"."MerchantAccount" ADD CONSTRAINT "MerchantAccount_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "public"."Aggregator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenueCommission" ADD CONSTRAINT "VenueCommission_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenueCommission" ADD CONSTRAINT "VenueCommission_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "public"."Aggregator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

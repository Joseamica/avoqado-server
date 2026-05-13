-- CreateTable
CREATE TABLE "VenuePaymentLinkSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "notifyOnPaid" BOOLEAN NOT NULL DEFAULT false,
    "defaultTippingConfig" JSONB,
    "defaultCustomFields" JSONB,
    "customerNotesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "merchantPolicies" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenuePaymentLinkSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenuePaymentLinkSettings_venueId_key" ON "VenuePaymentLinkSettings"("venueId");

-- AddForeignKey
ALTER TABLE "VenuePaymentLinkSettings" ADD CONSTRAINT "VenuePaymentLinkSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

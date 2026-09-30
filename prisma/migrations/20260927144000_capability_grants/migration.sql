-- Additive: existing VenueFeature grants and subscriptions are untouched.
CREATE TABLE "CapabilityGrant" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "featureCode" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CapabilityGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CapabilityGrant_window_check" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "CapabilityGrant_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CapabilityGrant_venueId_sourceId_featureCode_key" ON "CapabilityGrant"("venueId", "sourceId", "featureCode");
CREATE INDEX "CapabilityGrant_venueId_featureCode_revokedAt_endsAt_idx" ON "CapabilityGrant"("venueId", "featureCode", "revokedAt", "endsAt");
CREATE INDEX "CapabilityGrant_sourceId_idx" ON "CapabilityGrant"("sourceId");

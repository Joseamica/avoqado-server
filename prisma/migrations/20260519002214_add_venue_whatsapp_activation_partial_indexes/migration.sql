-- Partial unique index: enforce at most one open activation per venue
-- (open = consumedAt IS NULL AND invalidatedAt IS NULL). Prisma schema cannot
-- express partial unique indexes, so this lives in raw SQL.
CREATE UNIQUE INDEX "venue_whatsapp_activation_one_open"
  ON "VenueWhatsappActivation" ("venueId")
  WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

-- Partial index for the cleanup sweeper that expires open activations.
CREATE INDEX "venue_whatsapp_activation_cleanup"
  ON "VenueWhatsappActivation" ("expiresAt")
  WHERE "consumedAt" IS NULL AND "invalidatedAt" IS NULL;

-- Soporte WhatsApp: tell a venue's relay operator apart from an employee by Venue.whatsappOptInPhone.
-- Almost every venue has no opt-in phone, hence the partial index. CONCURRENTLY and one statement per file;
-- if it is interrupted, DROP INDEX CONCURRENTLY the invalid copy and retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Venue_whatsappOptInPhone_idx"
  ON "Venue"("whatsappOptInPhone")
  WHERE "whatsappOptInPhone" IS NOT NULL;

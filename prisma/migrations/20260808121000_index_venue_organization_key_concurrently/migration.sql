-- The leading primary key makes duplicates impossible. Recovery still checks
-- indisvalid/indisready and drops only an invalid remnant before retrying.
CREATE UNIQUE INDEX CONCURRENTLY "Venue_id_organizationId_key" ON "Venue"("id", "organizationId");

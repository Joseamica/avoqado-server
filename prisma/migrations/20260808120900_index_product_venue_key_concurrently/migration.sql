-- The leading primary key makes duplicates impossible. Recovery still checks
-- indisvalid/indisready and drops only an invalid remnant before retrying.
CREATE UNIQUE INDEX CONCURRENTLY "Product_id_venueId_key" ON "Product"("id", "venueId");

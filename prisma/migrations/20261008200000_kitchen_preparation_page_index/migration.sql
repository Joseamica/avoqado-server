-- Independent of the additive columns migration: do not hold its table lock while scanning old kitchen history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "KdsOrder_venueId_preparationVersion_status_id_idx"
  ON "KdsOrder"("venueId", "preparationVersion", "status", "id");

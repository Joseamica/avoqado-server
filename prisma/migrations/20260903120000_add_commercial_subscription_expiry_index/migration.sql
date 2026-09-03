-- Bounded worker scan: status narrows the live queue, graceEndsAt orders the
-- deadline and id provides a deterministic tie-breaker for SKIP LOCKED.
CREATE INDEX "CommercialSubscriptionPeriod_status_graceEndsAt_id_idx"
  ON "CommercialSubscriptionPeriod"("status", "graceEndsAt", "id");

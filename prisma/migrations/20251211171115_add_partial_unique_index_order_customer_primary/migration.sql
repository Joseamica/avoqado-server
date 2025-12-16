-- Partial Unique Index: Only ONE customer can be isPrimary=true per order
-- This prevents race conditions where two threads simultaneously set isPrimary=true
-- If a conflict occurs, PostgreSQL will reject the second INSERT with a unique constraint violation

CREATE UNIQUE INDEX "OrderCustomer_orderId_isPrimary_unique"
ON "OrderCustomer" ("orderId")
WHERE "isPrimary" = true;

-- Note: This index only includes rows where isPrimary=true
-- Multiple customers can have isPrimary=false on the same order (no conflict)
-- But only ONE customer can have isPrimary=true per order (enforced by DB)

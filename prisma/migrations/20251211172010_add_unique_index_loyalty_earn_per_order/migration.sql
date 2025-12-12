-- Partial Unique Index: Only ONE EARN transaction per customer per order
-- This prevents race conditions where concurrent payment retries create duplicate loyalty points
-- If a conflict occurs, PostgreSQL will reject the second INSERT with a unique constraint violation

CREATE UNIQUE INDEX "LoyaltyTransaction_customerId_orderId_earn_unique"
ON "LoyaltyTransaction" ("customerId", "orderId")
WHERE "type" = 'EARN' AND "orderId" IS NOT NULL;

-- Note: This index only includes EARN transactions with a non-null orderId
-- Multiple EARN transactions can exist for the same customer (different orders)
-- But only ONE EARN transaction can exist per customer per order (enforced by DB)

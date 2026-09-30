-- Refund/dispute recovery queues active purchases by their verified Stripe customer.
CREATE INDEX "HybridPurchase_stripeCustomerId_status_idx" ON "HybridPurchase"("stripeCustomerId", "status");

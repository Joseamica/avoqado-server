-- Ties a check discount to the loyalty REDEEM transaction that produced it, so
-- removing the discount can refund the points atomically.
ALTER TABLE "OrderDiscount" ADD COLUMN "loyaltyTransactionId" TEXT;

CREATE UNIQUE INDEX "OrderDiscount_loyaltyTransactionId_key"
  ON "OrderDiscount"("loyaltyTransactionId");

ALTER TABLE "OrderDiscount"
  ADD CONSTRAINT "OrderDiscount_loyaltyTransactionId_fkey"
  FOREIGN KEY ("loyaltyTransactionId") REFERENCES "LoyaltyTransaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

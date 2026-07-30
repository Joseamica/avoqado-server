-- Preserve referential integrity for the denormalized orderId fields used by
-- reconciliation and fulfillment. Restrict prevents deleting a financial order
-- while its payment-attempt or physical-delivery evidence still exists.
ALTER TABLE "AreaTicketPaymentAttempt"
ADD CONSTRAINT "AreaTicketPaymentAttempt_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AreaTicketFulfillment"
ADD CONSTRAINT "AreaTicketFulfillment_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

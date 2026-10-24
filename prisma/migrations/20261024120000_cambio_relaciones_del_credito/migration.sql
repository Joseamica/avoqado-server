BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ExchangeCreditLink"
  ADD CONSTRAINT "ExchangeCreditLink_creditPaymentId_fkey" FOREIGN KEY ("creditPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ExchangeCreditLink_originPaymentId_fkey" FOREIGN KEY ("originPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;

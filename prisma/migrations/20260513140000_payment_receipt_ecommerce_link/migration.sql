-- Add receipt URL + EcommerceMerchant link to Payment so the customer
-- checkout can offer "Ver recibo" and the dashboard can render "Cuenta
-- Comercial" for payment-link transactions.

ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "receiptUrl" VARCHAR(500);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "ecommerceMerchantId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Payment_ecommerceMerchantId_fkey'
  ) THEN
    ALTER TABLE "Payment"
      ADD CONSTRAINT "Payment_ecommerceMerchantId_fkey"
      FOREIGN KEY ("ecommerceMerchantId") REFERENCES "EcommerceMerchant"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Payment_ecommerceMerchantId_idx" ON "Payment"("ecommerceMerchantId");

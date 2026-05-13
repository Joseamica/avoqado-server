-- PaymentLinkItemModifier: pre-selected modifiers per bundle line item.
-- Admin picks them at link-creation time. Replayed into OrderItemModifier
-- when the customer pays so cocina + inventory + reports see them.

CREATE TABLE IF NOT EXISTS "PaymentLinkItemModifier" (
  "id"                TEXT NOT NULL,
  "paymentLinkItemId" TEXT NOT NULL,
  "modifierId"        TEXT NOT NULL,
  "quantity"          INTEGER NOT NULL DEFAULT 1,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentLinkItemModifier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentLinkItemModifier_paymentLinkItemId_modifierId_key"
  ON "PaymentLinkItemModifier"("paymentLinkItemId", "modifierId");

CREATE INDEX IF NOT EXISTS "PaymentLinkItemModifier_modifierId_idx"
  ON "PaymentLinkItemModifier"("modifierId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkItemModifier_paymentLinkItemId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkItemModifier"
      ADD CONSTRAINT "PaymentLinkItemModifier_paymentLinkItemId_fkey"
      FOREIGN KEY ("paymentLinkItemId") REFERENCES "PaymentLinkItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLinkItemModifier_modifierId_fkey'
  ) THEN
    ALTER TABLE "PaymentLinkItemModifier"
      ADD CONSTRAINT "PaymentLinkItemModifier_modifierId_fkey"
      FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

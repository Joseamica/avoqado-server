-- PaymentLink.attributedStaffId: who gets commission for this link's sales.
-- Separate from createdById (the link creator). NULL → no commission.
-- The commission engine reads Payment.processedById, which finalizePayment
-- LinkCheckout populates from this field when the customer pays.

ALTER TABLE "PaymentLink"
  ADD COLUMN IF NOT EXISTS "attributedStaffId" TEXT;

-- FK on delete SET NULL: if the staff member is deleted, the link survives
-- but loses commission attribution (consistent with Order.createdBy
-- onDelete: SetNull behavior).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentLink_attributedStaffId_fkey'
  ) THEN
    ALTER TABLE "PaymentLink"
      ADD CONSTRAINT "PaymentLink_attributedStaffId_fkey"
      FOREIGN KEY ("attributedStaffId") REFERENCES "Staff"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PaymentLink_attributedStaffId_idx"
  ON "PaymentLink"("attributedStaffId");

-- P3-B: enforce refund/reversal capacity at the ledger boundary.
-- The service serializes on the original PAYMENT, and this trigger preserves
-- the same invariant for direct SQL and future callers.

CREATE OR REPLACE FUNCTION commercial_billing_guard_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_receipt "CommercialCashReceipt"%ROWTYPE;
  adjusted_minor BIGINT;
BEGIN
  IF NEW."entryType" = 'PAYMENT' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO related_receipt
  FROM "CommercialCashReceipt"
  WHERE "id" = NEW."relatedReceiptId"
  FOR UPDATE;

  IF related_receipt."id" IS NULL
     OR related_receipt."entryType" <> 'PAYMENT'
     OR related_receipt."organizationId" <> NEW."organizationId"
     OR related_receipt."venueId" <> NEW."venueId"
     OR related_receipt."provider" <> NEW."provider"
     OR related_receipt."currency" <> NEW."currency"
     OR NEW."paymentAttemptId" IS NOT NULL THEN
    RAISE EXCEPTION 'commercial cash adjustment original payment mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialCashReceipt_adjustment_original_check';
  END IF;

  SELECT COALESCE(SUM("amountMinor"), 0)::BIGINT
    INTO adjusted_minor
  FROM "CommercialCashReceipt"
  WHERE "relatedReceiptId" = related_receipt."id"
    AND "entryType" IN ('REFUND', 'REVERSAL');

  IF adjusted_minor + NEW."amountMinor" > related_receipt."amountMinor" THEN
    RAISE EXCEPTION 'commercial cash adjustments exceed original payment'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialCashReceipt_adjustment_capacity_check';
  END IF;
  RETURN NEW;
END;
$$;

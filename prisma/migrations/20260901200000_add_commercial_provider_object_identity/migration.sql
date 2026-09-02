-- Signed provider objects are aliases only. The canonical money authority
-- remains CommercialCashReceipt and every alias is immutable and tenant-bound.
CREATE TABLE "CommercialBillingProviderObject" (
  "id" TEXT NOT NULL,
  "provider" "CommercialBillingProvider" NOT NULL,
  "objectType" VARCHAR(32) NOT NULL,
  "objectId" VARCHAR(255) NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "cashReceiptId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialBillingProviderObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialBillingProviderObject_type_check" CHECK (
    ("provider" = 'STRIPE' AND "objectType" = 'INVOICE' AND "objectId" LIKE 'in\_%' ESCAPE '\')
    OR ("provider" = 'STRIPE' AND "objectType" = 'PAYMENT_INTENT' AND "objectId" LIKE 'pi\_%' ESCAPE '\')
    OR ("provider" = 'STRIPE' AND "objectType" = 'CHARGE' AND "objectId" LIKE 'ch\_%' ESCAPE '\')
  )
);

CREATE UNIQUE INDEX "CommercialCashReceipt_id_org_venue_key"
  ON "CommercialCashReceipt"("id", "organizationId", "venueId");
CREATE UNIQUE INDEX "CommercialBillingProviderObject_provider_object_key"
  ON "CommercialBillingProviderObject"("provider", "objectId");
CREATE INDEX "CommercialBillingProviderObject_paymentAttempt_created_idx"
  ON "CommercialBillingProviderObject"("paymentAttemptId", "createdAt");
CREATE INDEX "CommercialBillingProviderObject_cashReceipt_created_idx"
  ON "CommercialBillingProviderObject"("cashReceiptId", "createdAt");

ALTER TABLE "CommercialBillingProviderObject"
  ADD CONSTRAINT "CommercialBillingProviderObject_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "CommercialBillingPaymentAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialBillingProviderObject"
  ADD CONSTRAINT "CommercialBillingProviderObject_cash_tenant_fkey"
  FOREIGN KEY ("cashReceiptId", "organizationId", "venueId")
  REFERENCES "CommercialCashReceipt"("id", "organizationId", "venueId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION commercial_billing_guard_provider_object_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_provider "CommercialBillingProvider";
  attempt_organization_id TEXT;
  attempt_venue_id TEXT;
  receipt_attempt_id TEXT;
  receipt_provider "CommercialBillingProvider";
  receipt_entry_type "CommercialCashReceiptEntryType";
BEGIN
  SELECT attempt."provider", ar."organizationId", ar."venueId"
    INTO attempt_provider, attempt_organization_id, attempt_venue_id
  FROM "CommercialBillingPaymentAttempt" attempt
  JOIN "CommercialAccountReceivable" ar ON ar."id" = attempt."receivableId"
  WHERE attempt."id" = NEW."paymentAttemptId"
  FOR SHARE OF attempt, ar;

  SELECT receipt."paymentAttemptId", receipt."provider", receipt."entryType"
    INTO receipt_attempt_id, receipt_provider, receipt_entry_type
  FROM "CommercialCashReceipt" receipt
  WHERE receipt."id" = NEW."cashReceiptId"
  FOR SHARE;

  IF attempt_provider IS NULL
     OR receipt_attempt_id IS NULL
     OR attempt_provider <> NEW."provider"
     OR receipt_provider <> NEW."provider"
     OR receipt_entry_type <> 'PAYMENT'
     OR receipt_attempt_id <> NEW."paymentAttemptId"
     OR attempt_organization_id <> NEW."organizationId"
     OR attempt_venue_id <> NEW."venueId" THEN
    RAISE EXCEPTION 'commercial provider object authority mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingProviderObject_authority_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialBillingProviderObject_insert_guard_trigger"
BEFORE INSERT ON "CommercialBillingProviderObject"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_provider_object_insert();

CREATE OR REPLACE FUNCTION commercial_billing_reject_provider_object_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CommercialBillingProviderObject is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingProviderObject_append_only_check';
END;
$$;

CREATE TRIGGER "CommercialBillingProviderObject_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialBillingProviderObject"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_provider_object_mutation();

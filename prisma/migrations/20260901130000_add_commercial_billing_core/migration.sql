-- P3-B: provider-neutral commercial billing core.
-- All monetary values are integer MXN minor units. Cash receipts and allocations
-- are append-only; corrections are new REFUND/REVERSAL + DEBIT rows.

CREATE TYPE "CommercialSubscriptionContractStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'CANCELED', 'COMPLETED');
CREATE TYPE "CommercialBillingCadence" AS ENUM ('MONTHLY', 'ANNUAL', 'MIXED');
CREATE TYPE "CommercialReceivableSubjectType" AS ENUM ('SUBSCRIPTION_PERIOD', 'TERMINAL_ORDER');
CREATE TYPE "CommercialAccountReceivableStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'PAST_DUE', 'EXPIRED', 'CANCELED');
CREATE TYPE "CommercialBillingProvider" AS ENUM ('STRIPE', 'MANUAL_SPEI', 'AUTOMATIC_SPEI');
CREATE TYPE "CommercialBillingPaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'OUTCOME_UNKNOWN', 'FAILED', 'CANCELED');
CREATE TYPE "CommercialCashReceiptEntryType" AS ENUM ('PAYMENT', 'REFUND', 'REVERSAL');
CREATE TYPE "CommercialBillingAllocationDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "CommercialSubscriptionPeriodStatus" AS ENUM ('OPEN', 'PAST_DUE', 'EXPIRED', 'PAID');
CREATE TYPE "CommercialEventOutboxSourceType" AS ENUM ('SUBSCRIPTION_PERIOD', 'OFFER_CONTROL_EVENT', 'CASH_RECEIPT');
CREATE TYPE "CommercialEventOutboxEventType" AS ENUM ('SUBSCRIPTION_PAYMENT_RECONCILED', 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED', 'COMMERCIAL_OFFER_CONTROL_CHANGED');
CREATE TYPE "CommercialEventOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'DEAD_LETTER');
CREATE TYPE "CommercialEntitlementProjectionAction" AS ENUM ('GRANT', 'REVOKE');

CREATE UNIQUE INDEX IF NOT EXISTS "CommercialQuoteAcceptance_id_org_venue_key"
  ON "CommercialQuoteAcceptance"("id", "organizationId", "venueId");

CREATE TABLE "CommercialSubscriptionContract" (
  "id" TEXT NOT NULL,
  "quoteAcceptanceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "snapshot" JSONB NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "status" "CommercialSubscriptionContractStatus" NOT NULL DEFAULT 'DRAFT',
  "cadence" "CommercialBillingCadence" NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialSubscriptionContract_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialSubscriptionContract_schema_check" CHECK (
    "schemaVersion" = 1
    AND "checksum" ~ '^[0-9a-f]{64}$'
    AND "currency" = 'MXN'
    AND char_length("timezone") BETWEEN 1 AND 128
    AND ("endedAt" IS NULL OR "endedAt" >= "startsAt")
  )
);

CREATE TABLE "CommercialSubscriptionPeriod" (
  "id" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "scheduleKey" VARCHAR(64) NOT NULL DEFAULT 'SAAS_MONTHLY',
  "cadence" "CommercialBillingCadence" NOT NULL DEFAULT 'MONTHLY',
  "sequence" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "graceEndsAt" TIMESTAMP(3) NOT NULL,
  "amountDueMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "status" "CommercialSubscriptionPeriodStatus" NOT NULL DEFAULT 'OPEN',
  "statusRevision" INTEGER NOT NULL DEFAULT 1,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialSubscriptionPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialSubscriptionPeriod_shape_check" CHECK (
    "sequence" >= 1
    AND char_length("scheduleKey") BETWEEN 1 AND 64
    AND "cadence" IN ('MONTHLY', 'ANNUAL')
    AND "startsAt" < "endsAt"
    AND "graceEndsAt" >= "dueAt"
    AND "amountDueMinor" >= 0
    AND "currency" = 'MXN'
    AND "statusRevision" >= 1
    AND (("status" = 'PAID' AND "paidAt" IS NOT NULL) OR ("status" <> 'PAID' AND "paidAt" IS NULL))
  )
);

CREATE TABLE "CommercialAccountReceivable" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "subjectType" "CommercialReceivableSubjectType" NOT NULL,
  "subscriptionPeriodId" TEXT,
  "terminalOrderId" TEXT,
  "reference" VARCHAR(128) NOT NULL,
  "amountDueMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" "CommercialAccountReceivableStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialAccountReceivable_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialAccountReceivable_subject_check" CHECK (
    ("subjectType" = 'SUBSCRIPTION_PERIOD' AND "subscriptionPeriodId" IS NOT NULL AND "terminalOrderId" IS NULL)
    OR
    ("subjectType" = 'TERMINAL_ORDER' AND "subscriptionPeriodId" IS NULL AND "terminalOrderId" IS NOT NULL)
  ),
  CONSTRAINT "CommercialAccountReceivable_money_check" CHECK (
    "amountDueMinor" >= 0 AND "currency" = 'MXN' AND char_length("reference") BETWEEN 1 AND 128
  )
);

CREATE TABLE "CommercialBillingPaymentAttempt" (
  "id" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "provider" "CommercialBillingProvider" NOT NULL,
  "providerAttemptId" VARCHAR(255),
  "idempotencyKey" TEXT NOT NULL,
  "status" "CommercialBillingPaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "amountMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "requestFingerprint" CHAR(64) NOT NULL,
  "lastErrorCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialBillingPaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialBillingPaymentAttempt_money_check" CHECK (
    "amountMinor" >= 0 AND "currency" = 'MXN' AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "CommercialCashReceipt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "paymentAttemptId" TEXT,
  "provider" "CommercialBillingProvider" NOT NULL,
  "providerEventId" VARCHAR(255) NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "entryType" "CommercialCashReceiptEntryType" NOT NULL,
  "relatedReceiptId" TEXT,
  "amountMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "receivingAccountFingerprint" CHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "reconciledById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialCashReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialCashReceipt_shape_check" CHECK (
    "amountMinor" > 0
    AND "currency" = 'MXN'
    AND "receivingAccountFingerprint" ~ '^[0-9a-f]{64}$'
    AND char_length("providerEventId") BETWEEN 1 AND 255
    AND (
      ("entryType" = 'PAYMENT' AND "relatedReceiptId" IS NULL)
      OR
      ("entryType" IN ('REFUND', 'REVERSAL') AND "relatedReceiptId" IS NOT NULL)
    )
  )
);

CREATE TABLE "CommercialBillingAllocation" (
  "id" TEXT NOT NULL,
  "cashReceiptId" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "direction" "CommercialBillingAllocationDirection" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialBillingAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialBillingAllocation_amount_check" CHECK ("amountMinor" > 0)
);

CREATE TABLE "CommercialEventOutbox" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "organizationId" TEXT,
  "venueId" TEXT,
  "sourceType" "CommercialEventOutboxSourceType" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "eventType" "CommercialEventOutboxEventType" NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "CommercialEventOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "firstAttemptAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialEventOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialEventOutbox_shape_check" CHECK (
    "sourceRevision" >= 1
    AND "attemptCount" >= 0
    AND (("organizationId" IS NULL AND "venueId" IS NULL) OR ("organizationId" IS NOT NULL AND "venueId" IS NOT NULL))
  )
);

CREATE TABLE "CommercialEntitlementProjection" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "subscriptionPeriodId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "featureCode" VARCHAR(128) NOT NULL,
  "action" "CommercialEntitlementProjectionAction" NOT NULL,
  "coverageStartsAt" TIMESTAMP(3) NOT NULL,
  "coverageEndsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialEntitlementProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialEntitlementProjection_shape_check" CHECK (
    "sourceRevision" >= 1
    AND char_length("featureCode") BETWEEN 1 AND 128
    AND "coverageStartsAt" < "coverageEndsAt"
  )
);

CREATE UNIQUE INDEX "CommercialSubscriptionContract_quoteAcceptanceId_key" ON "CommercialSubscriptionContract"("quoteAcceptanceId");
CREATE UNIQUE INDEX "CommercialSubscriptionContract_idempotencyKey_key" ON "CommercialSubscriptionContract"("idempotencyKey");
CREATE UNIQUE INDEX "CommercialSubscriptionContract_acceptance_org_venue_key" ON "CommercialSubscriptionContract"("quoteAcceptanceId", "organizationId", "venueId");
CREATE UNIQUE INDEX "CommercialSubscriptionContract_id_org_venue_key" ON "CommercialSubscriptionContract"("id", "organizationId", "venueId");
CREATE INDEX "CommercialSubscriptionContract_organizationId_status_idx" ON "CommercialSubscriptionContract"("organizationId", "status");
CREATE INDEX "CommercialSubscriptionContract_venueId_status_idx" ON "CommercialSubscriptionContract"("venueId", "status");

CREATE UNIQUE INDEX "CommercialSubscriptionPeriod_contract_schedule_sequence_key" ON "CommercialSubscriptionPeriod"("contractId", "scheduleKey", "sequence");
CREATE UNIQUE INDEX "CommercialSubscriptionPeriod_id_contract_key" ON "CommercialSubscriptionPeriod"("id", "contractId");
CREATE INDEX "CommercialSubscriptionPeriod_status_dueAt_idx" ON "CommercialSubscriptionPeriod"("status", "dueAt");
CREATE INDEX "CommercialSubscriptionPeriod_contractId_startsAt_idx" ON "CommercialSubscriptionPeriod"("contractId", "startsAt");

CREATE UNIQUE INDEX "CommercialAccountReceivable_subscriptionPeriodId_key" ON "CommercialAccountReceivable"("subscriptionPeriodId");
CREATE UNIQUE INDEX "CommercialAccountReceivable_terminalOrderId_key" ON "CommercialAccountReceivable"("terminalOrderId");
CREATE UNIQUE INDEX "CommercialAccountReceivable_reference_key" ON "CommercialAccountReceivable"("reference");
CREATE INDEX "CommercialAccountReceivable_organization_status_due_idx" ON "CommercialAccountReceivable"("organizationId", "status", "dueAt");
CREATE INDEX "CommercialAccountReceivable_venue_status_due_idx" ON "CommercialAccountReceivable"("venueId", "status", "dueAt");

CREATE UNIQUE INDEX "CommercialBillingPaymentAttempt_idempotencyKey_key" ON "CommercialBillingPaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "CommercialBillingPaymentAttempt_provider_attempt_key" ON "CommercialBillingPaymentAttempt"("provider", "providerAttemptId");
CREATE INDEX "CommercialBillingPaymentAttempt_receivable_status_idx" ON "CommercialBillingPaymentAttempt"("receivableId", "status", "createdAt");

CREATE UNIQUE INDEX "CommercialCashReceipt_idempotencyKey_key" ON "CommercialCashReceipt"("idempotencyKey");
CREATE UNIQUE INDEX "CommercialCashReceipt_provider_event_key" ON "CommercialCashReceipt"("provider", "providerEventId");
CREATE INDEX "CommercialCashReceipt_organization_observed_idx" ON "CommercialCashReceipt"("organizationId", "observedAt");
CREATE INDEX "CommercialCashReceipt_venue_observed_idx" ON "CommercialCashReceipt"("venueId", "observedAt");
CREATE INDEX "CommercialCashReceipt_relatedReceiptId_idx" ON "CommercialCashReceipt"("relatedReceiptId");
CREATE INDEX "CommercialCashReceipt_paymentAttemptId_idx" ON "CommercialCashReceipt"("paymentAttemptId");
CREATE INDEX "CommercialCashReceipt_reconciledById_idx" ON "CommercialCashReceipt"("reconciledById");

CREATE UNIQUE INDEX "CommercialBillingAllocation_idempotencyKey_key" ON "CommercialBillingAllocation"("idempotencyKey");
CREATE INDEX "CommercialBillingAllocation_cashReceipt_created_idx" ON "CommercialBillingAllocation"("cashReceiptId", "createdAt");
CREATE INDEX "CommercialBillingAllocation_receivable_created_idx" ON "CommercialBillingAllocation"("receivableId", "createdAt");

CREATE UNIQUE INDEX "CommercialEventOutbox_eventId_key" ON "CommercialEventOutbox"("eventId");
CREATE UNIQUE INDEX "CommercialEventOutbox_source_revision_event_key" ON "CommercialEventOutbox"("sourceType", "sourceId", "sourceRevision", "eventType");
CREATE INDEX "CommercialEventOutbox_status_availableAt_idx" ON "CommercialEventOutbox"("status", "availableAt");
CREATE INDEX "CommercialEventOutbox_organization_created_idx" ON "CommercialEventOutbox"("organizationId", "createdAt");
CREATE INDEX "CommercialEventOutbox_venue_created_idx" ON "CommercialEventOutbox"("venueId", "createdAt");

CREATE UNIQUE INDEX "CommercialEntitlementProjection_event_feature_key" ON "CommercialEntitlementProjection"("eventId", "featureCode");
CREATE UNIQUE INDEX "CommercialEntitlementProjection_source_action_key" ON "CommercialEntitlementProjection"("contractId", "featureCode", "subscriptionPeriodId", "sourceRevision", "action");
CREATE INDEX "CommercialEntitlementProjection_organization_feature_created_idx" ON "CommercialEntitlementProjection"("organizationId", "featureCode", "createdAt");
CREATE INDEX "CommercialEntitlementProjection_venue_feature_created_idx" ON "CommercialEntitlementProjection"("venueId", "featureCode", "createdAt");
CREATE INDEX "CommercialEntitlementProjection_contract_feature_created_idx" ON "CommercialEntitlementProjection"("contractId", "featureCode", "createdAt");

ALTER TABLE "CommercialSubscriptionContract"
  ADD CONSTRAINT "CommercialSubscriptionContract_acceptance_fkey"
  FOREIGN KEY ("quoteAcceptanceId", "organizationId", "venueId")
  REFERENCES "CommercialQuoteAcceptance"("id", "organizationId", "venueId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialSubscriptionContract"
  ADD CONSTRAINT "CommercialSubscriptionContract_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialSubscriptionContract"
  ADD CONSTRAINT "CommercialSubscriptionContract_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialSubscriptionPeriod"
  ADD CONSTRAINT "CommercialSubscriptionPeriod_contractId_fkey"
  FOREIGN KEY ("contractId") REFERENCES "CommercialSubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialAccountReceivable"
  ADD CONSTRAINT "CommercialAccountReceivable_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialAccountReceivable"
  ADD CONSTRAINT "CommercialAccountReceivable_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialAccountReceivable"
  ADD CONSTRAINT "CommercialAccountReceivable_period_fkey"
  FOREIGN KEY ("subscriptionPeriodId") REFERENCES "CommercialSubscriptionPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialAccountReceivable"
  ADD CONSTRAINT "CommercialAccountReceivable_terminalOrder_fkey"
  FOREIGN KEY ("terminalOrderId") REFERENCES "TerminalOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialBillingPaymentAttempt"
  ADD CONSTRAINT "CommercialBillingPaymentAttempt_receivableId_fkey"
  FOREIGN KEY ("receivableId") REFERENCES "CommercialAccountReceivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialCashReceipt"
  ADD CONSTRAINT "CommercialCashReceipt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCashReceipt"
  ADD CONSTRAINT "CommercialCashReceipt_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCashReceipt"
  ADD CONSTRAINT "CommercialCashReceipt_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "CommercialBillingPaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCashReceipt"
  ADD CONSTRAINT "CommercialCashReceipt_relatedReceiptId_fkey"
  FOREIGN KEY ("relatedReceiptId") REFERENCES "CommercialCashReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialCashReceipt"
  ADD CONSTRAINT "CommercialCashReceipt_reconciledById_fkey"
  FOREIGN KEY ("reconciledById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialBillingAllocation"
  ADD CONSTRAINT "CommercialBillingAllocation_cashReceiptId_fkey"
  FOREIGN KEY ("cashReceiptId") REFERENCES "CommercialCashReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialBillingAllocation"
  ADD CONSTRAINT "CommercialBillingAllocation_receivableId_fkey"
  FOREIGN KEY ("receivableId") REFERENCES "CommercialAccountReceivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialEventOutbox"
  ADD CONSTRAINT "CommercialEventOutbox_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialEventOutbox"
  ADD CONSTRAINT "CommercialEventOutbox_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialEntitlementProjection"
  ADD CONSTRAINT "CommercialEntitlementProjection_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "CommercialEventOutbox"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialEntitlementProjection"
  ADD CONSTRAINT "CommercialEntitlementProjection_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialEntitlementProjection"
  ADD CONSTRAINT "CommercialEntitlementProjection_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialEntitlementProjection"
  ADD CONSTRAINT "CommercialEntitlementProjection_contract_tenant_fkey"
  FOREIGN KEY ("contractId", "organizationId", "venueId")
  REFERENCES "CommercialSubscriptionContract"("id", "organizationId", "venueId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialEntitlementProjection"
  ADD CONSTRAINT "CommercialEntitlementProjection_period_contract_fkey"
  FOREIGN KEY ("subscriptionPeriodId", "contractId")
  REFERENCES "CommercialSubscriptionPeriod"("id", "contractId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION commercial_billing_guard_receivable_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subject_organization_id TEXT;
  subject_venue_id TEXT;
BEGIN
  -- Leave malformed subject shapes to the named table CHECK so callers receive
  -- the stable shape error instead of a misleading tenant error.
  IF (NEW."subjectType" = 'SUBSCRIPTION_PERIOD' AND (NEW."subscriptionPeriodId" IS NULL OR NEW."terminalOrderId" IS NOT NULL))
     OR (NEW."subjectType" = 'TERMINAL_ORDER' AND (NEW."subscriptionPeriodId" IS NOT NULL OR NEW."terminalOrderId" IS NULL)) THEN
    RETURN NEW;
  END IF;

  IF NEW."subjectType" = 'SUBSCRIPTION_PERIOD' THEN
    SELECT contract."organizationId", contract."venueId"
      INTO subject_organization_id, subject_venue_id
    FROM "CommercialSubscriptionPeriod" AS period
    JOIN "CommercialSubscriptionContract" AS contract ON contract."id" = period."contractId"
    WHERE period."id" = NEW."subscriptionPeriodId"
    FOR SHARE OF period, contract;
  ELSE
    SELECT venue."organizationId", terminal_order."venueId"
      INTO subject_organization_id, subject_venue_id
    FROM "TerminalOrder" AS terminal_order
    JOIN "Venue" AS venue ON venue."id" = terminal_order."venueId"
    WHERE terminal_order."id" = NEW."terminalOrderId"
    FOR SHARE OF terminal_order, venue;
  END IF;

  IF subject_organization_id IS NULL
     OR subject_organization_id <> NEW."organizationId"
     OR subject_venue_id <> NEW."venueId" THEN
    RAISE EXCEPTION 'commercial receivable subject tenant mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialAccountReceivable_subject_tenant_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialAccountReceivable_subject_tenant_trigger"
BEFORE INSERT OR UPDATE OF "organizationId", "venueId", "subjectType", "subscriptionPeriodId", "terminalOrderId"
ON "CommercialAccountReceivable"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_receivable_subject();

CREATE OR REPLACE FUNCTION commercial_billing_guard_receipt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_organization_id TEXT;
  related_venue_id TEXT;
  related_currency CHAR(3);
BEGIN
  IF NEW."relatedReceiptId" IS NOT NULL THEN
    SELECT "organizationId", "venueId", "currency"
      INTO related_organization_id, related_venue_id, related_currency
    FROM "CommercialCashReceipt"
    WHERE "id" = NEW."relatedReceiptId"
    FOR SHARE;

    IF related_organization_id IS NULL
       OR related_organization_id <> NEW."organizationId"
       OR related_venue_id <> NEW."venueId"
       OR related_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'commercial receipt adjustment mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'CommercialCashReceipt_related_tenant_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialCashReceipt_insert_guard_trigger"
BEFORE INSERT ON "CommercialCashReceipt"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_receipt_insert();

CREATE OR REPLACE FUNCTION commercial_billing_reject_cash_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CommercialCashReceipt is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'CommercialCashReceipt_append_only_check';
END;
$$;

CREATE TRIGGER "CommercialCashReceipt_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialCashReceipt"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_cash_receipt_mutation();

CREATE OR REPLACE FUNCTION commercial_billing_guard_allocation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row "CommercialCashReceipt"%ROWTYPE;
  receivable_row "CommercialAccountReceivable"%ROWTYPE;
  receipt_allocated BIGINT;
  receivable_active BIGINT;
  next_receivable_active BIGINT;
BEGIN
  SELECT * INTO receipt_row
  FROM "CommercialCashReceipt"
  WHERE "id" = NEW."cashReceiptId"
  FOR UPDATE;

  SELECT * INTO receivable_row
  FROM "CommercialAccountReceivable"
  WHERE "id" = NEW."receivableId"
  FOR UPDATE;

  IF receipt_row."id" IS NULL OR receivable_row."id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF receipt_row."organizationId" <> receivable_row."organizationId"
     OR receipt_row."venueId" <> receivable_row."venueId"
     OR receipt_row."currency" <> receivable_row."currency" THEN
    RAISE EXCEPTION 'commercial allocation tenant mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingAllocation_tenant_check';
  END IF;

  IF (NEW."direction" = 'CREDIT' AND receipt_row."entryType" <> 'PAYMENT')
     OR (NEW."direction" = 'DEBIT' AND receipt_row."entryType" NOT IN ('REFUND', 'REVERSAL')) THEN
    RAISE EXCEPTION 'commercial allocation direction does not match receipt'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingAllocation_direction_check';
  END IF;

  SELECT COALESCE(SUM("amountMinor"), 0)::BIGINT
    INTO receipt_allocated
  FROM "CommercialBillingAllocation"
  WHERE "cashReceiptId" = NEW."cashReceiptId";

  IF receipt_allocated + NEW."amountMinor" > receipt_row."amountMinor" THEN
    RAISE EXCEPTION 'commercial receipt allocation exceeds receipt amount'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingAllocation_receipt_capacity_check';
  END IF;

  SELECT COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::BIGINT
    INTO receivable_active
  FROM "CommercialBillingAllocation"
  WHERE "receivableId" = NEW."receivableId";

  next_receivable_active := receivable_active
    + CASE WHEN NEW."direction" = 'CREDIT' THEN NEW."amountMinor" ELSE -NEW."amountMinor" END;

  IF next_receivable_active < 0 OR next_receivable_active > receivable_row."amountDueMinor" THEN
    RAISE EXCEPTION 'commercial allocation exceeds receivable coverage'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingAllocation_receivable_capacity_check';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialBillingAllocation_capacity_trigger"
BEFORE INSERT ON "CommercialBillingAllocation"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_allocation_insert();

CREATE OR REPLACE FUNCTION commercial_billing_reject_allocation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CommercialBillingAllocation is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'CommercialBillingAllocation_append_only_check';
END;
$$;

CREATE TRIGGER "CommercialBillingAllocation_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialBillingAllocation"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_allocation_mutation();

CREATE OR REPLACE FUNCTION commercial_billing_guard_entitlement_projection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row "CommercialEventOutbox"%ROWTYPE;
BEGIN
  SELECT * INTO event_row
  FROM "CommercialEventOutbox"
  WHERE "eventId" = NEW."eventId"
  FOR SHARE;

  IF event_row."eventId" IS NULL
     OR event_row."eventType" NOT IN ('SUBSCRIPTION_PAYMENT_RECONCILED', 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED')
     OR event_row."sourceType" <> 'SUBSCRIPTION_PERIOD'
     OR event_row."sourceId" <> NEW."subscriptionPeriodId"
     OR event_row."sourceRevision" <> NEW."sourceRevision"
     OR event_row."organizationId" <> NEW."organizationId"
     OR event_row."venueId" <> NEW."venueId" THEN
    RAISE EXCEPTION 'commercial entitlement projection source mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEntitlementProjection_source_check';
  END IF;

  IF (NEW."action" = 'GRANT' AND event_row."eventType" <> 'SUBSCRIPTION_PAYMENT_RECONCILED')
     OR (NEW."action" = 'REVOKE' AND event_row."eventType" <> 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED') THEN
    RAISE EXCEPTION 'commercial entitlement projection action mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEntitlementProjection_action_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialEntitlementProjection_insert_guard_trigger"
BEFORE INSERT ON "CommercialEntitlementProjection"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_entitlement_projection_insert();

CREATE OR REPLACE FUNCTION commercial_billing_reject_entitlement_projection_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CommercialEntitlementProjection is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'CommercialEntitlementProjection_append_only_check';
END;
$$;

CREATE TRIGGER "CommercialEntitlementProjection_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialEntitlementProjection"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_entitlement_projection_mutation();

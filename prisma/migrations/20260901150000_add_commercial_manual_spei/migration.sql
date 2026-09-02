-- P3-B: manual SPEI proof and financial-approval authorities.
-- Proof/review/approval rows are append-only. Only a reconciled cash receipt
-- may move a case to RECONCILED; accepted proof alone is never money.

CREATE TYPE "CommercialManualSpeiCaseStatus" AS ENUM (
  'PENDING_REVIEW', 'AWAITING_APPROVAL', 'READY_TO_RECONCILE', 'RECONCILED', 'REJECTED'
);
CREATE TYPE "CommercialManualSpeiEvidenceReviewAction" AS ENUM ('ACCEPT', 'REJECT', 'SUPERSEDE');

CREATE TABLE "CommercialManualSpeiPolicyVersion" (
  "id" TEXT NOT NULL,
  "market" CHAR(2) NOT NULL,
  "version" INTEGER NOT NULL,
  "dualApprovalThresholdMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "checksum" CHAR(64) NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialManualSpeiPolicyVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialManualSpeiPolicyVersion_shape_check" CHECK (
    "market" = 'MX'
    AND "version" >= 1
    AND "dualApprovalThresholdMinor" > 0
    AND "currency" = 'MXN'
    AND "checksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "CommercialManualSpeiPolicyActivation" (
  "market" CHAR(2) NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommercialManualSpeiPolicyActivation_pkey" PRIMARY KEY ("market")
);

CREATE TABLE "CommercialManualSpeiCase" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "receivableId" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "observedAmountMinor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'MXN',
  "bankReference" VARCHAR(128),
  "receivingAccountFingerprint" CHAR(64) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "attributedCommercialActorIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdById" TEXT NOT NULL,
  "requiredApprovals" INTEGER NOT NULL,
  "exceptionReasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status" "CommercialManualSpeiCaseStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "reconciledReceiptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CommercialManualSpeiCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialManualSpeiCase_shape_check" CHECK (
    "observedAmountMinor" > 0
    AND "currency" = 'MXN'
    AND "receivingAccountFingerprint" ~ '^[0-9a-f]{64}$'
    AND ("bankReference" IS NULL OR char_length("bankReference") BETWEEN 1 AND 128)
    AND jsonb_typeof("attributedCommercialActorIds") = 'array'
    AND jsonb_typeof("exceptionReasons") = 'array'
    AND "requiredApprovals" IN (1, 2)
    AND (
      ("status" = 'RECONCILED' AND "reconciledReceiptId" IS NOT NULL)
      OR ("status" <> 'RECONCILED' AND "reconciledReceiptId" IS NULL)
    )
  )
);

CREATE TABLE "CommercialManualSpeiEvidence" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "storageObjectKey" VARCHAR(512) NOT NULL,
  "contentSha256" CHAR(64) NOT NULL,
  "mimeType" VARCHAR(128) NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialManualSpeiEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialManualSpeiEvidence_shape_check" CHECK (
    "sequence" >= 1
    AND "storageObjectKey" LIKE 'private/%'
    AND "contentSha256" ~ '^[0-9a-f]{64}$'
    AND char_length("mimeType") BETWEEN 1 AND 128
    AND "sizeBytes" BETWEEN 1 AND 10485760
  )
);

CREATE TABLE "CommercialManualSpeiEvidenceReview" (
  "id" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "action" "CommercialManualSpeiEvidenceReviewAction" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialManualSpeiEvidenceReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialManualSpeiEvidenceReview_reason_check" CHECK (
    "reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500
  )
);

CREATE TABLE "CommercialManualSpeiApproval" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "exceptionReasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialManualSpeiApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialManualSpeiApproval_shape_check" CHECK (
    jsonb_typeof("exceptionReasons") = 'array'
  )
);

CREATE UNIQUE INDEX "CommercialManualSpeiPolicyVersion_market_version_key"
  ON "CommercialManualSpeiPolicyVersion"("market", "version");
CREATE UNIQUE INDEX "CommercialManualSpeiPolicyVersion_id_market_key"
  ON "CommercialManualSpeiPolicyVersion"("id", "market");
CREATE INDEX "CommercialManualSpeiPolicyVersion_publishedAt_idx"
  ON "CommercialManualSpeiPolicyVersion"("publishedAt");

CREATE UNIQUE INDEX "CommercialManualSpeiPolicyActivation_policyVersionId_key"
  ON "CommercialManualSpeiPolicyActivation"("policyVersionId");
CREATE UNIQUE INDEX "CommercialManualSpeiPolicyActivation_version_market_key"
  ON "CommercialManualSpeiPolicyActivation"("policyVersionId", "market");

CREATE UNIQUE INDEX "CommercialManualSpeiCase_paymentAttemptId_key"
  ON "CommercialManualSpeiCase"("paymentAttemptId");
CREATE UNIQUE INDEX "CommercialManualSpeiCase_reconciledReceiptId_key"
  ON "CommercialManualSpeiCase"("reconciledReceiptId");
CREATE INDEX "CommercialManualSpeiCase_organization_status_created_idx"
  ON "CommercialManualSpeiCase"("organizationId", "status", "createdAt");
CREATE INDEX "CommercialManualSpeiCase_venue_status_created_idx"
  ON "CommercialManualSpeiCase"("venueId", "status", "createdAt");
CREATE INDEX "CommercialManualSpeiCase_policyVersion_created_idx"
  ON "CommercialManualSpeiCase"("policyVersionId", "createdAt");
CREATE INDEX "CommercialManualSpeiCase_createdBy_created_idx"
  ON "CommercialManualSpeiCase"("createdById", "createdAt");

CREATE UNIQUE INDEX "CommercialManualSpeiEvidence_storageObjectKey_key"
  ON "CommercialManualSpeiEvidence"("storageObjectKey");
CREATE UNIQUE INDEX "CommercialManualSpeiEvidence_case_sequence_key"
  ON "CommercialManualSpeiEvidence"("caseId", "sequence");
CREATE INDEX "CommercialManualSpeiEvidence_case_created_idx"
  ON "CommercialManualSpeiEvidence"("caseId", "createdAt");

CREATE UNIQUE INDEX "CommercialManualSpeiEvidenceReview_evidence_actor_action_key"
  ON "CommercialManualSpeiEvidenceReview"("evidenceId", "actorId", "action");
CREATE INDEX "CommercialManualSpeiEvidenceReview_evidence_created_idx"
  ON "CommercialManualSpeiEvidenceReview"("evidenceId", "createdAt");

CREATE UNIQUE INDEX "CommercialManualSpeiApproval_case_actor_key"
  ON "CommercialManualSpeiApproval"("caseId", "actorId");
CREATE INDEX "CommercialManualSpeiApproval_policyVersion_created_idx"
  ON "CommercialManualSpeiApproval"("policyVersionId", "createdAt");

ALTER TABLE "CommercialManualSpeiPolicyVersion"
  ADD CONSTRAINT "CommercialManualSpeiPolicyVersion_publishedById_fkey"
  FOREIGN KEY ("publishedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiPolicyActivation"
  ADD CONSTRAINT "CommercialManualSpeiPolicyActivation_policyVersion_market_fkey"
  FOREIGN KEY ("policyVersionId", "market")
  REFERENCES "CommercialManualSpeiPolicyVersion"("id", "market") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiPolicyActivation"
  ADD CONSTRAINT "CommercialManualSpeiPolicyActivation_activatedById_fkey"
  FOREIGN KEY ("activatedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_venue_tenant_fkey"
  FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_receivableId_fkey"
  FOREIGN KEY ("receivableId") REFERENCES "CommercialAccountReceivable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "CommercialBillingPaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "CommercialManualSpeiPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiCase"
  ADD CONSTRAINT "CommercialManualSpeiCase_reconciledReceiptId_fkey"
  FOREIGN KEY ("reconciledReceiptId") REFERENCES "CommercialCashReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommercialManualSpeiEvidence"
  ADD CONSTRAINT "CommercialManualSpeiEvidence_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "CommercialManualSpeiCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiEvidence"
  ADD CONSTRAINT "CommercialManualSpeiEvidence_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiEvidenceReview"
  ADD CONSTRAINT "CommercialManualSpeiEvidenceReview_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "CommercialManualSpeiEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiEvidenceReview"
  ADD CONSTRAINT "CommercialManualSpeiEvidenceReview_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiApproval"
  ADD CONSTRAINT "CommercialManualSpeiApproval_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "CommercialManualSpeiCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiApproval"
  ADD CONSTRAINT "CommercialManualSpeiApproval_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialManualSpeiApproval"
  ADD CONSTRAINT "CommercialManualSpeiApproval_policyVersionId_fkey"
  FOREIGN KEY ("policyVersionId") REFERENCES "CommercialManualSpeiPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION commercial_billing_guard_manual_spei_case_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_row "CommercialBillingPaymentAttempt"%ROWTYPE;
  receivable_row "CommercialAccountReceivable"%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row
  FROM "CommercialBillingPaymentAttempt"
  WHERE "id" = NEW."paymentAttemptId"
  FOR SHARE;

  SELECT * INTO receivable_row
  FROM "CommercialAccountReceivable"
  WHERE "id" = NEW."receivableId"
  FOR SHARE;

  IF attempt_row."id" IS NULL
     OR receivable_row."id" IS NULL
     OR attempt_row."provider" <> 'MANUAL_SPEI'
     OR attempt_row."receivableId" <> NEW."receivableId"
     OR attempt_row."amountMinor" <> NEW."observedAmountMinor"
     OR attempt_row."currency" <> NEW."currency"
     OR receivable_row."organizationId" <> NEW."organizationId"
     OR receivable_row."venueId" <> NEW."venueId" THEN
    RAISE EXCEPTION 'commercial manual SPEI case authority mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialManualSpeiCase_authority_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialManualSpeiCase_insert_guard_trigger"
BEFORE INSERT ON "CommercialManualSpeiCase"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_manual_spei_case_insert();

CREATE OR REPLACE FUNCTION commercial_billing_guard_manual_spei_case_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row "CommercialCashReceipt"%ROWTYPE;
BEGIN
  IF ROW(
    NEW."organizationId", NEW."venueId", NEW."receivableId", NEW."paymentAttemptId",
    NEW."policyVersionId", NEW."observedAmountMinor", NEW."currency", NEW."bankReference",
    NEW."receivingAccountFingerprint", NEW."observedAt", NEW."attributedCommercialActorIds",
    NEW."createdById", NEW."requiredApprovals", NEW."exceptionReasons", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."organizationId", OLD."venueId", OLD."receivableId", OLD."paymentAttemptId",
    OLD."policyVersionId", OLD."observedAmountMinor", OLD."currency", OLD."bankReference",
    OLD."receivingAccountFingerprint", OLD."observedAt", OLD."attributedCommercialActorIds",
    OLD."createdById", OLD."requiredApprovals", OLD."exceptionReasons", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'commercial manual SPEI authority is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialManualSpeiCase_authority_immutable_check';
  END IF;

  IF NEW."status" = 'RECONCILED' THEN
    SELECT * INTO receipt_row
    FROM "CommercialCashReceipt"
    WHERE "id" = NEW."reconciledReceiptId"
    FOR SHARE;

    IF receipt_row."id" IS NULL
       OR receipt_row."provider" <> 'MANUAL_SPEI'
       OR receipt_row."paymentAttemptId" <> NEW."paymentAttemptId"
       OR receipt_row."organizationId" <> NEW."organizationId"
       OR receipt_row."venueId" <> NEW."venueId" THEN
      RAISE EXCEPTION 'commercial manual SPEI receipt mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'CommercialManualSpeiCase_receipt_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialManualSpeiCase_update_guard_trigger"
BEFORE UPDATE ON "CommercialManualSpeiCase"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_manual_spei_case_update();

CREATE OR REPLACE FUNCTION commercial_billing_guard_manual_spei_approval_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  case_row "CommercialManualSpeiCase"%ROWTYPE;
BEGIN
  SELECT * INTO case_row
  FROM "CommercialManualSpeiCase"
  WHERE "id" = NEW."caseId"
  FOR UPDATE;

  IF case_row."id" IS NULL
     OR case_row."policyVersionId" <> NEW."policyVersionId"
     OR case_row."createdById" = NEW."actorId"
     OR case_row."attributedCommercialActorIds" ? NEW."actorId"
     OR EXISTS (
       SELECT 1
       FROM "CommercialManualSpeiEvidenceReview" AS review
       JOIN "CommercialManualSpeiEvidence" AS evidence ON evidence."id" = review."evidenceId"
       WHERE evidence."caseId" = NEW."caseId"
         AND review."action" = 'ACCEPT'
         AND review."actorId" = NEW."actorId"
     ) THEN
    RAISE EXCEPTION 'commercial manual SPEI approver is not independent'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialManualSpeiApproval_independence_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialManualSpeiApproval_insert_guard_trigger"
BEFORE INSERT ON "CommercialManualSpeiApproval"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_manual_spei_approval_insert();

CREATE OR REPLACE FUNCTION commercial_billing_reject_manual_spei_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'commercial manual SPEI evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_append_only_check';
END;
$$;

CREATE TRIGGER "CommercialManualSpeiPolicyVersion_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialManualSpeiPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_manual_spei_append_only_mutation();
CREATE TRIGGER "CommercialManualSpeiEvidence_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialManualSpeiEvidence"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_manual_spei_append_only_mutation();
CREATE TRIGGER "CommercialManualSpeiEvidenceReview_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialManualSpeiEvidenceReview"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_manual_spei_append_only_mutation();
CREATE TRIGGER "CommercialManualSpeiApproval_append_only_trigger"
BEFORE UPDATE OR DELETE ON "CommercialManualSpeiApproval"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_reject_manual_spei_append_only_mutation();

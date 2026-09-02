-- P3-1A1a: durable platform Stripe inbox classification, phase leases and
-- immutable local object bindings. Expand-only; payload/metadata is never used
-- to backfill routing authority.

BEGIN;

-- PostgreSQL cannot safely use freshly-added enum values inside constraints in
-- the same migration transaction. Rebuild the two tiny enums while preserving
-- their only existing consumer and its A0 constraint.
ALTER TABLE "StripeCheckoutOrigin" DROP CONSTRAINT "StripeCheckoutOrigin_owner_route_check";
ALTER TYPE "StripeEventOwnerKind" RENAME TO "StripeEventOwnerKind_a0";
CREATE TYPE "StripeEventOwnerKind" AS ENUM ('COMMERCIAL_V2', 'LEGACY', 'INDEPENDENT');
ALTER TABLE "StripeCheckoutOrigin"
  ALTER COLUMN "ownerKind" TYPE "StripeEventOwnerKind"
  USING ("ownerKind"::text::"StripeEventOwnerKind");
DROP TYPE "StripeEventOwnerKind_a0";

ALTER TYPE "StripeEventRouteKey" RENAME TO "StripeEventRouteKey_a0";
CREATE TYPE "StripeEventRouteKey" AS ENUM (
  'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
  'LEGACY_PLAN_CHECKOUT',
  'LEGACY_SUBSCRIPTION_LIFECYCLE',
  'TERMINAL_ORDER_CHECKOUT',
  'TOKEN_PAYMENT_INTENT',
  'TOKEN_INVOICE',
  'CREDIT_PACK_CHECKOUT',
  'VENUE_BILLING_PROFILE'
);
ALTER TABLE "StripeCheckoutOrigin"
  ALTER COLUMN "routeKey" TYPE "StripeEventRouteKey"
  USING ("routeKey"::text::"StripeEventRouteKey");
DROP TYPE "StripeEventRouteKey_a0";

ALTER TABLE "StripeCheckoutOrigin"
  ADD CONSTRAINT "StripeCheckoutOrigin_owner_route_check" CHECK (
    "ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_PLAN_CHECKOUT'
  );

CREATE TYPE "WebhookClassificationState" AS ENUM (
  'LEGACY_UNCLASSIFIED',
  'PENDING_CLASSIFICATION',
  'CLASSIFIED',
  'IGNORED',
  'UNRESOLVED'
);
CREATE TYPE "WebhookClaimPhase" AS ENUM ('CLASSIFICATION', 'EFFECT');
CREATE TYPE "StripeEventSubjectKind" AS ENUM (
  'COMMERCIAL_ACCEPTANCE',
  'STRIPE_CHECKOUT_ORIGIN',
  'VENUE_FEATURE',
  'TERMINAL_ORDER',
  'TOKEN_PURCHASE',
  'VENUE'
);
CREATE TYPE "StripeObjectType" AS ENUM (
  'CHECKOUT_SESSION',
  'SUBSCRIPTION',
  'INVOICE',
  'PAYMENT_INTENT',
  'CHARGE'
);

ALTER TABLE "WebhookEvent"
  ADD COLUMN "classificationState" "WebhookClassificationState" NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED',
  ADD COLUMN "classificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "classificationNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "classificationErrorCode" VARCHAR(64),
  ADD COLUMN "classificationErrorMessage" VARCHAR(1024),
  ADD COLUMN "classificationResolvedAt" TIMESTAMP(3),
  ADD COLUMN "effectAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "effectNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "ownerKind" "StripeEventOwnerKind",
  ADD COLUMN "routeKey" "StripeEventRouteKey",
  ADD COLUMN "subjectKind" "StripeEventSubjectKind",
  ADD COLUMN "subjectId" TEXT,
  ADD COLUMN "claimPhase" "WebhookClaimPhase",
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimedBy" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP);

-- Historical rows are terminal compatibility records for classification. Their
-- EFFECT projection remains eligible exactly where the old status was not a
-- success; budget checks, not a null timestamp, decide exhaustion.
UPDATE "WebhookEvent"
SET
  "effectAttempts" = "retryCount",
  "effectNextAttemptAt" = CASE
    WHEN "status" = 'SUCCESS' THEN NULL
    ELSE timezone('UTC', CURRENT_TIMESTAMP)
  END;

ALTER TABLE "WebhookEvent"
  ALTER COLUMN "classificationState" SET DEFAULT 'PENDING_CLASSIFICATION',
  ALTER COLUMN "classificationNextAttemptAt" SET DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  ALTER COLUMN "effectNextAttemptAt" SET DEFAULT timezone('UTC', CURRENT_TIMESTAMP);

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_authority_tuple_complete_check" CHECK (
    ("ownerKind" IS NULL AND "routeKey" IS NULL AND "subjectKind" IS NULL AND "subjectId" IS NULL)
    OR
    ("ownerKind" IS NOT NULL AND "routeKey" IS NOT NULL AND "subjectKind" IS NOT NULL AND "subjectId" IS NOT NULL AND btrim("subjectId") <> '')
  ),
  ADD CONSTRAINT "WebhookEvent_classification_state_tuple_check" CHECK (
    ("classificationState" = 'CLASSIFIED' AND "ownerKind" IS NOT NULL)
    OR
    ("classificationState" <> 'CLASSIFIED' AND "ownerKind" IS NULL)
  ),
  ADD CONSTRAINT "WebhookEvent_classification_schedule_check" CHECK (
    ("classificationState" = 'LEGACY_UNCLASSIFIED' AND "classificationNextAttemptAt" IS NULL AND "classificationResolvedAt" IS NULL)
    OR
    ("classificationState" = 'PENDING_CLASSIFICATION' AND "classificationNextAttemptAt" IS NOT NULL AND "classificationResolvedAt" IS NULL)
    OR
    ("classificationState" IN ('CLASSIFIED', 'IGNORED', 'UNRESOLVED') AND "classificationNextAttemptAt" IS NULL AND "classificationResolvedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "WebhookEvent_attempts_nonnegative_check" CHECK (
    "retryCount" >= 0 AND "classificationAttempts" >= 0 AND "effectAttempts" >= 0
  ),
  ADD CONSTRAINT "WebhookEvent_unresolved_reason_check" CHECK (
    "classificationState" <> 'UNRESOLVED'
    OR ("classificationErrorCode" IS NOT NULL AND btrim("classificationErrorCode") <> '')
  ),
  ADD CONSTRAINT "WebhookEvent_lease_complete_check" CHECK (
    ("claimPhase" IS NULL AND "claimToken" IS NULL AND "claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL)
    OR
    ("claimPhase" IS NOT NULL AND "claimToken" IS NOT NULL AND btrim("claimToken") <> ''
      AND "claimedBy" IS NOT NULL AND btrim("claimedBy") <> '' AND "claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "WebhookEvent_lease_expiry_check" CHECK (
    "claimExpiresAt" IS NULL OR "claimExpiresAt" > "claimedAt"
  ),
  ADD CONSTRAINT "WebhookEvent_authority_matrix_check" CHECK (
    "ownerKind" IS NULL
    OR ("ownerKind" = 'COMMERCIAL_V2' AND "routeKey" = 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'COMMERCIAL_ACCEPTANCE')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_PLAN_CHECKOUT' AND "subjectKind" = 'STRIPE_CHECKOUT_ORIGIN')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'VENUE_FEATURE')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TERMINAL_ORDER_CHECKOUT' AND "subjectKind" = 'TERMINAL_ORDER')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_PAYMENT_INTENT' AND "subjectKind" = 'TOKEN_PURCHASE')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_INVOICE' AND "subjectKind" = 'TOKEN_PURCHASE')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'VENUE_BILLING_PROFILE' AND "subjectKind" = 'VENUE')
  );

CREATE INDEX "WebhookEvent_classificationState_classificationNextAttemptAt_createdAt_idx"
  ON "WebhookEvent"("classificationState", "classificationNextAttemptAt", "createdAt");
CREATE INDEX "WebhookEvent_status_effectNextAttemptAt_createdAt_idx"
  ON "WebhookEvent"("status", "effectNextAttemptAt", "createdAt");
CREATE INDEX "WebhookEvent_claimPhase_claimExpiresAt_idx"
  ON "WebhookEvent"("claimPhase", "claimExpiresAt");
CREATE INDEX "WebhookEvent_ownerKind_routeKey_subjectKind_subjectId_idx"
  ON "WebhookEvent"("ownerKind", "routeKey", "subjectKind", "subjectId");

-- Non-unique classifier lookups. A1b intentionally probes with ambiguity
-- limit two; indexes accelerate the lookup without asserting unsafe legacy
-- uniqueness that has not passed duplicate preflight.
CREATE INDEX "TerminalOrder_stripeCheckoutSessionId_idx"
  ON "TerminalOrder"("stripeCheckoutSessionId");
CREATE INDEX "TokenPurchase_stripeInvoiceId_idx"
  ON "TokenPurchase"("stripeInvoiceId");

CREATE FUNCTION reject_webhook_event_authority_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."ownerKind" IS NOT NULL AND (
    NEW."ownerKind" IS DISTINCT FROM OLD."ownerKind"
    OR NEW."routeKey" IS DISTINCT FROM OLD."routeKey"
    OR NEW."subjectKind" IS DISTINCT FROM OLD."subjectKind"
    OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
  ) THEN
    RAISE EXCEPTION 'WebhookEvent authority tuple is immutable once classified'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_event_authority_immutable
BEFORE UPDATE ON "WebhookEvent"
FOR EACH ROW EXECUTE FUNCTION reject_webhook_event_authority_mutation();

CREATE TABLE "StripeObjectBinding" (
  "objectType" "StripeObjectType" NOT NULL,
  "stripeObjectId" TEXT NOT NULL,
  "ownerKind" "StripeEventOwnerKind" NOT NULL,
  "routeKey" "StripeEventRouteKey" NOT NULL,
  "subjectKind" "StripeEventSubjectKind" NOT NULL,
  "subjectId" TEXT NOT NULL,
  "sourceWebhookEventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  CONSTRAINT "StripeObjectBinding_pkey" PRIMARY KEY ("objectType", "stripeObjectId"),
  CONSTRAINT "StripeObjectBinding_object_id_nonempty_check" CHECK (btrim("stripeObjectId") <> ''),
  CONSTRAINT "StripeObjectBinding_subject_nonempty_check" CHECK (btrim("subjectId") <> ''),
  CONSTRAINT "StripeObjectBinding_authority_matrix_check" CHECK (
    ("ownerKind" = 'COMMERCIAL_V2' AND "routeKey" = 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'COMMERCIAL_ACCEPTANCE')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_PLAN_CHECKOUT' AND "subjectKind" = 'STRIPE_CHECKOUT_ORIGIN')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'VENUE_FEATURE')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TERMINAL_ORDER_CHECKOUT' AND "subjectKind" = 'TERMINAL_ORDER')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_PAYMENT_INTENT' AND "subjectKind" = 'TOKEN_PURCHASE')
    OR ("ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_INVOICE' AND "subjectKind" = 'TOKEN_PURCHASE')
    OR ("ownerKind" = 'LEGACY' AND "routeKey" = 'VENUE_BILLING_PROFILE' AND "subjectKind" = 'VENUE')
  ),
  CONSTRAINT "StripeObjectBinding_object_type_authority_check" CHECK (
    ("ownerKind" = 'COMMERCIAL_V2' AND "routeKey" = 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'COMMERCIAL_ACCEPTANCE')
    OR ("objectType" = 'CHECKOUT_SESSION' AND "ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_PLAN_CHECKOUT' AND "subjectKind" = 'STRIPE_CHECKOUT_ORIGIN')
    OR ("objectType" = 'CHECKOUT_SESSION' AND "ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TERMINAL_ORDER_CHECKOUT' AND "subjectKind" = 'TERMINAL_ORDER')
    OR ("objectType" IN ('SUBSCRIPTION', 'INVOICE', 'PAYMENT_INTENT', 'CHARGE') AND "ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_SUBSCRIPTION_LIFECYCLE' AND "subjectKind" = 'VENUE_FEATURE')
    OR ("objectType" = 'INVOICE' AND "ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_INVOICE' AND "subjectKind" = 'TOKEN_PURCHASE')
    OR ("objectType" = 'PAYMENT_INTENT' AND "ownerKind" = 'INDEPENDENT' AND "routeKey" = 'TOKEN_PAYMENT_INTENT' AND "subjectKind" = 'TOKEN_PURCHASE')
  ),
  CONSTRAINT "StripeObjectBinding_sourceWebhookEventId_fkey"
    FOREIGN KEY ("sourceWebhookEventId") REFERENCES "WebhookEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "StripeObjectBinding_ownerKind_routeKey_subjectKind_subjectId_idx"
  ON "StripeObjectBinding"("ownerKind", "routeKey", "subjectKind", "subjectId");
CREATE INDEX "StripeObjectBinding_sourceWebhookEventId_idx"
  ON "StripeObjectBinding"("sourceWebhookEventId");

CREATE FUNCTION reject_stripe_object_binding_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'StripeObjectBinding is append-only and immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stripe_object_binding_immutable
BEFORE UPDATE OR DELETE ON "StripeObjectBinding"
FOR EACH ROW EXECUTE FUNCTION reject_stripe_object_binding_mutation();

COMMIT;

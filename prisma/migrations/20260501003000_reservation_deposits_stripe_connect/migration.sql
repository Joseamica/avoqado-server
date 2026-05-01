-- Reservation deposits via Stripe Connect.
-- v2.3 spec: Accounts v2/controller-property onboarding, direct-charge deposits,
-- idempotent Connect webhooks, refund lifecycle, and money anomaly tracking.

-- Enums
CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'RESTRICTED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "DepositStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "DepositStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- EcommerceMerchant: provider-agnostic Connect/onboarding state.
ALTER TABLE "EcommerceMerchant"
  ADD COLUMN "providerMerchantId" TEXT,
  ADD COLUMN "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requirementsDue" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "onboardingLinkUrl" TEXT,
  ADD COLUMN "onboardingLinkExpiry" TIMESTAMP(3),
  ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "reserveBps" INTEGER,
  ADD COLUMN "offboardingInitiatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "EcommerceMerchant_providerId_providerMerchantId_key"
  ON "EcommerceMerchant"("providerId", "providerMerchantId");

CREATE INDEX "EcommerceMerchant_onboardingStatus_idx"
  ON "EcommerceMerchant"("onboardingStatus");

-- Reservation: Checkout/direct-charge state and independent refund lifecycle.
ALTER TABLE "Reservation"
  ADD COLUMN "checkoutSessionId" TEXT,
  ADD COLUMN "depositExpiresAt" TIMESTAMP(3),
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "refundStatus" "RefundStatus",
  ADD COLUMN "refundRequestedAt" TIMESTAMP(3),
  ADD COLUMN "refundProcessorRef" TEXT,
  ADD COLUMN "refundFailedReason" TEXT,
  ADD COLUMN "refundRetryCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Reservation_idempotencyKey_key"
  ON "Reservation"("idempotencyKey");

CREATE INDEX "Reservation_depositStatus_depositExpiresAt_idx"
  ON "Reservation"("depositStatus", "depositExpiresAt");

CREATE INDEX "Reservation_refundStatus_refundRequestedAt_idx"
  ON "Reservation"("refundStatus", "refundRequestedAt");

-- Existing field semantics change from hours to minutes. Keep bounded values explicit.
UPDATE "ReservationSettings"
SET "depositPaymentWindow" = "depositPaymentWindow" * 60
WHERE "depositPaymentWindow" IS NOT NULL
  AND "depositPaymentWindow" BETWEEN 1 AND 24;

-- Connect webhook event idempotency.
CREATE TABLE "ProcessedStripeEvent" (
  "id" TEXT NOT NULL,
  "stripeEventId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "account" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,

  CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessedStripeEvent_endpoint_stripeEventId_key"
  ON "ProcessedStripeEvent"("endpoint", "stripeEventId");

CREATE INDEX "ProcessedStripeEvent_eventType_processedAt_idx"
  ON "ProcessedStripeEvent"("eventType", "processedAt");

CREATE INDEX "ProcessedStripeEvent_account_idx"
  ON "ProcessedStripeEvent"("account");

-- Money anomalies that need human reconciliation.
CREATE TABLE "MoneyAnomaly" (
  "id" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "category" TEXT NOT NULL,
  "reservationId" TEXT,
  "stripeEventId" TEXT,
  "expectedState" JSONB NOT NULL,
  "observedState" JSONB NOT NULL,
  "resolution" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,

  CONSTRAINT "MoneyAnomaly_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MoneyAnomaly_stripeEventId_category_key"
  ON "MoneyAnomaly"("stripeEventId", "category");

CREATE INDEX "MoneyAnomaly_category_resolvedAt_idx"
  ON "MoneyAnomaly"("category", "resolvedAt");

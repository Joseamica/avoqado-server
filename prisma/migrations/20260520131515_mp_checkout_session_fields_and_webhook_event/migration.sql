-- Phase 3 of Mercado Pago marketplace integration (plan v3).
--
-- 1. Add MP-specific columns to CheckoutSession (for tracking preference, payment, and
--    merchant_order IDs returned by MP). All optional — only populated for sessions
--    where ecommerceMerchant.provider.code = 'MERCADO_PAGO'.
--
-- 2. Create MercadoPagoWebhookEvent dedupe table. The unique constraint on
--    (mpUserId, dataId, requestId) makes "have we processed this delivery?" an
--    O(1) atomic check via INSERT — P2002 unique violation = duplicate, skip.

-- ============================================================================
-- 1. CheckoutSession: add MP fields + indexes
-- ============================================================================

ALTER TABLE "CheckoutSession"
  ADD COLUMN "mpPreferenceId"    TEXT,
  ADD COLUMN "mpPaymentId"       TEXT,
  ADD COLUMN "mpMerchantOrderId" TEXT;

-- Unique constraints (one preference / payment maps to at most one CheckoutSession)
CREATE UNIQUE INDEX "CheckoutSession_mpPreferenceId_key" ON "CheckoutSession"("mpPreferenceId");
CREATE UNIQUE INDEX "CheckoutSession_mpPaymentId_key"    ON "CheckoutSession"("mpPaymentId");

-- Lookup index for merchant_order (NOT unique — one merchant_order can have
-- multiple payment attempts, all pointing to the same parent CheckoutSession)
CREATE INDEX "CheckoutSession_mpMerchantOrderId_idx" ON "CheckoutSession"("mpMerchantOrderId");

-- ============================================================================
-- 2. MercadoPagoWebhookEvent dedupe table
-- ============================================================================

CREATE TABLE "MercadoPagoWebhookEvent" (
    "id"               TEXT NOT NULL,
    "mpUserId"         TEXT NOT NULL,
    "dataId"           TEXT NOT NULL,
    "requestId"        TEXT NOT NULL,
    "eventType"        TEXT NOT NULL,
    "action"           TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "processingStatus" TEXT NOT NULL,
    "errorMessage"     TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercadoPagoWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- The unique constraint that powers our dedupe check at insert time.
CREATE UNIQUE INDEX "MercadoPagoWebhookEvent_mpUserId_dataId_requestId_key"
  ON "MercadoPagoWebhookEvent"("mpUserId", "dataId", "requestId");

-- Supporting indexes for forensics + cleanup
CREATE INDEX "MercadoPagoWebhookEvent_dataId_idx"    ON "MercadoPagoWebhookEvent"("dataId");
CREATE INDEX "MercadoPagoWebhookEvent_createdAt_idx" ON "MercadoPagoWebhookEvent"("createdAt");

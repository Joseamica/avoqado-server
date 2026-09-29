-- CreateTable
CREATE TABLE "HybridPurchase" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "quotedById" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "quoteHash" TEXT NOT NULL,
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "clientKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "acceptedAt" TIMESTAMP(3),
    "paymentExpiresAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "initialInvoiceId" TEXT,
    "lastIssue" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HybridContract" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeItemId" TEXT NOT NULL,
    "featureCodes" TEXT[],
    "planTier" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "paidThrough" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "cancelAt" TIMESTAMP(3),
    "pendingFeatureCodes" JSONB,
    "pendingEffectiveAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HybridBillingOperation" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerId" TEXT,
    "lastIssue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridBillingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HybridRedemption" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HybridPaymentPeriod" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "fundedAmount" DECIMAL(12,2) NOT NULL,
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "composition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridPaymentPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HybridCreditAllocation" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "sourceInvoiceId" TEXT NOT NULL,
    "sourceSubscriptionId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HybridCreditAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HybridPurchase_stripeSubscriptionId_key" ON "HybridPurchase"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "HybridPurchase_initialInvoiceId_key" ON "HybridPurchase"("initialInvoiceId");

-- CreateIndex
CREATE INDEX "HybridPurchase_venueId_createdAt_id_idx" ON "HybridPurchase"("venueId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "HybridPurchase_status_nextAttemptAt_id_idx" ON "HybridPurchase"("status", "nextAttemptAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HybridPurchase_venueId_clientKey_key" ON "HybridPurchase"("venueId", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "HybridContract_stripeItemId_key" ON "HybridContract"("stripeItemId");

-- CreateIndex
CREATE INDEX "HybridContract_venueId_endedAt_createdAt_id_idx" ON "HybridContract"("venueId", "endedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "HybridContract_stripeSubscriptionId_idx" ON "HybridContract"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "HybridContract_purchaseId_publicationId_key" ON "HybridContract"("purchaseId", "publicationId");

-- CreateIndex
CREATE UNIQUE INDEX "HybridBillingOperation_purchaseId_step_key" ON "HybridBillingOperation"("purchaseId", "step");

-- CreateIndex
CREATE INDEX "HybridRedemption_purchaseId_idx" ON "HybridRedemption"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "HybridRedemption_campaignId_organizationId_key" ON "HybridRedemption"("campaignId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "HybridPaymentPeriod_stripeInvoiceId_key" ON "HybridPaymentPeriod"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "HybridPaymentPeriod_venueId_stripeSubscriptionId_endsAt_idx" ON "HybridPaymentPeriod"("venueId", "stripeSubscriptionId", "endsAt");

-- CreateIndex
CREATE INDEX "HybridCreditAllocation_sourceInvoiceId_status_idx" ON "HybridCreditAllocation"("sourceInvoiceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HybridCreditAllocation_purchaseId_sourceInvoiceId_key" ON "HybridCreditAllocation"("purchaseId", "sourceInvoiceId");

-- CreateIndex
CREATE INDEX "HybridCampaign_createdAt_id_idx" ON "HybridCampaign"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "HybridPurchase" ADD CONSTRAINT "HybridPurchase_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridContract" ADD CONSTRAINT "HybridContract_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridContract" ADD CONSTRAINT "HybridContract_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "HybridPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridContract" ADD CONSTRAINT "HybridContract_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "HybridOfferPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridBillingOperation" ADD CONSTRAINT "HybridBillingOperation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "HybridPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridRedemption" ADD CONSTRAINT "HybridRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "HybridCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridRedemption" ADD CONSTRAINT "HybridRedemption_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "HybridPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridPaymentPeriod" ADD CONSTRAINT "HybridPaymentPeriod_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HybridCreditAllocation" ADD CONSTRAINT "HybridCreditAllocation_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "HybridPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An expired lease is not evidence that Stripe did not receive the request.
CREATE UNIQUE INDEX "HybridPurchase_one_pending_per_venue" ON "HybridPurchase" ("venueId")
WHERE "status" IN ('ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING', 'PAID', 'DELIVERING', 'REQUIRES_REVIEW');
ALTER TABLE "HybridPurchase" ADD CONSTRAINT "HybridPurchase_status_check" CHECK ("status" IN ('QUOTED', 'ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING', 'PAID', 'DELIVERING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REQUIRES_REVIEW'));
ALTER TABLE "HybridBillingOperation" ADD CONSTRAINT "HybridBillingOperation_status_check" CHECK ("status" IN ('PENDING', 'OBSERVED', 'UNKNOWN', 'REJECTED'));
ALTER TABLE "HybridRedemption" ADD CONSTRAINT "HybridRedemption_status_check" CHECK ("status" IN ('RESERVED', 'REDEEMED', 'RELEASED'));
ALTER TABLE "HybridPaymentPeriod" ADD CONSTRAINT "HybridPaymentPeriod_value_check" CHECK ("fundedAmount" >= 0 AND "refundedAmount" >= 0 AND "endsAt" > "startsAt");
ALTER TABLE "HybridCreditAllocation" ADD CONSTRAINT "HybridCreditAllocation_value_check" CHECK ("amount" > 0 AND "status" IN ('RESERVED', 'CONSUMED', 'RELEASED'));

CREATE FUNCTION "hybrid_purchase_immutable_quote"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW."venueId", NEW."quotedById", NEW."quote", NEW."quoteHash", NEW."quoteExpiresAt", NEW."createdAt") IS DISTINCT FROM ROW(OLD."venueId", OLD."quotedById", OLD."quote", OLD."quoteHash", OLD."quoteExpiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'Hybrid purchase quote is immutable';
  END IF;
  IF (OLD."clientKey" IS NOT NULL AND NEW."clientKey" IS DISTINCT FROM OLD."clientKey") OR
     (OLD."stripeSubscriptionId" IS NOT NULL AND NEW."stripeSubscriptionId" IS DISTINCT FROM OLD."stripeSubscriptionId") OR
     (OLD."initialInvoiceId" IS NOT NULL AND NEW."initialInvoiceId" IS DISTINCT FROM OLD."initialInvoiceId") OR
     (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt") THEN
    RAISE EXCEPTION 'Hybrid purchase identity is immutable';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'EXPIRED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Hybrid purchase terminal state is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HybridPurchase_immutable_quote" BEFORE UPDATE OR DELETE ON "HybridPurchase" FOR EACH ROW EXECUTE FUNCTION "hybrid_purchase_immutable_quote"();

CREATE FUNCTION "hybrid_operation_immutable_request"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW."purchaseId", NEW."step", NEW."request", NEW."requestHash", NEW."createdAt") IS DISTINCT FROM ROW(OLD."purchaseId", OLD."step", OLD."request", OLD."requestHash", OLD."createdAt") OR
     (OLD."providerId" IS NOT NULL AND NEW."providerId" IS DISTINCT FROM OLD."providerId") THEN
    RAISE EXCEPTION 'Hybrid provider operation is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HybridBillingOperation_immutable_request" BEFORE UPDATE OR DELETE ON "HybridBillingOperation" FOR EACH ROW EXECUTE FUNCTION "hybrid_operation_immutable_request"();

-- Serialize starting a provider mutation against abandoning the same intent.
CREATE FUNCTION "hybrid_operation_requires_accepted_intent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_status TEXT;
BEGIN
  SELECT "status" INTO purchase_status FROM "HybridPurchase" WHERE "id" = NEW."purchaseId" FOR UPDATE;
  IF purchase_status IS NULL OR purchase_status IN ('QUOTED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Hybrid purchase is closed or not accepted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "HybridBillingOperation_accepted_intent" BEFORE INSERT ON "HybridBillingOperation" FOR EACH ROW EXECUTE FUNCTION "hybrid_operation_requires_accepted_intent"();

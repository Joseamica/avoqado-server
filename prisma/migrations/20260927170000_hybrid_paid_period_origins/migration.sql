ALTER TABLE "CapabilityGrant" ADD COLUMN "contractId" TEXT, ADD COLUMN "paymentPeriodId" TEXT;
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "HybridContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_paymentPeriodId_fkey" FOREIGN KEY ("paymentPeriodId") REFERENCES "HybridPaymentPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "CapabilityGrant_contractId_idx" ON "CapabilityGrant"("contractId");
CREATE INDEX "CapabilityGrant_paymentPeriodId_idx" ON "CapabilityGrant"("paymentPeriodId");
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_paid_origin_pair" CHECK (("contractId" IS NULL) = ("paymentPeriodId" IS NULL));
CREATE FUNCTION hybrid_grant_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contractId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "HybridContract" c JOIN "HybridPaymentPeriod" p ON p."stripeSubscriptionId" = c."stripeSubscriptionId"
    WHERE c.id = NEW."contractId" AND p.id = NEW."paymentPeriodId" AND c."venueId" = NEW."venueId" AND p."venueId" = NEW."venueId"
      AND NEW."startsAt" >= p."startsAt" AND NEW."endsAt" <= p."endsAt"
  ) THEN RAISE EXCEPTION 'CapabilityGrant paid origin mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hybrid_grant_origin_guard BEFORE INSERT OR UPDATE ON "CapabilityGrant" FOR EACH ROW EXECUTE FUNCTION hybrid_grant_origin_guard();
CREATE FUNCTION hybrid_period_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."venueId" IS DISTINCT FROM OLD."venueId" OR NEW."stripeSubscriptionId" IS DISTINCT FROM OLD."stripeSubscriptionId"
     OR NEW."stripeInvoiceId" IS DISTINCT FROM OLD."stripeInvoiceId" OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
     OR NEW."endsAt" IS DISTINCT FROM OLD."endsAt" OR NEW.composition IS DISTINCT FROM OLD.composition
  THEN RAISE EXCEPTION 'HybridPaymentPeriod composition is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hybrid_period_immutable_guard BEFORE UPDATE ON "HybridPaymentPeriod" FOR EACH ROW EXECUTE FUNCTION hybrid_period_immutable_guard();

-- P3-1A0 durable Stripe checkout origin. Expand-only: no legacy metadata backfill.
CREATE TYPE "StripeEventOwnerKind" AS ENUM ('LEGACY');
CREATE TYPE "StripeEventRouteKey" AS ENUM ('LEGACY_PLAN_CHECKOUT');
CREATE TYPE "StripeCheckoutBillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

CREATE TABLE "StripeCheckoutOrigin" (
  "stripeCheckoutSessionId" TEXT NOT NULL,
  "ownerKind" "StripeEventOwnerKind" NOT NULL,
  "routeKey" "StripeEventRouteKey" NOT NULL,
  "venueId" TEXT NOT NULL,
  "featureId" TEXT NOT NULL,
  "stripeCustomerId" TEXT NOT NULL,
  "billingInterval" "StripeCheckoutBillingInterval" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeCheckoutOrigin_pkey" PRIMARY KEY ("stripeCheckoutSessionId"),
  CONSTRAINT "StripeCheckoutOrigin_owner_route_check" CHECK (
    "ownerKind" = 'LEGACY' AND "routeKey" = 'LEGACY_PLAN_CHECKOUT'
  )
);

CREATE INDEX "StripeCheckoutOrigin_venueId_createdAt_idx" ON "StripeCheckoutOrigin"("venueId", "createdAt");
CREATE INDEX "StripeCheckoutOrigin_featureId_idx" ON "StripeCheckoutOrigin"("featureId");
CREATE INDEX "StripeCheckoutOrigin_stripeCustomerId_idx" ON "StripeCheckoutOrigin"("stripeCustomerId");

ALTER TABLE "StripeCheckoutOrigin"
  ADD CONSTRAINT "StripeCheckoutOrigin_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StripeCheckoutOrigin"
  ADD CONSTRAINT "StripeCheckoutOrigin_featureId_fkey"
  FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_stripe_checkout_origin_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'StripeCheckoutOrigin is immutable; create a new origin row'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER stripe_checkout_origin_immutable
BEFORE UPDATE OR DELETE ON "StripeCheckoutOrigin"
FOR EACH ROW EXECUTE FUNCTION reject_stripe_checkout_origin_mutation();

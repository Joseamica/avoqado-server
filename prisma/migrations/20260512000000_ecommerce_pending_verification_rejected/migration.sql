-- Add new OnboardingStatus enum values for Stripe Connect transitional states.
-- PENDING_VERIFICATION: Stripe is manually reviewing the submitted documents
-- (typically 1-5 business days). User can't act — must wait.
-- REJECTED: Stripe rejected the connected account (fraud, prohibited business).
-- Terminal failure — needs support intervention.

ALTER TYPE "OnboardingStatus" ADD VALUE IF NOT EXISTS 'PENDING_VERIFICATION';
ALTER TYPE "OnboardingStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- Persist Stripe's `requirements.disabled_reason` verbatim so list views can
-- render distinct UI without re-fetching from Stripe every render.
ALTER TABLE "EcommerceMerchant" ADD COLUMN IF NOT EXISTS "disabledReason" TEXT;

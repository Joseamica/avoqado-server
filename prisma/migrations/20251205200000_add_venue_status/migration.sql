-- Migration: Add VenueStatus enum and fields
-- Purpose: Replace boolean 'active' with proper status enum for Mexican regulatory compliance
-- Mexican law requires data retention - venues cannot be hard deleted

-- Step 1: Create the VenueStatus enum
CREATE TYPE "VenueStatus" AS ENUM (
  'ONBOARDING',        -- In initial setup process
  'TRIAL',             -- 30-day demo trial (replaces isOnboardingDemo)
  'PENDING_ACTIVATION',-- KYC submitted, awaiting approval
  'ACTIVE',            -- Fully operational venue
  'SUSPENDED',         -- Suspended by venue owner (voluntary)
  'ADMIN_SUSPENDED',   -- Suspended by Avoqado (non-payment, policy)
  'CLOSED'             -- Permanently closed (data retained for audit)
);

-- Step 2: Add new columns to Venue table
ALTER TABLE "Venue"
ADD COLUMN "status" "VenueStatus" NOT NULL DEFAULT 'ONBOARDING',
ADD COLUMN "statusChangedAt" TIMESTAMP(3),
ADD COLUMN "statusChangedBy" TEXT,
ADD COLUMN "suspensionReason" TEXT;

-- Step 3: Data migration - Set initial status based on existing fields
-- Priority order:
--   1. isLiveDemo = true → ACTIVE (live demos are operational)
--   2. isOnboardingDemo = true → TRIAL
--   3. active = false → SUSPENDED
--   4. kycStatus = 'VERIFIED' and active = true → ACTIVE
--   5. kycStatus = 'PENDING_REVIEW' and active = true → PENDING_ACTIVATION
--   6. Everything else → ONBOARDING
UPDATE "Venue"
SET "status" = CASE
  WHEN "isLiveDemo" = true THEN 'ACTIVE'::"VenueStatus"
  WHEN "isOnboardingDemo" = true THEN 'TRIAL'::"VenueStatus"
  WHEN "active" = false THEN 'SUSPENDED'::"VenueStatus"
  WHEN "kycStatus" = 'VERIFIED' AND "active" = true THEN 'ACTIVE'::"VenueStatus"
  WHEN "kycStatus" = 'PENDING_REVIEW' AND "active" = true THEN 'PENDING_ACTIVATION'::"VenueStatus"
  WHEN "kycStatus" = 'IN_REVIEW' AND "active" = true THEN 'PENDING_ACTIVATION'::"VenueStatus"
  ELSE 'ONBOARDING'::"VenueStatus"
END,
"statusChangedAt" = NOW();

-- Step 4: Create index for efficient filtering
CREATE INDEX "Venue_status_idx" ON "Venue"("status");

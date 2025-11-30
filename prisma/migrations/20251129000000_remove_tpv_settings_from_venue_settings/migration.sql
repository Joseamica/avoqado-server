-- Migration: Remove TPV Settings from VenueSettings
-- TPV settings are now stored per-terminal in Terminal.config.settings
-- Data was migrated using: scripts/migrate-tpv-settings-to-terminal.ts

-- Drop TPV columns from VenueSettings table
ALTER TABLE "VenueSettings" DROP COLUMN IF EXISTS "tpvShowReviewScreen";
ALTER TABLE "VenueSettings" DROP COLUMN IF EXISTS "tpvShowTipScreen";
ALTER TABLE "VenueSettings" DROP COLUMN IF EXISTS "tpvShowReceiptScreen";
ALTER TABLE "VenueSettings" DROP COLUMN IF EXISTS "tpvDefaultTipPercentage";

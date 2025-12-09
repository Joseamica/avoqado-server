-- DropColumn: Remove deprecated isOnboardingDemo field
-- This field has been replaced by status = 'TRIAL'
ALTER TABLE "Venue" DROP COLUMN IF EXISTS "isOnboardingDemo";

-- DropColumn: Remove deprecated isLiveDemo field
-- This field has been replaced by status = 'LIVE_DEMO'
ALTER TABLE "Venue" DROP COLUMN IF EXISTS "isLiveDemo";

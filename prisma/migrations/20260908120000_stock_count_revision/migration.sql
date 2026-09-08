-- Optimistic revision for the StockCount aggregate. Every accepted PUT and
-- cancellation advances it once; confirmation advances it only at COMPLETED.
-- Existing rows start at revision zero so released clients can keep omitting
-- the additive expectedRevision precondition.
ALTER TABLE "StockCount"
ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;

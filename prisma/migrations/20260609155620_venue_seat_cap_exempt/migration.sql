-- AlterTable
-- Add the Free-plan seat-cap grandfathering flag. New rows default to false (enforced).
ALTER TABLE "public"."Venue" ADD COLUMN     "seatCapExempt" BOOLEAN NOT NULL DEFAULT false;

-- Grandfather every venue that EXISTS at rollout: exempt forever from the Free-tier
-- seat cap. This is what protects the legacy venues already over 2 users from breaking.
-- Runs once, against existing rows only; new venues inserted after this migration keep
-- the column default of false (enforced).
UPDATE "public"."Venue" SET "seatCapExempt" = true;

-- PR-2 · Per-venue rollout flag for roster-based cost/routing resolution.
-- Additive + default false → every existing venue keeps TODAY's behavior (resolve
-- via the 3 legacy slots). Flipped to true per-venue ONLY after the recompute-diff
-- gate passes for that venue. Internal migration state, NOT a paid-tier gate.
-- Boolean column with a constant default is a metadata-only change in PostgreSQL
-- (no full-table rewrite / no long lock).

-- AlterTable
ALTER TABLE "public"."VenuePaymentConfig" ADD COLUMN     "rosterRolloutEnabled" BOOLEAN NOT NULL DEFAULT false;

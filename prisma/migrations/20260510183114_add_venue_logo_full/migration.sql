-- Adds the wide / horizontal "full" logo URL on Venue for marketing surfaces
-- (public booking page header, etc). The existing `logo` field remains the
-- small square logo used for receipts/avatars. Additive, default null.
ALTER TABLE "public"."Venue" ADD COLUMN "logoFull" TEXT;

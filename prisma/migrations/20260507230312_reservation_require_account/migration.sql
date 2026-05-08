-- Adds optional account-required gate for public booking. Default false keeps
-- existing venues anonymous-friendly; admins flip per-venue when needed.
ALTER TABLE "public"."ReservationSettings"
  ADD COLUMN "requireAccount" BOOLEAN NOT NULL DEFAULT false;

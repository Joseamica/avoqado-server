-- Multi-AngelPay accounts per venue (2026-05-18).
--
-- Goal: allow a venue to register multiple AngelPay logins (one per AngelPay
-- merchant when the venue runs several merchants under different emails).
-- Uniqueness moves from (venueId) to (venueId, email) so the same email can
-- still not appear twice in the same venue.
--
-- Also adds MerchantAccount.angelpayUserAccountId so the TPV can route the
-- merchant picker back to "which AngelPay login owns this merchant?" via the
-- new `switchAccount(accountId)` flow.

-- 1. Drop the old single-account unique constraint on AngelPayUserAccount.venueId.
ALTER TABLE "public"."AngelPayUserAccount" DROP CONSTRAINT IF EXISTS "AngelPayUserAccount_venueId_key";
DROP INDEX IF EXISTS "public"."AngelPayUserAccount_venueId_key";

-- 2. Create the new compound uniqueness constraint on (venueId, email).
--    Same email can't appear twice in the same venue, but a venue can register
--    multiple distinct emails.
CREATE UNIQUE INDEX "AngelPayUserAccount_venueId_email_key"
  ON "public"."AngelPayUserAccount"("venueId", "email");

-- 3. Plain index on venueId (no longer covered by the unique constraint) so
--    list-by-venue queries stay fast.
CREATE INDEX "AngelPayUserAccount_venueId_idx" ON "public"."AngelPayUserAccount"("venueId");

-- 4. Add MerchantAccount.angelpayUserAccountId — nullable FK to AngelPayUserAccount.
--    ON DELETE SET NULL so soft-deleting an AngelPay account doesn't break the
--    merchant routing (merchants stay routable, just lose the back-link).
ALTER TABLE "public"."MerchantAccount" ADD COLUMN "angelpayUserAccountId" TEXT;
ALTER TABLE "public"."MerchantAccount"
  ADD CONSTRAINT "MerchantAccount_angelpayUserAccountId_fkey"
  FOREIGN KEY ("angelpayUserAccountId")
  REFERENCES "public"."AngelPayUserAccount"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "MerchantAccount_angelpayUserAccountId_idx"
  ON "public"."MerchantAccount"("angelpayUserAccountId");

-- 5. Backfill — for every existing AngelPay MerchantAccount that's assigned to
--    a VenuePaymentConfig slot in a venue with exactly one AngelPayUserAccount,
--    set angelpayUserAccountId to that account's id.
--
--    Rationale: pre-multi-account, every venue had at most one AngelPay account
--    so the link is unambiguous. Venues with multiple accounts post-migration
--    (none today, but possible via the new dashboard flow) get null and admin
--    must re-attribute manually OR the next discovery run lazily back-fills
--    via `upsertDiscoveredAngelPayMerchants` (which now sets the FK when called
--    with `angelpayUserAccountId`).
WITH angelpay_provider AS (
  SELECT "id" FROM "public"."PaymentProvider" WHERE "code" = 'ANGELPAY' LIMIT 1
),
single_account_venues AS (
  SELECT "venueId", MIN("id") AS "accountId"
  FROM "public"."AngelPayUserAccount"
  WHERE "status" != 'DELETED'
  GROUP BY "venueId"
  HAVING COUNT(*) = 1
),
slot_assignments AS (
  SELECT vpc."venueId", vpc."primaryAccountId"   AS "merchantId" FROM "public"."VenuePaymentConfig" vpc WHERE vpc."primaryAccountId"   IS NOT NULL
  UNION
  SELECT vpc."venueId", vpc."secondaryAccountId" AS "merchantId" FROM "public"."VenuePaymentConfig" vpc WHERE vpc."secondaryAccountId" IS NOT NULL
  UNION
  SELECT vpc."venueId", vpc."tertiaryAccountId"  AS "merchantId" FROM "public"."VenuePaymentConfig" vpc WHERE vpc."tertiaryAccountId"  IS NOT NULL
)
-- NOTE: Postgres forbids referencing the UPDATE target (`ma`) in a JOIN of the
-- FROM clause, so we bring `angelpay_provider` in via CROSS JOIN (the CTE
-- returns at most one row) and match `ma."providerId" = ap."id"` in WHERE.
UPDATE "public"."MerchantAccount" ma
SET "angelpayUserAccountId" = sav."accountId"
FROM slot_assignments sa
JOIN single_account_venues sav ON sav."venueId" = sa."venueId"
CROSS JOIN angelpay_provider ap
WHERE ma."id" = sa."merchantId"
  AND ma."providerId" = ap."id"
  AND ma."angelpayUserAccountId" IS NULL;

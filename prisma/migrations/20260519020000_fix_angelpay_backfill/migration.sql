-- Fix for migration 20260518203901_multi_angelpay_per_venue (2026-05-19).
--
-- The original backfill UPDATE contained `JOIN angelpay_provider ap ON
-- ap."id" = ma."providerId"` — Postgres rejects this because in
-- UPDATE...FROM, the target table alias (`ma`) cannot be referenced inside
-- JOIN ON clauses, only inside WHERE. The original migration's DDL portion
-- (constraint changes + FK column) committed successfully, but the backfill
-- silently failed, leaving `MerchantAccount.angelpayUserAccountId` NULL for
-- every pre-existing AngelPay merchant.
--
-- This fix-up migration re-runs the backfill with the provider filter
-- expressed as a subquery in WHERE (no JOIN against `ma`'s providerId).
-- It is idempotent: rows already backfilled (e.g., by manual UPDATE in dev)
-- have `angelpayUserAccountId IS NULL` filtered out, so re-applying is a no-op.

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
UPDATE "public"."MerchantAccount" ma
SET "angelpayUserAccountId" = sav."accountId"
FROM slot_assignments sa
JOIN single_account_venues sav ON sav."venueId" = sa."venueId"
WHERE ma."id" = sa."merchantId"
  AND ma."providerId" IN (SELECT "id" FROM angelpay_provider)
  AND ma."angelpayUserAccountId" IS NULL;

-- Multi-AngelPay accounts per venue (2026-05-19)
--
-- Allow MULTIPLE `MerchantAccount` rows to share the same
-- `(providerId, externalMerchantId)` pair when they belong to different
-- AngelPay user accounts. Without this, two AngelPay logins (e.g.
-- ventas@avoqado.io and contacto@avoqado.io) that both have access to the
-- same physical merchant (e.g. afiliación 9814275) cannot each have their
-- own routing row — the second one's reserved slot would either fail to
-- upsert or collapse into the first via the prior orphan-cleanup workaround
-- (introduced 2026-05-19, now removed).
--
-- Effect on Blumon: Blumon `MerchantAccount` rows have
-- `angelpayUserAccountId = NULL`. Postgres unique constraints treat NULL as
-- distinct, so technically duplicate `(providerId, externalMerchantId,
-- NULL)` tuples are allowed. In practice Blumon code never tries to insert
-- duplicate externalMerchantIds (Blumon assigns globally unique merchant
-- IDs per affiliation), so the relaxation is benign. If a stricter
-- guarantee becomes necessary, add a partial unique index later:
--   CREATE UNIQUE INDEX "MerchantAccount_blumon_unique"
--   ON "MerchantAccount" ("providerId", "externalMerchantId")
--   WHERE "angelpayUserAccountId" IS NULL;

-- Prisma created the old uniqueness as a UNIQUE INDEX (not a CONSTRAINT),
-- so we DROP INDEX rather than DROP CONSTRAINT. IF EXISTS keeps this
-- migration idempotent in case it was partially applied previously.
DROP INDEX IF EXISTS "MerchantAccount_providerId_externalMerchantId_key";

CREATE UNIQUE INDEX "MerchantAccount_providerId_externalMerchantId_angelpayUserAccountId_key"
  ON "MerchantAccount" ("providerId", "externalMerchantId", "angelpayUserAccountId");

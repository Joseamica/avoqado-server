-- Data-only backfill: no schema changes here, only INSERTs.
--
-- IDs en formato cuid-compatible (25 chars, prefijo 'c') per regla del repo
-- (CLAUDE.md "Production Data Inserts: IDs MUST be cuid format"). En SQL puro no
-- hay cuid v1 real; 'c' + 24 hex de md5(uuid) respeta el formato del catálogo.
-- a. 3 ReferralTierReward por config desde los campos planos
INSERT INTO "ReferralTierReward" ("id","configId","tierLevel","rewardType","recurrence","rewardPercent","rewardQuantity","active","createdAt","updatedAt")
SELECT 'c' || substr(md5(gen_random_uuid()::text), 1, 24), c."id", lvl.n, 'PERCENT_COUPON', 'ONE_TIME',
       CASE lvl.n WHEN 1 THEN c."tier1RewardPercent" WHEN 2 THEN c."tier2RewardPercent" ELSE c."tier3RewardPercent" END,
       1, true, now(), now()
FROM "ReferralProgramConfig" c CROSS JOIN (VALUES (1),(2),(3)) AS lvl(n);

-- c. ReferralTierUnlock para TODOS los niveles ya alcanzados (TIER_3 => 1,2,3)
INSERT INTO "ReferralTierUnlock" ("id","customerId","tierLevel","unlockedAt")
SELECT 'c' || substr(md5(gen_random_uuid()::text), 1, 24), cu."id", lvl.n, now()
FROM "Customer" cu CROSS JOIN (VALUES (1),(2),(3)) AS lvl(n)
WHERE cu."referralTier" IS NOT NULL
  AND lvl.n <= CASE cu."referralTier" WHEN 'TIER_1' THEN 1 WHEN 'TIER_2' THEN 2 WHEN 'TIER_3' THEN 3 ELSE 0 END;

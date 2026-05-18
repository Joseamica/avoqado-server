-- Normalize Terminal.brand to canonical values: PAX | NEXGO | INGENICO | VERIFONE
-- Any unknown brand is preserved as-is (and surfaces in app logs for manual cleanup).
-- Dev DB had 0 Terminal rows at write time; this migration is a forward-fix for
-- sandbox/production datasets that may have free-text values.

UPDATE "Terminal" SET "brand" = 'PAX'        WHERE LOWER(TRIM("brand")) IN ('pax', 'pax mobile', 'paxa910s', 'pax a910s', 'pax a80', 'pax a90');
UPDATE "Terminal" SET "brand" = 'NEXGO'      WHERE LOWER(TRIM("brand")) IN ('nexgo', 'nexgo n86', 'nexgo n62', 'n86', 'n62');
UPDATE "Terminal" SET "brand" = 'INGENICO'   WHERE LOWER(TRIM("brand")) IN ('ingenico');
UPDATE "Terminal" SET "brand" = 'VERIFONE'   WHERE LOWER(TRIM("brand")) IN ('verifone');

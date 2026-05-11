-- Denormalize latest health score onto Terminal so the org dashboard can
-- sort by Salud without aggregating a to-many relation (Prisma orderBy does
-- not support _max on healthMetrics for findMany).

ALTER TABLE "Terminal"
  ADD COLUMN "latestHealthScore" INTEGER,
  ADD COLUMN "latestHealthAt" TIMESTAMP(3);

-- Backfill from the most recent TerminalHealth row per terminal
UPDATE "Terminal" t
SET "latestHealthScore" = hm."healthScore",
    "latestHealthAt"    = hm."createdAt"
FROM (
  SELECT DISTINCT ON ("terminalId") "terminalId", "healthScore", "createdAt"
  FROM "TerminalHealth"
  ORDER BY "terminalId", "createdAt" DESC
) hm
WHERE hm."terminalId" = t."id";

CREATE INDEX "Terminal_latestHealthScore_idx" ON "Terminal" ("latestHealthScore");

-- Fence monotónico por dispositivo para el reducer offline.
--
-- Builds anteriores trataban seq como informativa y pudieron dejar duplicados.
-- Conservar el primero y volver NULL los posteriores es seguro: el UUID de
-- idempotencia y el ACK permanecen intactos; sólo se retira del fence el dato
-- histórico ambiguo. PostgreSQL permite múltiples NULL en un UNIQUE.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "venueId", "deviceId", "seq"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number
  FROM "PosSyncIntent"
  WHERE "seq" IS NOT NULL
)
UPDATE "PosSyncIntent" AS intent
SET "seq" = NULL
FROM ranked
WHERE intent."id" = ranked."id"
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX "PosSyncIntent_venueId_deviceId_seq_key"
ON "PosSyncIntent"("venueId", "deviceId", "seq");

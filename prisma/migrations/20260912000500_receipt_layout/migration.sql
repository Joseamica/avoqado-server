-- Diseñador de tickets, Fase 1: la receta del ticket en papel por venue (spec § 7.1).
--
-- ADITIVA e IDEMPOTENTE: crea una tabla nueva y no toca ninguna existente.
-- SIN migración de DATOS: nadie recibe fila. Sin fila, el servidor sirve la canónica, así
-- que desplegar esto no cambia lo que imprime ningún negocio.

CREATE TABLE IF NOT EXISTS "ReceiptLayout" (
    "id"            TEXT NOT NULL,
    "venueId"       TEXT NOT NULL,
    "blocks"        JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "revision"      INTEGER NOT NULL DEFAULT 1,
    "updatedById"   TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceiptLayout_pkey" PRIMARY KEY ("id")
);

-- 🔴 Una fila por venue. Éste es el candado que hace imposible que dos `create` simultáneos
-- produzcan dos recetas: el perdedor recibe P2002 y el servicio lo traduce a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptLayout_venueId_key" ON "ReceiptLayout"("venueId");
CREATE INDEX IF NOT EXISTS "ReceiptLayout_venueId_idx" ON "ReceiptLayout"("venueId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReceiptLayout_venueId_fkey') THEN
        ALTER TABLE "ReceiptLayout"
            ADD CONSTRAINT "ReceiptLayout_venueId_fkey"
            FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

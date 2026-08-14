-- Llave de idempotencia del POS para los eventos del cajón.
-- Las apps mandan el lote a /sync fire-and-forget y sin cola de reintento: si la respuesta
-- se pierde, el MISMO lote vuelve y antes se insertaba otra vez (efectivo inventado).
-- Nullable a propósito: una app vieja sin la llave sigue sincronizando — Postgres permite
-- varios NULL en un índice único.
-- AlterTable
ALTER TABLE "CashDrawerEvent" ADD COLUMN     "localId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CashDrawerEvent_venueId_localId_key" ON "CashDrawerEvent"("venueId", "localId");

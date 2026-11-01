-- D9 (31-oct-2026): llaves de «Pagar después» que el POS devolvió a «Carritos guardados» tras un rechazo del reenvío.
-- Aditiva: una tabla nueva, sin enums ni cambios a tablas existentes. Ver schema.prisma (OrderKeyRelease).
CREATE TABLE "OrderKeyRelease" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "staffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderKeyRelease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderKeyRelease_venueId_externalId_key" ON "OrderKeyRelease"("venueId", "externalId");

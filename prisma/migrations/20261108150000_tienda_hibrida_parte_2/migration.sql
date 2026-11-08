-- Columnas aditivas: las sesiones anteriores conservan versión 0; la hora anterior queda nula.
ALTER TABLE "Customer" ADD COLUMN "versionDeSesion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "loyaltySaleAt" TIMESTAMP(3);

-- Sin llaves foráneas ni UNIQUE extra: insertar un aviso no espera filas de beneficios ni otro aviso.
CREATE TABLE "WalletPassOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "motivo" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reclamadoPor" VARCHAR(30),
    "reclamadoHasta" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "siguienteIntentoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletPassOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WalletPassOutbox_siguienteIntentoAt_id_idx" ON "WalletPassOutbox"("siguienteIntentoAt", "id");
CREATE INDEX "WalletPassOutbox_venueId_customerId_id_idx" ON "WalletPassOutbox"("venueId", "customerId", "id");

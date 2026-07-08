-- Pérdida fiscal de ejercicios anteriores pendiente de amortizar (captura manual por contribuyente).
CREATE TABLE "FiscalLossCarryforward" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "pendingCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiscalLossCarryforward_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FiscalLossCarryforward_organizationId_rfc_key" ON "FiscalLossCarryforward"("organizationId", "rfc");
CREATE INDEX "FiscalLossCarryforward_organizationId_rfc_idx" ON "FiscalLossCarryforward"("organizationId", "rfc");

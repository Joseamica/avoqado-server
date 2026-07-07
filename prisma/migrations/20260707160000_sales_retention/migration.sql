-- Retención en ventas (que los clientes morales retienen al contribuyente), captura manual por periodo.
CREATE TABLE "SalesRetention" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "isrRetenidoCents" INTEGER NOT NULL DEFAULT 0,
    "ivaRetenidoCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SalesRetention_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesRetention_organizationId_rfc_period_key" ON "SalesRetention"("organizationId", "rfc", "period");
CREATE INDEX "SalesRetention_organizationId_rfc_idx" ON "SalesRetention"("organizationId", "rfc");

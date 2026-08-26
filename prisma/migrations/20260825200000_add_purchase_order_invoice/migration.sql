-- Factura del proveedor colgada de una orden de compra (fase 1).
--
-- 🔴 Nada aquí toca inventario ni costos. `StockBatch.costPerUnit` se congela al RECIBIR
-- desde `PurchaseOrderItem.unitPrice`; una diferencia con lo facturado se AVISA vía
-- "matchStatus", nunca se corrige — revaluarlo cambiaría el costo de ventas ya ocurridas.

CREATE TYPE "InvoiceMatchStatus" AS ENUM ('PENDING', 'MATCHED', 'SUPPLIER_MISMATCH', 'AMOUNT_MISMATCH', 'LINES_MISMATCH');

CREATE TABLE "PurchaseOrderInvoice" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "supplierId" TEXT,
    "uuid" TEXT NOT NULL,
    "serie" TEXT,
    "folio" TEXT,
    "emisorRfc" TEXT NOT NULL,
    "emisorNombre" TEXT NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "descuentoCents" INTEGER NOT NULL DEFAULT 0,
    "ivaCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "xmlUrl" TEXT,
    "matchStatus" "InvoiceMatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchNotes" JSONB,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrderInvoice_pkey" PRIMARY KEY ("id")
);

-- El folio fiscal es único POR NEGOCIO, no global: dos negocios distintos pueden recibir
-- legítimamente el mismo CFDI de un corporativo que factura a varios. Dentro de un negocio,
-- en cambio, subir dos veces la misma factura es siempre un error.
CREATE UNIQUE INDEX "PurchaseOrderInvoice_venueId_uuid_key" ON "PurchaseOrderInvoice"("venueId", "uuid");
CREATE INDEX "PurchaseOrderInvoice_purchaseOrderId_idx" ON "PurchaseOrderInvoice"("purchaseOrderId");
CREATE INDEX "PurchaseOrderInvoice_venueId_fechaEmision_idx" ON "PurchaseOrderInvoice"("venueId", "fechaEmision");
CREATE INDEX "PurchaseOrderInvoice_supplierId_idx" ON "PurchaseOrderInvoice"("supplierId");
CREATE INDEX "PurchaseOrderInvoice_matchStatus_idx" ON "PurchaseOrderInvoice"("matchStatus");

CREATE TABLE "PurchaseOrderInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT,
    "supplierItemCode" TEXT,
    "descripcion" TEXT NOT NULL,
    "claveProdServ" TEXT,
    "claveUnidad" TEXT,
    "cantidad" DECIMAL(12,3) NOT NULL,
    "valorUnitarioCents" INTEGER NOT NULL,
    "importeCents" INTEGER NOT NULL,
    "descuentoCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderInvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrderInvoiceLine_invoiceId_idx" ON "PurchaseOrderInvoiceLine"("invoiceId");
CREATE INDEX "PurchaseOrderInvoiceLine_purchaseOrderItemId_idx" ON "PurchaseOrderInvoiceLine"("purchaseOrderItemId");
-- El código del proveedor es la llave de la fase 2 (reconocer solo lo ya visto): se busca por él.
CREATE INDEX "PurchaseOrderInvoiceLine_supplierItemCode_idx" ON "PurchaseOrderInvoiceLine"("supplierItemCode");

ALTER TABLE "PurchaseOrderInvoice" ADD CONSTRAINT "PurchaseOrderInvoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderInvoice" ADD CONSTRAINT "PurchaseOrderInvoice_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull y no Cascade: borrar un proveedor no puede borrar la evidencia de lo que cobró.
ALTER TABLE "PurchaseOrderInvoice" ADD CONSTRAINT "PurchaseOrderInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderInvoice" ADD CONSTRAINT "PurchaseOrderInvoice_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderInvoiceLine" ADD CONSTRAINT "PurchaseOrderInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "PurchaseOrderInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Igual que arriba: si el renglón de la orden desaparece, el renglón de la factura sobrevive.
ALTER TABLE "PurchaseOrderInvoiceLine" ADD CONSTRAINT "PurchaseOrderInvoiceLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fase 2 de la factura: el codigo del proveedor aprende, y la factura puede llegar sin orden.
ALTER TYPE "InvoiceMatchStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
ALTER TYPE "InvoiceMatchStatus" ADD VALUE IF NOT EXISTS 'NO_ORDER';

-- La factura sin orden previa: el vinculo a la orden se vuelve opcional, y si la orden se
-- borra la factura queda como evidencia (SetNull, ya no Cascade).
ALTER TABLE "PurchaseOrderInvoice" ALTER COLUMN "purchaseOrderId" DROP NOT NULL;
ALTER TABLE "PurchaseOrderInvoice" DROP CONSTRAINT "PurchaseOrderInvoice_purchaseOrderId_fkey";
ALTER TABLE "PurchaseOrderInvoice" ADD CONSTRAINT "PurchaseOrderInvoice_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El renglon identificado: insumo O producto, nunca ambos.
ALTER TABLE "PurchaseOrderInvoiceLine" ADD COLUMN "rawMaterialId" TEXT;
ALTER TABLE "PurchaseOrderInvoiceLine" ADD COLUMN "productId" TEXT;
ALTER TABLE "PurchaseOrderInvoiceLine" ADD CONSTRAINT "PurchaseOrderInvoiceLine_rawMaterialId_fkey"
  FOREIGN KEY ("rawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderInvoiceLine" ADD CONSTRAINT "PurchaseOrderInvoiceLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderInvoiceLine" ADD CONSTRAINT "invoice_line_material_xor"
  CHECK (NOT ("rawMaterialId" IS NOT NULL AND "productId" IS NOT NULL));

CREATE TABLE "SupplierItemCode" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "rawMaterialId" TEXT,
  "productId" TEXT,
  "lastDescription" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierItemCode_pkey" PRIMARY KEY ("id"),
  -- XOR duro: un codigo es un insumo O un producto, y siempre UNO de los dos.
  CONSTRAINT "supplier_item_code_xor" CHECK (
    ("rawMaterialId" IS NOT NULL AND "productId" IS NULL) OR ("rawMaterialId" IS NULL AND "productId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "SupplierItemCode_venueId_supplierId_code_key" ON "SupplierItemCode"("venueId", "supplierId", "code");
CREATE INDEX "SupplierItemCode_supplierId_idx" ON "SupplierItemCode"("supplierId");
CREATE INDEX "SupplierItemCode_rawMaterialId_idx" ON "SupplierItemCode"("rawMaterialId");
CREATE INDEX "SupplierItemCode_productId_idx" ON "SupplierItemCode"("productId");
ALTER TABLE "SupplierItemCode" ADD CONSTRAINT "SupplierItemCode_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierItemCode" ADD CONSTRAINT "SupplierItemCode_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierItemCode" ADD CONSTRAINT "SupplierItemCode_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierItemCode" ADD CONSTRAINT "SupplierItemCode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierItemCode" ADD CONSTRAINT "SupplierItemCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

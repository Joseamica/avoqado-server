-- Additive only: existing invoices remain evidence, with no implicit stock effect.
ALTER TABLE "PurchaseOrderInvoice"
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "cfdiType" TEXT,
  ADD COLUMN "iepsCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventoryPreparedAt" TIMESTAMP(3),
  ADD COLUMN "inventoryReceivedAt" TIMESTAMP(3),
  ADD COLUMN "inventoryIncludeIeps" BOOLEAN;
ALTER TABLE "PurchaseOrderInvoiceLine"
  ADD COLUMN "iepsCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purchaseUnit" "Unit",
  ADD COLUMN "presentationName" TEXT;
ALTER TABLE "SupplierItemCode"
  ADD COLUMN "claveUnidad" TEXT,
  ADD COLUMN "purchaseUnit" "Unit",
  ADD COLUMN "presentationName" TEXT;
CREATE INDEX "PurchaseOrderInvoice_venueId_fechaEmision_id_idx"
  ON "PurchaseOrderInvoice" ("venueId", "fechaEmision", "id");

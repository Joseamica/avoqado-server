-- Dos cosas, ambas cerrando huecos de la migración anterior
-- (20260805211911_purchase_order_item_product_or_raw_material):
--
--   1. InventoryMovement.purchaseOrderItemId — la liga que faltaba para que recibir
--      mercancía de reventa derive su delta del ESTADO REAL (cuánto puso ya esa línea
--      en la bodega) en vez de la columna `quantityReceived`, que `receiveNoItems`
--      reinicia sin revertir el saldo. Sin esto, "recibir 5 → recibir ninguno →
--      recibir todo" dejaba 10 de existencia habiendo llegado 5.
--      Es el espejo de StockBatch.purchaseOrderItemId, que es lo que hace que el
--      camino de insumos sí sea autocorrectivo.
--
--   2. El CHECK que la migración anterior no puso. Al volver opcional `rawMaterialId`
--      se quitó la última red de seguridad de las rutas que escriben renglones SIN
--      pasar por Zod (/mobile, chatbot, autoReorder): un renglón sin destino pasaba
--      de reventar en la base a guardarse en silencio.
--
-- lock_timeout: si el lock no se adquiere en 5s (p.ej. una recepción larga en vuelo),
-- aborta limpio y se reintenta el deploy - nunca se queda encolado bloqueando ventas.
SET lock_timeout = '5s';

-- AlterTable
-- ADD COLUMN sin default es cambio de catálogo: instantáneo, no reescribe la tabla.
ALTER TABLE "InventoryMovement" ADD COLUMN     "purchaseOrderItemId" TEXT;

-- CreateIndex
CREATE INDEX "InventoryMovement_purchaseOrderItemId_idx" ON "InventoryMovement"("purchaseOrderItemId");

-- AddForeignKey
-- SET NULL, no CASCADE: el movimiento es historia contable y debe sobrevivir al
-- borrado de la orden de compra, igual que StockBatch.
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Exclusividad insumo XOR producto, a nivel de base ────────────────────────
-- Prisma no declara CHECKs en el esquema, pero los RESPETA y los conserva entre
-- regeneraciones. NO lo quites: es la única capa que hace imposible el estado
-- inválido para TODAS las rutas de escritura, incluidas las que no pasan por Zod.
--
-- `<>` sobre dos booleanos es XOR: exactamente uno de los dos debe ser NOT NULL.
-- Se crea NOT VALID y se valida en un segundo paso a propósito: NOT VALID no
-- escanea la tabla bajo ACCESS EXCLUSIVE, y VALIDATE sólo toma SHARE UPDATE
-- EXCLUSIVE, que NO bloquea escrituras. Da igual con 27 filas, importa si esta
-- tabla creció en prod.
ALTER TABLE "PurchaseOrderItem"
  ADD CONSTRAINT "PurchaseOrderItem_insumo_xor_producto"
  CHECK (("rawMaterialId" IS NOT NULL) <> ("productId" IS NOT NULL)) NOT VALID;

ALTER TABLE "PurchaseOrderItem" VALIDATE CONSTRAINT "PurchaseOrderItem_insumo_xor_producto";

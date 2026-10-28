-- Modo Autoservicio, Fase 0 (0.d): un renglón de orden vende un paquete de créditos y se entrega UNA vez, desde la foto.
--
-- · OrderItem.creditPackId / creditPackSnapshot: qué paquete vende el renglón y la FOTO de lo vendido. RESTRICT: un paquete
--   vendido no se borra. Sin índice en "creditPackId" a propósito: la entrega busca por "orderId" (ya indexado) y un
--   CREATE INDEX en OrderItem bloquea las escrituras de las ventas en producción.
-- · La FK de OrderItem nace NOT VALID (como la de "giftCardId", 20261019000000): sin eso, ADD CONSTRAINT recorre OrderItem
--   entero con un candado que frena las ventas. Las filas nuevas se revisan igual; la siguiente migración la valida sin frenar.
--   La de "CreditPackPurchase"."orderItemId" también: el ADD COLUMN de arriba deja OrderItem bajo candado hasta el COMMIT, y
--   validarla aquí recorrería las compras con las ventas esperando (Codex, código r1 #4).
-- · CreditPackPurchase.orderItemId @unique: la llave que hace idempotente la entrega (como "paymentId").
-- · CreditItemBalance.creditPackItemId deja de ser obligatorio: null = saldo nacido de la foto (sólo catálogo, no reescribe).
-- · ORDEN (Codex, código r2 #3): el primer ALTER de OrderItem deja su candado tomado hasta el COMMIT. Por eso lo que RECORRE
--   una tabla (el índice único de las compras) va ANTES, y después de tocar OrderItem sólo quedan cambios instantáneos.
-- · lock_timeout (molde 20261019000000): si una lectura larga tiene OrderItem, la migración falla a los 5 s en vez de esperar
--   para siempre con las ventas formadas detrás de su candado.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "CreditPackPurchase" ADD COLUMN "orderItemId" TEXT;

CREATE UNIQUE INDEX "CreditPackPurchase_orderItemId_key" ON "CreditPackPurchase"("orderItemId");

ALTER TABLE "CreditItemBalance" ALTER COLUMN "creditPackItemId" DROP NOT NULL;

ALTER TABLE "OrderItem" ADD COLUMN "creditPackId" TEXT, ADD COLUMN "creditPackSnapshot" JSONB;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_creditPackId_fkey"
  FOREIGN KEY ("creditPackId") REFERENCES "CreditPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

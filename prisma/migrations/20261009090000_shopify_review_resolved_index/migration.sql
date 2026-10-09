-- La retención de «Por revisar» (B10) borra cada hora las revisiones RESUELTAS de hace más de 90 días, entre todos los
-- negocios: sin este índice cada pasada es un Seq Scan de toda la tabla (medido: 201 ms con 1,000,000 de filas; con un
-- índice sobre resolvedAt, 0.04 ms). La tabla es nueva (migración 20261008120000): crearlo ahora no bloquea nada que importe.

-- CreateIndex
CREATE INDEX "ShopifyReviewItem_status_resolvedAt_idx" ON "ShopifyReviewItem"("status", "resolvedAt");

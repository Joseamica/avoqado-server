-- Barrido del cierre perdido de MP: sesiones de MP sin venta de los últimos 30 días. Parcial: sólo las filas que el barrido
-- puede elegir (Prisma 6 no declara índices parciales; ver el comentario en el modelo CheckoutSession).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CheckoutSession_mp_sin_venta_createdAt_idx" ON "CheckoutSession" ("createdAt") WHERE "paymentId" IS NULL AND "mpPaymentId" IS NOT NULL;

-- Barrido del cierre perdido de MP (mercadopago-cierre-perdido.job): eventos en error/pending por fecha.
-- CONCURRENTLY: un solo statement por archivo (Prisma manda el archivo como un batch; ver memoria migracion-a-mano-en-base-compartida).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "MercadoPagoWebhookEvent_processingStatus_createdAt_id_idx" ON "MercadoPagoWebhookEvent" ("processingStatus", "createdAt", "id");

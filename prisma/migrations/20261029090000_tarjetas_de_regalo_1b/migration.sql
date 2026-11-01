-- 20261029090000_tarjetas_de_regalo_1b — sólo columnas nulas o con default.
ALTER TABLE "GiftCard"
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deliveryClaimedAt" TIMESTAMP(3),
  ADD COLUMN "deliveryErrorCode" TEXT,
  ADD COLUMN "deliveryMessageId" TEXT,
  ADD COLUMN "deliveryOperationKey" TEXT,
  ADD COLUMN "ventaHuella" TEXT;
-- Índices normales (no CONCURRENTLY): "GiftCard" sólo lo escriben las ventas de tarjetas, que la 1a todavía no tiene en
-- producción; un CONCURRENTLY exigiría otra carpeta y el índice pide UNA.
CREATE INDEX "GiftCard_deliveryStatus_deliveryNextAttemptAt_idx" ON "GiftCard"("deliveryStatus", "deliveryNextAttemptAt");
CREATE INDEX "GiftCard_deliveryMessageId_idx" ON "GiftCard"("deliveryMessageId");
ALTER TABLE "OtpChallenge" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'CUSTOMER_LOGIN';

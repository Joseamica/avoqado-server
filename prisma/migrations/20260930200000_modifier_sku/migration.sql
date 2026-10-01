-- Caja externa: SKU del extra en el otro POS. Opcional y no único (varios extras lo comparten).
ALTER TABLE "Modifier" ADD COLUMN "sku" TEXT;

-- D661 · pagar con tarjeta en línea en «Nadie» (tarea 1, migración única del SERVIDOR). Sólo columnas nuevas, opcionales o con
-- valor de fábrica: ningún UPDATE de datos ni valores de enum nuevos. Las tareas 3–6 usan las cuatro que la tarea 1 no lee.

-- AlterTable
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN     "cardOnlineNadie" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastCardAlertPollAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OnlineOrder" ADD COLUMN     "notPickedUpAt" TIMESTAMP(3),
ADD COLUMN     "refundRequestedAt" TIMESTAMP(3),
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OnlineOrderCardRefund" ADD COLUMN     "toStoreCredit" BOOLEAN NOT NULL DEFAULT false;


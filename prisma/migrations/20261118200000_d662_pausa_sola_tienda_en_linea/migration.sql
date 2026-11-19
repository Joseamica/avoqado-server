-- D662 (founder, 18-nov): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» vencidos seguidos. Aditiva.
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "missedOrdersInARow" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "lastAnsweredAt" TIMESTAMP(3);
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPausedAt" TIMESTAMP(3);

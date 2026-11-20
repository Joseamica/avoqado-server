-- D662 parte 2 (founder, 19-nov, «a»; v3 del 20-nov): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» sin atender.
-- Aditiva. La pausa se LEE de la línea de tiempo de los pedidos (no hay contador): cada pedido guarda una sola vez la hora en que una
-- PERSONA lo contestó (aceptar, rechazar o anular su cuenta), y el corte dice desde qué hora límite cuentan los pedidos.
ALTER TABLE "OnlineOrder" ADD COLUMN "staffAnsweredAt" TIMESTAMP(3);
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPauseResumedAt" TIMESTAMP(3);

-- Gracia del despliegue (Codex p2-r1 #5, p2-r2 #5): Render corre esta migración con el servidor ANTERIOR todavía atendiendo, y ése no
-- guarda `staffAnsweredAt`. Los pedidos con hora límite en los próximos 30 min (todos los que el servidor anterior pudo tocar: vive
-- minutos y un pedido vence a los 10 min de creado) no cuentan para la pausa sola. Hora UTC, como la escribe Prisma.
UPDATE "OnlineOrderingSettings" SET "autoPauseResumedAt" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '30 minutes';

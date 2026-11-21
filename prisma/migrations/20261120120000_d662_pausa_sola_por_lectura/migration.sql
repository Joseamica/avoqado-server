-- D662 parte 2 (founder, 19-nov «a»; v4 «cero huecos», 20-nov «C»): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» sin
-- atender. Aditiva. La pausa se LEE de la línea de tiempo de los pedidos (no hay contador): cada pedido guarda una sola vez la hora en
-- que una PERSONA lo contestó (aceptar, rechazar o anular su cuenta), y el corte dice desde qué hora límite cuentan los pedidos.
ALTER TABLE "OnlineOrder" ADD COLUMN "staffAnsweredAt" TIMESTAMP(3);
-- Corte propio de cada tienda (sólo sube: «Reanudar» y la propia lectura). Vacío = sin corte propio: cuenta desde la hora del interruptor
-- PAUSA_SOLA_DESDE (v5; `interruptorPausaSola.ts`).
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPauseResumedAt" TIMESTAMP(3);

-- D662 parte 2 (founder, 19-nov, «a»; v3 del 20-nov): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» sin atender.
-- Aditiva. La pausa se LEE de la línea de tiempo de los pedidos (no hay contador): cada pedido guarda una sola vez la hora en que una
-- PERSONA lo contestó (aceptar, rechazar o anular su cuenta), y el corte dice desde qué hora límite cuentan los pedidos.
ALTER TABLE "OnlineOrder" ADD COLUMN "staffAnsweredAt" TIMESTAMP(3);
-- Vacío = gracia del despliegue pendiente (Codex p2-r1 #5, p2-r4 #3): la primera lectura del SERVIDOR nuevo lo pone 20 min adelante,
-- así lo que contestó el servidor anterior (sin `staffAnsweredAt`) nunca cuenta, aunque el despliegue falle y se repita después.
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPauseResumedAt" TIMESTAMP(3);

-- D662 parte 2 (founder, 19-nov «a»; v4 «cero huecos», 20-nov «C»): la tienda en línea se pausa sola tras 2 pedidos de «Mi equipo» sin
-- atender. Aditiva. La pausa se LEE de la línea de tiempo de los pedidos (no hay contador): cada pedido guarda una sola vez la hora en
-- que una PERSONA lo contestó (aceptar, rechazar o anular su cuenta), y el corte dice desde qué hora límite cuentan los pedidos.
ALTER TABLE "OnlineOrder" ADD COLUMN "staffAnsweredAt" TIMESTAMP(3);
-- Corte propio de cada tienda (sólo sube: «Reanudar» y la propia lectura). Vacío = sin corte propio: cuenta desde el inicio global.
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "autoPauseResumedAt" TIMESTAMP(3);
-- El inicio global: la primera petición que atiende el SERVIDOR nuevo (no `/health`) escribe su fila una sola vez; la pausa sola cuenta
-- 90 s después (`arranquePausaSola.ts`). Sin fila, la pausa sola no existe todavía.
CREATE TABLE "ArranqueDeFuncion" (
    "clave" TEXT NOT NULL,
    "primerServicioAt" TIMESTAMP(3) NOT NULL,
    "legadoSelladoAt" TIMESTAMP(3),
    CONSTRAINT "ArranqueDeFuncion_pkey" PRIMARY KEY ("clave")
);

-- D17 (Flautas, 20-nov-2026): la comanda con tiempos sale del tablero cuando la cocina termina, lo viejo se archiva al cerrar el
-- día y un interruptor deja a la cocina liberar tiempos. Columnas nuevas y opcionales: no reescriben la tabla ni frenan escrituras.
ALTER TABLE "public"."KdsOrder" ADD COLUMN IF NOT EXISTS "kitchenDoneAt" TIMESTAMP(3);
ALTER TABLE "public"."KdsOrder" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "public"."VenueSettings" ADD COLUMN IF NOT EXISTS "kitchenCanReleaseCourses" BOOLEAN NOT NULL DEFAULT false;
-- Las comandas con tiempos que la cocina YA terminó antes del despliegue (READY) salen del tablero al desplegar. No se sabe a qué
-- hora terminó (su `updatedAt` puede ser una entrega parcial posterior, Codex r12): se les pone una hora de hace dos horas, así no
-- entran a «Recientes» con una hora inventada ni se pueden «deshacer» fuera de su ventana (en develop las v1 no tenían «Deshacer»).
UPDATE "public"."KdsOrder" SET "kitchenDoneAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours'
WHERE "preparationVersion" = 1 AND status = 'READY' AND "kitchenDoneAt" IS NULL;

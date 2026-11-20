-- D17 (Flautas, 20-nov-2026): la comanda con tiempos sale del tablero cuando la cocina termina, lo viejo se archiva al cerrar el
-- día y un interruptor deja a la cocina liberar tiempos. Columnas nuevas y opcionales: no reescriben la tabla ni frenan escrituras.
ALTER TABLE "public"."KdsOrder" ADD COLUMN IF NOT EXISTS "kitchenDoneAt" TIMESTAMP(3);
ALTER TABLE "public"."KdsOrder" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "public"."VenueSettings" ADD COLUMN IF NOT EXISTS "kitchenCanReleaseCourses" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "public"."VenueSettings" ADD COLUMN IF NOT EXISTS "kitchenCanReleaseHistory" JSONB;
-- Codex r1 #8: las comandas con tiempos que la cocina YA terminó antes del despliegue salen del tablero al desplegar; con su
-- última modificación como «cuándo terminó» entran a «Recientes» la hora que les toca en vez de desaparecer sin rastro.
-- Sólo las de preparación por producto en READY (pocas: la v1 es de mesas con tiempos).
UPDATE "public"."KdsOrder" SET "kitchenDoneAt" = "updatedAt"
WHERE "preparationVersion" = 1 AND status = 'READY' AND "kitchenDoneAt" IS NULL;

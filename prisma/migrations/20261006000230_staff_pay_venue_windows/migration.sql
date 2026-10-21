-- Fase 3 de pago al personal, participación por sede (diseño r3.2 / r7; tarea B9): el dueño activa cada sede «desde qué
-- día». Esta migración sólo crea la tabla y sus restricciones; ningún lector de dinero la usa todavía.

-- CreateTable
CREATE TABLE "StaffPayVenueWindow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "desde" DATE NOT NULL,
    "hasta" DATE,
    "activadaPor" TEXT NOT NULL,
    "desactivadaPor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffPayVenueWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffPayVenueWindow_organizationId_venueId_desde_idx" ON "StaffPayVenueWindow"("organizationId", "venueId", "desde");

-- CreateIndex: la barrera de traslado, borrado y limpieza de demos pregunta si la sede tiene devengos.
CREATE INDEX "ServiceEarning_venueId_idx" ON "ServiceEarning"("venueId");

-- AddForeignKey
ALTER TABLE "StaffPayVenueWindow" ADD CONSTRAINT "StaffPayVenueWindow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Lo que el ORM no expresa ──

-- 1) Una ventana nunca termina antes de empezar, y una cerrada siempre sabe quién la cerró.
ALTER TABLE "StaffPayVenueWindow" ADD CONSTRAINT "StaffPayVenueWindow_rango" CHECK ("hasta" IS NULL OR "hasta" >= "desde");
ALTER TABLE "StaffPayVenueWindow" ADD CONSTRAINT "StaffPayVenueWindow_cierre_completo" CHECK (("hasta" IS NULL) = ("desactivadaPor" IS NULL));

-- 2) Sin traslapes por sede: ni una ventana nueva encima de una cerrada, ni la misma sede en dos organizaciones. Los días
--    son inclusivos ('[]'); `hasta` nulo es «sin fin». `btree_gist` ya existe (migración 20260223140431).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "StaffPayVenueWindow" ADD CONSTRAINT "StaffPayVenueWindow_sin_traslape"
  EXCLUDE USING gist ("venueId" WITH =, daterange("desde", "hasta", '[]') WITH &&);

-- 3) Sin backfill: una organización que ya activó pago al personal y no tiene ninguna ventana se queda sin participación
--    hasta que el dueño active sus sedes. Por eso la migración ABORTA y las nombra. Se vuelve a comprobar al desplegar.
-- ABORTO:INICIO
DO $$
DECLARE
  n integer;
  lista text;
BEGIN
  SELECT COUNT(*) INTO n
  FROM "Organization" org
  WHERE org."staffPayStartDate" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "StaffPayVenueWindow" w WHERE w."organizationId" = org.id);
  IF n > 0 THEN
    SELECT string_agg(format('%s («%s»)', o.id, o.name), ', ' ORDER BY o.id) INTO lista
    FROM (
      SELECT org.id, org.name
      FROM "Organization" org
      WHERE org."staffPayStartDate" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "StaffPayVenueWindow" w WHERE w."organizationId" = org.id)
      ORDER BY org.id
      LIMIT 20
    ) o;
    RAISE EXCEPTION 'Pago al personal: % organización(es) ya activadas sin ninguna sede activa (hasta 20): %. Activa sus sedes desde el dashboard; nunca borres "staffPayStartDate".', n, lista;
  END IF;
END $$;
-- ABORTO:FIN

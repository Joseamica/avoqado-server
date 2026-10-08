-- Pago por servicio, fase 3, Bloque C (spec §10, Codex r2-8). El acceso deja de salir del módulo SERVICE_PAY y sale de la
-- función SERVICE_PAY del plan. Toda sede que HOY lo tiene por módulo recibe un acceso de función que no vence: propio
-- (VenueModule) o heredado de la organización (OrganizationModule), con la precedencia de moduleService.venuesWithModule
-- (módulo global activo; la fila de la sede manda aunque diga «apagado»; sólo sin fila propia se hereda, y sólo con scope
-- BOTH). Es el mismo tipo de acceso sin contrato que ya leen la cuadrícula de funciones y la compra. Después se borra el
-- módulo: un interruptor que ya no prende nada no se deja en superadmin. Producción (5-oct): ninguna sede.
--
-- · Las demos (LIVE_DEMO) y las de prueba (TRIAL) NO reciben el acceso (pre-flight fila 18): ya tienen el plan por la
--   exención de demo, y un acceso (CapabilityGrant.venue es onDelete: Restrict) impediría que su limpieza las borre.
-- · Las sedes migradas quedan con el plan pero SIN activar (pre-flight fila 17): las rutas de dinero dan 403 not_activated
--   hasta que el dueño active pago al personal, y al activar reciben su ventana. Esta migración no toca staffPayStartDate.
-- · Las columnas son timestamp sin zona y Prisma escribe UTC: now() AT TIME ZONE 'UTC', nunca now() a secas (con una sesión
--   al este de UTC el acceso empezaría horas en el futuro).
-- · Id con formato cuid ('c' + 24 hex), determinista por sede. Idempotente: si se vuelve a correr con el módulo sembrado otra
--   vez, ON CONFLICT no duplica el acceso. Todo el archivo va en un solo envío (una transacción implícita).
-- · Antes de leer, el candado de los escritores del módulo (`lockModuleScope`, module.service.ts:44; Codex Bloque C r1-1). Sin
--   él, superadmin apagando una sede a media migración (enabled=false sin confirmar) dejaba que el INSERT leyera el «prendido»
--   viejo y creara el acceso que no vence; el DELETE esperaba al apagado y la sede se quedaba con el acceso (y al revés se
--   perdía una habilitación). Con él, quien escribe espera a la migración (y luego ya no encuentra el módulo) o la migración
--   espera a quien escribe; en READ COMMITTED cada sentencia toma su foto al empezar, DESPUÉS de este candado, así que el
--   INSERT ve lo que superadmin ya confirmó. El candado vive hasta el final de la transacción implícita del archivo.
SELECT id FROM "Module" WHERE code = 'SERVICE_PAY' FOR UPDATE;

WITH modulo AS (
  SELECT id, scope FROM "Module" WHERE code = 'SERVICE_PAY' AND active = true
), con_modulo AS (
  SELECT vm."venueId"
  FROM "VenueModule" vm
  JOIN modulo m ON m.id = vm."moduleId"
  WHERE m.scope IN ('BOTH', 'VENUE_ONLY') AND vm.enabled = true
  UNION
  SELECT v.id
  FROM "Venue" v
  JOIN "OrganizationModule" om ON om."organizationId" = v."organizationId" AND om.enabled = true
  JOIN modulo m ON m.id = om."moduleId" AND m.scope = 'BOTH'
  WHERE NOT EXISTS (SELECT 1 FROM "VenueModule" x WHERE x."venueId" = v.id AND x."moduleId" = m.id)
)
INSERT INTO "CapabilityGrant" ("id", "venueId", "featureCode", "sourceId", "startsAt", "endsAt", "createdAt", "updatedAt")
SELECT 'c' || substr(md5('MODULO_SERVICE_PAY:' || c."venueId"), 1, 24), c."venueId", 'SERVICE_PAY', 'MODULO_SERVICE_PAY',
       now() AT TIME ZONE 'UTC', TIMESTAMP '9999-12-31 00:00:00', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM con_modulo c
JOIN "Venue" v ON v.id = c."venueId"
WHERE v.status NOT IN ('LIVE_DEMO', 'TRIAL')
ON CONFLICT DO NOTHING;

DELETE FROM "VenueModule" WHERE "moduleId" IN (SELECT id FROM "Module" WHERE code = 'SERVICE_PAY');
DELETE FROM "OrganizationModule" WHERE "moduleId" IN (SELECT id FROM "Module" WHERE code = 'SERVICE_PAY');
DELETE FROM "Module" WHERE code = 'SERVICE_PAY';

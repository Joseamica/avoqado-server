# Runbook: selección de profesionista y horarios de equipo

Este rollout es forward-only y usa dos releases. No activa módulos nuevos: el entitlement sigue siendo la Feature existente `RESERVATIONS`. En particular, no cambia `SERIALIZED_INVENTORY`, `OrganizationModule`, `VenueModule` ni la configuración white-label de Playtelecom.

## Artefactos

- Release A (protocolo dual + gracia acotada para holds viejos): `63907e06130b2ac3c7d9788fbac4e15d6205795c`.
- Release B (match estricto de reschedule): `6bc35bad41e2c2299e94f06d4df2d1b1f2030ee8`.
- Los artefactos anteriores `8b4087e0…` / `a7d47d81…` y `a7c30dce…` / `909cb24b…` están superseded y no deben desplegarse: no parten del `develop` actual o no contienen los cierres del review técnico final.
- Preflight read-only: `scripts/preflight-reservation-staff-rollout.ts` del artefacto B.
- TTL del servidor: `SLOT_HOLD_TTL_MS = 600000` ms. La espera A→B es 11 minutos (`TTL + 60 s`).

El seed general agrega mappings `ProductStaff` solamente a `avoqado-wellness`. Resuelve cada membership por `StaffVenue.staffId_venueId` y persiste `StaffVenue.id`; no modifica el seed de Playtelecom. `src/services/onboarding/demoSeed.service.ts` queda intencionalmente sin cambios porque no crea productos de cita ni mappings producto-profesionista.

## Gates previos

1. Confirmar que el SHA A anterior y el SHA B registrado pertenecen a esta misma línea de historia.
2. En cada ambiente, repetir el tamaño real de las tablas antes de aplicar la migración:

   ```sql
   SELECT relname, pg_size_pretty(pg_relation_size(oid)) AS size
   FROM pg_class
   WHERE relname IN ('Reservation', 'SlotHold', 'ClassSession')
   ORDER BY relname;
   ```

   Si hubo crecimiento material respecto del snapshot del diseño, el DBA debe decidir si los índices nuevos requieren `CREATE INDEX CONCURRENTLY`. PostgreSQL no permite esa variante dentro de `BEGIN`/`COMMIT`.
3. Desde un checkout del artefacto B, instalar dependencias y generar Prisma. Inyectar `DATABASE_URL` por el gestor de secretos; nunca ponerla en el comando, logs o documento.
4. Ejecutar:

   ```bash
   NODE_ENV=production npx ts-node -r tsconfig-paths/register scripts/preflight-reservation-staff-rollout.ts
   ```

   El script sólo ejecuta `SELECT`, imprime categoría/conteo/IDs accionables y retorna 1 si cualquier categoría es mayor que cero. Deben estar en cero:

   - Reservation activa futura asignada sin `StaffVenue(staffId, venueId)`.
   - ClassSession `SCHEDULED` futura asignada sin esa membership.
   - Solape futuro del mismo `(organizationId, Staff.id)` en Reservation↔Reservation.
   - Solape futuro en Reservation↔ClassSession.
   - Solape futuro en ClassSession↔ClassSession.
   - Reservation futura `PENDING|CONFIRMED` con `productIds` no vacío cuyo primer ID difiere de `productId`.

Cualquier conteo positivo bloquea el rollout. Resolver cada ID explícitamente y volver a ejecutar; no crear un backfill inferido.

## Secuencia obligatoria

1. Desplegar exactamente Release A. Aplicar la migración aditiva, mantener `capacityMode='pacing'` y `showStaffPicker=false`, y no desplegar clientes nuevos ni activar venues piloto.
2. Esperar hasta que el control plane confirme que todos los pods/instances con código anterior a A salieron. No basta que A tenga réplicas saludables.
3. Volver a ejecutar los seis preflights. Esto detecta escrituras inválidas que un pod viejo pudo hacer durante el rolling deploy. Cualquier conteo positivo bloquea B.
4. Registrar fuera de PostgreSQL el timestamp del control plane en que salió el último pod viejo. Desde ese evento, esperar monotónicamente 11 minutos. No inferir la espera desde `SlotHold.createdAt`, `now()` ni el reloj SQL.
5. Desplegar exactamente el SHA registrado de Release B. B exige `heldForReservationId === reservation.id`; todo hold de reschedule con etiqueta nula responde 409 y queda sin consumir.
6. Tras estabilizar B, desplegar clientes en este orden:

   1. dashboard y desktop;
   2. widget y consumer;
   3. iOS y Android juntos;
   4. habilitar `showStaffPicker=true` y el modo elegido en un único venue piloto.

7. Observar 409 de holds/ventanas, reintentos serializables, asignaciones automáticas y solapes antes de ampliar el opt-in.

Branch protection debe marcar el job `test-and-build` como requerido. Un deploy manual no sustituye ese gate.

## Rollback settings-first

La reversa primaria no es un revert de código:

1. Snapshotear los settings del venue afectado.
2. Apagar `showStaffPicker` y volver `capacityMode='pacing'` mediante el flujo administrativo normal.
3. Verificar que `/info` ya no publique `staffSelection` ni `appointmentWindowSemantics`.
4. Conservar tablas, columnas y migración. No ejecutar down migration.

Los holds staff-aware existentes conservan su protocolo y pueden consumirse una vez. El servidor deja de mintear holds staff-aware nuevos para el venue después del opt-out.

Si una emergencia exige volver a código anterior al protocolo dual:

1. Snapshotear y apagar globalmente `publicBooking.enabled` y `cancellation.allowCustomerReschedule`; esto causa downtime explícito.
2. Esperar `SLOT_HOLD_TTL_MS + 60 s` completos.
3. Ejecutar en una transacción read-only exactamente:

   ```sql
   SELECT count(*) FROM "SlotHold" WHERE "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND ("windowSemantics" IS NOT NULL OR "staffId" IS NOT NULL OR "heldForReservationId" IS NOT NULL)
   ```

4. Sólo con resultado cero desplegar el servidor viejo y restaurar los valores snapshot. No forzar valores `true` y no retirar las columnas aditivas.

## Gate de servidor

Ejecutar exclusivamente contra PostgreSQL efímero/local; nunca reutilizar una URL productiva:

```bash
npm ci
TZ=UTC npx jest tests/unit/services/dashboard/reservationAvailability.service.test.ts tests/unit/services/dashboard/reservation.dashboard.service.test.ts --runInBand --no-watchman
npm run test:unit -- --no-watchman
export TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test'
export DATABASE_URL="$TEST_DATABASE_URL"
npx prisma migrate deploy
npm run test:integration -- --no-watchman
npm run audit:permissions
npm run schema:map -- --check
npm run typecheck
npm run pre-deploy
```

No declarar el server mergeable hasta que todos los comandos terminen en cero y un reviewer independiente revise el feature completo.

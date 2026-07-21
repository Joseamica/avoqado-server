# EPIC — Selección de profesionista + horarios de equipo en reservas por cita (PRO) — v5.2

> **v5 (2026-07-20)** — reconciliación tras el 5to audit Codex (6 P0 + P1s, 100% verificados). CERO conceptos nuevos: esta versión solo
> reconcilia los invariantes de v4 entre sí y contra el código real. Cambios: gate de capacidad en DOS comprobaciones (la fórmula `min()` de
> v4 estaba mal y recortaba capacidad a la mitad); setup gate transaccional (TOCTOU); fast-fail con hold reducido a existencia/expiración;
> `heldForReservationId` liga el hold de reschedule a su reserva; `windowSemantics` para convivencia con widgets cacheados; consentimiento
> de sobre-cupo ANTES del write (`allowOverCapacity` + 409 confirmable); alcance de la garantía del hold acotado; occupancy por tipo de
> producto; wire explícito de reschedule; hijo #9 desktop; `writeOrigin` obligatorio con todos los callers; CI con Postgres efímero; paridad
> MCP de gestión; tests de tenant isolation; comandos autocontenidos.

> **v5.1 (2026-07-21)** — reconciliación del 6to audit Codex, adjudicado contra código en los 5 repos (eng run 3): P0-1/P0-2/P0-4 reales,
> P0-3 parcial, P0-5 refutado — ver §17. Decisiones cerradas **D-v5.1-1..4**: compat-primero en `windowSemantics` (legacy compara raw↔raw;
> garantía plena solo `'base'`; SlotHold persiste ventana FINAL); availability conserva el param `duration` EXISTENTE como advisory (no
> recibe `modifierSelections`); reschedule conserva SIEMPRE al staff actual (`allowStaffReassignment` fuera de alcance); availability ops
> con `includeFull` para slots llenos marcados (Android/Desktop create son slot-only). Fixes integrados: §2 acotado a modo legacy y
> settings-aditivo, retry ejecutable (`isRetryableDbError` en módulo neutral, normaliza `P2010`), envelope 409 con `code`+`details`, holds
> genéricos rechazados, hold de reschedule reemplaza siblings, `weekly:null` = borrar fila, semántica de conteo documentada (overlap
> conservador), CI gatea prod, seeds vía lookup de `StaffVenue`, consumer single-product, typo `OVER_CAPACITY`.

> **v5.2 (2026-07-21)** — corrección del 7mo audit Codex + verificación read-only contra PostgreSQL de producción: duración base
> autoritativa por productos para `windowSemantics:'base'` (un cliente ya no puede sub-reservar la ventana), máximo FINAL de 1440 min,
> normalizador HTTP explícito de `productIds`, fallback real al horario del venue, precedencia de conflictos duros antes de `includeFull`,
> capability de ventana separada del picker y `staffSelection` condicionado por entitlement `RESERVATIONS`, marcador de protocolo en
> `SlotHold`, rollback con puente para holds en vuelo y comandos exactos por repo. Se documenta la separación obligatoria **Feature ≠
> Module**: este epic usa `Feature RESERVATIONS` + opt-in en settings; NO crea ni consulta un `Module` (el precedente `SERIALIZED_INVENTORY`
> de PlayTelecom pertenece al sistema de módulos). Cierre editorial: reschedule usa duración histórica también en availability/hold;
> conflicto personal es cross-venue dentro de la organización por `Staff.id`; TTL usa reloj UTC post-lock; rollout/rollback drenan holds en
> dos fases.

## 1. Context

El ICP activo de Avoqado (estéticas, salones, spas, clínicas) reserva citas donde "con quién" importa. Hoy: el dashboard puede asignar
profesionista con lock anti-empalme (`src/services/dashboard/reservation.dashboard.service.ts:348`), pero el cliente final no puede elegirlo
— el input consumer lo descarta (`src/services/consumer/reservation.consumer.service.ts:12` no incluye staffId y el literal `:296-313` no lo
pasa). No existen horarios por staff. El motor ofrece a todo el staff con membresía activa (`reservationAvailability.service.ts:175-187` —
filtra `StaffVenue.active`, NO `Staff.active`; ambos se filtran en los modos nuevos). Sin profesionista asignado, el único límite es el piso
pacing=1 para APPOINTMENTS_SERVICE (`reservationAvailability.service.ts:245`).

**Consumidores del contrato de reservas `/dashboard` (verificados):** avoqado-web-dashboard, **avoqado-desktop** (`AvoqadoApi.kt:521` —
create/availability/reschedule, su create dialog ya usa staff picker), **avoqado-ios** (`Reservations/`, `CreateReservationSheet.swift`) y
**avoqado-android** (`reservations/`, `ReservationApi.kt`, `PosMode.RESERVATIONS`). Los 4 crean citas/clases HOY — todo cambio de respuesta
es aditivo y se verifica contra el código de los 4 + widget + consumer app.

Validado contra la industria: Square Bookings API — SearchAvailability con `segment_filters.team_member_id_filter`, slots con
`team_member_id` resuelto server-side, mapeo servicio↔staff en el servicio, `TeamMemberBookingProfile` expone solo display_name +
profile_image_url + is_bookable.

Tier: PRO vía Feature `RESERVATIONS` existente (`basePlan.service.ts:181`). Sin Stripe nuevo. Paywall visible para FREE.

**Tres candados distintos, sin cruces:**

| Responsabilidad          | Fuente de verdad                                                                |
| ------------------------ | ------------------------------------------------------------------------------- | --- | ---------------------------------------------------- |
| Entitlement comercial    | `venueHasFeatureAccess(venueId, 'RESERVATIONS')` / middleware Feature existente |
| Opt-in de comportamiento | `showStaffPicker === true                                                       |     | capacityMode === 'per_staff'`en`ReservationSettings` |
| Autorización del actor   | permisos existentes `teams:*`, `menu:*`, `reservations:*`                       |

No se crea `Module`, `VenueModule`, `OrganizationModule`, Feature code ni producto Stripe. `SERIALIZED_INVENTORY` sí se activa como módulo
(PlayTelecom lo hereda por organización y además tiene overrides por venue), pero es un precedente del sistema interno/configurable, NO del
entitlement pagado de reservas. Nunca llamar `moduleService` para este epic ni gatear inventario serializado con `venueHasFeatureAccess`
(regla del repo: `.claude/rules/feature-gating.md:38-50`).

## 2. Regla de oro (no negociable)

Ausencia de configuración = comportamiento actual byte-idéntico:

- Cuando corre la elegibilidad nueva (`isStaffAware`), staff sin `StaffSchedule` ⇒ usa el horario del venue; la ventana FINAL completa debe
  caber dentro de un rango abierto. Con opt-in apagado no se introduce este rechazo nuevo.
- Modo legacy (`capacityMode='pacing'` + `showStaffPicker=false`, default): servicio sin `ProductStaff` ⇒ todos los staff elegibles;
  dashboard sin gate de capacidad (hoy); `allowOverCapacity`/`windowSemantics` ignorados/ausentes.
- **Excepciones de seguridad operativa al byte-idéntico legacy (cerradas, no carta blanca):** toda escritura que crea o cambia la ocupación
  personal (`assignedStaffId`/`staffId` o intervalo) de Reservation/ClassSession/SlotHold deja de buscar empalmes sólo en `venueId` y los
  busca en todas las sucursales de la organización por `Staff.id`. Una misma persona no puede estar en dos sucursales ni impartir clase y
  cita a la vez; el busy block personal ya tiene al menos ese alcance (hoy es platform-wide, `external-busy-block.service.ts:17-25`). Sí
  amplía cross-venue el conflicto personal de mesas/eventos que hoy ya es duro dentro del venue; no cambia el pacing legacy.
- **Excepción acotada de integridad legacy:** cambiar `productId` en una Reservation con `productIds.length > 1` ahora da 400 en vez de
  dejar lead/lista divergentes; el cambio single-service se conserva y sincroniza ambas columnas (§9). Snapshot producción 2026-07-21: 0
  filas multi-servicio/0 leads divergentes, así que no cambia un flujo vivo conocido.
- Venue sin tocar settings ⇒ slots y JSON idénticos a hoy en booking/availability/info (campos nuevos OMITIDOS, nunca `null`/`[]`).
  Excepción declarada: el GET de settings es ADITIVO — los 2 campos nuevos aparecen con sus defaults (el read mapea campo-por-campo desde la
  fila, `reservationSettings.service.ts:185-255`; `getDefaultConfig` solo aplica a venues sin fila).
- Cliente viejo (widget cacheado, POS sin actualizar) contra server nuevo **en modo legacy** ⇒ sigue funcionando por su camino actual
  byte-idéntico (§3b compat explícita). Si el venue ACTIVA opt-in (cambio deliberado de settings, no "ausencia de configuración"), el
  cliente viejo crea normal con una ventana válida y al sobre-cupo ve el 409 en español (§10d); una ventana menor que la duración canónica
  se rechaza para que un cliente legacy no sub-reserve el lock nuevo.
- Los clientes públicos (widget/consumer) solo mandan `windowSemantics:'base'` cuando el server expone `appointmentWindowSemantics:'base'`
  (capability escalar: `isStaffAware` + entitlement). **No se negocia mediante `staffSelection`**: `capacityMode='per_staff'` + picker
  apagado sigue autoasignando y necesita el protocolo corregido aunque no muestre personas. Los clientes operados (`/dashboard`) detectan
  los campos nuevos del GET de settings; si faltan, conservan el wire legacy. MCP se despliega lockstep con el server y fija `'base'`
  explícitamente cuando el venue está opt-in. Esto permite apagar el opt-in sin desactualizar clientes (§16).

Criterio ejecutable: `tests/unit/services/dashboard/reservationAvailability.service.test.ts` (baselines 14/27) y
`reservation.dashboard.service.test.ts` pasan SIN modificar asserts, con `TZ=UTC`.

## 3. Convenciones de contrato

### 3a. Nombres — staffId ↔ assignedStaffId

| Capa                                                                 | Nombre            |
| -------------------------------------------------------------------- | ----------------- |
| HTTP público, widget, consumer app, MCP                              | `staffId`         |
| Servicio interno (`CreateReservationInput`) y Prisma (`Reservation`) | `assignedStaffId` |
| Availability y holds (query/body/`SlotHold`)                         | `staffId`         |

Mapeo EXPLÍCITO por boundary — nunca por spread (`reservation.public.controller.ts:1016` hace `...req.body`). Los 5 puntos de cableo: schema
público create, schema+tipo+literal consumer (`:296-313`), forward del query de availability (`:379`/`:582`), body del hold, MCP.
Elegibilidad se valida DENTRO de la tx tras calcular la ventana final. Prueba de contrato: inspección de FILA en el proyecto `integration`
(api-tests usan prismaMock — `jest.config.js:80+93`).

### 3b. Semántica de ventana + convivencia con clientes cacheados (cierra P0-5 y P0-v5.2-1)

**Problema real verificado:** el widget actual manda ventanas FINALES (duración ya incluye modifiers — `booking.ts:144`), el hold no acepta
selections, y el core re-suma el delta en el create (`:285-295`). Un cambio seco a "ventana base" rompería todos los widgets cacheados en
CDN (hold≠create → 409). Contrato versionado:

- Request de hold/create/availability de booking nuevo acepta `windowSemantics?: 'base'` (opcional). **(D-v5.1-1: compatibilidad primero.)**
  El hold de reschedule usa la excepción fija de abajo y no acepta el marcador.
  - **Ausente = cliente legacy**: con settings legacy el server preserva el comportamiento ACTUAL byte-idéntico para ese request. En venue
    opt-in conserva el cálculo/wire raw, pero `canonicalBaseDurationMin` es un piso obligatorio para availability/hold/create; una ventana
    raw menor devuelve `APPOINTMENT_WINDOW_CHANGED` y CERO writes. Así un atacante no evade el fix omitiendo el marcador, mientras widgets
    viejos correctos (que mandan base + modifiers) siguen iguales. Hold y create comparan ventanas CRUDAS con igualdad estricta (hoy
    `reservation.public.controller.ts:2391-2394`) y el core re-suma modifiers en el create (`reservation.dashboard.service.ts:292-296`). La
    doble-extensión existente es un **bug VIVO conocido** (la reserva se persiste `modifierDurationDelta` más larga que el slot mostrado y
    sobre-bloquea el calendario) que NO se "arregla" bajo los pies de clientes viejos. **La garantía D4 en legacy cubre la ventana CRUDA del
    hold** — el delta re-sumado queda fuera (acotación documentada; se corrige sola al migrar el cliente a `'base'`).
  - **`'base'` = cliente nuevo**: `startsAt/endsAt` son la ventana base sin modifiers. El módulo neutral `resolveAppointmentWindow.ts`
    expone `resolveCanonicalAppointmentDuration(db, { venueId, productIds, settings })` y `resolveAppointmentWindow(tx, input)`. El primero
    exige que el número de productos encontrados coincida con los IDs, que todos pertenezcan al venue y sean `APPOINTMENTS_SERVICE`; después
    calcula por producto `duration ?? durationMinutes ?? settings.scheduling.defaultDurationMin` y devuelve su suma como
    `canonicalBaseDurationMin`; el segundo lo reutiliza y valida que `endsAt-startsAt` coincida (tolerancia existente de ±1 min), resuelve
    modifiers y calcula UNA vez `finalDurationMin = canonicalBaseDurationMin + modifierDurationDelta` y
    `finalEndsAt = startsAt + finalDurationMin`. Si la ventana base no coincide (catálogo cambió o request manipulado), no escribe y
    devuelve `409 APPOINTMENT_WINDOW_CHANGED` con `details: { expectedBaseDurationMin, expectedBaseEndsAt }`; los clientes limpian slot/hold
    y recargan availability. **Nunca** confiar en `duration`/`endsAt` del cliente para conflictos o persistencia en este branch.
  - Máximo autoritativo: `finalDurationMin <= 1440` (24 h). Para preservar byte-identidad, requests legacy sin `windowSemantics` conservan
    el límite actual de 480; requests `'base'` admiten base hasta 1440 pero se rechazan si base + modifiers supera 1440. El mismo
    refinamiento aplica a schemas dashboard/public/consumer y al helper (defensa en profundidad).
  - **Puente de update/rollback:** `updateReservationBodySchema.duration` acepta el wire hasta 1440 porque una fila creada en modo `'base'`
    puede sobrevivir a apagar settings. El core calcula el intervalo efectivo y aplica
    `maxAllowed = isAppointmentReservation && isStaffAware(settings) ? 1440 : max(480, reservation.duration)`: una fila legacy de 60 no
    puede crecer a 600 con opt-in apagado, pero una fila válida de 600 puede preservar/re-enviar 600 (también al editar metadata/fecha) y
    reducirse; no puede crecer a 700 hasta reactivar opt-in. Mesas/eventos no ganan un cap nuevo sólo porque el venue activó staff-aware.
    Siempre exige `duration ≈ endsAt-startsAt` y máximo duro 1440. No hace falta persistir otro marcador en Reservation.
  - Hold acepta `modifierSelections`, usa el MISMO helper, y **`SlotHold` persiste la ventana FINAL más `windowSemantics`** (`null` =
    legacy, `'base'` = nuevo). El consumo exige igualdad exacta del marcador antes de comparar ventanas: un hold `'base'` no puede
    degradarse a create legacy, que volvería a sumar modifiers fuera del cupo retenido. Create vuelve a resolver contra catálogo actual y
    compara la ventana FINAL calculada con la persistida. Un cambio administrativo de duración entre hold y create invalida el hold con
    `APPOINTMENT_WINDOW_CHANGED`, igual que los cambios de horario o mapping permitidos por D4 (§6).
- Widget/consumer/POS/dashboard nuevos mandan `windowSemantics:'base'` solo en sesiones opt-in y dejan de pre-sumar modifiers en
  hold/create; MCP opt-in siempre lo manda porque tool y core se despliegan juntos. Availability sigue recibiendo el param `duration`
  EXISTENTE (D-v5.1-2) como duración FINAL advisory (base + modifiers), sin `modifierSelections`: availability llama
  `resolveCanonicalAppointmentDuration` y dimensiona el slot con `max(canonicalBaseDurationMin, duration ?? canonicalBaseDurationMin)`,
  limitado a 1440. Hold/create son la autoridad. Para construir el request base desde un slot final, el cliente manda
  `baseEndsAt = slot.endsAt - selectedModifierDurationDelta` y `duration = baseEndsAt-startsAt`; no reutiliza `slot.endsAt` como base.
  Cambiar modifiers invalida fecha/slot/hold (§10e).
- **Reschedule es excepción codificada:** conserva `Reservation.duration` final y NUNCA re-suma modifiers ni vuelve a canonicalizar contra
  Product (es el comportamiento actual — "Same service + same extras → duration is fixed", `:1497`). Su hold recibe/deriva una ventana
  FINAL, deja `windowSemantics:null` y se liga con `heldForReservationId`; enviar `'base'` en esta ruta es 400/CERO writes. Su availability
  usa una opción INTERNA `fixedDurationMin = Reservation.duration`, cargada por `reservationId`/cancelSecret bajo tenant auth y jamás
  aceptada del query público. Omite `max(canonicalBase, advisory)` y ofrece exactamente esa duración histórica, aunque Product o modifiers
  hayan cambiado; horario/conflictos se evalúan sobre la ventana fija.
- Availability conserva `productId` legacy y añade `productIds` en DOS encodings equivalentes: CSV (`productIds=a,b`) o keys repetidas
  (`productIds=a&productIds=b`). Un normalizador compartido aplana ambos, separa por coma, trimmea, elimina vacíos, deduplica preservando el
  primer orden y limita a 20. Contrato exacto:
  `canonicalProductIds = normalize(productIds !== undefined ? productIds : productId ? [productId] : [])`; después
  `productId := canonicalProductIds[0]`. Si llegan ambos, el `productId` debe coincidir con el primer ID canonicalizado; mismatch (incluido
  `productIds=[]` + `productId`) → 400/CERO writes. Widget usa CSV; tests HTTP cubren productId-only, ambos coincidentes/conflictivos, ambos
  formatos, duplicados y >20. Availability, hold y create reutilizan esta regla; la intersección de staff usa los IDs canonicalizados.
- `bookedProductIds` se normaliza una vez con esa regla para lógica/validación y `productId := bookedProductIds[0]` se deriva siempre. Se
  conserva además `productIdsWasProvided` **antes** de aplicar fallback: Reservation persiste `productIds=bookedProductIds` dentro del
  create sólo cuando el cliente mandó la lista; un request legacy `productId`-only conserva `productIds=[]` (representación documentada en
  Prisma y shape byte-idéntico). Así el array multi-servicio deja de depender del stamp best-effort post-commit sin reescribir todos los
  singles legacy.
- Todo read posterior usa el helper puro `reservationBookedProductIds(r)`:
  `r.productIds.length ? normalize(r.productIds) : r.productId ? [r.productId] : []`. Si el array no está vacío, exige también
  `r.productId === normalized[0]`; divergencia fail-closed 409 + log (el preflight §16 debe impedirla). Reschedule availability, hold nuevo,
  consume y elegibilidad usan este helper; nunca copian literalmente `Reservation.productIds`, porque una cita single legacy/consumer guarda
  `[]` aunque su servicio sea `productId`.

## 4. Modelos Prisma

Parent = `StaffVenue` (membresía única, `schema.prisma:948`); config con `onDelete: Cascade` (config, no historial).

```prisma
model StaffSchedule {
  id           String     @id @default(cuid())
  staffVenueId String     @unique
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String     // denormalizado; derivado del StaffVenue validado, jamás del body
  weekly       Json       // shape del NUEVO weeklyScheduleSchema (§5a): { "monday": { "enabled": true, "ranges": [{ "open": "09:00", "close": "18:00" }] }, ... }
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  @@index([venueId])
}

model StaffScheduleException {
  id           String     @id @default(cuid())
  staffVenueId String
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String
  startDate    String     // 'YYYY-MM-DD' venue-local (string — anti runtime-tz trap)
  endDate      String     // inclusive
  kind         String     // 'OFF' | 'HOURS'
  startTime    String?    // solo 'HOURS'
  endTime      String?    // solo 'HOURS'
  note         String?
  createdAt    DateTime   @default(now())
  @@index([staffVenueId, startDate, endDate])
  @@index([venueId, startDate])
}

model ProductStaff {
  id           String     @id @default(cuid())
  productId    String
  product      Product    @relation(fields: [productId], references: [id], onDelete: Cascade)
  staffVenueId String
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String
  createdAt    DateTime   @default(now())
  @@unique([productId, staffVenueId])
  @@index([venueId, productId])
  @@index([staffVenueId])
}
```

Adiciones Prisma exactas (además de los tres modelos de arriba):

```prisma
model SlotHold {
  // ...campos existentes...
  staffId                 String?
  staff                   Staff?       @relation(fields: [staffId], references: [id], onDelete: Cascade)
  heldForReservationId    String?
  heldForReservation      Reservation? @relation("ReservationRescheduleHolds", fields: [heldForReservationId], references: [id], onDelete: Cascade)
  windowSemantics         String?      // null=legacy; único valor no-null aceptado: "base"

  @@index([venueId, staffId, startsAt])
  @@index([staffId, startsAt, endsAt])
  @@index([heldForReservationId, expiresAt])
}

model Reservation {
  rescheduleSlotHolds SlotHold[] @relation("ReservationRescheduleHolds")
  @@index([assignedStaffId, startsAt, endsAt])
}

model ClassSession {
  @@index([assignedStaffId, startsAt, endsAt])
}

model Staff {
  slotHolds SlotHold[]
}

model StaffVenue {
  schedule          StaffSchedule?
  scheduleExceptions StaffScheduleException[]
  productStaff      ProductStaff[]
}

model Product {
  productStaff ProductStaff[]
}

model ReservationSettings {
  showStaffPicker Boolean @default(false)
  capacityMode    String  @default("pacing")
}
```

Los índices staff-first soportan el predicado personal cross-venue de §7.5; el índice Reservation venue-first actual no sirve como prefijo.
Son fragmentos a insertar dentro de los modelos existentes, no declaraciones duplicadas.

- Precedencia de horario: `OFF` aplicable cierra el día; sin `OFF`, unión normalizada de las `HOURS` aplicables; sin excepciones, `weekly`;
  sin fila, horario del venue. Evaluación en tz del venue vía string/`fromZonedTime`.
- Elegibilidad en modos nuevos: `Staff.active` AND `StaffVenue.active`.
- `MODEL_TO_DOMAIN` + `npm run schema:map` + SCHEMA_MAP mismo commit. `migrate dev`, jamás `db push`.

## 5. Contratos HTTP de gestión

4 rutas en `src/routes/dashboard/reservation.routes.ts` ANTES de `/:id` (mount padre ya aplica auth + feature gate).

### 5a. Horario por miembro

```
GET  /venues/:venueId/reservations/staff/:staffVenueId/schedule → { staffVenueId, weekly|null, exceptions[] }
PUT  /venues/:venueId/reservations/staff/:staffVenueId/schedule   body { weekly|null, exceptions[] } → reemplazo atómico en tx
```

- Permisos `teams:update`/`teams:read`. Tenant: membresía del `:venueId`.
- Zod español: `localDateStringSchema` (regex + fecha real por round-trip `yyyy-MM-dd`); `endDate >= startDate`; `kind` enum; horas con
  `timeStringSchema` + `endTime > startTime` (requeridas en `HOURS`, prohibidas en `OFF`); máx 30 exceptions. **`weekly` usa un
  `weeklyScheduleSchema` NUEVO y REQUERIDO** (mapa de 7 días, `ranges[].open/close`, máx 3 rangos/día) — extraído del actual
  `operatingHoursSchema`, que termina en `.optional()` (`reservation.schema.ts:24`) y se queda como wrapper solo para settings. **Semántica
  de `weekly:null` (definida):** borra la fila `StaffSchedule` en la misma tx (reset a horario del venue — §4: "sin fila, horario del
  venue"; el modelo conserva `weekly Json` requerido porque una fila sin weekly no significa nada); `exceptions` se reemplazan
  independientemente en la misma tx (un staff puede tener excepciones sin weekly propio).
- ActivityLog `STAFF_SCHEDULE_UPDATED` (actor de authContext, fire-and-forget fuera de tx).

### 5b. Quién realiza cada servicio

```
GET  /venues/:venueId/reservations/products/:productId/staff → { productId, staffVenueIds[], explicit }
PUT  /venues/:venueId/reservations/products/:productId/staff   body { staffVenueIds[] } → reemplazo atómico; [] borra
```

- Permisos `menu:update`/`menu:read` (los del CRUD de servicios — `dashboard.routes.ts:1139`). Producto del venue + `APPOINTMENTS_SERVICE` +
  membresías activas. ActivityLog `SERVICE_STAFF_UPDATED`.
- Opt-in: `[]` = cero elegibles = no reservable (deshabilitar sin otro flag). Legacy: sin filas = "todos".
- **Tests de tenant isolation obligatorios para ambos CRUD:** `staffVenueId` de otro venue, `productId` de otro venue, array mixto
  (propios + ajenos → 400 y CERO writes), membresía inactiva, y rollback atómico (fallo a mitad del reemplazo no deja estado parcial). Los 3
  modelos denormalizan `venueId` — el aislamiento se prueba, no se asume.

## 6. Ciclo de vida del hold (cierra P0-3 y P0-4)

**Garantía acotada (decisión D4, alcance explícito):** un hold vigente garantiza **capacidad global** — el checkout nunca falla por cupo ni
porque el operador haya sobre-llenado después. La garantía está **sujeta a invalidación administrativa**: si entre hold y consumo un admin
des-mapeó al staff, cambió su horario/estado o la duración de un producto/modifier, o un evento de calendario lo bloqueó, el consumo
revalida la ventana FINAL, elegibilidad y conflicto personal y puede dar 409 (raro y correcto — la alternativa exige congelar
catálogo/config dentro del hold y acopla todo el admin al booking). Perder entitlement `RESERVATIONS` también invalida comercialmente el
checkout; el hold garantiza capacidad, no acceso al plan. Cambio de duración usa `APPOINTMENT_WINDOW_CHANGED` (§3b); los demás, el 409
específico existente.

1. `bookedProductIds` normalizado (§3b); igualdad hold↔booking por IDs canonicalizados.
2. **Crear hold de booking nuevo** (`holdAppointmentSlot`): migra a `withSerializableRetry` (hoy usa `prisma.$transaction` simple —
   `reservation.public.controller.ts:2162`). Lecturas sin lock (settings §8b, resources, `resolveAppointmentWindow` §3b); luego del
   `SET LOCAL lock_timeout`, `pg_advisory_xact_lock` es la primera operación de lock. Persiste `windowSemantics` junto a la ventana FINAL
   (§3b). AQUÍ se gatea la capacidad self-service (§13): el hold nace solo si hay cupo — por eso puede garantizar. `staffId` explícito →
   validar y guardar; sin staff y `shouldAutoAssign` → resolver candidato bajo el lock; legacy → `staffId:null`. **El endpoint restringe
   `productIds` a `APPOINTMENTS_SERVICE` y rechaza holds sin producto y sin `classSessionId`** (hoy la rama else `:2303-2330` mintea holds
   genéricos que contaminan la ocupación appointment y bloquearían el setup gate §7a; tarea del hijo #2: grep de los 6 clientes confirmando
   que nadie crea holds sin producto antes de cerrar la puerta). **Hold de reschedule (rama separada, NO llama
   `resolveAppointmentWindow`):** después de adquirir el mismo advisory lock, re-lee la `Reservation` del venue con row lock, valida
   estado/reschedule policy, conserva `Reservation.duration` FINAL y deriva `endsAt = startsAt + duration`; si el body aún trae `endsAt`,
   debe coincidir ±1 min. Fija `heldForReservationId = reservationId`, `windowSemantics = null`, staff desde la reserva y productIds vía
   `reservationBookedProductIds(R)` (nunca del body) y excluye esa reserva del conteo (el flujo actual ya lo hace en `:1574`). Bajo el mismo
   advisory lock, el orden es obligatorio: bloquear/localizar sibling vivo de esa reserva → borrarlo → gatear el nuevo target → insertar el
   reemplazo. Si el gate falla, el rollback restaura el sibling; si se contara antes de borrarlo, pacing=1 bloquearía erróneamente
   reemplazar H1 por H2 en un target igual/solapado. Nunca quedan dos tokens vivos. Toda mutación posterior de R que cambie
   `startsAt`/`endsAt`/`duration`/`productId`/`productIds`/`assignedStaffId` adquiere los mismos locks en orden
   `venue advisory → Reservation FOR UPDATE → SlotHold` y borra `where heldForReservationId=R.id` en ESA tx. Los status writers dispersos no
   se refactorizan todos: el conteo de capacidad, disponibilidad, allocator y `assertOrganizationStaffAvailability` comparten UN predicado
   `isLiveSlotHold(checkedAt)`: `expiresAt > checkedAt AND (heldForReservationId IS NULL OR parent.status IN ('PENDING','CONFIRMED'))`; la
   implementación hace LEFT JOIN a `heldForReservation`. Consumo siempre row-lockea/revalida R. Así una cancelación/status writer puede
   dejar como máximo una fila lazy-cleanup hasta el TTL, pero produce CERO ocupación fantasma global o personal, sin tocar jobs/webhooks ni
   añadir versionado.
3. **Fast-fail pre-tx con `holdId`: SOLO existencia y expiración.** Nada de capacidad ni comparación de ventanas fuera de la tx — el guard
   del controller (`:747-764`) SE SALTA cuando viene `holdId` (hoy re-cuenta reservas y rompería la garantía si el operador sobre-llenó; y
   la comparación actual `:2373` fallaría con `windowSemantics:'base'` + extras).
4. **Consumir DENTRO de la tx:** booking normal usa `venue advisory → SlotHold FOR UPDATE`; reschedule usa el orden único
   `venue advisory → Reservation FOR UPDATE → SlotHold FOR UPDATE` (el request ya identifica R), evitando el deadlock update-R/consume-hold.
   Valida venue. Inmediatamente DESPUÉS de obtener la fila bloqueada captura `checkedAt = new Date()` y compara
   `hold.expiresAt.getTime() > checkedAt.getTime()` en JS; **nunca SQL `now()`** (PostgreSQL está en hora México, `DateTime` guarda UTC, y
   `now()` además se congela al inicio de la tx). Booking normal exige **igualdad exacta
   `request.windowSemantics ?? null === hold.windowSemantics`** y después ventana según ese marcador (legacy: CRUDAS raw↔raw con igualdad
   estricta, como hoy `:2391`; `'base'`: recalcular con `resolveAppointmentWindow` y comparar FINALES server-side contra la ventana FINAL
   persistida del hold — §3b), `bookedProductIds` (columna real: `SlotHold.productIds`, `schema.prisma:9786`), staff consistente (booking
   sin staff hereda `hold.staffId`; explícito debe coincidir), y **`heldForReservationId` con match exacto**: create normal exige `null`;
   reschedule de R exige `=== R.id`, `hold.windowSemantics === null`, R aún reprogramable y ventana contra `R.duration` final (un token
   minteado excluyendo a R1 no puede mover a R2 — eso sobrevendería el slot). Si cambió una identidad de R, la mutación borró el hold; si
   cambió solo el status mediante un writer existente, la fila puede seguir hasta TTL pero la revalidación la rechaza. Ambos consumos
   dan 409. **Capacidad global NO se re-verifica** (el hold es el cupo). Elegibilidad/conflicto personal del staff SÍ: la condición es
   `isStaffAware(settings) || hold.staffId != null`, de modo que apagar settings durante checkout no omite la revalidación del contexto
   opt-in minteado. No re-autoasigna. `DELETE` del hold EN LA MISMA tx, más cualquier sibling con el mismo `heldForReservationId` (defensa).
   Inexistente/expirado/consumido/mismatch → 409 español.
5. Sin hold: capacidad + asignación dentro de la tx del create (§8/§13).

## 7. Validación de elegibilidad

`assertStaffEligible(tx, { venueId, staffId, productIds, startsAt, endsAt, excludeHoldId?, excludeReservationId? })` en
`appointmentStaffAssignment.service.ts` — se invoca para appointments `isStaffAware`, siempre dentro de la tx y después de la ventana final.
Con opt-in apagado, los paths legacy conservan sus validaciones actuales de ownership/overlap y no adoptan silenciosamente horarios ni
mappings nuevos. El sub-helper
`assertOrganizationStaffAvailability(tx, { organizationId, staffId, startsAt, endsAt, excludeReservationId?, excludeHoldId?, excludeClassSessionId? })`
corre para todo create/hold/bulk con staff y para updates que cambian `startsAt`/`endsAt`/`duration`/`assignedStaffId`; una edición sólo de
`capacity`/`internalNotes` de ClassSession no revalida un intervalo que ya ocupa (§7.5):

1. Membresía activa (`StaffVenue.active` AND `Staff.active`).
2. Productos del venue y `APPOINTMENTS_SERVICE`. Reservas no-appointment: NO invocan autoallocator, ProductStaff ni horario nuevo; conservan
   membresía sola como elegibilidad (`:191-196`). **Pero si llevan `assignedStaffId`, siempre invocan `assertOrganizationStaffAvailability`
   dentro de `withSerializableRetry`**: que el candidato sea legacy no permite escapar del predicado personal contra una cita/clase/hold
   concurrente.
3. Multi-servicio: intersección de `ProductStaff` de TODOS los `productIds` (regla §7a por producto); un `assignedStaffId` para todo, libre
   la duración combinada. Staff por segmento fuera de alcance.
4. En horario según schedule/excepciones: `OFF` cierra; si hay `HOURS`, la ventana FINAL completa debe caber en su unión normalizada; si no,
   usa `StaffSchedule.weekly`; **sin fila weekly usa `ReservationConfig.operatingHours` del venue**. Nunca significa "pasa". Las excepciones
   sin weekly propio se aplican sobre ese fallback del venue (§5a).
5. Sin conflicto con `ExternalBusyBlock` personal, **cualquier Reservation activa** solapada que tenga ese `assignedStaffId`, holds activos
   de ese staff ni `ClassSession.status='SCHEDULED'` asignada — **por `Staff.id` en toda la organización, sin filtro al venue actual**.
   Incluir toda Reservation preserva el bloqueo legacy de mesas/eventos del venue; no se estrecha accidentalmente a products appointment.
   Horario/ProductStaff siguen siendo locales al `StaffVenue`. Excluye `excludeReservationId` (la propia reserva al editar; el código actual
   ya lo hace en `:1218`/`:1235`) y `excludeHoldId`. `assertOrganizationStaffAvailability` encapsula este predicado y lo reutilizan las
   mutaciones que crean o cambian ocupación personal de Reservation/ClassSession/SlotHold, incluidas las legacy, para que venue B, una clase
   o un hold no escapen del SSI de una cita opt-in en venue A (§8c). Para cumplir tenant isolation, recibe el `organizationId` validado del
   venue actual y deriva los `venueId` con `StaffVenue.staffId` + `Venue.organizationId` (filas activas o inactivas); todos los queries de
   conflictos filtran ese set/organización y devuelven sólo existencia/booleano, jamás confirmationCode, venue ni datos de la otra sucursal.
   **No consulta compromisos de otra organización**: eso violaría la regla absoluta del repo (`.claude/rules/critical-warnings.md:19-22`).
   `ExternalBusyBlock` personal conserva su alcance platform-wide existente (`external-busy-block.service.ts:17-25`); este epic no amplía
   esa excepción.

**Invariante al borrar membresía:** el soft-delete conserva `StaffVenue`, por lo que el scope anterior sigue viendo sus compromisos.
`hardDeleteTeamMember` sí borra la fila (`team.dashboard.service.ts:1097`) y hoy deja vivo `Staff`; migra a `withSerializableRetry`,
bloquea/revalida la membresía `{ id: teamMemberId, venueId }` y, antes de borrarla, rechaza si en ESE venue existen Reservation
`PENDING|CONFIRMED|CHECKED_IN` con `endsAt > checkedAt`, ClassSession `SCHEDULED` con `endsAt > checkedAt` o `isLiveSlotHold(checkedAt)`
asignados al `staffId`. Los creates de Reservation/ClassSession/hold leen esa misma membresía dentro de `SERIALIZABLE`, así que un create
concurrente o el hard-delete aborta y la closure completa reintenta; no se agrega otro advisory lock. Release A hace preflight tenant-scoped
y falla si ya existe un compromiso futuro asignado sin `StaffVenue` del mismo venue. La consulta read-only de producción del 2026-07-21 dio
0 Reservations y 0 ClassSessions huérfanos; el preflight sigue siendo obligatorio en cada ambiente.

### 7a. Fallback + setup gate TRANSACCIONAL (cierra P0-2, decisión D5)

| Modo             | Servicio sin filas `ProductStaff`                                                   |
| ---------------- | ----------------------------------------------------------------------------------- |
| Legacy (default) | Fallback "todos" (actual)                                                           |
| Opt-in           | Set vacío: cero elegibles, cero slots, omitido de `staffByProductId`. Jamás "todos" |

**La transición off→opt-in de `showStaffPicker`/`capacityMode` corre COMPLETA dentro de `withSerializableRetry` + el mismo advisory lock del
venue** (el update actual es read + upsert sin tx — `reservationSettings.service.ts:271` — y tendría TOCTOU contra creates concurrentes):
re-leer settings → validar que todo servicio `APPOINTMENTS_SERVICE` activo tenga ≥1 mapping → adquirir el lock → capturar
`checkedAt = new Date()` → buscar con parámetros Prisma/UTC citas appointment activas sin staff con `endsAt > checkedAt` → **rechazar si
existen holds appointment vivos con `staffId:null` y `expiresAt > checkedAt`** ("hay clientes reservando en este momento; intenta en unos
minutos") → guardar. Nunca interpolar SQL `now()` para columnas `DateTime`. Cada rechazo = 400/409 español con lista accionable (servicios
sin mapear / confirmationCodes de citas sin staff). Tests concurrentes obligatorios: activation-vs-create y activation-vs-hold (uno gana,
estado final consistente). Después de activar, el guard no es el invariante (§5b `[]` y servicios nuevos sin mapear = no reservables).

## 8. Concurrencia y origen de la mutación

### 8a. `writeOrigin` — obligatorio, sin default

`Reservation.channel` es atribución (MCP no lo manda y persiste `DASHBOARD` `:403`; un `WEB` editado por recepción sigue `WEB`) — NO es
política. Parámetro interno NO persistido, **OBLIGATORIO en el core** (sin default — si tiene default, "cada entrypoint lo fija" es
mentira):

```
writeOrigin: 'PUBLIC' | 'CONSUMER' | 'DASHBOARD' | 'MCP'
```

- `DASHBOARD` = clientes operados por staff: web, **desktop**, iOS POS, Android POS (todos entran por `/dashboard`).
- `MCP` = self-service (políticas completas; cierra el bypass de settings).
- `PUBLIC`/`CONSUMER` solo aceptan selección directa `staffId` (hold/create sin token) cuando `showStaffPicker === true` y el entitlement
  `RESERVATIONS` está vigente; si llega con el picker apagado se rechaza con 400 y CERO writes (no se ignora ni se convierte silenciosamente
  a "cualquiera"). **Excepción de rollback de settings:** un `holdId` vivo minteado previamente puede heredar o repetir EXACTAMENTE
  `hold.staffId` aunque el picker se apague durante sus 10 min; el core exige el hold válido. Esta excepción NO salta el middleware Feature:
  si se pierde `RESERVATIONS`, el checkout se invalida. Dashboard conserva su asignación operada y MCP su selección autorizada.
- **Todos los callers internos del core se actualizan en el MISMO commit.** Verificados hoy: controllers dashboard/público/consumer, MCP, y
  `liveDemo.service.ts:532` (fija `PUBLIC` — su comment dice "customer self-service, same as the real booking widget"). Tarea del hijo #2:
  `grep` de todos los call sites de `createReservation`/`updateReservation`/`rescheduleReservation` antes de mergear.

|                           | Capacidad global (§13)               | Conflicto personal de staff                                                                          | Auto-asignación                                                  |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PUBLIC`/`CONSUMER`/`MCP` | Gate duro (o hold §6)                | Duro siempre                                                                                         | Según `shouldAutoAssign`                                         |
| `DASHBOARD`               | Saltable SOLO con consentimiento §13 | **Duro siempre — el operador puede ignorar el pacing global, JAMÁS empalmar al mismo profesionista** | Según `shouldAutoAssign`; "Sin asignar" en opt-in = "cualquiera" |

`shouldAutoAssign = isAppointmentService && (per_staff || showStaffPicker)`.

### 8b. Settings autoritativos en el core

`getReservationSettings` acepta `TransactionClient`; create/update/reschedule/hold cargan la config dentro de la tx (lectura inicial sin
lock; ausencia de fila = defaults legacy). `resolveAppointmentWindow` y `assertStaffEligible` reciben esa MISMA config, de donde sale
`defaultDurationMin` y el fallback `operatingHours`; nunca vuelven a consultar settings fuera de la tx. `enforceBookingWindow` (con su
exención WALK_IN existente), autoConfirm, depósitos y capacidad deciden tras esa lectura. Config de caller = solo fast-fail.

### 8c. Asignador centralizado

`lockAppointmentVenue(tx, venueId)` + `resolveStaffAssignment(tx, {..., requestedStaffId?, excludeHoldId?, excludeReservationId? })`:

1. Lecturas sin lock → confirmado appointment → `SET LOCAL lock_timeout = '1500ms'` → PRIMERA operación de lock =
   `pg_advisory_xact_lock(hashtext('apt-hold:' || venueId))`. Orden único anti-deadlock. La snapshot SERIALIZABLE puede predatar el lock:
   SSI + retry obligatorios. El timeout acotado evita que el lock bloqueante exceda el timeout de 10 s de la interactive tx; PostgreSQL
   entrega `55P03`, que entra al retry, en vez del `P2028`/500 observado en otros módulos.
2. Con `requestedStaffId`: §7 → asignar o 409.
3. Sin él: candidatos elegibles y libres (busy blocks/Reservations/holds/ClassSessions de TODOS, consulta agrupada; conflictos personales
   cross-venue por `Staff.id`). Orden: menos reservas `ACTIVE_RESERVATION_STATUSES` ese día venue-local ASC → `StaffVenue.startDate` ASC →
   `StaffVenue.id` ASC.
4. `withSerializableRetry` se EXTRAE a un módulo neutral (`src/utils/serializableRetry.ts`) — hoy vive en
   `reservation.dashboard.service.ts:99`, que importa `reservationSettings.service`, así que si settings importara el helper (§7a) habría
   import circular (hazard que el propio archivo ya documenta en `:23-24`). Predicado `isRetryableDbError(err)`: `P2034` top-level (lo único
   que se reintenta hoy), SQLSTATE `40001`/`55P03` directos, **y `P2010` cuyo `meta.code`/causa interna sea `40001`/`55P03`** ($queryRaw
   envuelve el SQLSTATE; hoy NADA lo normaliza — cero hits de `P2010` en `src/`, verificado). Test de integración con contención PostgreSQL
   real. Cada retry re-adquiere lock y re-resuelve. Agotados → 409.
5. Layer 1b (NOWAIT) queda como defensa; el árbitro es lock + validaciones en tx + SSI. No hace falta otro advisory lock por staff: TODOS
   los writes que crean o cambian ocupación personal Reservation/ClassSession/SlotHold — legacy u opt-in, en cualquier venue de la
   organización — leen el mismo predicado dentro de `SERIALIZABLE`; dos venues o clase↔cita que eligen a la misma persona forman el
   conflicto SSI, uno aborta y la closure completa reintenta. `classSession.dashboard.service.ts` create/update/bulk migra al mismo retry;
   create/bulk siempre invocan el helper, y update sólo cuando cambia intervalo/staff, usando valores efectivos y `excludeClassSessionId`
   (sin gate de pacing/ProductStaff). En **cada intento** de update, la closure relee la ClassSession tenant-scoped con `FOR UPDATE`,
   revalida status/capacity/membresía y recomputa `effectiveStartsAt`/`effectiveEndsAt`/duration/`updateData`; nada derivado del `session`
   pre-tx queda capturado fuera. Así dos updates parciales concurrentes (start vs end) no persisten un intervalo invertido tras retry. Bulk
   además rechaza overlaps internos del lote antes de escribir. Test PostgreSQL real A/B/clase obligatorio (§15).

**Regla transversal de reloj:** todo cutoff de `Reservation.endsAt`/`SlotHold.expiresAt` usa un `checkedAt = new Date()` capturado después
de los locks que pudieron esperar y pasado como parámetro Prisma/SQL. Nunca `NOW()`/`CURRENT_TIMESTAMP` contra `DateTime` del repo; para un
comando puramente psql se usa `clock_timestamp() AT TIME ZONE 'UTC'` (§16).

## 9. Booking por write path

| Path                        | Cambio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create PUBLIC               | staffId + mapeo; productIds explícitos atómicos en el create (productId-only conserva `[]`); hold garantizado o gate §13; `resolveAppointmentWindow` + `windowSemantics` §3b                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Create CONSUMER             | Ídem (schema, tipo, literal `:296-313`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Create DASHBOARD            | Ya manda `assignedStaffId`; §8a + consentimiento §13; clientes nuevos usan `'base'`, legacy queda raw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Create MCP                  | `staffId` exacto + `staffName` (único → usa; si no → candidatos); settings y ventana autoritativa en core; en opt-in el tool fija `windowSemantics:'base'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Update DASHBOARD/MCP        | Conserva la validación existente `duration ≈ endsAt-startsAt` (`reservation.dashboard.service.ts:1181-1189`) y la personalización operada de duración, con el cap forward-compatible de §3b. En opt-in, el set `productId`/`productIds` es inmutable: cambio → 400, cancelar+recrear. En legacy se conserva el cambio single-service sin dejar columnas divergentes: tras validar ownership/tipo, si el array está vacío, actualiza `productId` y conserva `productIds=[]`; si tiene exactamente uno, actualiza atómicamente lead + `[nuevoId]` (o ambos a null/`[]`); si ya hay >1 servicios, cambiar el lead se rechaza 400, no descarta silenciosamente el resto. Si cambia tiempo/duración/staff revalida §7/§13 con `excludeReservationId`; cualquier cambio permitido de tiempo/duración/product/staff invalida holds §6. |
| Reschedule PUBLIC/DASHBOARD | **Conserva SIEMPRE al staff actual (D-v5.1-3).** En opt-in, availability de reschedule pasa el staff actual + `excludeReservationId` + `fixedDurationMin` interno §3b; staff inelegible en la nueva fecha → cero slots + empty-state accionable ("el profesionista no tiene horario disponible; reasigna desde el detalle de la cita"). Reasignar staff va por Update (fila de arriba, ya revalida §7/§13 con `assignedStaffId`) — `allowStaffReassignment` FUERA de alcance (§18). **Dos entrypoints ops (verificados):** `rescheduleAppointmentReservation` (hoy gatea pacing duro `:1508-1520` → adopta §13 confirmable para DASHBOARD, 409 duro MCP) y `rescheduleReservation`→`updateReservation` (hoy SIN gate de pacing → en opt-in adopta §13 al cambiar startsAt/endsAt; en legacy queda como hoy)                     |
| Reschedule con hold         | §6.4 — FOR UPDATE + `heldForReservationId === reservation.id` + consumo en la misma tx                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Respuestas: cero campos removidos; `staffId`, `staffAssignmentChanged`, `overCapacity` opcionales, omitidos si no aplican.

## 10. Exposición al cliente final

### 10a. `/public/venues/:slug/info`

Dos keys aditivas e independientes:

- `appointmentWindowSemantics:'base'`, OMITIDA salvo `isStaffAware(settings)` **y**
  `venueHasFeatureAccess(venueId, 'RESERVATIONS') === true`. Es capability de wire, no Feature/flag/config nuevo.
- `staffSelection`, OMITIDA salvo que además `showStaffPicker === true`. Shape:
  `{ enabled, staffByProductId: { productId: [{id, name, photoUrl}] } }`. Whitelist estricto; `id` = `Staff.id` siempre (los §5 usan
  `staffVenueId`).

Así `per_staff` sin picker negocia ventana base pero no filtra roster ni añade un paso UI. El GET `/info` permanece público para datos
generales; se condicionan sólo estas keys, no se monta el gate sobre toda la ruta. Controller resuelve entitlement una vez y lo pasa al
serializer compartido public/consumer; relaciones en el query del venue (sin N+1). Test obligatorio con venue FREE **no-exempt** que
conserva settings opt-in tras downgrade: respuesta 200 sin ninguna key. Grandfather/demo NO sirve porque el resolver les concede todo. El
downgrade tampoco mintea ni consume holds: perder entitlement no usa la excepción acotada de settings de §8a.

### 10b. Consumer app

Amplía `GET /consumer/venues/:slug` (`client.ts:74` → `venue.consumer.service.ts:80`) con las mismas dos keys y exactamente las mismas
condiciones. El create ya usa `requireReservationsPlan`; el read no se bloquea completo.

### 10c. Dashboard web (+ contrato de sobre-cupo)

`CreateReservation.tsx:207` carga roster completo — #4 lo filtra por servicio + disponibilidad (no elegible = deshabilitado con motivo).
**Sobre-cupo (corrige el claim falso de v4):** availability HOY descarta slots llenos (`reservationAvailability.service.ts:267-270` hace
`continue`) — el operador no puede "ver ocupación" ahí. **D-v5.1-4:** availability acepta `includeFull?: boolean` (query, opt-in). `FULL`
significa UNA sola cosa: todos los checks duros pasaron y únicamente falló el gate global saltable de §13. Por tanto, antes de emitir un
slot `FULL` se evalúan horario del venue/staff, ProductStaff, `Staff.active`/`StaffVenue.active`, busy blocks, conflicto personal, incluidas
Reservations/holds/ClassSessions, tables/product capacity y existencia de candidato; cualquiera de esos fallos mantiene el slot OMITIDO.
Solo después se evalúa pacing global: lleno + `includeFull=true` → `available:false` + `reason:'FULL'`; sin el param, respuesta idéntica a
hoy. Test combinado obligatorio: pacing lleno + staff solicitado ocupado NO devuelve `FULL`. El contrato de consentimiento sigue siendo §13:
la UI intenta crear, recibe `409 OVER_CAPACITY_CONFIRMATION_REQUIRED` con preview, muestra "Horario lleno — ¿sobre-agendar?" y reintenta con
`allowOverCapacity:true`. Sin preflight frágil, sin carrera (el POST es la autoridad; el slot marcado es solo descubrimiento). Ante
`APPOINTMENT_WINDOW_CHANGED`, limpia slot/hora y refetch de producto/modifiers + availability antes de reintentar, igual que §10e.

### 10d. iOS + Android POS (#7/#8 — JUNTOS) y Desktop (#9)

Mismos contratos que 10c en `CreateReservationSheet.swift`, módulo `reservations/` de Android y el create dialog de desktop
(`AvoqadoApi.kt:521` ya consume availability con staff). **Android y Desktop create son SLOT-ONLY (verificado: `DateTimeSection.kt:131-154`
sin TimePicker en create; `ReservationsScreen.kt:1023` exige `selectedSlot` — web tiene TimePicker manual e iOS es 100% manual sin consumir
availability)** — por eso #8/#9 mandan `includeFull:true` y pintan los slots llenos como "lleno"; al tocarlos → create → 409 §13 →
confirmar. iOS llega al 409 natural por su hora manual. Comportamiento visible equivalente; los tres compilando. POS/desktop viejos en venue
opt-in: crean normal con cupo; al sobre-cupo ven el 409 en español (comportamiento conocido hasta actualizar; en modo legacy no cambia
nada). Los clientes nuevos aplican el mismo recovery de catálogo/slot ante `APPOINTMENT_WINDOW_CHANGED`; no reenvían la hora stale.

### 10e. Contrato de estado — widget y consumer

Orden opt-in: Servicio(s) → Profesionista → Fecha → Hora → Datos. Sin `staffSelection` → paso omitido; la presencia de
`appointmentWindowSemantics:'base'` sigue activando el wire base aunque ese paso no exista. `selectedStaffId: string|null` (`null` =
"cualquiera" con `shouldAutoAssign`). Multi-servicio: **SOLO widget** (ya tiene `selectedProducts`); **consumer queda single-product este
epic** (verificado: `index.tsx:124` un solo `selectedProduct`, cero estado multi en el repo — generalizarlo es scope creep). Intersección
por `Staff.id`; vacía = mensaje + no continuar. Cambiar productos limpia staff/fecha/slot/hold; cambiar staff limpia fecha/slot/hold;
**cambiar modifiers limpia fecha/slot/hold** (la duración cambia). Availability manda `staffId` solo si eligió; hold/create el mismo;
"cualquiera" lo omite y hereda del hold. Respuesta del hold += `staffId?` ("Te atenderá X"). En transiciones in-app, "limpiar hold"
significa un helper único `await releaseHold()` antes de borrar token o pedir/mintar otro; si falla conserva token y bloquea el siguiente
hold con retry visible. Sólo unload/cierre de pestaña queda best-effort porque el navegador no garantiza await. En opt-in, clientes nuevos
mandan `windowSemantics:'base'`, derivan `baseEndsAt` restando al `slot.endsAt` final el delta de modifiers (§3b). Recovery de
`APPOINTMENT_WINDOW_CHANGED`, en este orden: (1) invalidar slot; (2) si existe `holdId`, **await** del DELETE idempotente
`/reservations/hold/:holdId` (204) antes de borrar el token local; si falla, conservar token, mostrar retry y NO continuar/mintear otro
hold; (3) refetch de venue/productos/modifiers, reconciliar selección (si desapareció/inactivó una opción, quitarla y avisar); (4) pedir
availability/recalcular base, sin perder datos personales. Fire-and-forget dejaría el hold stale bloqueando cupo/staff hasta TTL. No
reintentan con catálogo stale ni confían sólo en `expectedBaseDurationMin`, evitando loop si Product cambió 45→60 durante la sesión. Compat
bidireccional: cliente nuevo + server viejo → sin `appointmentWindowSemantics`, camino legacy; cliente viejo + server nuevo → camino legacy
byte-idéntico.

## 11. Return URLs del widget — anti open-redirect

`new URL()`; solo `https:` (+ localhost/127.0.0.1 en development); hostname `avoqado.io` exacto o `endsWith('.avoqado.io')` (nunca
`includes`) o hostname exacto del `website` del venue. Inválido → se IGNORA (default, no 400). Redirect con `URL.searchParams.set`. Tests:
`javascript:`/`data:`/no-HTTP/`evilavoqado.io`/hosts ajenos ignorados; subdominio/website/localhost-dev aceptados.

## 12. Settings, check-in y MCP

- DB flat; `ReservationConfig` expone `scheduling.capacityMode` + `publicBooking.showStaffPicker`; 3 mappings (`!== undefined`) +
  `getDefaultConfig`; **dominio formal:** Prisma `String @default("pacing")` + Zod `z.enum(['pacing','per_staff'])` (patrón de la casa:
  `depositMode` `schema.prisma:9912` ↔ `z.enum` en `reservation.schema.ts:40`);
  `isStaffAware = capacityMode === 'per_staff' || showStaffPicker === true`; `capacityMode` desconocido en DB → `pacing`; NO-cobro en el
  guard; transición opt-in = §7a transaccional; round-trip test ambos formatos.
- Check-in: `servedById` desde `assignedStaffId` solo en rama de orden nueva y solo si no es null; idempotente intacta; best-effort intacto;
  ActivityLog solo `{created:true}`. DECISIÓN FOUNDER APROBADA (2026-07-20).
- **MCP lockstep COMPLETO (regla de la casa — paridad de capacidades):** `configure_reservations` (2 campos + labels + setup gate §7a en el
  confirm), `reservation_settings`, `create_reservation` (§9), **y los 4 de gestión nuevos:** `staff_schedule` (read), `set_staff_schedule`
  (write confirm-gated, preview current→new), `service_staff` (read), `set_service_staff` (write confirm-gated). Todos con
  `requirePermission` exacto (`teams:*`/`menu:*`), `venueFilter`, `auditMcpWrite`, gate `planGateMessage('RESERVATIONS')` — Feature
  resolver.
- **Duración MCP sin default fantasma:** hoy `create_reservation` usa `durationMinutes ?? 90` (`src/mcp/tools/reservations.ts:118-139`).
  Para un `APPOINTMENTS_SERVICE` opt-in, el tool resuelve el producto y construye `baseEndsAt` con `resolveCanonicalAppointmentDuration`; si
  el caller mandó `durationMinutes`, debe coincidir o el core devuelve `APPOINTMENT_WINDOW_CHANGED`. El default 90 se conserva únicamente
  para el path legacy sin producto/no-appointment. La lectura del tool es advisory; el core revalida catálogo dentro de la tx.
- **Prohibición de cruce de gates:** ningún path anterior usa `MODULE_CODES`, `moduleService` ni `SERIALIZED_INVENTORY`; el entitlement
  siempre es `RESERVATIONS`. Los serializers public/consumer omiten ambas keys pagadas cuando el resolver Feature da false (§10a-b), aunque
  settings viejos sigan activos.
- Permisos: se REUSAN `teams:read/update`, `menu:read/update`, `reservations:*`; `npm run audit:permissions` exit 0.

## 13. Capacidad — DOS comprobaciones por origen (cierra P0-1 y P0-6)

`assertAppointmentCapacity` corre dentro de la tx tras el advisory lock (creates y cambios de tiempo de appointments), con
`excludeReservationId`/`excludeHoldId`. **Son DOS gates independientes — nunca una fórmula combinada** (la `min(pacing, staffLibres)` de v4
estaba MAL: con A ocupado, B libre y pacing=2 rechazaba la segunda cita):

1. **Gate global:** `ocupaciónGlobal < límiteGlobal` — legacy: `effectiveAppointmentPacing` (piso 1 actual); opt-in: `pacingMaxPerSlot ?? ∞`
   (null deja de colapsar a 1 SOLO en opt-in).
2. **Gate de recurso (solo modos staff-aware):** existe ≥1 candidato elegible y libre (o el solicitado está libre). La ocupación del recurso
   es por-staff, no global.

- Self-service (`PUBLIC`/`CONSUMER`/`MCP`): ambos gates duros. Con hold vigente: gate global NO se re-verifica (§6); gate de
  recurso/elegibilidad sí.
- `DASHBOARD`: **gate global saltable con consentimiento previo al write** — slot lleno + `allowOverCapacity` ausente o `false` → NO
  escribe, `409 OVER_CAPACITY_CONFIRMATION_REQUIRED` + preview legible; el cliente confirma y reintenta con `allowOverCapacity:true` →
  escribe y responde `overCapacity:true` (patrón confirm-gate de la casa, sin carrera preflight-create). En modo LEGACY el dashboard sigue
  exactamente como hoy (sin gate, flag ignorado). **El gate de recurso jamás es saltable: sobre-agendar es exceder el pacing global, nunca
  empalmar al mismo profesionista.** El reschedule ops actual (que hoy sí gatea, `:1509-1520`) adopta el mismo contrato confirmable para
  `DASHBOARD` y 409 duro para MCP (cambio deliberado, con test).
- **Bugfix de conteo (documentado, con test):** `countAppointmentOccupancy` hoy cuenta TODA reserva no-clase
  (`reservationAvailability.service.ts:39-58` solo filtra `classSessionId:null`) — incluye MESAS y EVENTOS → falsos 409 en venues híbridos.
  El conteo pasa a filtrar por producto `APPOINTMENTS_SERVICE` (join por `productId`; reservas de mesa puras — `productId:null` — quedan
  fuera). Holds: siguen contando los de `classSessionId:null` (nacen solo del flujo appointments).
- **Semántica del conteo (definida):** `ocupaciónGlobal` = conteo CONSERVADOR por overlap — toda fila activa que toca la ventana candidata
  cuenta (el `countAppointmentOccupancy` actual, `:39-68`), NO la concurrencia máxima por instante. Dos reservas consecutivas de 30 min
  cuentan 2 contra una candidata de 60 aunque nunca coexistan — es el comportamiento de hoy y cambiarlo alteraría los baselines legacy. Test
  del caso staggered asserting esta semántica.
- **Envelope de los 409 recuperables (end-to-end):** `ConflictError` gana `code?` y `details?` (hoy solo acepta message —
  `AppError.ts:38-42`) y el handler global serializa `details` cuando exista (`app.ts:382-386` hoy serializa `code` pero NO `details`; de
  paso se corrige el doc-comment engañoso de `TerminalBrandChangeBlocked` que afirma lo contrario). Capacidad responde
  `{ message, code: 'OVER_CAPACITY_CONFIRMATION_REQUIRED', details: { preview } }`; cambio de ventana responde el envelope
  `APPOINTMENT_WINDOW_CHANGED` de §3b. Los seis clientes permiten ambos códigos explícitos (sin reflejar `details` arbitrarios). Los cuatro
  clientes staff-side implementan la confirmación; **los seis** implementan recovery `APPOINTMENT_WINDOW_CHANGED` con refetch de
  producto/modifiers + recarga de ventana (detalle widget/consumer en §10e).
- El guard del controller público (`:747-764`) queda como fast-fail SOLO sin `holdId` (§6.3).
- Availability staff-aware carga `ExternalBusyBlock`, Reservations, holds y `ClassSession.SCHEDULED` de TODOS los candidatos; el busy
  personal es cross-venue, pero la respuesta nunca expone la fuente/venue del bloqueo.
- En cualquier cliente que tenga `holdId`, el recovery de ventana sigue el release awaited de §10e; el 409 del create no quema el hold
  porque promete CERO writes.

## 14. Grafo y esfuerzo

```
#1 Modelos + CRUD + motor + CI (~20h) ─→ #2 Booking + holds + windowSemantics + concurrencia + rollout A/B (~28h) ─→ #3 Settings + check-in + MCP (~11h)
                                                                                                          │ (deploy server → estable)
                                            ┌──────────────┬──────────────┬─────────────┼──────────────┬──────────────┐
                                      #4 Dashboard    #5 Widget     #6 Consumer    #7 iOS POS    #8 Android POS   #9 Desktop
                                         (~10h)         (~10h)         (~8h)         (~8h)          (~8h)           (~8h)
```

#2 produce dos artefactos desplegables A/B (§16); no se activa settings entre ambos. #7 y #8 se entregan JUNTOS. #9 desktop es cliente real
de reservas (31 refs en `AvoqadoApi.kt`) — declarado en alcance. Ownership anti-hueco: #1 entrega modelos/índices, helper organization-wide
y migración de ClassSession/hard-delete; #2 conecta Reservation/SlotHold, protocolos, preflights y rollout A/B. Ningún hijo puede declarar
listo su write path sin los tests PostgreSQL compartidos de §15.

## 15. Plan de pruebas y comandos (autocontenido)

| Capa                                                                | Prueba                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                                                | `resolveAppointmentWindow`: producto 60 + request 5 → `APPOINTMENT_WINDOW_CHANGED` en `'base'` y como legacy dentro de opt-in; el mismo legacy bajo settings default conserva comportamiento actual; precedencia `duration ?? durationMinutes ?? defaultDurationMin` POR producto, modifiers una sola vez, final 1440 válido/1441 inválido, legacy conserva max 480; dos gates §13 (pacing 1/2/null × staff 1/2 × ocupación); `isLiveSlotHold` con booking normal/reschedule parent PENDING-CONFIRMED/CANCELLED/expirado; predicado personal incluye toda Reservation activa, hold live y ClassSession SCHEDULED; intersección multi-servicio; horario: sin weekly dentro/fuera/atravesando cierre del venue, exceptions OFF/HOURS sin weekly + TZ; `includeFull`: solo pacing falla → FULL, pacing+staff ocupado → omitido; `shouldAutoAssign`; opt-in `[]`; busy blocks; baselines 14/27 intactos; settings round-trip + capacityMode desconocido→pacing; URLs §11                                                                                                                                                                            |
| Integration — contrato (PG real, `tests/integration/reservations/`) | Fila `assignedStaffId`; lista explícita `bookedProductIds` persiste en create atómico y productId-only conserva `productIds=[]`; `reservationBookedProductIds` recupera `[productId]` de esa fila y reschedule/eligibilidad funcionan; normalizador `productId`-only, ambos coincidentes/conflictivos y `productIds` CSV/repetido/dedup/>20; producto 60 + ventana 5 en `'base'` o legacy-opt-in → 409 y CERO writes; MCP producto 60 sin `durationMinutes` → usa 60 (no default 90), explícito 5 → 409; cambio de duración availability→hold y hold→create → `APPOINTMENT_WINDOW_CHANGED`; update sólo de duración conserva la validación actual; crear base 600 → apagar opt-in → metadata/time con `duration:600` funciona, 700 falla, mientras fila legacy <=480 no puede subir a 600; cambio de producto opt-in → 400/CERO writes; cambio legacy single conserva `[]` o sincroniza la lista de uno según representación, y multi-service rechaza cambiar el lead sin perder servicios; reschedule availability conserva `Reservation.duration` en cambios catálogo 60→90 y 90→60; windowSemantics legacy raw↔raw y `'base'` autoritativa. |
| Integration — holds                                                 | Hold persiste ventana FINAL + marcador; `'base'` consumido sin semantics y legacy consumido como `'base'` → 409/CERO writes; fila predeploy null sigue consumible por legacy; reserva base 60 + modifier 15 → hold de reschedule FINAL 75 sin recanonicalizar; token R1 contra R2 y create normal con token de reschedule → 409; reemplazo sibling en target igual/solapado con pacing=1 funciona y fallo restaura H1; update de hora/staff/duración/product borra el token en la misma tx; `APPOINTMENT_WINDOW_CHANGED` no lo quema server-side y DELETE posterior 204 lo libera inmediatamente; cancelación normal y un status update con shape de job/webhook pueden dejar la fila hasta TTL, pero `isLiveSlotHold` la excluye tanto de capacidad como de disponibilidad/conflicto personal y consume da 409; consumo único; operador sobre-llena después del hold → consumo sigue pasando; fast-fail con holdId no consulta capacidad; expirado y hold que expira mientras espera advisory lock → 409 usando reloj UTC post-lock; hold sin producto rechazado.                                                                              |
| Integration — concurrencia                                          | 1/2 staff; pacing=1 con 2 staff; doble create/hold/reschedule; venue A opt-in vs venue B opt-in y A opt-in vs B legacy de la misma organización para el mismo `Staff.id` → solo una cita/hold personal; otra organización no se consulta; cita/ClassSession/hold ya committed y simultáneos, mismo/cross-venue; cita opt-in ↔ Reservation no-appointment legacy simultánea también serializa; ClassSession create/bulk y update de intervalo/staff contra citas/holds, más overlaps internos del lote → un solo resultado válido; dos updates parciales start/end releen por retry y nunca dejan `endsAt <= startsAt`; update sólo de capacity/notes no revalida busy nuevo; hard-delete con compromiso futuro rechaza y hard-delete-vs-create serializa sin huérfano; retries P2034/40001/55P03/P2010-wrapped; advisory retenido >1500 ms reintenta y agota en 409, nunca P2028/500; activation-vs-create/hold; `excludeReservationId`/`excludeClassSessionId`; tenant isolation §5b y conflicto cross-venue no filtra datos.                                                                                                                 |
| Integration — políticas                                             | En opt-in, create PUBLIC/DASHBOARD/MCP y hold fuera del horario del venue con staff sin weekly → 409; opt-in off conserva baseline dashboard; `per_staff` + picker off expone `appointmentWindowSemantics:'base'` pero omite `staffSelection` y autoasigna; public/consumer con `staffId` y picker apagado → 400/CERO writes; apagar picker entre hold→create permite consumir SOLO el token vivo/staff exacto, pero perder Feature lo invalida en middleware; DASHBOARD lleno sin flag → 409 confirmable, con flag → 201+`overCapacity`, PUBLIC/MCP → 409 duro; occupancy ignora mesas/eventos; conteo staggered; `includeFull` con conflicto combinado; `weekly:null`; reschedule conserva staff; public/consumer FREE no-exempt con settings stale → omiten ambas keys nuevas.                                                                                                                                                                                                                                                                                                                                                               |
| Rollout A/B                                                         | Preflight detecta Reservation/ClassSession futura asignada sin StaffVenue, los tres pares de solape personal futuro (Reservation↔Reservation, Reservation↔ClassSession, ClassSession↔ClassSession; self-joins con `a.id < b.id`) y Reservation futura mutable con `productIds` no vacío cuyo primer ID difiere de `productId`. Se repite tras salir pods viejos. Fixtures de hold reschedule pre-migración (`heldForReservationId:null`): single `productId=X/productIds=[]` + hold `[X]`, y multi R `[A,B]` + hold legacy `[A]`; A acepta sólo el shape lead-only exacto y registra métrica, otros mismatch dan 409. Fixture dual-write lleva las 3 columnas + array canónico completo. Tras TTL simulado, B rechaza todo reschedule null y acepta `=== R.id`. Ningún test depende de `createdAt`/`now()`.                                                                                                                                                                                                                                                                                                                                  |
| Clientes                                                            | Step condicional, intersección, resets, "cualquiera", back, sobre-cupo confirmable; todo reset in-app espera release H1 antes del siguiente request; capability base sin picker; cálculo `baseEndsAt = slot.endsAt - modifierDelta`; `APPOINTMENT_WINDOW_CHANGED` hace await DELETE del hold, refetch catálogo y recarga. Caso completo: Product 45→60 con modifier +15 durante sesión elimina H1, obtiene slots y mintea H2 inmediatamente, no loop/espera TTL; fallo de DELETE conserva token y ofrece retry. Compat viejo/nuevo. Automatizado donde ya hay runner (dashboard/iOS/Android/desktop); widget = typecheck+build y consumer = typecheck+smoke porque hoy NO tienen suites, sin fingir cobertura inexistente                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Mocks                                                               | 3 modelos en `setup.ts` Y re-primados en `beforeEach` (`jest.resetAllMocks()` en availability test `:66`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Comandos gate exactos por repo** (todos parten del directorio server actual; `npm ci`/Gradle no modifican source):

| Repo / cwd                           | Gate obligatorio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server `.`                           | `npm ci`<br>`TZ=UTC npx jest tests/unit/services/dashboard/reservationAvailability.service.test.ts tests/unit/services/dashboard/reservation.dashboard.service.test.ts`<br>`npm run test:unit`<br>`export TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test'`<br>`export DATABASE_URL="$TEST_DATABASE_URL"`<br>`npx prisma migrate deploy`<br>`npm run test:integration`<br>`npm run audit:permissions` (exit 0)<br>`npm run schema:map` (`docs/SCHEMA_MAP.md` sin diff pendiente)<br>`npm run pre-deploy`<br>`npm run format && npm run lint:fix` |
| Dashboard `../avoqado-web-dashboard` | `npm ci`<br>`npm run lint`<br>`npm run lint:i18n`<br>`npm run test:run`<br>`npm run build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Widget `../avoqado-booking-widget`   | `npm ci`<br>`npx tsc --noEmit`<br>`npm run build`<br>No existen lint/tests hoy; el checklist manual cubre picker, modifiers, back y ambos errores 409.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Consumer `../avoqado-consumer-app`   | `npm ci`<br>`npx tsc --noEmit`<br>No existen build/lint/test ni CI hoy; smoke obligatorio con `npm run ios` y `npm run android` en simuladores configurados. EAS no es gate hasta reemplazar el projectId placeholder.                                                                                                                                                                                                                                                                                                                                                         |
| iOS `../avoqado-ios`                 | `DEVELOPER_DIR=/Applications/Xcode-26.app/Contents/Developer xcodebuild -project avoqado-ios.xcodeproj -scheme avoqado-ios -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.1' CODE_SIGNING_ALLOWED=NO build`<br>Mismo comando sustituyendo `build` por `test -only-testing:avoqado-iosTests`. No usar scheme `avoqado-ios-prod` para tests.                                                                                                                                                                                                 |
| Android `../avoqado-android`         | `./gradlew :app:lintDebug :app:testDebugUnitTest :app:assembleDebug`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Desktop `../avoqado-desktop`         | `JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home ./gradlew :shared:jvmTest :desktopApp:compileKotlin --no-daemon` (JDK 17; JDK 24 local rompe este Gradle)                                                                                                                                                                                                                                                                                                                                                                                               |

El hijo #1 también cambia `scripts/pre-deploy-check.sh`: al cargar `.env`, NO sobrescribe variables ya presentes en el environment
(precedencia estándar shell > dotenv). Así los dos `export` de la tabla sobreviven dentro de `npm run pre-deploy`; se prueba con una URL
sentinel sin conectarse. El log deja de imprimir `${DATABASE_URL%%@*}` (eso conserva `user:password`) y muestra solo un literal "test DB
configurada", sin URL. El Postgres local/CI se crea previamente con DB `avoqado_test`, user/password `postgres/postgres`;
`export`→`migrate deploy`→`test:integration` son consecutivos y obligatorios. Ningún comando de tests usa la URL de producción.

**CI (`.github/workflows/ci-cd.yml`):** el paso integration vive DENTRO del job `test-and-build`, que SÍ está en `deploy-production.needs`
(`:265-267` — `needs: [test-and-build, unit-tests]`): quitarle el `continue-on-error` y el skip silencioso `exit 0` (hoy `:85-93`) lo hace
gatear producción TRANSITIVAMENTE. Usa **PostgreSQL efímero como service container del job** (sin `TEST_DATABASE_URL` secret compartido —
funciona en forks/Dependabot y elimina colisiones entre PRs) y corre `npx prisma migrate deploy` contra ese contenedor. Si en cambio se
extrae a job propio, DEBE agregarse a `deploy-production.needs` Y a staging. Paso manual documentado en el checklist del hijo #1: marcar el
job como required check en branch protection (editar el YAML no basta).

## 16. Deploy y rollback

- Migración aditiva sin backfill. Render migra en build (`render.yaml:25,80`); Fly demo migra por `release_command` (`fly.toml:20`). Incluye
  índices staff-first §4. Medición read-only 2026-07-21: `Reservation` ≈36 filas/32 kB y `SlotHold` 8 kB, `ClassSession` 8 kB, así que
  `CREATE INDEX` normal es seguro hoy; el release owner repite `pg_relation_size` de las tres antes del deploy y, si hubo crecimiento
  material, cambia sólo esos índices a `CREATE INDEX CONCURRENTLY` y verifica que la migración no tenga `BEGIN/COMMIT` (PostgreSQL lo
  prohíbe dentro de bloque).
- **Rollout forward en dos releases (obligatorio, sin backfill imposible):**
  1. Antes de A, un preflight operacional read-only cuenta (a) Reservation futura activa y ClassSession `SCHEDULED` con `assignedStaffId`
     pero sin `StaffVenue(staffId, venueId)`, y (b) solapes futuros por el mismo `(organizationId, Staff.id)` en los tres pares
     Reservation↔Reservation, Reservation↔ClassSession y ClassSession↔ClassSession — los self-joins usan `a.id < b.id` para no duplicar
     —, y (c) Reservation futura `PENDING|CONFIRMED` con `cardinality(productIds) > 0` y `productId IS DISTINCT FROM productIds[1]`.
     Cualquier conteo
     > 0 bloquea el release y exige resolver cada fila explícitamente (nunca inventar backfill). Release A migra y hace dual-write de
     > `staffId`, `heldForReservationId` y `windowSemantics`; todo hold nuevo ligado persiste `reservationBookedProductIds(R)` completo.
     > Settings nuevos siguen en defaults; todavía NO se despliegan clientes ni se activa opt-in. Para reschedule acepta temporalmente un
     > hold legacy con `heldForReservationId:null` sólo si venue/ventana final/partySize coinciden y sus `productIds` son EXACTAMENTE el
     > shape que escribe el pod viejo: `R.productId ? [R.productId] : []`, **no** el array canónico multi. Así una R `[A,B]` + hold
     > predeploy `[A]` cruza A deliberadamente; es la semántica insegura existente, acotada a la gracia y con métrica/log. Snapshot
     > producción read-only 2026-07-21: 0 huérfanos, 0/0/0 solapes y 0 leads divergentes; no hay backfill manual pendiente hoy, pero ambos
     > preflights siguen siendo gates.
  2. Cuando TODOS los pods viejos salieron, repetir **todos los checks — huérfanos + tres pares de solapes + lead productIds — antes de
     declarar A estable**: un ClassSession writer o `hardDeleteTeamMember` viejo no participaba en el nuevo predicado y pudo insertar/dejar
     un estado inválido durante el rolling. Con sólo pods nuevos, un resultado 0 queda preservado;
     > 0 bloquea B/activación y se remedia explícitamente. Luego registrar ese timestamp del control plane y esperar de forma monotónica
     > `SLOT_HOLD_TTL_MS + 60 s`; no inferirlo de `SlotHold.createdAt`/SQL local. Cumplido el drenaje por TTL, Release B elimina la rama de
     > gracia y exige match estricto `=== R.id`.
  3. Solo tras B estable: dashboard/desktop → widget/consumer → iOS+Android juntos → activar un venue piloto. Compat §3b garantiza clientes
     viejos; ningún cliente nuevo puede crear `'base'` mientras conviven pods viejos.
- **Rollback primario (sin revert):** apagar `showStaffPicker` y volver `capacityMode='pacing'` en los venues afectados. El server conserva
  el protocolo dual, `/info` omite `staffSelection` + `appointmentWindowSemantics` y clientes nuevos vuelven al wire legacy; las
  tablas/columnas aditivas quedan inertes. Holds staff-aware ya minteados conservan su protocolo/staff y pueden consumirse una vez bajo
  §6/§8a; no se crean nuevos holds staff-aware (los holds legacy continúan como hoy). Es la reversa preferida porque no rompe checkouts en
  curso.
- **Rollback de código:** NO hacer un revert ciego del núcleo de holds. Un hold `'base'` creado por el server nuevo persiste ventana FINAL,
  mientras el server viejo compara raw↔raw; durante su TTL de 10 min rechazaría un checkout válido o perdería staff/identidad de
  reschedule. El núcleo forward-only conserva las tres columnas `windowSemantics`/`staffId`/`heldForReservationId`, compare dual, herencia +
  revalidación de `hold.staffId`, match de reschedule (incluida la gracia de Release A si aplica), invalidación y borrado atómico. También
  conserva el schema de update hasta 1440 + cap por fila de §3b: apagar opt-in no vuelve ineditable una Reservation larga ya persistida. Si
  una emergencia obliga a retirarlo también: (1) snapshotear los valores originales y detener GLOBALMENTE nuevos holds normales Y de
  reschedule (`publicBooking.enabled=false` + `cancellation.allowCustomerReschedule=false`; es downtime explícito), (2) esperar
  `SLOT_HOLD_TTL_MS` completo + 60 s de margen, (3) confirmar en una transacción read-only con
  `SELECT count(*) FROM "SlotHold" WHERE "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND ("windowSemantics" IS NOT NULL OR "staffId" IS NOT NULL OR "heldForReservationId" IS NOT NULL)`
  que el resultado sea 0 y solo entonces desplegar el server viejo. `now()` está prohibido aquí por la regla DateTime UTC/raw SQL local.
  Después del deploy se restauran los valores snapshot (no se fuerza `true`). Las tablas huérfanas siguen sin efecto y no se ejecuta down
  migration.
- Seeds: mappings demo explícitos sin tocar venues de baselines. **Cableo exacto (verificado):** el seed wellness solo tiene `Staff.id` a la
  mano (vía `StaffOrganization` — `seed.ts:5371-5376`); `ProductStaff` necesita `staffVenueId`, así que el seed resuelve
  `prisma.staffVenue.findUnique({ where: { staffId_venueId } })` por cada mapping. `demoSeed.service.ts` NO crea citas ni productos
  appointment (verificado, 0 hits) → declarado NO-OP para este feature.

## 17. Historial de auditorías y decisiones

- **1er audit** (workflow interno): GO-with-guardrails, 14 guardrails → v2.
- **2do Codex (4/10) → v2**: contratos/mapeo/hold/concurrencia. Refutado "Fly sin migraciones"; matizado SSI.
- **3er Codex (6/10) → v3/v3.1**: shapes/permisos/integration/inversas; v3.1 introdujo pacing universal defectuoso.
- **4to Codex (4/10) → v4**: 8/8 aceptados (writeOrigin, hold-token, excludeReservationId, setup gate, endsAt, allocator solo-appointments,
  fixes de compilación, CI). Founder D2-D5. + hijos iOS/Android (hallazgo del founder).
- **5to Codex (4/10) → v5: 6 P0 + P1s, 100% verificados y aceptados.** Los P0 eran inconsistencias ENTRE los invariantes nuevos de v4 —
  fórmula de capacidad mal compuesta (mía), TOCTOU del setup gate, fast-fails que rompían la garantía del hold, hold de reschedule sin
  ligar, `windowSemantics` faltante para widgets cacheados, consentimiento inexistente. P1s: alcance de la garantía, occupancy por tipo,
  wire de reschedule, **hijo #9 desktop**, writeOrigin obligatorio + liveDemo, CI efímero, tenant isolation, paridad MCP,
  `weeklyScheduleSchema`, comandos autocontenidos. **Nota de proceso:** el "ENG CLEARED" de v4 fue prematuro — se selló sin someter el texto
  nuevo de v4 a verificación adversarial propia. v5 no agrega semántica nueva: solo reconcilia.
- **6to Codex (4/10) → v5.1: 5 P0 adjudicados contra código en los 5 repos (eng run 3, 2026-07-21).** P0-1 (windowSemantics sin branch en
  §6.4) REAL → compat-primero; P0-2 (availability sin modifiers) REAL → `duration` advisory EXISTENTE (Codex no vio que el param ya está en
  el schema `:89` y el widget ya lo manda); P0-3 (reschedule) PARCIAL → scope a conservar-staff; P0-4 (Android/Desktop slot-only) REAL →
  `includeFull`; **P0-5 REFUTADO** (ausente→409 es decisión consciente coherente con D2, documentada en §10d; su semántica `undefined`=write
  dejaría el gate evadible por omisión eterna del campo). P1s casi todos confirmados e integrados; matices: settings GET mapea
  campo-por-campo (no "siempre defaults"), y el paso CI integration ya gatearía prod transitivamente al quitar el continue-on-error.
  Hallazgos propios del run: la doble-extensión es bug VIVO en prod (`:292-296`), hay DOS entrypoints ops de reschedule con gating distinto,
  y holds genéricos sin producto son minteables hoy (`:2303-2330`).
- **7mo Codex (5/10) → v5.2 (esta): 2 P0 + 6 P1 verificados.** P0-1: la ventana `'base'` era consistente hold↔create pero NO autoritativa;
  producto de 60 min aceptaba request de 5 y rompía el lock personal → helper canónico §3b. P0-2: §2 decía fallback a venue pero §7 decía
  "sin schedule ⇒ pasa" → fallback y tests fuera/atravesando horario. P1: máximo 480 vs Product 1440, encoding `productIds`, precedencia
  `FULL`, entitlement de serializers public/consumer, rollback de holds y comandos multi-repo. La verificación read-only de producción
  confirmó que `SERIALIZED_INVENTORY` es `Module` activo para PlayTelecom, mientras `RESERVATIONS` es `Feature`; copiar el gate habría sido
  doble-gating incorrecto. La auto-asignación **venue-local** con advisory + SSI era correcta; el cierre editorial posterior detectó que la
  promesa organization-wide cross-venue aún no estaba implementada (siguiente punto).
- **Cierre editorial v5.2 (esta edición; no se finge como 8vo audit puntuado):** al integrar el 7mo audit aparecieron contradicciones nuevas
  verificadas contra código: downgrade de protocolo del hold, reschedule recanonicalizado por error (hold y availability), conflicto
  personal solo venue-local y ausente contra ClassSession, `now()` local/congelado para TTL, sibling contado antes de reemplazar, timeout
  P2028, token stale tras identity update/status, parent cancelado que aún ocupaba staff, divergencia legacy `productId`/`productIds`,
  hard-delete que borraba el scope, negociación base acoplada por error al picker, recovery con catálogo stale, update >480 no reversible,
  retry de clase capturando estado pre-tx, pods viejos capaces de dejar huérfanos/solapes, holds pre-migración sin identidad y
  `pre-deploy-check.sh` capaz de pisar la DB exportada/filtrar password. Se cerraron en §3b/§4/§6-§10/§15-§16 sin crear scheduler, Module,
  permiso ni Feature nuevos.
- **Decisiones cerradas (no re-litigar):** PRO bajo RESERVATIONS; servedById prefill; D2 sobre-agendado operador con consentimiento (§13);
  D3 walk-in = origen operador, sin excepción de capacidad; D4 hold = garantía de capacidad global acotada (§6 — plena en `'base'`, ventana
  cruda en legacy §3b); D5 setup gate transaccional; MCP self-service; ventana base con `windowSemantics` versionado; el operador jamás
  empalma al mismo `Staff.id` entre venues de la misma organización (recomendación Codex aceptada); **D-v5.1-1..4** (compat-primero ·
  duration advisory · reschedule conserva staff · includeFull), cerradas por el founder 2026-07-21.
- **Invariantes técnicos v5.2 (sin decisión de producto nueva):** `'base'` deriva duración de catálogo y final máximo 1440; legacy conserva
  max 480; `FULL` solo representa pacing global saltable; horario faltante cae al venue; entitlement=`Feature RESERVATIONS`,
  activación=settings, autorización=permisos; reschedule usa duración histórica; reloj TTL=UTC post-lock; el núcleo
  `windowSemantics`/staff/heldFor no se revierte mientras existan holds/clientes nuevos.

## 18. Out of Scope

Precio/duración por profesionista · staff por segmento · cambiar el set multi-servicio/servicio opt-in en update (el update single-service
legacy compatible de §9 sí se conserva) · eventos huérfanos de Google Calendar al reasignar · tier gating iOS/Android (aparte) ·
nómina/asistencia · **reasignación de staff en reschedule** (`allowStaffReassignment` — la reasignación va por Update; D-v5.1-3) ·
**multi-servicio en consumer app** (single-product este epic; multi solo widget).

## 19. Files Reference (server)

| File                                                                   | Change                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma` + migración                                     | +3 modelos/inversas, ReservationSettings +2, SlotHold +staffId/+heldForReservationId/+windowSemantics/relación; índices staff-first Reservation/SlotHold/ClassSession §4                                                                                      |
| `scripts/generate-schema-map.ts`                                       | +3 modelos                                                                                                                                                                                                                                                    |
| `src/routes/dashboard/reservation.routes.ts`                           | +4 rutas §5 antes de `/:id`                                                                                                                                                                                                                                   |
| `src/controllers/dashboard/reservation.dashboard.controller.ts`        | +4 handlers thin                                                                                                                                                                                                                                              |
| `src/services/dashboard/staffSchedule.service.ts` (nuevo)              | CRUD horario + ActivityLog + tenant tests                                                                                                                                                                                                                     |
| `src/services/dashboard/productStaff.service.ts` (nuevo)               | CRUD mapeo + ActivityLog + tenant tests                                                                                                                                                                                                                       |
| `src/services/dashboard/appointmentStaffAssignment.service.ts` (nuevo) | lock+timeout, elegibilidad/fallback, conflicto personal cross-venue tenant-safe, capacidad 2-gates, writeOrigin matrix                                                                                                                                        |
| `src/services/reservation/resolveAppointmentWindow.ts` (nuevo)         | `reservationBookedProductIds`, `resolveCanonicalAppointmentDuration` compartido con availability + `resolveAppointmentWindow` para hold/create; base canónica, modifiers una vez, final max 1440 y `APPOINTMENT_WINDOW_CHANGED`                               |
| `src/services/dashboard/reservationAvailability.service.ts`            | filtros null-safe, duración canónica+advisory/fixed reschedule, busy organization-wide incluye ClassSession, occupancy pacing solo `APPOINTMENTS_SERVICE`, hard checks antes de `includeFull`                                                                 |
| `src/services/dashboard/reservation.dashboard.service.ts`              | writeOrigin, producto inmutable opt-in + sincronización single legacy §9, hold-token/heldFor + invalidación por identity update, `isLiveSlotHold`, productIds explícitos en create/`[]` legacy, consentimiento/reschedule                                     |
| `src/services/dashboard/classSession.dashboard.service.ts`             | create/bulk y update de intervalo/staff usan retry + conflicto personal organization-wide; metadata-only no revalida; `SCHEDULED`, cross-venue y overlaps internos del lote                                                                                   |
| `src/services/dashboard/team.dashboard.service.ts`                     | hard-delete serializable rechaza compromisos futuros antes de borrar StaffVenue §7                                                                                                                                                                            |
| `src/utils/serializableRetry.ts` (nuevo)                               | `withSerializableRetry` extraído (anti import circular §8c) + `isRetryableDbError` (P2034/40001/55P03/P2010-normalizado); agotamiento lock→409, no retry genérico P2028                                                                                       |
| `src/errors/AppError.ts` + `src/app.ts`                                | `ConflictError` acepta `code`/`details`; handler serializa `details` (§13)                                                                                                                                                                                    |
| `src/services/dashboard/reservationSettings.service.ts`                | TransactionClient, 2 campos, transición §7a transaccional                                                                                                                                                                                                     |
| `src/services/consumer/reservation.consumer.service.ts`                | staffId + mapeo + origen CONSUMER                                                                                                                                                                                                                             |
| `src/services/consumer/venue.consumer.service.ts:80`                   | keys `appointmentWindowSemantics`/`staffSelection` con condiciones independientes + entitlement                                                                                                                                                               |
| `src/controllers/public/reservation.public.controller.ts`              | forward staffId; normalizador productId(s); holds normal/reschedule separados, orden locks+UTC+rollout A/B; `/info` capability+entitlement; reschedule fixed; URLs/windowSemantics                                                                            |
| `src/schemas/dashboard/reservation.schema.ts`                          | staffId, hold+selections+windowSemantics, wire update hasta 1440 con cap core §3b, cap create condicional legacy 480/base-final 1440, normalizador compatible productId/CSV/repeated productIds, `includeFull`, schemas §5, settings, URLs, allowOverCapacity |
| `src/services/reservation/createOrderFromReservation.ts`               | servedById prefill (rama nueva)                                                                                                                                                                                                                               |
| `src/services/liveDemo.service.ts:532`                                 | writeOrigin `PUBLIC`                                                                                                                                                                                                                                          |
| `src/mcp/tools/reservations.ts`                                        | staffId/staffName, settings en core, origen MCP, +4 tools gestión §12                                                                                                                                                                                         |
| `.github/workflows/ci-cd.yml`                                          | Postgres service container + migrate deploy + sin continue-on-error                                                                                                                                                                                           |
| `scripts/pre-deploy-check.sh`                                          | shell env gana a `.env`; nunca imprime credenciales; integration usa DB exportada §15                                                                                                                                                                         |
| `tests/__helpers__/setup.ts` + suites                                  | 3 modelos + re-prime beforeEach                                                                                                                                                                                                                               |
| `tests/integration/reservations/*` (nuevos)                            | §15 completo                                                                                                                                                                                                                                                  |
| `prisma/seed.ts`, `src/services/onboarding/demoSeed.service.ts`        | mappings demo                                                                                                                                                                                                                                                 |

## 20. Files Reference (clientes)

| Repo                                                | Change                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avoqado-web-dashboard`                             | picker filtrado, editor horarios/ProductStaff, toggles, sobre-cupo confirmable + recovery catálogo/ventana (§10c)                                                                     |
| `avoqado-booking-widget`                            | `StaffSelector`, staffId, productIds CSV, capability `appointmentWindowSemantics`, `windowSemantics:'base'`, `baseEndsAt=slot.end-modifierDelta`, await cancelHold + refetch recovery |
| `avoqado-consumer-app`                              | capability + `staffSelection` + staffId + windowSemantics/baseEndsAt + await release/refetch recovery §10e (single-product este epic)                                                 |
| `avoqado-ios` — `Reservations/`                     | selector filtrado, "Sin asignar=cualquiera" opt-in, ventana base/refetch recovery, sobre-cupo confirmable (hora manual) — JUNTO con Android                                           |
| `avoqado-android` — `reservations/`                 | ídem iOS + `includeFull` con pills "lleno" (create slot-only; hard conflicts nunca pill FULL)                                                                                         |
| `avoqado-desktop` — `AvoqadoApi.kt` + create dialog | mismos contratos (#9), ventana base/refetch recovery + `includeFull` con chips "lleno"                                                                                                |

## GSTACK REVIEW REPORT

| Review        | Trigger                    | Why                             | Runs            | Status                             | Findings                                                                                                              |
| ------------- | -------------------------- | ------------------------------- | --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`         | Scope & strategy                | 0               | not run (scope fijado por founder) | —                                                                                                                     |
| Codex Review  | `/codex` (manual, founder) | Independent 2nd opinion         | 7 + repair pass | integrated                         | 7ma ronda (5/10) integrada; repair pass cerró holds/reschedule/cross-venue/UTC/rollout sin inflar el conteo de audits |
| Eng Review    | `/plan-eng-review`         | Architecture & tests (required) | 4               | reconciled                         | run 4 aportó Module≠Feature/SSI; Codex editó v5.2 y acotó SSI por organización + migración con medición PG read-only  |
| Design Review | `/plan-design-review`      | UI/UX gaps                      | 0               | not run                            | —                                                                                                                     |
| DX Review     | `/plan-devex-review`       | Developer experience gaps       | 0               | not run                            | —                                                                                                                     |

**CODEX:** 7 audits + esta pasada de reparación. SSI + retry cierra el write-skew solo cuando TODOS los writes leen el mismo predicado; v5.2
ahora lo hace por `(organizationId, Staff.id)` (§7/§8), incluida la interacción opt-in↔legacy. **CROSS-MODEL:** la consulta read-only a
producción confirmó el dato del founder: PlayTelecom usa `SERIALIZED_INVENTORY` mediante Module/OrganizationModule/VenueModule, no Feature.
Cruzarlo con `RESERVATIONS` habría sido overengineering y un bug de entitlement; v5.2 deja la separación ejecutable en §1/§10/§12.
**VERDICT:** **v5.2 integra el 7mo audit y los defectos encontrados al editarlo.** No se declara ENG CLEAR todavía: criterio de salida
vigente = re-audit adversarial limpio de este texto; entonces filear epic + 9 hijos. P1/P2 nuevos se adjudican contra código antes de
incorporarse.

NO UNRESOLVED DECISIONS

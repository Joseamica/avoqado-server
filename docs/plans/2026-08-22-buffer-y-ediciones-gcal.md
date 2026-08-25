# Buffer post-servicio + ediciones del venue en Google Calendar

> Diseño, 2026-08-22. Origen: incidente prod venue `amaena` (21-ago-2026), reservas RES-68RBF2 / RES-W5NRNK. **Decidido por el founder: fase
> 1 = buffer; el buffer va con Reservas (PRO), sin gate propio.**
>
> **Estado 2026-08-23 — fase 1 NÚCLEO IMPLEMENTADO, sin commitear, sin desplegar.**
>
> Hecho y verificado (831 tests de reservas + typecheck del proyecto en verde): `Product.bufferAfterMin` · `Reservation.blockedEndsAt` NOT
> NULL + 2 índices espejo · migración escrita a mano con los 3 pasos · `resolveAppointmentWindow` devuelve `bufferAfterMin` y
> `blockedEndsAt` · helpers `resolveBufferAfterMin` / `applyBufferToEndsAt` · 7 creates y 2 reprogramaciones cableados · disponibilidad y
> las 7 consultas `FOR UPDATE` migradas al fin de bloque · `appointmentStaffAssignment` (camino staff-aware) migrado · guardarraíl
> automático `tests/unit/services/reservation/blockedEndsAt.guard.test.ts` · 8 tests nuevos del buffer.
>
> 🔴 **La migración NO se aplicó a la base local**: otra sesión tiene 4 migraciones aplicadas cuyos archivos viven en su worktree, y
> `prisma migrate dev` sólo ofrece resetear la base compartida. Aplicarla requiere que ese trabajo aterrice primero. Hasta entonces el
> código compila y los tests pasan (mockeados), pero el servidor local NO puede correr contra la columna nueva.
>
> **Cadena completa cerrada (23-ago, segunda tanda):** campo "Tiempo de limpieza después" en `ServiceFormDialog` del dashboard (es/en; `fr`
> no cubre esa sección) · `bufferAfterMin` aceptado en el Zod de menú y cableado en `product.dashboard.service` (create y update) · expuesto
> en el MCP `menu_item_detail` · deck + los dos one-pagers actualizados **y sus 3 PDFs regenerados**. Dashboard typecheck en verde.
>
> Falta: el push a Google con el bloque completo (`event-body.service.ts`) — es lo que le quita al salón el motivo para estirar el evento a
> mano, así que conviene antes de la fase 2.
>
> Pendiente declarado: hoy se respeta el bloque de la cita EXISTENTE. El caso simétrico —que el buffer de la cita NUEVA empuje sobre una que
> ya estaba— no está cubierto.

## El problema, en una línea

El salón alargó a mano en Google el evento que Avoqado empujó (16:00–17:15 → 18:00). El pull descarta a propósito los eventos propios
(`avoqadoOrigin === 'avoqado'`), así que la edición fue invisible y el widget vendió 17:15–18:45 encima.

Dos causas encadenadas:

1. **Causa raíz** — el catálogo no puede expresar "esto se lleva 40 minutos más". El salón corrige en Google porque Avoqado no le da otra
   puerta. → **Fase 1: buffer.**
2. **Causa próxima** — la edición no llega a la disponibilidad. Pasa igual con catálogo perfecto (el cliente llegó tarde, el servicio se
   complicó). → **Fase 2: honrar el excedente.**

## Qué hace el mercado (investigado en vivo 2026-08-22)

Precedente completo con fuentes: `../../.claude/rules/product-decisions-industry-reference.md`.

|                         | Edición en Google de un evento propio                                                                            | Buffer post-servicio                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Square Appointments** | No regresa; _"You can only edit an event from its calendar of origin"_, y se pierde en el re-sync                | "Block extra time after appointment", por servicio, **de paga** (Plus/Premium)                         |
| **Mindbody**            | One-way estricto: _"Events from Google Calendar do not sync back to Mindbody"_. Ni siquiera importa busy externo | **Sin campo**: el método oficial es inflar la duración del servicio, y quitar `ENDTIME` de los correos |
| **Booksy**              | No existe el canal (sólo import `.ics` one-time)                                                                 | "Padding Time" (bloquea antes/después) + "Processing Time" (libera el tramo medio)                     |

**Por qué nadie resuelve la edición** (inferencia, ningún referente lo declara): sus salones casi no necesitan editar en Google porque el
buffer ya existe en el catálogo. Es consecuencia de una carencia nuestra, no de una sabiduría ajena. Y Square ya acepta el principio de
fondo — importa eventos de Google como tiempo ocupado; sólo exige que sean eventos _nuevos_.

**Trampa a NO copiar de Mindbody:** inflar la duración del servicio hace que el cliente reciba una hora de fin falsa. Por eso separamos las
marcas de tiempo (abajo).

---

## Fase 1 — Buffer post-servicio (decidida)

### Modelo

- `Product.bufferAfterMin Int?` — por SERVICIO (Square y Booksy coinciden; sin decisión pendiente). Default `null`/0 ⇒ nadie nota nada hasta
  configurarlo.
- `Reservation.blockedEndsAt DateTime` — fin **materializado** en la escritura. Que sea una columna y no un cálculo es deliberado: hay
  varios sitios que consultan solapamiento (`reservationAvailability.service.ts`, `appointmentStaffAssignment.service.ts`,
  `reservation.dashboard.service.ts`) y uno que se olvide de sumar el buffer reintroduce el bug.

### Tres marcas de tiempo, nunca mezcladas

| Marca           | Qué es                   | Quién la ve                                      |
| --------------- | ------------------------ | ------------------------------------------------ |
| `startsAt`      | inicio                   | cliente y negocio                                |
| `endsAt`        | fin del servicio         | **cliente** — correo, comprobante, recordatorio  |
| `blockedEndsAt` | fin del bloque de agenda | **negocio** — disponibilidad, colisiones, Google |

### Punto de inyección

Un solo lugar suma duraciones hoy: `resolveCanonicalAppointmentDuration` (`src/services/reservation/resolveAppointmentWindow.ts:118`) y su
gemelo de disponibilidad `resolveAppointmentBaseDurationIfAllAppointments` (:169). El buffer **NO** entra en `canonicalBaseDurationMin` —
eso rompería la validación `APPOINTMENT_WINDOW_CHANGED` que compara contra lo que el widget mostró, y le mentiría al cliente. Se devuelve
como campo aparte del `ResolvedAppointmentWindow` y se materializa en `blockedEndsAt`.

**Decisión declarada (revisable con datos reales):** en una cita multi-servicio se aplica **un solo buffer al final, el MAYOR de los
servicios incluidos** — no la suma, que inflaría la agenda de una cita de tres servicios hasta volverla invendible.

### Superficies a tocar en el mismo cambio

- Disponibilidad y colisiones → usar `blockedEndsAt`, nunca `endsAt`.
- Push a Google: el evento cubre hasta `blockedEndsAt`, y la descripción aclara el desglose (`event-body.service.ts`). **Es la mitad del fix
  del incidente**: un evento que ya refleja el tiempo real ocupado le quita al salón el motivo para estirarlo.
- Dashboard: campo en el editor de servicio (switch canónico en dashboard, no en las apps — no se toca durante el turno desde el piso).
- MCP cliente (`src/mcp/tools/`): exponer y configurar `bufferAfterMin`.
- Presentación de ventas: deck + los dos one-pagers + **regenerar los tres PDFs** (capacidad visible al cliente).
- `npm run schema:map` en el mismo commit que el cambio de schema.

### Gating

**Sin gate propio: hereda el de Reservas (PRO)** — decisión del founder, 2026-08-22. Razón: es exactitud de la agenda, no una capacidad
avanzada; cobrarla aparte sería cobrar por no tener el bug. Divergimos de Square, que sí lo cobra en Plus/Premium.

### Verificación

TDD obligatorio (toca disponibilidad y fechas). Casos mínimos: buffer 0 no cambia nada (regresión); buffer N corre el primer hueco; el
correo/comprobante siguen mostrando `endsAt`; multi-servicio usa el mayor; `APPOINTMENT_WINDOW_CHANGED` no se dispara por el buffer. Correr
con `TZ=UTC`.

Estimado: ~2–3 días.

---

## Fase 2 — Honrar la edición del venue (diseñada, no aprobada)

Recomendación **A+C**: apartar el excedente y avisar.

1. En el pull, cuando `isAvoqadoOrigin(ev)`, buscar `ReservationGoogleEventMapping` por `(connectionId, googleEventId)` — llave primaria,
   lookup directo.
2. Comparar la ventana del evento contra `blockedEndsAt` de la reserva (tolerancia 60s, la misma constante que ya usa
   `resolveAppointmentWindow`).
3. El **excedente** se upsertea como `ExternalBusyBlock` con el MISMO `externalEventId`. Esto lo hace auto-limpiante: las ramas existentes
   de `cancelled` / `transparent` / fuera de horizonte ya lo borran, y si el salón revierte la edición el excedente da cero y el bloque
   desaparece.
4. Correo al venue explicando que estirar el evento no reprograma la cita, y cómo bloquear bien.

**Tres sitios donde vive el skip** — los tres necesitan el mismo handler compartido: `pull.service.ts` backfill (~:188), `pull.service.ts`
incremental (~:305), `gcal-horizon-refresh.job.ts:142`.

**La reserva NUNCA se toca** (nada de two-way): recordatorios, depósitos y notificaciones al cliente quedan intactos.
`checkExternalBusyBlock` ya protege availability y los caminos de escritura sin cambios.

**Riesgo declarado y sus tres mitigaciones obligatorias** — una edición en Google es ambigua (¿duró más? ¿estoy tapando? ¿se me fue el
dedo?). Un arrastre accidental podría apagar la agenda. No construir sin: (a) tope — no bloquear más allá del cierre del día; (b) el bloque
**visible** en el dashboard con su explicación y un botón para quitarlo; (c) el correo.

**Sobre-bloqueo conocido:** un `ExternalBusyBlock` aparta el slot completo, así que en venues con `pacingMaxPerSlot > 1` (Amaena tiene 2) el
tramo excedente bloquea más de lo estrictamente necesario. Dirección segura y aceptada: preferimos no vender a doble-vender.

Estimado: ~2 días.

---

## Descartadas

| Opción                                             | Por qué no                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **B — two-way real** (la edición mueve la reserva) | Un arrastre accidental reprograma a un cliente en silencio. Ningún referente lo hace.                          |
| **D — revertir el evento** (Square literal)        | Le borra al salón su corrección y el hueco se vuelve a vender: no arregla la disponibilidad, sólo el pizarrón. |
| **Sólo avisar**                                    | Deja el hueco abierto hasta que alguien lea el correo.                                                         |

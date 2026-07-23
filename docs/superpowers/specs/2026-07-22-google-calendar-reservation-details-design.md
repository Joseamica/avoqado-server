# Google Calendar: detalles completos de la reserva

**Fecha:** 2026-07-22
**Estado:** diseño aprobado, pendiente plan de implementación
**Origen:** petición de Amaena (salón de uñas) — "que el Google Calendar también incluya los detalles de la reserva"

---

## 1. Problema

`src/services/google-calendar/event-body.service.ts` arma el evento desde
`resolveServiceName(reservation.product)` — **solo el servicio líder**.

Las citas multi-servicio (patrón Square: líder en `Reservation.productId`, lista
ordenada en `Reservation.productIds`) pierden todo lo demás. La cita real de
Amaena del 2026-07-20 (RES-PY45XU) llega a Google como:

```
Reserva: Extensión con polygel — Hilda
```

cuando en realidad eran 4 servicios y un modificador. El dueño mira su celular y
no sabe qué se reservó ni cuánto va a durar.

**Es la misma causa raíz** que se corrigió el 2026-07-21 en el dashboard (lista
de reservas y calendario): `productIds` ignorado a favor de `product`. Google
Calendar es la tercera superficie con el mismo defecto.

## 2. Objetivo

Paridad de contenido entre el dashboard y Google Calendar, respetando los tres
niveles de privacidad que ya existen por venue
(`ReservationSettings.googleCalendarEventDetailLevel`).

**Fuera de alcance:** recordatorios por email/WhatsApp y el TPV. Tienen el mismo
defecto latente; el resolvedor compartido (§4) los deja listos para corregirse
después sin volver a duplicar la lógica.

## 3. Decisiones tomadas (no re-litigar)

| # | Decisión | Elegido |
|---|---|---|
| D1 | Qué entra | Servicios + modificadores + duración total + total a cobrar + teléfono |
| D2 | Reparto por nivel | Teléfono **solo en FULL**. Dinero en FULL **y SERVICE** (ver D6) |
| D6 | Dinero en SERVICE | **SÍ** — revisión del founder 2026-07-22, revierte parte de D2 |
| D3 | Título | **Todos** los servicios concatenados en el título |
| D4 | Teléfono | Se mantiene; se actualiza el aviso de privacidad como parte del entregable |
| D5 | Arquitectura | Resolvedor compartido, builder puro |

**Nota sobre D3:** se evaluó la alternativa "servicio líder + contador" (`+3`).
Google trunca ambos títulos igual en vista de mes; el contador avisaba que había
más servicios y el título completo no. El founder eligió el título completo con
ese tradeoff a la vista. **Decisión cerrada.**

**Nota sobre D2/D4 (privacidad):** escribir datos propios en el calendario que
el dueño conectó **no** infringe la
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
— esa política regula datos que se *reciben* de Google, no los que se escriben,
y es el caso de uso para el que existe la Calendar API. El riesgo real es otro y
es doble: (a) LFPDPPP — el teléfono de la clienta final viaja a un tercero y eso
debe estar cubierto en el aviso de privacidad; (b) exposición por calendario
compartido — el salón comparte el calendario con su equipo. Por eso el teléfono
y el dinero viven **solo** en FULL, nunca en SERVICE ni en MINIMAL.

## 4. Arquitectura

### 4.1 Resolvedor compartido de servicios

Hoy "cuáles son los servicios de una reserva" está definido dos veces:
`attachServicesMany` (privado en `reservation.dashboard.service.ts`) y el
`reservation.product` de Google Calendar. Agregar una tercera definición
garantiza que el bug reaparezca en la cuarta superficie.

**Extraer** a `src/services/reservation/reservation-services.resolver.ts`:

```ts
export type ResolvedService = { id: string; name: string; price: Decimal | null; duration: number | null }

/** Cliente Prisma o transacción — el push DEBE pasar su `tx`. */
type PrismaLike = { product: { findMany: (args: any) => Promise<any[]> } }

/** Los ids de servicio de una reserva, en orden de reserva. */
export function reservationServiceIds(r: { productId: string | null; productIds: string[] }): string[]

/** Resuelve servicios para N reservas con UNA query. Preserva el orden. */
export function resolveServicesMany<T>(reservations: T[], client?: PrismaLike): Promise<(T & { services: ResolvedService[] })[]>

/** Variante de una reserva — la usa el push, que procesa fila por fila. */
export function resolveServices(reservation: { productId: string | null; productIds: string[] }, client?: PrismaLike): Promise<ResolvedService[]>
```

El cliente es inyectable porque el push corre dentro de `prisma.$transaction` y
**debe** usar su `tx`; leer con el `prisma` global desde adentro de una
transacción es un bug de aislamiento.

Consumidores: `reservation.dashboard.service.ts` (reemplaza su copia privada) y
el push de Google Calendar. `productIds` es `String[]` escalar, no relación, así
que Prisma no puede hacer `include` — de ahí que exista el resolvedor.

### 4.2 El builder se mantiene puro

`buildEventBodyForReservation` sigue siendo **síncrono y sin acceso a DB**. Sus
23 tests actuales no necesitan mocks de Prisma y así debe quedarse. Recibe los
datos ya resueltos:

```ts
export interface EventBodyForReservationArgs {
  reservation: ReservationWithRelations   // ahora con `modifiers` en el include
  services: ResolvedService[]             // NUEVO — resuelto por el caller
  detailLevel: EventDetailLevel
  dashboardUrl: string
}
```

Los modificadores **sí** son relación directa (`Reservation.modifiers`), así que
entran por el `include` de Prisma sin query extra. `ReservationModifier` trae
`name`, `quantity` y `price` denormalizados: no hace falta join con `Modifier`.

### 4.3 Dónde se resuelve

`processOutboxRow` procesa **una fila a la vez** dentro de un
`prisma.$transaction` — no hay lote. Por tanto:

- Los modificadores entran por el `include` existente (`modifiers: true` sobre
  `reservation`): **cero queries extra**, son relación directa.
- Los servicios cuestan **una query adicional por fila**, vía
  `resolveServices(row.reservation, tx)`. Es aceptable: una lectura por push, ya
  dentro de la transacción abierta.
- `buildBodyForRow` es hoy **síncrono**. Al necesitar `await` para los servicios
  pasa a `async`, y sus dos llamadas (`handleCreate` línea ~220, `handleUpdate`
  línea ~254) pasan a `await`. Ambas ya están en funciones `async`.

**El `tx` es obligatorio.** Resolver con el `prisma` global desde dentro de la
transacción rompería el aislamiento y podría leer datos que la transacción aún
no ve.

### 4.4 Duración y total

- **Duración:** usar `reservation.duration` tal cual. Ya es autoritativa y ya
  incluye el tiempo de los modificadores (`finalDuration = data.duration +
  modifierDurationDelta`, `reservation.dashboard.service.ts:296`). **No
  recalcular** sumando servicios: daría un número distinto y equivocado.
- **Total:** `Σ(service.price) + Σ(mod.price × mod.quantity)`. No existe un total
  persistido en `Reservation`. Es el **cobro esperado**, no el cobrado: el cobro
  real ocurre en el POS y puede diferir. Etiquetar como `Total estimado:` para no
  prometer exactitud que el dato no tiene.

## 5. Formato de salida por nivel

**MINIMAL** — sin cambios. Título `Reserva Avoqado`, descripción solo la URL.

**SERVICE** — gana la lista de servicios, la duración, los extras **y el dinero**
(D6). Lo que oculta es **quién es la clienta**: sin nombre, sin teléfono, sin
notas internas. Contrato: *"qué se vendió y cuánto vale, no a quién"* — sirve
para un calendario compartido con el personal.

```
Reserva: Extensión con polygel + Francés manos + Retiro de Geles Blandos con Extensión + Manicure + Pedicure Spa + Gel

Personas: 1
Duración: 3 h 10 min

Servicios:
• Extensión con polygel (75 min)
• Francés manos (25 min)
• Retiro de Geles Blandos con Extensión (20 min)
• Manicure + Pedicure Spa + Gel (70 min)

Extras:
• Gel semipermanente ×1  +$300.00

Total estimado: $2,280.00

https://dashboard.avoqado.io/venues/amaena/reservations/<id>
```

**Riesgo aceptado por el founder (2026-07-22):** un venue que eligió SERVICE
para compartir su calendario *sin dinero* empezará a mostrar montos tras el
deploy, sin haberlo pedido. Se le advirtió explícitamente y aun así lo eligió.
Si esto llega a molestar a algún venue, la salida es un interruptor propio para
el dinero, independiente del nivel.

**FULL** — todo.

```
Reserva: Extensión con polygel + Francés manos + Retiro de Geles Blandos con Extensión + Manicure + Pedicure Spa + Gel — Hilda

Cliente: Hilda
Teléfono: 55-1234-5678
Personas: 1
Duración: 3 h 10 min

Servicios:
• Extensión con polygel (75 min)
• Francés manos (25 min)
• Retiro de Geles Blandos con Extensión (20 min)
• Manicure + Pedicure Spa + Gel (70 min)

Extras:
• Gel semipermanente ×1  +$300.00

Total estimado: $1,900.00

Solicitudes especiales:
<...>

Notas internas:
<...>

¿Necesitas gestionar esta reservación?
Ver detalles, editar o cancelar en Avoqado:
https://dashboard.avoqado.io/venues/amaena/reservations/<id>

— Powered by Avoqado
```

Reglas de formato:

- Servicio sin duración → se omite el `(N min)`, no se imprime `(null min)`.
  (Hay 50 servicios así en producción; ver §8.)
- Sin modificadores → la sección `Extras:` no se imprime.
- Un solo servicio → se imprime igual como lista de un elemento. Sin rama
  especial: menos código y menos formas de romperse.
- Teléfono ausente → se omite la línea.

## 6. Pruebas

Extender `tests/unit/services/google-calendar/event-body.service.test.ts`
(23 tests hoy, todos deben seguir verdes).

**Nuevos:**
1. FULL lista los 4 servicios en orden de reserva
2. FULL imprime extras con cantidad y precio
3. FULL imprime duración total y total estimado
4. FULL imprime el teléfono
5. SERVICE lista servicios y duración **sin** nombre, teléfono ni dinero
6. MINIMAL no cambia
7. Servicio sin duración → sin `(N min)`, sin `null`
8. Sin modificadores → sin sección `Extras:`
9. Un servicio → misma forma de lista
10. Total = servicios + modificadores × cantidad

**Regresión reforzada (crítico):** el test existente
*"same reservation rendered MINIMAL strips ALL PII visible in FULL"* (línea 174)
debe extenderse para incluir **teléfono y total** en lo que MINIMAL no puede
filtrar. Es el candado de privacidad de todo el diseño.

**Regresión del resolvedor compartido:** la suite del dashboard
(`reservation.dashboard.service.test.ts`) debe seguir verde tras reemplazar
`attachServicesMany` por el resolvedor — misma salida, mismo orden.

## 7. Re-push de eventos ya sincronizados — decisión (b)

Los eventos ya en Google **no se actualizan solos**. Sin acción, las reservas
futuras de Amaena conservan el título viejo hasta que alguien las edite.

Opciones:

- **(a) Solo hacia adelante.** Nada se re-empuja. Cero riesgo, cero cuota de API;
  las citas ya agendadas se quedan pobres.
- **(b) Re-push de reservas futuras del venue que lo pida.** Encolar en el outbox
  las reservas con `startsAt >= NOW()` de un venue. Acotado y reversible.
  **Recomendado.**
- **(c) Re-push global de todas las futuras.** Corrige a todos los venues de una,
  pero modifica calendarios de gente que no pidió nada y consume cuota de API.

**Decidido: (b).** Se implementa como script/comando de **disparo manual por
venue** — construirlo no modifica ningún calendario; solo ejecutarlo lo hace, y
eso queda como acción humana deliberada. Esa separación es la razón por la que
la decisión es segura y reversible.

Requisitos del disparador:

- Recibe un `venueId` explícito. **Nunca** un default de "todos los venues".
- Solo encola reservas con `startsAt >= NOW()` y estado `PENDING` / `CONFIRMED`.
- Imprime cuántas reservas va a encolar y pide confirmación antes de escribir.
- Reutiliza el outbox existente (no llama a la API de Google directamente), así
  que hereda reintentos, dead-letter y rate limiting ya probados.

## 8. Dependencia con las duraciones faltantes

Hay **50 servicios activos sin duración** en producción (Mindform 33,
Alberto Dominguez 12, Amaena 5) — ver el fix del 2026-07-21. Con esos servicios,
el evento imprime el nombre sin `(N min)`. Es correcto y honesto, pero la línea
`Duración:` refleja el fallback del venue, no el tiempo real. **Este diseño no
depende de que se capturen, pero se ve mejor cuando estén.**

## 9. Tareas fuera de código

- **Aviso de privacidad (D4).** Revisar y actualizar el de Avoqado para describir
  la transferencia de PII de clientes finales a Google Calendar. Avisar a Amaena
  que el suyo debe cubrirlo también. **Parte del entregable, no un pendiente.**

## 10. Archivos afectados

| Archivo | Cambio |
|---|---|
| `src/services/reservation/reservation-services.resolver.ts` | **nuevo** — resolvedor compartido |
| `src/services/dashboard/reservation.dashboard.service.ts` | usa el resolvedor; borra su copia privada |
| `src/services/google-calendar/event-body.service.ts` | acepta `services` + `modifiers`; nuevo formato |
| `src/services/google-calendar/push.service.ts` | resuelve en lote; `modifiers: true` en el include |
| `scripts/repush-google-calendar-events.ts` | **nuevo** — re-push manual por venue (§7) |
| `tests/unit/services/google-calendar/event-body.service.test.ts` | +10 tests, refuerza el de privacidad |
| `tests/unit/services/dashboard/reservation.dashboard.service.test.ts` | regresión del resolvedor |

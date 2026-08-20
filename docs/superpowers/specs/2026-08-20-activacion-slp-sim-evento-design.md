# Activación SLP — venue + reasignación automática de ventas "SIM de Evento"

Asana: [Crear Venue ACTIVACION SLP](https://app.asana.com/1/12709793723059/project/1213523434401320/task/1217556190300772) (`1217556190300772`, "Bait <> Play Telecom", Prioridad Alta).

## Contexto

PlayTelecom tiene promotores asignados a tiendas físicas (`BAE <sucursal>`) que a veces salen de su tienda a hacer una **activación**
— una actividad de venta fuera del mostrador. Cuando venden ahí, marcan el SIM con la categoría existente `SIM de Evento`
(`ItemCategory`, org-level; ya usada en reportes — `sale-verification.org.dashboard.service.ts:48-53`). Hoy esa venta se queda
atribuida a la tienda de origen del promotor, cuando debería contar para una "tienda" separada de Activación.

Isaac (PlayTelecom) pidió dos acciones en el task de Asana:

1. Crear el venue `ACTIVACIÓN SLP`.
2. Mover las ventas de SIM de Evento (pasadas y futuras) a ese venue, restándolas de la tienda del promotor.

Confirmado con Isaac en el propio task (comentario `1217686256927402`, 2026-08-20):

- Un retraso de hasta ~15 minutos entre la venta y su reclasificación es aceptable (no necesita ser instantáneo).
- Si una venta mezcla un SIM de Evento con un SIM normal en la MISMA orden, se deja tal cual para revisión manual — no se mueve
  automáticamente.

Confirmado con el founder (2026-08-19):

- Alcance **sólo San Luis Potosí** por ahora. Querétaro tendrá su propio `ACTIVACIÓN QRO` más adelante (no se construye en este cambio,
  pero el diseño debe hacerlo trivial de agregar).
- Sí quiere automatización a futuro, no sólo una corrección de una sola vez.

## Precedente que reutilizamos (no inventamos mecanismo nuevo)

Esto ya se hizo dos veces a mano, documentado en memoria (`playtelecom-cubre-descanso-and-external-sales`):

- **"Cubre Descanso"** (73 ventas, 2026-07-07): reasignar una venta = mover el venue en **4 tablas a la vez**: `Order.venueId`,
  `Payment.venueId`, `SaleVerification.venueId`, `SerializedItem.sellingVenueId` (nunca `SerializedItem.venueId` — es null,
  org-level). **Nunca se toca `Payment.shiftId`** — el turno/caja del promotor se queda en la tienda real donde físicamente ocurrió
  el cobro; sólo cambia a quién "le cuenta" la venta para reportes. Esto es lo que hace seguro mover el venue sin tocar el cierre de
  caja del día.
- **"Cambaceo"** (`scripts/temp-cambaceo-migration.ts`, 2026-06-30): crear un venue nuevo clonando el venue-molde "Cubre Descanso"
  (mismo `type`, `timezone`, `currency`, `country`, `VenuePaymentConfig`, y los `VenueModule` — `SERIALIZED_INVENTORY` +
  `COMMISSIONS`).

Este diseño es la MISMA receta en ambos frentes, sólo que la reasignación de ventas corre sola en vez de a mano cada semana.

## Fuera de alcance (YAGNI)

- No se construye un motor genérico de reglas de reasignación reusable por cualquier tenant. Esto es bespoke a PlayTelecom, igual que
  "Cubre Descanso" — un patrón operativo con datos de configuración, no una feature de plataforma. Ver
  `.claude/rules/playtelecom-vertical.md`, "Founder's explicit stance (2026-06-23)": no endurecer el camino genérico de creación de
  venues para tapar huecos propios de PT.
- No se construye `ACTIVACIÓN QRO` en este cambio — sólo se deja el mecanismo trivial de extender (una entrada más en un arreglo de
  reglas) cuando el founder lo pida.
- No se cambia el flujo de cobro en vivo (TPV / `order.tpv.service.ts` / `payment.tpv.service.ts`). Se descartó esa opción por riesgo
  sobre turno, impresión y sockets en tiempo real — ver sección "Alternativas descartadas".
- No requiere gating de tier/Feature ni switch en dashboard: es un job interno, sin capacidad expuesta a ningún cliente ni rol — mismo
  cajón que `requiresOwnerApproval` o "Cubre Descanso" (aditivo, cero efecto en otros tenants). No aplica MCP tool nueva: los reportes
  de venta/venue existentes ya leen por `venueId`, así que una vez reasignada la venta "simplemente aparece" en Activación SLP sin
  tocar ninguna tool.

## Arquitectura

### 1. Creación del venue (acción única, no recurrente)

Script `scripts/temp-create-activacion-slp.ts`, siguiendo el patrón de `temp-cambaceo-migration.ts`:

- Clona el venue-molde `cmnv_cubredescanso_playtelecom` ("Cubre Descanso"): mismo `type`, `timezone`, `currency`, `country`,
  `VenuePaymentConfig`, y los `VenueModule` (`SERIALIZED_INVENTORY` + `COMMISSIONS`).
- `name: "ACTIVACIÓN SLP"`, `slug: "activacion-slp"`.
- Guard de idempotencia: si el slug ya existe, aborta sin duplicar (igual que Cambaceo).
- `ActivityLog` (`VENUE_CREATED`) con el motivo (Asana `1217556190300772`).
- `DRY_RUN` por default; `CONFIRM=EJECUTAR` para escribir. Corre contra `RENDER_DATABASE_URL`.
- No lleva `StaffVenue` — a diferencia de Cambaceo (que reasignaba a Isela), este venue no tiene personal propio: es un destino
  contable, no un lugar de trabajo. Nadie hace login ahí.

### 2. Job de reasignación periódica

Archivo nuevo: `src/jobs/playtelecom-event-sim-reassignment.job.ts`. Patrón calcado de
`src/jobs/areaTicketExternalReconciliation.job.ts` (mismo tipo de "barredora" periódica, mismas herramientas):

```typescript
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleCron } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'

interface EventVenueReassignmentRule {
  orgName: string // resuelto por nombre en cada tick, nunca un id fijo en código
  categoryName: string // match exacto, normalizado (trim + lowercase), igual que SIM_EXACT_BUCKETS
  originState: string // normalizado igual — acepta variantes de acento/caja
  targetVenueSlug: string
}

const RULES: EventVenueReassignmentRule[] = [
  { orgName: 'PlayTelecom', categoryName: 'SIM de Evento', originState: 'San Luis Potosí', targetVenueSlug: 'activacion-slp' },
  // Agregar aquí la regla de Querétaro cuando exista 'activacion-qro' — una línea, sin tocar el resto del job.
]

scheduleCron('playtelecom-event-sim-reassignment', '*/15 * * * *', reassignEventSimSales)
```

**Por qué config-por-nombre y no ids fijos:** mismo criterio que `scripts/setup-playtelecom.ts` — resolver por nombre en cada corrida
es robusto a que alguien recree el venue o cambie de ambiente (dev/staging no tienen datos de PlayTelecom, y el job debe no-operar ahí
sin tronar, no fallar el arranque del servidor).

**Cadencia:** cada 15 minutos, con minuto desfasado (`4,19,34,49 * * * *`, no `*/15` alineado a `:00/:15/:30/:45`) para evitar la
estampida de conexiones documentada en `.claude/rules/cron-jobs.md`.

### 3. Qué hace cada tick

Por cada regla en `RULES`:

1. Resuelve `Organization` por nombre (case-insensitive). Si no existe (ambiente sin datos de PT) → `log.debug` y sigue con la
   siguiente regla. No es un error.
2. Resuelve el venue destino por `slug` **dentro de esa organización**. Si no existe todavía (p. ej. el script de creación no ha
   corrido) → `log.warn` una vez por tick y sigue. Auto-sana solo: en cuanto el venue exista, el siguiente tick ya lo encuentra —
   no hace falta reiniciar el server.
3. Busca `SerializedItem` candidatos, con `retry(..., shouldRetryDbConnectionError)` en esta lectura de entrada (regla obligatoria de
   `cron-jobs.md`):
   ```typescript
   status: 'SOLD',
   category: { name: { equals: rule.categoryName, mode: 'insensitive' } },
   sellingVenueId: { not: null },
   sellingVenue: { organizationId: org.id, state: { equals: rule.originState, mode: 'insensitive' } },
   NOT: { sellingVenueId: targetVenue.id }, // idempotencia: reruns no vuelven a tocar lo ya movido
   ```
4. Agrupa los items encontrados por `Order` (vía `orderItemId → OrderItem.orderId`). Para cada orden:
   - Carga TODOS los `OrderItem` de esa orden con su `SerializedItem` (si lo tienen).
   - **Regla de pureza** (confirmada con Isaac): si la orden tiene CUALQUIER item que no sea un `SerializedItem` de la MISMA
     categoría `SIM de Evento` (otro SIM normal, u otro producto no serializado) → **se salta**, con un `logger.warn` estructurado
     (`entrypoint: 'job:playtelecom-event-sim-reassignment'`, `orderId`, `reason: 'mixed_order_skipped'`) para que alguien la revise
     a mano. Nunca se reasigna parcialmente por item — el `Order`/`Payment`/`SaleVerification` son a nivel de orden completa.
   - Si la orden es 100% SIM de Evento → transacción:
     ```typescript
     await prisma.$transaction(async tx => {
       await tx.order.update({ where: { id: order.id, venueId: { not: targetVenue.id } }, data: { venueId: targetVenue.id } })
       await tx.payment.updateMany({ where: { orderId: order.id }, data: { venueId: targetVenue.id } }) // shiftId NO se toca
       await tx.saleVerification.updateMany({ where: { payment: { orderId: order.id } }, data: { venueId: targetVenue.id } })
       await tx.serializedItem.updateMany({
         where: { orderItemId: { in: itemIds } },
         data: { sellingVenueId: targetVenue.id },
       })
     })
     await logAction({
       action: 'ORDER_VENUE_REASSIGNED',
       entity: 'Order',
       entityId: order.id,
       venueId: targetVenue.id,
       data: { fromVenueId: order.venueId, toVenueId: targetVenue.id, reason: 'playtelecom_evento_sim', rule: rule.categoryName },
     })
     ```
   - `Payment.shiftId`, `Terminal`, `Shift`, `CashDrawerEvent` **nunca se tocan** — el turno y la caja física del promotor siguen
     cerrando en su tienda real, igual que en "Cubre Descanso". Sólo cambia a quién le cuenta la venta.
5. Si una orden individual falla (conflicto de versión, fila ya movida por otro tick concurrente, etc.), se loggea con el `orderId` y
   el job sigue con las demás — un error no aborta el tick completo (mismo patrón que el `try/catch` alrededor de `markAsSold` en
   `payment.tpv.service.ts:1018-1030`).

### 4. Backlog histórico (acción 2 del Asana, sin script aparte)

El `WHERE` no tiene corte de fecha — es "todo lo que esté mal atribuido ahora mismo". Por eso el PRIMER tick después de desplegar este
job, con el venue ya creado, corrige de una sola vez TODO el histórico de ventas de SIM de Evento en SLP (equivalente a lo que el
script manual de Cubre Descanso hizo con 73 ventas) — no hace falta un script separado de "una sola vez": el mismo job cubre ambas
acciones del Asana.

## Alternativas descartadas

- **Reasignar en vivo, dentro del flujo de cobro** (que `markAsSold`/`order.tpv.service.ts` decidan el venue en el momento de vender):
  descartada por riesgo — mete la mano en el camino más sensible del sistema (dinero en vivo), y una orden puede no saber si es
  "100% Evento" hasta que el ÚLTIMO item se agrega (una orden empieza con un item normal y podría terminar mixta). Reasignar después
  de completada, quieta, es más simple de razonar y de probar.
- **Reatribución sólo a nivel de reporte** (no tocar `Order.venueId`/`Payment.venueId`, sólo hacer que las pantallas de reportes
  reconozcan la categoría "Evento" y resten): descartada — cada pantalla/reporte/MCP tool que hoy filtra por `venueId` tendría que
  aprender a hacer la excepción, superficie mucho mayor que un job, y diverge del patrón ya construido con "Cubre Descanso" donde el
  dato de origen SÍ se mueve.

## Testing

- **Unit** (`tests/unit/jobs/playtelecomEventSimReassignment.test.ts`): la función de "¿esta orden es 100% Evento?" aislada — casos:
  orden pura → true; orden mixta (Evento + normal) → false; orden con item no-serializado → false.
- **Integration** (contra DB real, patrón de `tests/unit/jobs/jobContextGuard.test.ts` / suites de `sale-verification`): sembrar
  Org + venue origen (state='San Luis Potosí') + venue `activacion-slp` + `ItemCategory('SIM de Evento')` + `SerializedItem` +
  `Order`/`Payment`/`SaleVerification`, correr `reassignEventSimSales()` directo, verificar:
  - Las 4 columnas se movieron al venue destino.
  - `Payment.shiftId` (si había turno) NO cambió.
  - `ActivityLog` con `action: 'ORDER_VENUE_REASSIGNED'`.
  - Segunda corrida inmediata = no-op (nada se duplica, el `NOT: { sellingVenueId: targetVenue.id }` ya lo excluye).
- **Caso mixto**: sembrar una orden con un SIM de Evento + un SIM normal, correr el job, verificar que NINGÚN campo se movió y que se
  loggeó `mixed_order_skipped`.
- **Ambiente sin PlayTelecom** (dev/CI limpios): correr el job sin datos de PT sembrados → no debe tronar, sólo `log.debug` y salir.
- **`npm run pre-deploy`** antes de considerar esto listo para desplegar (regla estándar del repo).

## Despliegue

1. Correr `scripts/temp-create-activacion-slp.ts` en dry-run primero, revisar el plan impreso, y **pedir autorización explícita antes
   de correr con `CONFIRM=EJECUTAR` contra producción** (regla del workspace: nunca se escribe en prod sin autorización explícita —
   precedente: Cubre Descanso se corrió con un "hazlo tú" explícito del founder).
2. Desplegar el job (arranca en `server.ts` junto a los demás, deshabilitado hasta el primer `start()`).
3. Verificar el primer tick en `logs/development*.log` (local) o Better Stack (prod) filtrando por
   `entrypoint: 'job:playtelecom-event-sim-reassignment'` — confirmar cuántas órdenes se reasignaron y cuántas se saltaron por
   mixtas, antes de darlo por bueno.

# Activación SLP — venue + reasignación automática de SIM de Evento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear el venue `ACTIVACIÓN SLP` y una barredora automática que, cada 15 minutos, mueve las ventas de SIM de Evento (pasadas y
futuras) de la tienda del promotor hacia ese venue — sin tocar el turno/caja del promotor.

**Architecture:** Un job cron nuevo (`src/jobs/playtelecomEventSimReassignment.job.ts`) reutiliza la receta ya probada de "Cubre Descanso"
(mover `Order.venueId` + `Payment.venueId` + `SaleVerification.venueId` + `SerializedItem.sellingVenueId` juntos, transaccional,
`Payment.shiftId` intacto), config-driven por un arreglo `RULES` (org por nombre, categoría, estado de origen, slug del venue destino).
Órdenes que mezclan SIM de Evento con otra categoría se saltan para revisión manual. La creación del venue va en un script único
(`scripts/temp-create-activacion-slp.ts`), separado del job, siguiendo el patrón de `temp-cambaceo-migration.ts`.

**Tech Stack:** TypeScript, Prisma, Jest, `scheduleCron` (`src/observability/jobContext.ts`), `retry`/`shouldRetryDbConnectionError`
(`src/utils/retry.ts`), `logAction` (`src/services/dashboard/activity-log.service.ts`).

**Spec:** `docs/superpowers/specs/2026-08-20-activacion-slp-sim-evento-design.md`

## Global Constraints

- Nunca tocar `Payment.shiftId`, `Terminal`, `Shift`, `CashDrawerEvent` — el turno y caja física del promotor no se mueven.
- Toda comparación de `categoryName`/`state` es case/espacio-insensible (`.trim().toLowerCase()` o `mode: 'insensitive'` en Prisma) —
  nunca match exacto sensible a mayúsculas, nunca fuzzy/`LIKE`/`startsWith`.
- Nunca reasignar una orden parcialmente por item — sólo si el 100% de sus `OrderItem` son de la categoría de la regla; si no, se salta y
  se loggea (`mixed_order_skipped`), nunca se mueve.
- Resolver `Organization` y `Venue` destino **por nombre/slug en cada tick**, nunca ids fijos en código — el job debe no-operar (no
  tronar) en un ambiente sin datos de PlayTelecom.
- La lectura de entrada del job (candidatos) va envuelta en `retry(..., shouldRetryDbConnectionError)` — regla obligatoria de
  `.claude/rules/cron-jobs.md`. La transacción de reasignación y `logAction` van FUERA del retry.
- Un fallo en UNA orden se loggea y el loop continúa — nunca aborta el tick completo.
- Nunca escribir en producción sin autorización explícita del founder — el script de creación de venue corre en `DRY_RUN` por default.

---

### Task 1: Predicado puro — ¿la orden es 100% de una categoría?

**Files:**

- Create: `src/jobs/playtelecomEventSimReassignment.job.ts`
- Test: `tests/unit/jobs/playtelecomEventSimReassignment.test.ts`

**Interfaces:**

- Produces: `isOrderPureCategoryMatch(categoryNames: Array<string | null>, categoryName: string): boolean` — usada por la Tarea 2.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/jobs/playtelecomEventSimReassignment.test.ts
import { isOrderPureCategoryMatch } from '@/jobs/playtelecomEventSimReassignment.job'

describe('isOrderPureCategoryMatch', () => {
  it('es true cuando TODOS los items de la orden son de la categoría pedida', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', 'SIM de Evento'], 'SIM de Evento')).toBe(true)
  })

  it('ignora mayúsculas y espacios al comparar', () => {
    expect(isOrderPureCategoryMatch(['  sim de evento  '], 'SIM de Evento')).toBe(true)
  })

  it('es false cuando hay un item de OTRA categoría mezclado', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', '$100 de Promotor'], 'SIM de Evento')).toBe(false)
  })

  it('es false cuando un item no tiene categoría (producto no serializado)', () => {
    expect(isOrderPureCategoryMatch(['SIM de Evento', null], 'SIM de Evento')).toBe(false)
  })

  it('es false para una orden vacía (nunca reasigna algo sin items)', () => {
    expect(isOrderPureCategoryMatch([], 'SIM de Evento')).toBe(false)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: FAIL — `Cannot find module '@/jobs/playtelecomEventSimReassignment.job'` (el archivo aún no existe).

- [ ] **Step 3: Crear el archivo con la implementación mínima**

```typescript
// src/jobs/playtelecomEventSimReassignment.job.ts

/**
 * Job de reasignación automática — Asana 1217556190300772 ("Bait <> Play Telecom").
 *
 * Cuando un promotor de PlayTelecom sale de su tienda a hacer una activación, marca el
 * SIM vendido con la categoría "SIM de Evento". Esa venta se queda hoy atribuida a la
 * tienda del promotor, cuando debería restarse de ahí y contar para un venue separado
 * ("ACTIVACIÓN SLP"). Este job la mueve sola, cada 15 minutos.
 *
 * Misma receta de 4 tablas ya usada a mano en "Cubre Descanso" (73 ventas, 2026-07-07):
 * mover Order.venueId + Payment.venueId + SaleVerification.venueId + SerializedItem.sellingVenueId
 * juntos, transaccional. Payment.shiftId NUNCA se toca — el turno/caja del promotor sigue
 * cerrando en la tienda real; sólo cambia a quién le cuenta la venta para reportes.
 *
 * Spec completa: docs/superpowers/specs/2026-08-20-activacion-slp-sim-evento-design.md
 */

/**
 * Regla de reasignación: qué categoría, en qué estado de origen, se mueve a qué venue
 * destino (dentro de qué organización, resuelta por NOMBRE — nunca un id fijo, para que
 * el job no truene en un ambiente sin datos de PlayTelecom).
 */
export interface EventVenueReassignmentRule {
  orgName: string
  categoryName: string
  originState: string
  targetVenueSlug: string
}

export const PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES: EventVenueReassignmentRule[] = [
  { orgName: 'PlayTelecom', categoryName: 'SIM de Evento', originState: 'San Luis Potosí', targetVenueSlug: 'activacion-slp' },
  // Agregar aquí la regla de Querétaro cuando exista el venue 'activacion-qro' — una línea, sin tocar el resto del archivo.
]

/**
 * ¿Todos los items de una orden son de la MISMA categoría pedida? Si hay uno solo que no
 * lo sea (otra categoría, o sin categoría — producto no serializado), la orden es "mixta"
 * y NUNCA se reasigna automáticamente (confirmado con Isaac Mayoral, comentario Asana
 * 1217686256927402: se deja para revisión manual).
 */
export function isOrderPureCategoryMatch(categoryNames: Array<string | null>, categoryName: string): boolean {
  if (categoryNames.length === 0) return false
  const target = categoryName.trim().toLowerCase()
  return categoryNames.every(name => name != null && name.trim().toLowerCase() === target)
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: PASS — los 5 casos.

- [ ] **Step 5: Formatear y commitear**

```bash
npm run format && npm run lint:fix
git add src/jobs/playtelecomEventSimReassignment.job.ts tests/unit/jobs/playtelecomEventSimReassignment.test.ts
git commit -m "feat: predicado puro isOrderPureCategoryMatch (Activación SLP, Asana 1217556190300772)"
```

---

### Task 2: `reassignEventSimSalesForRule` — el núcleo de la reasignación

**Files:**

- Modify: `src/jobs/playtelecomEventSimReassignment.job.ts`
- Test: `tests/unit/jobs/playtelecomEventSimReassignment.test.ts`

**Interfaces:**

- Consumes: `isOrderPureCategoryMatch` (Tarea 1), `PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES` (Tarea 1).
- Produces: `reassignEventSimSalesForRule(rule: EventVenueReassignmentRule): Promise<{ reassigned: number; skippedMixed: number }>` —
  usada por la Tarea 3.

- [ ] **Step 1: Escribir los tests que fallan (mock de Prisma)**

Agregar al mismo archivo de test, ARRIBA del `describe('isOrderPureCategoryMatch', ...)` ya escrito:

```typescript
// tests/unit/jobs/playtelecomEventSimReassignment.test.ts (agregar al inicio del archivo)
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organization: { findFirst: jest.fn() },
    venue: { findFirst: jest.fn() },
    serializedItem: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { isOrderPureCategoryMatch, reassignEventSimSalesForRule, type EventVenueReassignmentRule } from '@/jobs/playtelecomEventSimReassignment.job'

const RULE: EventVenueReassignmentRule = {
  orgName: 'PlayTelecom',
  categoryName: 'SIM de Evento',
  originState: 'San Luis Potosí',
  targetVenueSlug: 'activacion-slp',
}

describe('reassignEventSimSalesForRule', () => {
  beforeEach(() => jest.clearAllMocks())

  it('salta la regla completa si la organización no existe en este ambiente (dev/CI limpios)', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue(null)

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.venue.findFirst).not.toHaveBeenCalled()
  })

  it('salta la regla completa si el venue destino todavía no existe', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null)

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.serializedItem.findMany).not.toHaveBeenCalled()
  })

  it('reasigna una orden pura (100% SIM de Evento) en las 4 tablas, y audita', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-1' }]) // resolver orderId desde orderItemIds candidatos
      .mockResolvedValueOnce([{ categoryName: 'SIM de Evento' }]) // items de esa orden, para el check de pureza
    const tx = {
      order: { updateMany: jest.fn() },
      payment: { updateMany: jest.fn() },
      saleVerification: { updateMany: jest.fn() },
      serializedItem: { updateMany: jest.fn() },
    }
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 1, skippedMixed: 0 })
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.saleVerification.updateMany).toHaveBeenCalledWith({
      where: { payment: { orderId: 'order-1' }, NOT: { venueId: 'venue-activacion-slp' } },
      data: { venueId: 'venue-activacion-slp' },
    })
    expect(tx.serializedItem.updateMany).toHaveBeenCalledWith({
      where: { orderItem: { orderId: 'order-1' } },
      data: { sellingVenueId: 'venue-activacion-slp' },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_VENUE_REASSIGNED', entity: 'Order', entityId: 'order-1', staffId: null }),
    )
  })

  it('salta una orden mixta (Evento + otra categoría) SIN tocar ninguna tabla, y no cuenta como reasignada', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([{ orderItemId: 'oi-1' }])
    ;(prisma.orderItem.findMany as jest.Mock)
      .mockResolvedValueOnce([{ orderId: 'order-mixta' }])
      .mockResolvedValueOnce([{ categoryName: 'SIM de Evento' }, { categoryName: '$100 de Promotor' }])

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 1 })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('sin candidatos, no hace ninguna llamada de escritura', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockResolvedValue({ id: 'org1' })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue-activacion-slp' })
    ;(prisma.serializedItem.findMany as jest.Mock).mockResolvedValue([])

    const result = await reassignEventSimSalesForRule(RULE)

    expect(result).toEqual({ reassigned: 0, skippedMixed: 0 })
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: FAIL — `reassignEventSimSalesForRule is not a function` (todavía no existe).

- [ ] **Step 3: Implementar `reassignEventSimSalesForRule`**

Agregar al final de `src/jobs/playtelecomEventSimReassignment.job.ts` (después de `isOrderPureCategoryMatch`):

```typescript
import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { logAction } from '../services/dashboard/activity-log.service'

export async function reassignEventSimSalesForRule(
  rule: EventVenueReassignmentRule,
): Promise<{ reassigned: number; skippedMixed: number }> {
  const org = await prisma.organization.findFirst({
    where: { name: { equals: rule.orgName, mode: 'insensitive' } },
    select: { id: true },
  })
  if (!org) {
    logger.debug(`[PlayTelecom Event SIM Reassignment] Organización "${rule.orgName}" no existe en este ambiente — se salta la regla`)
    return { reassigned: 0, skippedMixed: 0 }
  }

  const targetVenue = await prisma.venue.findFirst({
    where: { slug: rule.targetVenueSlug, organizationId: org.id },
    select: { id: true },
  })
  if (!targetVenue) {
    logger.warn(`[PlayTelecom Event SIM Reassignment] Venue destino "${rule.targetVenueSlug}" no existe todavía — se salta la regla`)
    return { reassigned: 0, skippedMixed: 0 }
  }

  const candidates = await retry(
    () =>
      prisma.serializedItem.findMany({
        where: {
          status: 'SOLD',
          orderItemId: { not: null },
          category: { name: { equals: rule.categoryName, mode: 'insensitive' } },
          sellingVenueId: { not: null },
          NOT: { sellingVenueId: targetVenue.id },
          sellingVenue: { organizationId: org.id, state: { equals: rule.originState, mode: 'insensitive' } },
        },
        select: { orderItemId: true },
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'playtelecom-event-sim-reassignment.findCandidates',
    },
  )

  const orderItemIds = candidates.map(c => c.orderItemId).filter((id): id is string => id != null)
  if (orderItemIds.length === 0) return { reassigned: 0, skippedMixed: 0 }

  const orderItemsForCandidates = await prisma.orderItem.findMany({
    where: { id: { in: orderItemIds } },
    select: { orderId: true },
  })
  const orderIds = Array.from(new Set(orderItemsForCandidates.map(oi => oi.orderId)))

  let reassigned = 0
  let skippedMixed = 0

  for (const orderId of orderIds) {
    try {
      const orderItems = await prisma.orderItem.findMany({ where: { orderId }, select: { categoryName: true } })
      if (!isOrderPureCategoryMatch(orderItems.map(i => i.categoryName), rule.categoryName)) {
        skippedMixed++
        logger.warn('[PlayTelecom Event SIM Reassignment] Orden mixta, se salta para revisión manual', {
          entrypoint: 'job:playtelecom-event-sim-reassignment',
          orderId,
          reason: 'mixed_order_skipped',
        })
        continue
      }

      await prisma.$transaction(async tx => {
        await tx.order.updateMany({ where: { id: orderId, NOT: { venueId: targetVenue.id } }, data: { venueId: targetVenue.id } })
        await tx.payment.updateMany({ where: { orderId, NOT: { venueId: targetVenue.id } }, data: { venueId: targetVenue.id } })
        await tx.saleVerification.updateMany({
          where: { payment: { orderId }, NOT: { venueId: targetVenue.id } },
          data: { venueId: targetVenue.id },
        })
        await tx.serializedItem.updateMany({ where: { orderItem: { orderId } }, data: { sellingVenueId: targetVenue.id } })
      })

      await logAction({
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: orderId,
        venueId: targetVenue.id,
        staffId: null,
        data: { toVenueId: targetVenue.id, reason: 'playtelecom_evento_sim', category: rule.categoryName },
      })
      reassigned++
    } catch (err) {
      logger.error('[PlayTelecom Event SIM Reassignment] No se pudo reasignar una orden', {
        entrypoint: 'job:playtelecom-event-sim-reassignment',
        orderId,
        error: err instanceof Error ? err.message : err,
      })
    }
  }

  return { reassigned, skippedMixed }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: PASS — los 5 casos nuevos + los 5 de la Tarea 1 (10 en total).

- [ ] **Step 5: Formatear y commitear**

```bash
npm run format && npm run lint:fix
git add src/jobs/playtelecomEventSimReassignment.job.ts tests/unit/jobs/playtelecomEventSimReassignment.test.ts
git commit -m "feat: reassignEventSimSalesForRule — núcleo de la reasignación (Activación SLP)"
```

---

### Task 3: Orquestador + cron wiring + arranque en `server.ts`

**Files:**

- Modify: `src/jobs/playtelecomEventSimReassignment.job.ts`
- Modify: `src/server.ts:23` (import), `src/server.ts:424` (arranque)
- Test: `tests/unit/jobs/playtelecomEventSimReassignment.test.ts`

**Interfaces:**

- Consumes: `reassignEventSimSalesForRule`, `PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES` (Tareas 1-2).
- Produces: `reassignEventSimSales(): Promise<void>`, `startPlaytelecomEventSimReassignmentJob(): void`.

- [ ] **Step 1: Escribir el test que falla**

Primero, ampliar el import que ya existe arriba del archivo de test (el que trajo `isOrderPureCategoryMatch`/`reassignEventSimSalesForRule`
en la Tarea 2) para incluir los dos símbolos nuevos de esta tarea:

```typescript
import {
  isOrderPureCategoryMatch,
  reassignEventSimSalesForRule,
  reassignEventSimSales,
  PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES,
  type EventVenueReassignmentRule,
} from '@/jobs/playtelecomEventSimReassignment.job'
```

Luego, agregar al final del archivo de test:

```typescript
// tests/unit/jobs/playtelecomEventSimReassignment.test.ts (agregar al final del archivo)
describe('reassignEventSimSales (orquestador)', () => {
  it('corre TODAS las reglas de PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES y no truena si una falla', async () => {
    ;(prisma.organization.findFirst as jest.Mock).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null)

    await expect(reassignEventSimSales()).resolves.toBeUndefined()

    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES.length)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: FAIL — `reassignEventSimSales is not a function`.

- [ ] **Step 3: Implementar el orquestador y el arranque del cron**

Agregar al final de `src/jobs/playtelecomEventSimReassignment.job.ts`:

```typescript
import { scheduleCron } from '../observability/jobContext'

export async function reassignEventSimSales(): Promise<void> {
  for (const rule of PLAYTELECOM_EVENT_VENUE_REASSIGNMENT_RULES) {
    try {
      const { reassigned, skippedMixed } = await reassignEventSimSalesForRule(rule)
      if (reassigned > 0 || skippedMixed > 0) {
        logger.info(
          `[PlayTelecom Event SIM Reassignment] ${rule.orgName}/${rule.categoryName}: ${reassigned} orden(es) movidas a ${rule.targetVenueSlug}, ${skippedMixed} saltada(s) por mixtas`,
        )
      }
    } catch (err) {
      logger.error('[PlayTelecom Event SIM Reassignment] Regla falló completa', {
        rule,
        error: err instanceof Error ? err.message : err,
      })
    }
  }
}

/**
 * Cadencia cada 15 min, con minuto desfasado (no `*/15` alineado a :00/:15/:30/:45) para
 * evitar la estampida de conexiones documentada en `.claude/rules/cron-jobs.md`.
 */
export function startPlaytelecomEventSimReassignmentJob(): void {
  logger.info('[PlayTelecom Event SIM Reassignment] ⏰ Job started. Runs every 15 min (offset :04/:19/:34/:49).')
  scheduleCron('playtelecom-event-sim-reassignment', '4,19,34,49 * * * *', () => {
    reassignEventSimSales().catch(err => {
      logger.error('[PlayTelecom Event SIM Reassignment] Job iteration failed', { err })
    })
  })
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx jest --selectProjects unit --testPathPattern "playtelecomEventSimReassignment"`
Expected: PASS — los 11 casos (10 previos + 1 nuevo).

- [ ] **Step 5: Wirear el arranque en `server.ts`**

En `src/server.ts:23`, junto al import de `startAreaTicketExternalReconciliationJob`:

```typescript
import { startPlaytelecomEventSimReassignmentJob } from './jobs/playtelecomEventSimReassignment.job'
```

En `src/server.ts:424`, justo después de la línea `startAreaTicketExternalReconciliationJob()`:

```typescript
      // Start area-ticket external-charge reconciliation (opens UNCONFIRMED_CHARGE incidents)
      startAreaTicketExternalReconciliationJob()

      // Start PlayTelecom Event-SIM venue reassignment (Asana 1217556190300772)
      startPlaytelecomEventSimReassignmentJob()
```

- [ ] **Step 6: Verificar que el server sigue compilando**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: 0 errores.

Si la máquina está saturada, usar el script de verificación repartida del workspace en vez de correrlo a pelo:

```bash
./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.build.json --noEmit
```

- [ ] **Step 7: Formatear y commitear**

```bash
npm run format && npm run lint:fix
git add src/jobs/playtelecomEventSimReassignment.job.ts tests/unit/jobs/playtelecomEventSimReassignment.test.ts src/server.ts
git commit -m "feat: arranca el job de reasignación Activación SLP cada 15 min"
```

---

### Task 4: Script de creación del venue "ACTIVACIÓN SLP"

**Files:**

- Create: `scripts/temp-create-activacion-slp.ts`

**Interfaces:**

- No consume ni produce nada de las tareas anteriores — es un script independiente, de una sola corrida.

- [ ] **Step 1: Escribir el script (dry-run por default, calcado de `temp-cambaceo-migration.ts`)**

```typescript
/**
 * DELETE AFTER USE — no aplica: este script se queda commiteado como bitácora re-corrible,
 * igual que `temp-cambaceo-migration.ts` (patrón del founder para fixes de datos de PlayTelecom).
 *
 * Crea el venue "ACTIVACIÓN SLP" (Asana 1217556190300772), clonando el venue-molde
 * "Cubre Descanso": mismo type/timezone/currency/country, VenuePaymentConfig, y los
 * VenueModule (SERIALIZED_INVENTORY + COMMISSIONS). A diferencia de "Cambaceo", este venue
 * NO tiene StaffVenue — es un destino contable, nadie hace login ahí.
 *
 * ⚠️ ESCRIBE EN PRODUCCIÓN. Por defecto corre en DRY-RUN (no escribe nada).
 *    Para ejecutar de verdad: CONFIRM=EJECUTAR npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-create-activacion-slp.ts
 *    Dry-run (preview):                          npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-create-activacion-slp.ts
 *
 * Después de correr esto en prod, el job `playtelecomEventSimReassignment` (que ya corre
 * cada 15 min) encuentra el venue por slug SOLO — no hace falta reiniciar el server.
 */
import { PrismaClient } from '@prisma/client'

const url = process.env.RENDER_DATABASE_URL
if (!url) {
  console.error('❌ RENDER_DATABASE_URL missing — aborting.')
  process.exit(1)
}
const prisma = new PrismaClient({ datasources: { db: { url } } })

const DRY_RUN = process.env.CONFIRM !== 'EJECUTAR'

// ── Constantes ──────────────────────────────────────────────────────────
const TEMPLATE_VENUE_ID = 'cmnv_cubredescanso_playtelecom' // molde "Cubre Descanso"
const NEW_VENUE_NAME = 'ACTIVACIÓN SLP'
const NEW_VENUE_SLUG = 'activacion-slp'
const ACTOR_STAFF_ID = 'cmliew9si001epx28q93w9vq2' // Isaac real (auditoría)

const strip = (o: any, keys: string[]) => {
  const c = { ...o }
  keys.forEach(k => delete c[k])
  return c
}
const now = new Date()

async function main() {
  console.log(`\n${DRY_RUN ? '🟡 DRY-RUN (no escribe)' : '🔴 EJECUTANDO ESCRITURAS EN PROD'}\n`)

  const existingSlug = await prisma.venue.findUnique({ where: { slug: NEW_VENUE_SLUG }, select: { id: true, name: true } })
  if (existingSlug) {
    console.error(`❌ Ya existe un venue con slug "${NEW_VENUE_SLUG}" (${existingSlug.name} [${existingSlug.id}]). Abortando.`)
    return
  }

  const tmpl = await prisma.venue.findUnique({ where: { id: TEMPLATE_VENUE_ID } })
  if (!tmpl) {
    console.error('❌ No se encontró el venue molde "Cubre Descanso". Abortando.')
    return
  }
  const tmplPc = await prisma.venuePaymentConfig.findUnique({ where: { venueId: TEMPLATE_VENUE_ID } })
  const tmplMods = await prisma.venueModule.findMany({ where: { venueId: TEMPLATE_VENUE_ID } })

  console.log('PLAN:')
  console.log(
    `  1. CREAR venue "${NEW_VENUE_NAME}" (slug ${NEW_VENUE_SLUG}, type ${tmpl.type}, tz ${tmpl.timezone}, ${tmpl.currency}/${tmpl.country}, org ${tmpl.organizationId})`,
  )
  console.log(`  2. CREAR VenuePaymentConfig → primaryAccountId ${tmplPc?.primaryAccountId ?? '(molde sin pc!)'}`)
  console.log(`  3. CLONAR ${tmplMods.length} VenueModule del molde: ${tmplMods.map(m => m.moduleId).join(', ')}`)
  console.log(`  4. SIN StaffVenue — nadie hace login en este venue`)
  console.log(`  5. ActivityLog por cada mutación (actor ${ACTOR_STAFF_ID})\n`)

  if (DRY_RUN) {
    console.log('🟡 DRY-RUN: no se escribió nada. Re-correr con CONFIRM=EJECUTAR para aplicar.')
    return
  }

  const result = await prisma.$transaction(async tx => {
    const venue = await tx.venue.create({
      data: {
        organizationId: tmpl.organizationId,
        name: NEW_VENUE_NAME,
        slug: NEW_VENUE_SLUG,
        type: tmpl.type,
        timezone: tmpl.timezone,
        currency: tmpl.currency,
        country: tmpl.country,
        state: 'San Luis Potosí',
        active: true,
      },
    })

    if (tmplPc) {
      await tx.venuePaymentConfig.create({ data: { ...strip(tmplPc, ['id', 'venueId', 'createdAt', 'updatedAt']), venueId: venue.id } })
    }

    for (const m of tmplMods) {
      await tx.venueModule.create({
        data: {
          ...strip(m, ['id', 'venueId', 'createdAt', 'updatedAt', 'enabledBy', 'enabledAt']),
          venueId: venue.id,
          enabledBy: ACTOR_STAFF_ID,
          enabledAt: now,
        },
      })
    }

    await tx.activityLog.create({
      data: {
        action: 'VENUE_CREATED',
        entity: 'Venue',
        entityId: venue.id,
        staffId: ACTOR_STAFF_ID,
        venueId: venue.id,
        data: { name: NEW_VENUE_NAME, slug: NEW_VENUE_SLUG, reason: 'Activación SLP (Asana 1217556190300772)' },
      },
    })

    return { venueId: venue.id }
  })

  console.log('✅ HECHO. ACTIVACIÓN SLP creado:', result.venueId)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
```

- [ ] **Step 2: Correr en DRY-RUN contra la base LOCAL primero (nunca prod sin ver el plan)**

Run: `RENDER_DATABASE_URL="$DATABASE_URL" npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-create-activacion-slp.ts`
Expected: imprime el PLAN con los datos reales del venue-molde "Cubre Descanso" local (o un error claro si esta base de dev no tiene el
molde — en ese caso está bien, es sólo prueba de que el script no truena; la corrida real es contra `RENDER_DATABASE_URL` de prod).

- [ ] **Step 3: Formatear y commitear**

```bash
npm run format && npm run lint:fix
git add scripts/temp-create-activacion-slp.ts
git commit -m "feat: script de creación del venue ACTIVACIÓN SLP (dry-run por default)"
```

- [ ] **Step 4: Pedir autorización explícita antes de correr contra producción**

Este paso NO se automatiza — al llegar aquí, preguntar directamente: "¿corro `CONFIRM=EJECUTAR` contra producción para crear el venue
ACTIVACIÓN SLP?" y esperar un sí explícito antes de tocar `RENDER_DATABASE_URL` real.

---

### Task 5: Verificación final

**Files:** ninguno nuevo — corre lo ya escrito.

- [ ] **Step 1: Suite completa de la carpeta de jobs**

Run: `npx jest --selectProjects unit --testPathPattern "jobs/playtelecomEventSimReassignment"`
Expected: PASS, 11 casos.

- [ ] **Step 2: Typecheck completo**

Run: `npx tsc -p tsconfig.build.json --noEmit` (o `./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.build.json --noEmit` si la
máquina está saturada — regla del workspace).
Expected: 0 errores.

- [ ] **Step 3: `npm run pre-deploy`**

Run: `npm run pre-deploy`
Expected: PASS. Si algo truena en un archivo que esta tarea NO tocó, no es de este cambio — anotarlo en el reporte, no debuggearlo aquí
(regla del workspace: varias sesiones trabajan en paralelo).

- [ ] **Step 4: Commit final si algo quedó suelto**

```bash
git status --short
# Si hay algo de este cambio sin commitear, commitearlo por ruta explícita (nunca `git add -A`).
```

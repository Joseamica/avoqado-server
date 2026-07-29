# MCP — Custodia de inventario serializado por promotor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exponer en el MCP el inventario serializado agregado por promotor y por supervisor, y permitir filtrar y ver al titular en el listado de ítems.

**Architecture:** Un método org-aware nuevo en `serializedInventory.service.ts` que resuelve todo con un solo `groupBy` de Prisma sobre el índice `@@index([assignedPromoterId, custodyState])`, más un tool nuevo en `src/mcp/tools/serialized.ts` que lo expone con cuatro gates en orden. Dos arreglos aditivos a `list_serialized_items`. Sin migración, sin writes, sin tocar el dashboard.

**Tech Stack:** TypeScript, Prisma (PostgreSQL), `@modelcontextprotocol/sdk`, Jest con `prismaMock`.

**Spec:** [`docs/superpowers/specs/2026-07-29-mcp-custodia-por-promotor-design.md`](../specs/2026-07-29-mcp-custodia-por-promotor-design.md)

## Global Constraints

- **No commitear sin permiso explícito del founder.** Los pasos de `git commit` de este plan quedan preparados pero **NO se ejecutan** hasta que el founder lo autorice. Regla de `.claude/rules/testing-and-git.md`.
- **PROHIBIDO modificar** `listItems`, `getStockByCategory`, `getCategories`, `scan`, `registerBatch`, `registerBatchOrg`, `ensureSellable`, `createCategory` en `serializedInventory.service.ts`. Los consumen dashboard y TPV.
- **No tocar** el dashboard white-label: ni `src/services/organization-dashboard/`, ni `src/controllers/dashboard/`, ni rutas, ni UI.
- **Sin cambios a `prisma/schema.prisma`** → sin migración y sin `npm run schema:map`.
- **Repo PÚBLICO** (`Joseamica/avoqado-server`): jamás hardcodear `orgId`, slug de cliente, ni nombres reales en código o scripts.
- Todo mensaje de error visible al usuario va **en español**.
- Después de editar TS: `npm run format && npm run lint:fix`.
- Scope siempre vía `this.orgPoolWhere(orgId, allowedVenueIds)`. Nunca una igualdad de `venueId` pelada.
- `prismaMock` ya trae `serializedItem.groupBy` (`tests/__helpers__/setup.ts:85` dentro de `createMockModel()`, registrado en `:208`). **No hay que registrarlo** — el spec lo daba como condicional y ya está resuelto.

---

## Task 1: Método `getOrgCustodyByPromoter` en el servicio

**Files:**
- Modify: `src/services/serialized-inventory/serializedInventory.service.ts` (añadir constantes y helpers a nivel módulo + un método nuevo a la clase; **no** tocar métodos existentes)
- Test: `tests/unit/services/serialized-inventory/custodyByPromoter.test.ts` (crear)

**Interfaces:**
- Consumes: `this.orgPoolWhere(orgId, allowedVenueIds)` (privado, `serializedInventory.service.ts:693`), `this.db.serializedItem.groupBy`, `this.db.staff.findMany`.
- Produces: `serializedInventoryService.getOrgCustodyByPromoter(opts)` — lo consume Task 3.

```ts
type CustodyCounts = { asignados: number; enRevision: number; enSuPoder: number; rechazados: number; vendidos: number }

getOrgCustodyByPromoter(opts: {
  orgId: string
  allowedVenueIds: string[]
  registeredFromVenueId?: string
}): Promise<{
  totals: CustodyCounts
  promoters: Array<CustodyCounts & {
    promoterId: string | null
    promoterName: string
    supervisors: Array<{ supervisorId: string | null; supervisorName: string }>
  }>
  supervisors: Array<CustodyCounts & {
    supervisorId: string | null
    supervisorName: string
    promoterCount: number
  }>
}>
```

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/services/serialized-inventory/custodyByPromoter.test.ts`:

```ts
import { prismaMock } from '../../../__helpers__/setup'
import { serializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'

/**
 * getOrgCustodyByPromoter — "¿cuántos SIMs trae hoy cada promotor?".
 *
 * Semántica MIXTA a propósito: `vendidos` es acumulado histórico (el vínculo
 * promotor↔SIM sobrevive la venta), los otros tres son foto de hoy (se borran
 * cuando el supervisor recoge, custody.service.ts:519). `asignados` es la suma
 * de los cuatro, así que cuadra por construcción.
 */

const ORG = 'org_1'
const VENUES = ['v1', 'v2']

/** Fila del groupBy: Prisma devuelve `_count` como número cuando se pide `_count: true`. */
const g = (assignedPromoterId: string | null, assignedSupervisorId: string | null, custodyState: string, count: number) => ({
  assignedPromoterId,
  assignedSupervisorId,
  custodyState,
  _count: count,
})

describe('getOrgCustodyByPromoter', () => {
  beforeEach(() => {
    prismaMock.staff.findMany.mockResolvedValue([
      { id: 'p1', firstName: 'Josefina', lastName: 'Alvarado' },
      { id: 'p2', firstName: 'Lucía', lastName: 'Briones' },
      { id: 's1', firstName: 'Renata', lastName: 'Cortés' },
      { id: 's2', firstName: 'Hugo', lastName: 'Delgado' },
    ])
  })

  it('sin ítems → totales en cero, sin filas, y SIN lecturas de nombres', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.totals).toEqual({ asignados: 0, enRevision: 0, enSuPoder: 0, rechazados: 0, vendidos: 0 })
    expect(r.promoters).toEqual([])
    expect(r.supervisors).toEqual([])
    expect(prismaMock.staff.findMany).not.toHaveBeenCalled()
  })

  it('mapea los 4 estados a sus columnas y suma asignados', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_PENDING', 3),
      g('p1', 's1', 'PROMOTER_HELD', 79),
      g('p1', 's1', 'PROMOTER_REJECTED', 1),
      g('p1', 's1', 'SOLD', 377),
    ])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.promoters[0]).toMatchObject({
      promoterId: 'p1',
      promoterName: 'Josefina Alvarado',
      enRevision: 3,
      enSuPoder: 79,
      rechazados: 1,
      vendidos: 377,
      asignados: 460,
    })
    expect(r.totals.asignados).toBe(460)
  })

  it('consulta sólo los 4 estados atribuibles, sobre el pool de la org', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 's1', 'PROMOTER_HELD', 1)])

    await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    const arg = prismaMock.serializedItem.groupBy.mock.calls[0][0]
    expect(arg.by).toEqual(['assignedPromoterId', 'assignedSupervisorId', 'custodyState'])
    expect(arg.where.custodyState).toEqual({ in: ['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED', 'SOLD'] })
    expect(arg.where.OR).toEqual([{ venueId: { in: VENUES } }, { organizationId: ORG }])
    expect(arg.where.registeredFromVenueId).toBeUndefined()
  })

  it('MERGE — un promotor con 2 supervisores aparece UNA sola vez', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_HELD', 10),
      g('p1', 's2', 'PROMOTER_HELD', 5),
    ])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.promoters).toHaveLength(1)
    expect(r.promoters[0]).toMatchObject({ promoterId: 'p1', enSuPoder: 15, asignados: 15 })
    expect(r.promoters[0].supervisors.map(s => s.supervisorName)).toEqual(['Hugo Delgado', 'Renata Cortés'])
  })

  it('promoterCount cuenta al promotor en AMBOS supervisores', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_HELD', 10),
      g('p1', 's2', 'PROMOTER_HELD', 5),
      g('p2', 's2', 'PROMOTER_HELD', 5),
    ])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    const s2 = r.supervisors.find(s => s.supervisorId === 's2')!
    expect(s2.promoterCount).toBe(2)
    // Σ promoterCount (1 + 2) excede promoters.length (2) — es correcto, no un bug
    expect(r.supervisors.reduce((a, s) => a + s.promoterCount, 0)).toBeGreaterThan(r.promoters.length)
  })

  it('CUADRE — Σ promotores == totals == Σ supervisores, en los 5 campos', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_HELD', 10),
      g('p1', 's2', 'SOLD', 5),
      g('p2', 's2', 'PROMOTER_PENDING', 7),
      g(null, null, 'SOLD', 3),
    ])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    for (const k of ['asignados', 'enRevision', 'enSuPoder', 'rechazados', 'vendidos'] as const) {
      expect(r.promoters.reduce((a, p) => a + p[k], 0)).toBe(r.totals[k])
      expect(r.supervisors.reduce((a, s) => a + s[k], 0)).toBe(r.totals[k])
    }
    expect(r.totals.asignados).toBe(25)
  })

  it('las filas sin titular NO se descartan (romperían el cuadre)', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g(null, null, 'SOLD', 7), g('p1', 's1', 'SOLD', 2)])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.totals.vendidos).toBe(9)
    expect(r.promoters.find(p => p.promoterId === null)).toMatchObject({ promoterName: 'Sin promotor asignado', vendidos: 7 })
    expect(r.supervisors.find(s => s.supervisorId === null)).toMatchObject({ supervisorName: 'Sin supervisor asignado' })
  })

  it('staff borrado → "(empleado eliminado)", nunca el id crudo', async () => {
    prismaMock.staff.findMany.mockResolvedValue([])
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p_ghost', 's_ghost', 'PROMOTER_HELD', 3)])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.promoters[0].promoterName).toBe('(empleado eliminado)')
    expect(r.promoters[0].promoterId).toBe('p_ghost') // el id SÍ se devuelve, para encadenar llamadas
    expect(r.supervisors[0].supervisorName).toBe('(empleado eliminado)')
  })

  it('ORDEN — asignados desc, desempate por nombre, fila nula al final', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_HELD', 5), // Josefina
      g('p2', 's1', 'PROMOTER_HELD', 5), // Lucía — mismo conteo, desempata por nombre
      g(null, 's1', 'PROMOTER_HELD', 999), // la nula va al final aunque sea la más grande
    ])

    const r = await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(r.promoters.map(p => p.promoterName)).toEqual(['Josefina Alvarado', 'Lucía Briones', 'Sin promotor asignado'])
  })

  it('registeredFromVenueId entra al where cuando se pasa', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 's1', 'PROMOTER_HELD', 1)])

    await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES, registeredFromVenueId: 'v_virtual' })

    expect(prismaMock.serializedItem.groupBy.mock.calls[0][0].where.registeredFromVenueId).toBe('v_virtual')
  })

  it('AISLAMIENTO — el scope incluye el pool org-level (venueId=null) vía organizationId', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([g('p1', 's1', 'PROMOTER_HELD', 1)])

    await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    // orgPoolWhere: los ítems con venueId=null entran por `organizationId`, no por `venueId`.
    // Sin esta rama, PT (que registra sus SIMs a nivel org) devolvería casi nada.
    const or = prismaMock.serializedItem.groupBy.mock.calls[0][0].where.OR
    expect(or).toContainEqual({ organizationId: ORG })
  })

  it('resuelve nombres en UNA lectura bulk, nunca N+1', async () => {
    prismaMock.serializedItem.groupBy.mockResolvedValue([
      g('p1', 's1', 'PROMOTER_HELD', 1),
      g('p2', 's2', 'PROMOTER_HELD', 1),
    ])

    await serializedInventoryService.getOrgCustodyByPromoter({ orgId: ORG, allowedVenueIds: VENUES })

    expect(prismaMock.staff.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staff.findMany.mock.calls[0][0].where.id.in.sort()).toEqual(['p1', 'p2', 's1', 's2'])
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
npm test -- tests/unit/services/serialized-inventory/custodyByPromoter.test.ts
```

Esperado: FAIL con `serializedInventoryService.getOrgCustodyByPromoter is not a function`.

- [ ] **Step 3: Añadir constantes y helpers a nivel módulo**

En `src/services/serialized-inventory/serializedInventory.service.ts`, junto a los demás tipos del archivo (fuera de la clase):

```ts
/** Los 4 estados de custodia atribuibles a un promotor. ADMIN_HELD y SUPERVISOR_HELD no lo son. */
const PROMOTER_CUSTODY_STATES = ['PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED', 'SOLD'] as const

export type CustodyCounts = {
  asignados: number
  enRevision: number
  enSuPoder: number
  rechazados: number
  vendidos: number
}

type CustodyField = Exclude<keyof CustodyCounts, 'asignados'>

const STATE_TO_FIELD: Record<string, CustodyField> = {
  PROMOTER_PENDING: 'enRevision',
  PROMOTER_HELD: 'enSuPoder',
  PROMOTER_REJECTED: 'rechazados',
  SOLD: 'vendidos',
}

const zeroCounts = (): CustodyCounts => ({ asignados: 0, enRevision: 0, enSuPoder: 0, rechazados: 0, vendidos: 0 })

/**
 * Orden determinista: `asignados` desc, desempate por nombre asc (es-MX), y la
 * fila sin titular SIEMPRE al final. Sin esto, dos llamadas idénticas devuelven
 * el mismo contenido en distinto orden y parece un cambio de datos.
 */
function sortCustodyRows<T extends CustodyCounts>(rows: T[], isNull: (r: T) => boolean, nameOf: (r: T) => string): T[] {
  return rows.sort((a, b) => {
    const [an, bn] = [isNull(a), isNull(b)]
    if (an !== bn) return an ? 1 : -1
    if (b.asignados !== a.asignados) return b.asignados - a.asignados
    return nameOf(a).localeCompare(nameOf(b), 'es-MX')
  })
}
```

- [ ] **Step 4: Implementar el método en la clase**

Añadir a la clase, inmediatamente después de `getOrgSalesByPromoterAndCategory`:

```ts
  /**
   * Inventario serializado agregado POR PROMOTOR y POR SUPERVISOR.
   *
   * Un solo groupBy sobre @@index([assignedPromoterId, custodyState]). Ambas
   * agregaciones y los totales salen de esas MISMAS filas, en memoria — no hay
   * un segundo query.
   *
   * Semántica MIXTA, a propósito: `vendidos` es acumulado histórico (SOLD
   * conserva el promotor para siempre); `enRevision`/`enSuPoder`/`rechazados`
   * son foto de hoy, porque collectFromPromoter (custody.service.ts:519) pone
   * assignedPromoterId a null al recoger. Por eso `asignados` significa "lo que
   * está o estuvo a su nombre y no le fue recogido", que es justo lo que sirve
   * para un conteo físico.
   */
  async getOrgCustodyByPromoter(opts: {
    orgId: string
    allowedVenueIds: string[]
    registeredFromVenueId?: string
  }): Promise<{
    totals: CustodyCounts
    promoters: Array<
      CustodyCounts & {
        promoterId: string | null
        promoterName: string
        supervisors: Array<{ supervisorId: string | null; supervisorName: string }>
      }
    >
    supervisors: Array<CustodyCounts & { supervisorId: string | null; supervisorName: string; promoterCount: number }>
  }> {
    const rows = await this.db.serializedItem.groupBy({
      by: ['assignedPromoterId', 'assignedSupervisorId', 'custodyState'],
      where: {
        ...this.orgPoolWhere(opts.orgId, opts.allowedVenueIds),
        custodyState: { in: [...PROMOTER_CUSTODY_STATES] as SerializedItemCustodyState[] },
        ...(opts.registeredFromVenueId ? { registeredFromVenueId: opts.registeredFromVenueId } : {}),
      },
      _count: true,
    })

    const totals = zeroCounts()
    if (rows.length === 0) return { totals, promoters: [], supervisors: [] }

    // Nombres en UNA lectura bulk (promotores y supervisores juntos), nunca N+1.
    const staffIds = [
      ...new Set(rows.flatMap(r => [r.assignedPromoterId, r.assignedSupervisorId]).filter((id): id is string => !!id)),
    ]
    const staff = staffIds.length
      ? await this.db.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
      : []
    const nameOf = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
    // NUNCA caer al id crudo como nombre (mismo criterio que sim_custody).
    const promoterLabel = (id: string | null) => (id === null ? 'Sin promotor asignado' : (nameOf.get(id) ?? '(empleado eliminado)'))
    const supervisorLabel = (id: string | null) => (id === null ? 'Sin supervisor asignado' : (nameOf.get(id) ?? '(empleado eliminado)'))

    type PBucket = CustodyCounts & { promoterId: string | null; supervisorIds: Set<string | null> }
    type SBucket = CustodyCounts & { supervisorId: string | null; promoterIds: Set<string | null> }
    const pBuckets = new Map<string, PBucket>()
    const sBuckets = new Map<string, SBucket>()

    for (const row of rows) {
      const count = row._count as unknown as number
      const field = STATE_TO_FIELD[row.custodyState]
      if (!field) continue // defensivo: el where ya excluye cualquier otro estado

      totals[field] += count
      totals.asignados += count

      const pKey = row.assignedPromoterId ?? '__none__'
      const p = pBuckets.get(pKey) ?? { ...zeroCounts(), promoterId: row.assignedPromoterId, supervisorIds: new Set<string | null>() }
      p[field] += count
      p.asignados += count
      p.supervisorIds.add(row.assignedSupervisorId)
      pBuckets.set(pKey, p)

      const sKey = row.assignedSupervisorId ?? '__none__'
      const s = sBuckets.get(sKey) ?? { ...zeroCounts(), supervisorId: row.assignedSupervisorId, promoterIds: new Set<string | null>() }
      s[field] += count
      s.asignados += count
      s.promoterIds.add(row.assignedPromoterId)
      sBuckets.set(sKey, s)
    }

    const promoters = [...pBuckets.values()].map(({ supervisorIds, ...counts }) => ({
      ...counts,
      promoterName: promoterLabel(counts.promoterId),
      supervisors: [...supervisorIds]
        .map(id => ({ supervisorId: id, supervisorName: supervisorLabel(id) }))
        .sort((a, z) => a.supervisorName.localeCompare(z.supervisorName, 'es-MX')),
    }))

    const supervisors = [...sBuckets.values()].map(({ promoterIds, ...counts }) => ({
      ...counts,
      supervisorName: supervisorLabel(counts.supervisorId),
      promoterCount: promoterIds.size,
    }))

    return {
      totals,
      promoters: sortCustodyRows(promoters, p => p.promoterId === null, p => p.promoterName),
      supervisors: sortCustodyRows(supervisors, s => s.supervisorId === null, s => s.supervisorName),
    }
  }
```

Verificar que `SerializedItemCustodyState` ya esté importado en el archivo (lo usa `listOrgItems`). Si no, añadirlo al import de `@prisma/client`.

- [ ] **Step 5: Correr los tests y verificar que pasan**

```bash
npm test -- tests/unit/services/serialized-inventory/custodyByPromoter.test.ts
```

Esperado: PASS, 12 tests.

- [ ] **Step 6: Formato y lint**

```bash
npm run format && npm run lint:fix
```

- [ ] **Step 7: Commit (NO ejecutar sin permiso del founder)**

```bash
git add src/services/serialized-inventory/serializedInventory.service.ts tests/unit/services/serialized-inventory/custodyByPromoter.test.ts
git commit -m "feat(mcp): agregar custodia de inventario serializado por promotor y supervisor"
```

---

## Task 2: `listOrgItems` — filtro por sucursal receptora y titulares en el resultado

**Files:**
- Modify: `src/services/serialized-inventory/serializedInventory.service.ts:702-733` (sólo `listOrgItems`)
- Test: `tests/unit/services/serialized-inventory/listOrgItems.test.ts` (crear)

**Interfaces:**
- Consumes: `this.orgPoolWhere(...)`.
- Produces: `listOrgItems` con dos campos nuevos por ítem (`assignedPromoter`, `assignedSupervisor`) y un parámetro nuevo (`registeredFromVenueId`). Lo consume Task 4.

```ts
// El tipo va inline en la firma (no hay alias que definir):
// { items: (SerializedItem & {
//     category: ItemCategory
//     assignedPromoter: { id: string; firstName: string; lastName: string } | null
//     assignedSupervisor: { id: string; firstName: string; lastName: string } | null
//   })[]; total: number }
```

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/services/serialized-inventory/listOrgItems.test.ts`:

```ts
import { prismaMock } from '../../../__helpers__/setup'
import { serializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'

const ORG = 'org_1'
const VENUES = ['v1', 'v2']

describe('listOrgItems — filtro por sucursal receptora y titulares', () => {
  beforeEach(() => {
    prismaMock.serializedItem.findMany.mockResolvedValue([])
    prismaMock.serializedItem.count.mockResolvedValue(0)
  })

  it('pasa registeredFromVenueId al where de findMany y de count', async () => {
    await serializedInventoryService.listOrgItems({ orgId: ORG, allowedVenueIds: VENUES, registeredFromVenueId: 'v_virtual' })

    expect(prismaMock.serializedItem.findMany.mock.calls[0][0].where.registeredFromVenueId).toBe('v_virtual')
    expect(prismaMock.serializedItem.count.mock.calls[0][0].where.registeredFromVenueId).toBe('v_virtual')
  })

  it('omite registeredFromVenueId del where cuando no se pasa', async () => {
    await serializedInventoryService.listOrgItems({ orgId: ORG, allowedVenueIds: VENUES })

    expect(prismaMock.serializedItem.findMany.mock.calls[0][0].where.registeredFromVenueId).toBeUndefined()
  })

  it('incluye promotor y supervisor en el include, para no obligar a una llamada por promotor', async () => {
    await serializedInventoryService.listOrgItems({ orgId: ORG, allowedVenueIds: VENUES })

    const include = prismaMock.serializedItem.findMany.mock.calls[0][0].include
    expect(include.category).toBe(true)
    expect(include.assignedPromoter).toEqual({ select: { id: true, firstName: true, lastName: true } })
    expect(include.assignedSupervisor).toEqual({ select: { id: true, firstName: true, lastName: true } })
  })

  it('REGRESIÓN — los filtros que ya existían siguen llegando al where', async () => {
    await serializedInventoryService.listOrgItems({
      orgId: ORG,
      allowedVenueIds: VENUES,
      categoryId: 'c1',
      status: 'AVAILABLE' as never,
      custodyState: 'PROMOTER_HELD' as never,
      assignedPromoterId: 'p1',
    })

    const where = prismaMock.serializedItem.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      categoryId: 'c1',
      status: 'AVAILABLE',
      custodyState: 'PROMOTER_HELD',
      assignedPromoterId: 'p1',
    })
    expect(where.OR).toEqual([{ venueId: { in: VENUES } }, { organizationId: ORG }])
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
npm test -- tests/unit/services/serialized-inventory/listOrgItems.test.ts
```

Esperado: FAIL en los primeros tres tests (`registeredFromVenueId` undefined, `include.assignedPromoter` undefined). El cuarto (regresión) debe pasar ya.

- [ ] **Step 3: Modificar `listOrgItems`**

Reemplazar el cuerpo de `listOrgItems` (`serializedInventory.service.ts:702-733`) por:

```ts
  async listOrgItems(opts: {
    orgId: string
    allowedVenueIds: string[]
    categoryId?: string
    status?: SerializedItemStatus
    custodyState?: SerializedItemCustodyState
    assignedPromoterId?: string
    registeredFromVenueId?: string
    skip?: number
    take?: number
  }): Promise<{
    items: (SerializedItem & {
      category: ItemCategory
      assignedPromoter: { id: string; firstName: string; lastName: string } | null
      assignedSupervisor: { id: string; firstName: string; lastName: string } | null
    })[]
    total: number
  }> {
    const where: Prisma.SerializedItemWhereInput = {
      ...this.orgPoolWhere(opts.orgId, opts.allowedVenueIds),
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.custodyState ? { custodyState: opts.custodyState } : {}),
      ...(opts.assignedPromoterId ? { assignedPromoterId: opts.assignedPromoterId } : {}),
      ...(opts.registeredFromVenueId ? { registeredFromVenueId: opts.registeredFromVenueId } : {}),
    }

    const [items, total] = await Promise.all([
      this.db.serializedItem.findMany({
        where,
        include: {
          category: true,
          // Devolver al titular: el tool ya FILTRABA por promotor pero no lo
          // regresaba, lo que obligaba a una llamada por promotor para saber
          // quién trae qué.
          assignedPromoter: { select: { id: true, firstName: true, lastName: true } },
          assignedSupervisor: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take ?? 50,
      }),
      this.db.serializedItem.count({ where }),
    ])

    return { items, total }
  }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
npm test -- tests/unit/services/serialized-inventory/listOrgItems.test.ts
```

Esperado: PASS, 4 tests.

- [ ] **Step 5: Formato y lint**

```bash
npm run format && npm run lint:fix
```

- [ ] **Step 6: Commit (NO ejecutar sin permiso del founder)**

```bash
git add src/services/serialized-inventory/serializedInventory.service.ts tests/unit/services/serialized-inventory/listOrgItems.test.ts
git commit -m "feat(mcp): listOrgItems devuelve titular y acepta filtro por sucursal receptora"
```

---

## Task 3: Tool `serialized_custody_by_promoter`

**Files:**
- Modify: `src/mcp/tools/serialized.ts` (añadir un bloque `server.tool(...)` dentro de `registerSerializedTools`, después de `serialized_sales_by_promoter`)
- Test: `tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts` (crear)

**Interfaces:**
- Consumes: `serializedInventoryService.getOrgCustodyByPromoter` (Task 1); `guard.venueFilter`, `guard.requirePermission` de `createGuard(scope)`; `moduleService.isModuleEnabled`; `ROLE_HIERARCHY`, `StaffRole`; `text` de `../respond`. Todos ya importados en el archivo.
- Produces: el tool `serialized_custody_by_promoter` en el catálogo MCP.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts`:

```ts
import { StaffRole } from '@prisma/client'
import { registerSerializedTools } from '../../../../src/mcp/tools/serialized'
import { serializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'
import { moduleService } from '../../../../src/services/modules/module.service'
import type { McpScope } from '../../../../src/mcp/scope'

/** Captura los handlers que registerSerializedTools registra, sin levantar un servidor MCP. */
function captureTools(scope: McpScope) {
  const handlers = new Map<string, (args: never) => Promise<{ content: { type: 'text'; text: string }[] }>>()
  const server = { tool: (name: string, _d: string, _s: unknown, h: never) => handlers.set(name, h) }
  registerSerializedTools(server as never, scope)
  return handlers
}

const makeScope = (role: StaffRole): McpScope =>
  ({
    activeOrg: 'org_1',
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map([['v1', { organizationId: 'org_1', role, permissions: ['inventory:read'] }]]),
  }) as unknown as McpScope

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

describe('serialized_custody_by_promoter — gates', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true)
    jest.spyOn(serializedInventoryService, 'getOrgCustodyByPromoter').mockResolvedValue({
      totals: { asignados: 1, enRevision: 0, enSuPoder: 1, rechazados: 0, vendidos: 0 },
      promoters: [],
      supervisors: [],
    })
  })

  it('módulo apagado → moduleRequired y NINGÚN dato', async () => {
    jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(false)
    const h = captureTools(makeScope(StaffRole.OWNER)).get('serialized_custody_by_promoter')!

    const out = parse(await h({ venueId: 'v1' } as never))

    expect(out).toMatchObject({ ok: false, moduleRequired: true })
    expect(out.totals).toBeUndefined()
    expect(serializedInventoryService.getOrgCustodyByPromoter).not.toHaveBeenCalled()
  })

  it('venue fuera de scope → lanza ScopeError', async () => {
    const h = captureTools(makeScope(StaffRole.OWNER)).get('serialized_custody_by_promoter')!

    await expect(h({ venueId: 'v_ajeno' } as never)).rejects.toThrow()
  })

  it('registeredFromVenueId fuera de scope → lanza ScopeError', async () => {
    const h = captureTools(makeScope(StaffRole.OWNER)).get('serialized_custody_by_promoter')!

    await expect(h({ venueId: 'v1', registeredFromVenueId: 'v_ajeno' } as never)).rejects.toThrow()
  })

  it('rol menor a MANAGER → rechazo en español y NINGÚN dato', async () => {
    const h = captureTools(makeScope(StaffRole.WAITER)).get('serialized_custody_by_promoter')!

    const out = parse(await h({ venueId: 'v1' } as never))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/MANAGER/)
    expect(serializedInventoryService.getOrgCustodyByPromoter).not.toHaveBeenCalled()
  })

  it('MANAGER pasa y recibe los tres bloques', async () => {
    const h = captureTools(makeScope(StaffRole.MANAGER)).get('serialized_custody_by_promoter')!

    const out = parse(await h({ venueId: 'v1' } as never))

    expect(out).toMatchObject({ orgId: 'org_1', registeredFromVenueId: null })
    expect(out.totals.asignados).toBe(1)
    expect(serializedInventoryService.getOrgCustodyByPromoter).toHaveBeenCalledWith({
      orgId: 'org_1',
      allowedVenueIds: ['v1'],
      registeredFromVenueId: undefined,
    })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
npm test -- tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts
```

Esperado: FAIL — `handlers.get('serialized_custody_by_promoter')` es `undefined`.

- [ ] **Step 3: Registrar el tool**

En `src/mcp/tools/serialized.ts`, después del bloque de `serialized_sales_by_promoter` (termina en la línea 437):

```ts
  server.tool(
    'serialized_custody_by_promoter',
    'Inventario de SIMs EN PODER DE CADA PROMOTOR, agregado por promotor y por supervisor. Responde "¿cuántos SIMs trae hoy cada promotor?", "saldo por promotor", "¿cuántos le quedan por entregar?", "inventario por supervisor", "cuadre de inventario físico". Por cada promotor devuelve: enRevision (asignados, pendientes de aceptar en TPV), enSuPoder (saldo actual vendible), rechazados (rechazados y aún NO recogidos por el supervisor), vendidos, y asignados = la suma de los cuatro. Este desglose SÍ existe: usa ESTE tool en vez de llamar list_serialized_items promotor por promotor. OJO con la semántica, que es mixta a propósito: "vendidos" es acumulado histórico (el vínculo promotor↔SIM sobrevive la venta), mientras que los otros tres son foto de HOY (se borran cuando el supervisor recoge el SIM). Por eso "asignados" significa "lo que está o estuvo a su nombre y no le fue recogido", NO "todo lo que se le entregó alguna vez". Un promotor con inventario cero NO aparece en la lista; para el roster completo usa org_structure. Opcionalmente filtra por registeredFromVenueId (la sucursal desde la que se dieron de alta los SIMs). Cubre las tiendas de la organización MÁS el pool org-level. Solo venues con SERIALIZED_INVENTORY, y solo OWNER/ADMIN/MANAGER.',
    {
      venueId: z.string().describe('Venue (must be in your scope) — for the module gate + org resolution'),
      registeredFromVenueId: z
        .string()
        .optional()
        .describe('Filtrar por la sucursal receptora desde la que se registraron los SIMs (debe estar en tu scope)'),
    },
    async ({ venueId, registeredFromVenueId }) => {
      guard.venueFilter(venueId)
      // Un id de venue que entra por parámetro NO puede apuntar fuera del scope.
      if (registeredFromVenueId) guard.venueFilter(registeredFromVenueId)
      if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
        return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
      }
      guard.requirePermission('inventory:read', venueId)
      // Mismo gate de rol que sim_custody: es visibilidad org-wide de custodia
      // atribuida a personas con nombre.
      const callerRole = scope.perVenueAccess.get(venueId)?.role
      if (!callerRole || ROLE_HIERARCHY[callerRole] < ROLE_HIERARCHY[StaffRole.MANAGER]) {
        return text({ ok: false, error: 'Solo OWNER, ADMIN o MANAGER pueden ver el inventario por promotor de la organización.' })
      }
      const orgId = scope.perVenueAccess.get(venueId)?.organizationId
      if (!orgId) return text({ ok: false, error: 'No pude resolver la organización de este venue.' })

      const result = await serializedInventoryService.getOrgCustodyByPromoter({
        orgId,
        allowedVenueIds: scope.allowedVenueIds,
        registeredFromVenueId,
      })

      return text({
        orgId,
        registeredFromVenueId: registeredFromVenueId ?? null,
        totals: result.totals,
        promoterCount: result.promoters.length,
        promoters: result.promoters,
        supervisors: result.supervisors,
      })
    },
  )
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

```bash
npm test -- tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts
```

Esperado: PASS, 5 tests.

- [ ] **Step 5: Formato y lint**

```bash
npm run format && npm run lint:fix
```

- [ ] **Step 6: Commit (NO ejecutar sin permiso del founder)**

```bash
git add src/mcp/tools/serialized.ts tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts
git commit -m "feat(mcp): tool serialized_custody_by_promoter con gate MANAGER+"
```

---

## Task 4: `list_serialized_items` — titular en la salida y filtro nuevo

**Files:**
- Modify: `src/mcp/tools/serialized.ts:343-400`

**Interfaces:**
- Consumes: `listOrgItems` extendido (Task 2).
- Produces: cada ítem devuelve `promoter` y `supervisor` como `{ id, name } | null`.

- [ ] **Step 1: Añadir el parámetro y la referencia cruzada en la descripción**

En el bloque de `list_serialized_items`, añadir al final del string de descripción (antes de `Pass venueId`):

```
Cada ítem devuelve también su promotor y supervisor actuales. Si lo que quieres son TOTALES por promotor (cuántos trae cada uno), usa serialized_custody_by_promoter en vez de paginar esto.
```

Y añadir el parámetro al esquema, después de `assignedPromoterId`:

```ts
      registeredFromVenueId: z
        .string()
        .optional()
        .describe('Filtrar por la sucursal receptora desde la que se registraron los SIMs (debe estar en tu scope)'),
```

- [ ] **Step 2: Pasar y validar el parámetro nuevo**

Añadir `registeredFromVenueId` a la desestructuración del handler, y justo después de `guard.venueFilter(venueId)`:

```ts
      if (registeredFromVenueId) guard.venueFilter(registeredFromVenueId)
```

Y pasarlo a la llamada del servicio, junto a los demás filtros:

```ts
        registeredFromVenueId,
```

- [ ] **Step 3: Devolver el titular en cada ítem**

Reemplazar el `items.map(...)` del `return text({...})`:

```ts
        items: items.map(i => ({
          serialNumber: i.serialNumber,
          status: i.status,
          custodyState: i.custodyState,
          category: i.category?.name ?? null,
          venueId: i.venueId,
          promoter: i.assignedPromoter
            ? { id: i.assignedPromoter.id, name: `${i.assignedPromoter.firstName} ${i.assignedPromoter.lastName}`.trim() }
            : null,
          supervisor: i.assignedSupervisor
            ? { id: i.assignedSupervisor.id, name: `${i.assignedSupervisor.firstName} ${i.assignedSupervisor.lastName}`.trim() }
            : null,
        })),
```

- [ ] **Step 4: Verificar que compila y que nada se rompió**

```bash
npx tsc --noEmit
npm test -- tests/unit/services/serialized-inventory/ tests/unit/mcp/
```

Esperado: sin errores de tipos; todos los tests de esas rutas en PASS.

- [ ] **Step 5: Formato y lint**

```bash
npm run format && npm run lint:fix
```

- [ ] **Step 6: Commit (NO ejecutar sin permiso del founder)**

```bash
git add src/mcp/tools/serialized.ts
git commit -m "feat(mcp): list_serialized_items devuelve titular y filtra por sucursal receptora"
```

---

## Task 5: Regresión del dashboard, cuadre contra base real y pre-deploy

**Files:**
- Test: `tests/unit/services/serialized-inventory/dashboardRegression.test.ts` (crear)
- Create (temporal, se borra): `scripts/temp-custody-reconcile.ts`

- [ ] **Step 1: Escribir el test de regresión**

Crear `tests/unit/services/serialized-inventory/dashboardRegression.test.ts`:

```ts
import { prismaMock } from '../../../__helpers__/setup'
import { serializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'

/**
 * REGRESIÓN — los métodos venue-scoped los consumen dashboard y TPV. Este
 * trabajo sólo puede rozar a `listItems` y `getStockByCategory`, que comparten
 * archivo con `listOrgItems`. Si alguno cambia de forma, el dashboard se rompe
 * en silencio.
 */
describe('métodos venue-scoped del dashboard — sin cambios de contrato', () => {
  it('listItems sigue filtrando venueId ESTRICTO (sin la rama org-level)', async () => {
    prismaMock.serializedItem.findMany.mockResolvedValue([])
    prismaMock.serializedItem.count.mockResolvedValue(0)

    await serializedInventoryService.listItems({ venueId: 'v1' } as never)

    const where = prismaMock.serializedItem.findMany.mock.calls[0][0].where
    expect(where.venueId).toBe('v1')
    expect(where.OR).toBeUndefined() // orgPoolWhere NO debe haberse colado aquí
  })

  it('listItems NO incluye promotor/supervisor (eso es sólo del camino org-aware)', async () => {
    prismaMock.serializedItem.findMany.mockResolvedValue([])
    prismaMock.serializedItem.count.mockResolvedValue(0)

    await serializedInventoryService.listItems({ venueId: 'v1' } as never)

    const include = prismaMock.serializedItem.findMany.mock.calls[0][0].include
    expect(include?.assignedPromoter).toBeUndefined()
  })
})
```

- [ ] **Step 2: Correr el test de regresión**

```bash
npm test -- tests/unit/services/serialized-inventory/dashboardRegression.test.ts
```

Esperado: PASS, 2 tests. Si falla, alguien tocó `listItems` — revertir ese cambio, no ajustar el test.

- [ ] **Step 3: Confirmar por diff que los 8 métodos prohibidos no se tocaron**

```bash
git diff develop -- src/services/serialized-inventory/serializedInventory.service.ts | grep -nE "^[-+].*(listItems|getStockByCategory|getCategories|async scan|registerBatch|ensureSellable|createCategory)" || echo "OK — ningún método prohibido en el diff"
```

Esperado: `OK — ningún método prohibido en el diff`.

- [ ] **Step 4: Escribir el script temporal de cuadre**

Crear `scripts/temp-custody-reconcile.ts`:

```ts
// DELETE AFTER: script temporal de verificación (AC-4 del spec 2026-07-29).
// Propósito: probar que los tres cortes de inventario serializado cuadran entre sí.
// Uso: npx ts-node -r tsconfig-paths/register scripts/temp-custody-reconcile.ts <orgId> [venueId]
// El orgId entra POR ARGUMENTO — este repo es público, nunca hardcodear ids.
import prisma from '@/utils/prismaClient'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'

async function main() {
  const [orgId] = process.argv.slice(2)
  if (!orgId) {
    console.error('Uso: npx ts-node -r tsconfig-paths/register scripts/temp-custody-reconcile.ts <orgId>')
    process.exit(2)
  }

  const venues = await prisma.venue.findMany({ where: { organizationId: orgId }, select: { id: true } })
  const allowedVenueIds = venues.map(v => v.id)

  const [custody, sales, byCategory] = await Promise.all([
    serializedInventoryService.getOrgCustodyByPromoter({ orgId, allowedVenueIds }),
    serializedInventoryService.getOrgSalesByPromoterAndCategory({ orgId, allowedVenueIds }),
    serializedInventoryService.getOrgStockByCategory(orgId, allowedVenueIds),
  ])

  const a = custody.totals.vendidos
  const b = sales.totalSold
  const c = byCategory.reduce((acc, r) => acc + r.sold, 0)

  console.log(`custody_by_promoter.totals.vendidos = ${a}`)
  console.log(`sales_by_promoter.totalSold         = ${b}`)
  console.log(`stock_by_category (Σ sold)          = ${c}`)

  // Cuadre interno: Σ promotores == totals == Σ supervisores
  const sumP = custody.promoters.reduce((x, p) => x + p.asignados, 0)
  const sumS = custody.supervisors.reduce((x, s) => x + s.asignados, 0)
  console.log(`asignados: totals=${custody.totals.asignados} Σpromotores=${sumP} Σsupervisores=${sumS}`)

  const ok = a === b && b === c && sumP === custody.totals.asignados && sumS === custody.totals.asignados
  console.log(ok ? '\n✅ CUADRA' : '\n❌ NO CUADRA')
  process.exit(ok ? 0 : 1)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 5: Correr el cuadre contra una base con datos serializados reales**

```bash
npx ts-node -r tsconfig-paths/register scripts/temp-custody-reconcile.ts <orgId>
```

Esperado: `✅ CUADRA` y exit 0. **Guardar la salida** — va en la descripción del PR como evidencia de AC-4. Si sale `❌ NO CUADRA`, los tres `where` divergieron: comparar que los tres pasen por `orgPoolWhere(orgId, allowedVenueIds)` con los mismos argumentos.

- [ ] **Step 6: Borrar el script temporal**

```bash
rm scripts/temp-custody-reconcile.ts
```

Política de `.claude/rules/testing-and-git.md`: los `scripts/temp-*.ts` se borran antes de commitear.

- [ ] **Step 7: Suite completa y pre-deploy**

```bash
npm test
npm run pre-deploy
```

Esperado: ambos en verde. `pre-deploy` es el gate obligatorio antes de considerar el trabajo terminado.

- [ ] **Step 8: Commit (NO ejecutar sin permiso del founder)**

```bash
git add tests/unit/services/serialized-inventory/dashboardRegression.test.ts
git commit -m "test(mcp): regresión de los métodos venue-scoped que consume el dashboard"
```

---

## Trazabilidad — cada criterio de aceptación del spec y quién lo prueba

| AC | Qué exige | Dónde se prueba |
| --- | --- | --- |
| AC-1 | `asignados` = suma de los 4, en cada fila | T1 · `mapea los 4 estados a sus columnas y suma asignados` |
| AC-2 | Σ promotores == totals == Σ supervisores, en los 5 campos | T1 · `CUADRE — Σ promotores == totals == Σ supervisores` |
| AC-3 | Cada `promoterId` aparece una sola vez (merge) | T1 · `MERGE — un promotor con 2 supervisores aparece UNA sola vez` |
| AC-4 | Cuadre entre los 3 tools, sin filtro | T5 · `scripts/temp-custody-reconcile.ts` (base real; salida al PR) |
| AC-5 | Módulo apagado → `moduleRequired`, sin datos | T3 · `módulo apagado → moduleRequired y NINGÚN dato` |
| AC-6 | Venue fuera de scope → `ScopeError` | T3 · `venue fuera de scope → lanza ScopeError` |
| AC-7 | Rol < MANAGER → rechazo, sin datos | T3 · `rol menor a MANAGER → rechazo en español` |
| AC-8 | Pool org-level incluido; otra org excluida | T1 · `AISLAMIENTO — el scope incluye el pool org-level` |
| AC-9 | `registeredFromVenueId` filtra consistente | T1 · `registeredFromVenueId entra al where` · T2 · `pasa registeredFromVenueId al where` |
| AC-10 | Filas nulas no se descartan | T1 · `las filas sin titular NO se descartan` |
| AC-11 | `promoterCount` cuenta en ambos supervisores | T1 · `promoterCount cuenta al promotor en AMBOS supervisores` |
| AC-12 | `list_serialized_items` devuelve titular y acepta el filtro | T2 · `incluye promotor y supervisor en el include` · T4 · Step 3-4 |
| AC-13 | Nombre nunca cae al id crudo | T1 · `staff borrado → "(empleado eliminado)"` |
| AC-14 | Los 8 métodos prohibidos no aparecen en el diff | T5 · Step 3 (`git diff` + grep) y `dashboardRegression.test.ts` |
| AC-15 | Orden determinista, nula al final | T1 · `ORDEN — asignados desc, desempate por nombre` |
| AC-16 | `registeredFromVenueId` fuera de scope → `ScopeError` | T3 · `registeredFromVenueId fuera de scope → lanza ScopeError` |
| AC-17 | `npm run pre-deploy` pasa | T5 · Step 7 |

Total: 23 tests unitarios (T1: 12, T2: 4, T3: 5, T5: 2) más la verificación de cuadre contra base real.

## Anotaciones para el revisor

**Inconsistencia preexistente, NO se corrige aquí.** `getOrgSalesByPromoterAndCategory` cae al **id crudo** cuando no resuelve el nombre de un promotor (`serializedInventory.service.ts:1083`, con un test que lo afirma en `salesByPromoter.test.ts:89`). El código nuevo de este plan usa `'(empleado eliminado)'`, siguiendo `sim_custody` (`serialized.ts:185-187`) y el spec. Quedan dos convenciones en el mismo archivo. Cambiar la existente rompería un test que pasa y está fuera del alcance acordado — vale la pena decidirlo aparte.

**Lo que este plan NO hace** (del spec §10): histórico de "cuántas se le entregaron alguna vez" (vive en `SerializedItemCustodyEvent`), cambios al dashboard white-label, writes de custodia desde el MCP, y tool de export tabular.

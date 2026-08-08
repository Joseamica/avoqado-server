# PITS · Cierre del hito H0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los dos puntos que faltan del hito H0 de PITS — exportación en inventario, compras y contabilidad (la bitácora ya quedó), y que "recibir ninguno" devuelva la mercancía al almacén en vez de dejar el inventario inflado.

**Architecture:** Las cuatro exportaciones copian el patrón ya probado en producción (pagos, órdenes, resumen de ventas): el controlador cuenta primero, rechaza si excede el tope, reusa el MISMO servicio de listado que la pantalla, arma `ExportColumnDef[]` y delega en `encodeExport`/`sendExport`. "Recibir ninguno" deriva lo que de verdad entró del estado real —lotes vivos y movimientos de inventario— y se niega si algo ya se consumió, siguiendo el modelo de Odoo: cancelar es "esto nunca pasó", devolver es otro documento.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Jest, React 18 (dashboard).

## Global Constraints

Estas aplican a TODAS las tareas. Violarlas es motivo de rechazo en la revisión.

- **Código en INGLÉS**: identificadores, comentarios, JSDoc y descripciones de prueba. En español SÓLO lo que lee una persona: mensajes de Zod, mensajes de `AppError`, etiquetas de UI, y las descripciones y llaves de salida de las herramientas del MCP.
- **Aislamiento multi-tenant**: TODA consulta filtra por `venueId` u `orgId`. Sin excepción.
- **`authContext`** se lee como `(req as any).authContext` — NUNCA `req.user`. Campos: `{ userId, orgId, venueId, role }`.
- **Permisos** con `checkPermission('recurso:accion')`. El nombre debe existir en `src/lib/permissions.ts`. NO crear permisos nuevos: usar `inventory:read`, `accounting:read`.
- **Dinero en PESOS 1:1** como `Decimal`. La ÚNICA excepción es el libro mayor (`...Cents`, enteros en centavos) — ahí se divide entre 100 antes de salir.
- **Fechas venue-local**: nunca `new Date('YYYY-MM-DD')` pelón. Usar `fromZonedTime(\`${fecha}T00:00:00.000\`, venueTz)`.
- **Orden de rutas Express**: las estáticas ANTES de las dinámicas `:param`. Una ruta `/export` debajo de `/:id` nace muerta.
- **`orderBy` único**: todo listado exportable ordena por algo único (agregar `id` como desempate) o pierde filas en silencio.
- **NO correr `npm run format` global** ni el typecheck del repo completo: otras sesiones trabajan en este árbol y el typecheck completo consume ~6 GB. Cada tarea corre `npx prettier --write <sus archivos>` y `npx jest <sus archivos de prueba> --maxWorkers=1`.
- **NO commitear.** El fundador tiene regla dura: nada de git sin su permiso explícito. Los pasos de commit de este plan quedan pendientes hasta que él lo autorice.
- **`tests/__helpers__/setup.ts` mockea globalmente** `@/services/dashboard/activity-log.service` con sólo `{ logAction: jest.fn() }`. Una función pura que viva ahí es INTESTABLE (el import vuelve `undefined` y el error dice "is not a function"). Las funciones puras van en su propio módulo.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `src/controllers/dashboard/inventory/export.controller.ts` | **Crear.** Los tres exports de inventario y compras. Un solo controlador porque comparten filtros, tope y forma. |
| `src/routes/dashboard/inventory.routes.ts` | **Modificar.** Cuatro rutas `/export`, todas antes de sus `:param`. |
| `src/services/dashboard/rawMaterial.service.ts` | **Modificar.** `countRawMaterialsForExport`. |
| `src/services/dashboard/purchaseOrder.service.ts` | **Modificar.** `countPurchaseOrdersForExport` y `revertReceiptForOrderInTx` (T5). |
| `src/controllers/dashboard/accounting.export.controller.ts` | **Crear.** Export de gastos y de la balanza. Separado de inventario: distinto candado de plan (`CFDI`) y distinto manejo de dinero (centavos). |
| `src/routes/dashboard/accounting.routes.ts` | **Modificar.** Dos rutas `/export`. |
| `tests/unit/controllers/dashboard/export.*.test.ts` | **Crear.** Una suite por tarea. |

---

## Task 1: Exportación de existencias (insumos)

**Files:**
- Create: `src/controllers/dashboard/inventory/export.controller.ts`
- Modify: `src/services/dashboard/rawMaterial.service.ts` (agregar al final)
- Modify: `src/routes/dashboard/inventory.routes.ts` (antes del bloque `RECIPES ROUTES`)
- Test: `tests/unit/controllers/dashboard/export.rawMaterials.test.ts`

**Interfaces:**
- Consumes: `getRawMaterials(venueId: string, filters?: { category?: string; lowStock?: boolean; active?: boolean; search?: string }): Promise<RawMaterial[]>` de `src/services/dashboard/rawMaterial.service.ts:59`. Helpers de `src/services/dashboard/export.helpers.ts`: `encodeExport`, `sendExport`, `parseFormatParam`, `parseColumnsParam`, `getRowCapForFormat`, `type ExportColumnDef`.
- Produces: `exportRawMaterials(req, res, next)` — lo consume la ruta. `countRawMaterialsForExport(venueId, filters): Promise<number>` — la usa T1 nada más.

- [ ] **Step 1: Escribir la prueba que falla**

`tests/unit/controllers/dashboard/export.rawMaterials.test.ts`:

```typescript
/**
 * Raw-material stock export.
 *
 * The matrix answers "exportable" for inventory and it was not: the generic export helper
 * existed and was wired to exactly three listings (payments, orders, sales summary).
 *
 * The two failure modes worth a test are the quiet ones — exporting a different row set than
 * the screen is showing, and truncating instead of refusing. Both produce a file that looks
 * complete and is not.
 */
import type { Request, Response } from 'express'

const getRawMaterials = jest.fn()
const countRawMaterialsForExport = jest.fn()
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ getRawMaterials, countRawMaterialsForExport }))

const encodeExport = jest.fn().mockResolvedValue({ body: Buffer.from(''), contentType: 'text/csv', extension: 'csv' })
const sendExport = jest.fn()
jest.mock('@/services/dashboard/export.helpers', () => ({
  ...jest.requireActual('@/services/dashboard/export.helpers'),
  encodeExport,
  sendExport,
}))

import { exportRawMaterials } from '@/controllers/dashboard/inventory/export.controller'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
const req = (query: Record<string, string> = {}) =>
  ({ params: { venueId: 'venue-1' }, query, authContext: { venueId: 'venue-1', userId: 'staff-1' } }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  countRawMaterialsForExport.mockResolvedValue(3)
  getRawMaterials.mockResolvedValue([
    { id: 'rm-1', name: 'Harina', sku: 'H-01', category: 'FOOD', unit: 'GRAM', currentStock: 1000, reorderPoint: 200, costPerUnit: 0.01, active: true },
  ])
})

describe('exportRawMaterials', () => {
  it('🔴 exports the SAME filters the screen is showing', async () => {
    // Exporting "everything" while the user looks at a filtered view is found late and badly:
    // the file is plausible, just wrong.
    await exportRawMaterials(req({ search: 'harina', category: 'FOOD', active: 'true' }), res(), jest.fn())

    expect(getRawMaterials).toHaveBeenCalledWith('venue-1', expect.objectContaining({ search: 'harina', category: 'FOOD', active: true }))
  })

  it('🔴 refuses over the cap instead of truncating', async () => {
    // A file with the first N rows reads as complete. Refusing is the honest answer.
    countRawMaterialsForExport.mockResolvedValue(999_999)
    const r = res()

    await exportRawMaterials(req(), r, jest.fn())

    expect(r.status).toHaveBeenCalledWith(413)
    expect(encodeExport).not.toHaveBeenCalled()
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => {
    await exportRawMaterials(req(), res(), jest.fn())
    expect(getRawMaterials).toHaveBeenCalledWith('venue-1', expect.anything())
  })

  it('ships the columns a stock take needs, labelled in Spanish', async () => {
    await exportRawMaterials(req(), res(), jest.fn())

    const columns = encodeExport.mock.calls[0][1].allColumns.map((c: { id: string }) => c.id)
    expect(columns).toEqual(expect.arrayContaining(['name', 'sku', 'category', 'unit', 'currentStock', 'reorderPoint', 'costPerUnit', 'stockValue']))
    const labels = encodeExport.mock.calls[0][1].allColumns.map((c: { label: string }) => c.label)
    expect(labels).toContain('Existencia')
  })

  it('computes stock value rather than making the reader do it', async () => {
    await exportRawMaterials(req(), res(), jest.fn())

    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'stockValue')
    expect(col.value({ currentStock: 1000, costPerUnit: 0.01 })).toBe(10)
  })
})
```

- [ ] **Step 2: Correr la prueba y verificar que falla**

Run: `npx jest tests/unit/controllers/dashboard/export.rawMaterials.test.ts --maxWorkers=1`
Expected: FAIL — "Cannot find module '@/controllers/dashboard/inventory/export.controller'"

- [ ] **Step 3: Agregar el contador al servicio**

Al final de `src/services/dashboard/rawMaterial.service.ts`:

```typescript
/**
 * Row count for the export, using the SAME filters as `getRawMaterials`. The controller
 * counts before building so it can refuse a file that would be truncated — a truncated
 * export reads as complete, which is the failure nobody reports.
 */
export async function countRawMaterialsForExport(
  venueId: string,
  filters?: { category?: string; lowStock?: boolean; active?: boolean; search?: string },
): Promise<number> {
  return prisma.rawMaterial.count({
    where: {
      venueId,
      deletedAt: null,
      ...(filters?.category && { category: filters.category as any }),
      ...(filters?.active !== undefined && { active: filters.active }),
      ...(filters?.search && {
        OR: [{ name: { contains: filters.search, mode: 'insensitive' } }, { sku: { contains: filters.search, mode: 'insensitive' } }],
      }),
    },
  })
}
```

- [ ] **Step 4: Crear el controlador**

`src/controllers/dashboard/inventory/export.controller.ts`:

```typescript
/**
 * Inventory and purchasing exports.
 *
 * The matrix answers "exportable" across inventory and purchasing; the generic helper
 * (`export.helpers.ts`) existed and was wired to exactly three listings. These follow the
 * same shape as those three, deliberately: count first, refuse over the cap, reuse the SAME
 * listing service the screen calls, then hand columns to `encodeExport`.
 *
 * Reusing the listing service is the load-bearing part. A second query built for the export
 * drifts from the one behind the screen, and then the file quietly disagrees with what the
 * user is looking at.
 */
import { NextFunction, Request, Response } from 'express'
import * as rawMaterialService from '../../../services/dashboard/rawMaterial.service'
import {
  encodeExport,
  sendExport,
  parseFormatParam,
  parseColumnsParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../../services/dashboard/export.helpers'

/** Current stock per raw material — the sheet someone walks the storeroom with. */
export async function exportRawMaterials(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const filters = {
      category: req.query.category as string | undefined,
      lowStock: req.query.lowStock === 'true',
      active: req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined,
      search: req.query.search as string | undefined,
    }

    const total = await rawMaterialService.countRawMaterialsForExport(venueId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message: `El rango contiene ${total.toLocaleString()} insumos. El máximo por exportación es ${cap.toLocaleString()}. Acota con filtros.`,
      })
      return
    }

    const rows = await rawMaterialService.getRawMaterials(venueId, filters)
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'name', label: 'Insumo', value: r => r.name },
      { id: 'sku', label: 'Clave', value: r => r.sku ?? '' },
      { id: 'category', label: 'Categoría', value: r => r.category ?? '' },
      { id: 'unit', label: 'Unidad', value: r => r.unit ?? '' },
      { id: 'currentStock', label: 'Existencia', value: r => Number(r.currentStock) || 0 },
      { id: 'reorderPoint', label: 'Punto de reorden', value: r => Number(r.reorderPoint) || 0 },
      { id: 'costPerUnit', label: 'Costo unitario', value: r => Number(r.costPerUnit) || 0 },
      // Computed here rather than left to the reader: the whole point of the sheet is what
      // the storeroom is worth, and a spreadsheet formula is one more thing to get wrong.
      { id: 'stockValue', label: 'Valor', value: r => Math.round(Number(r.currentStock ?? 0) * Number(r.costPerUnit ?? 0) * 100) / 100 },
      { id: 'active', label: 'Activo', value: r => (r.active ? 'Sí' : 'No') },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Existencias',
    })

    sendExport(res, encoded, 'existencias')
  } catch (error) {
    next(error)
  }
}
```

- [ ] **Step 5: Correr la prueba y verificar que pasa**

Run: `npx jest tests/unit/controllers/dashboard/export.rawMaterials.test.ts --maxWorkers=1`
Expected: PASS (5 pruebas)

- [ ] **Step 6: Montar la ruta**

En `src/routes/dashboard/inventory.routes.ts`, justo ANTES del comentario `// ===== RECIPES ROUTES =====`:

```typescript
// 🔴 Las rutas de exportación van ANTES de cualquier `/:param` de su familia, o Express
// se traga "export" como valor de parámetro y la ruta nace muerta — lo que le pasó a
// `/purchase-orders/stats`.
router.get('/raw-materials/export', checkPermission('inventory:read'), exportController.exportRawMaterials)
```

Y el import junto a los demás controladores:

```typescript
import * as exportController from '../../controllers/dashboard/inventory/export.controller'
```

- [ ] **Step 7: Guardia de orden de rutas**

Agregar a `tests/unit/routes/inventory.lotes.routes.test.ts`... **NO.** Crear `tests/unit/routes/inventory.export.routes.test.ts`:

```typescript
/**
 * Export routes are reachable.
 *
 * `/raw-materials/export` MUST be declared before `/raw-materials/:rawMaterialId`, or Express
 * matches "export" as the id and the endpoint is born dead. `/purchase-orders/stats` shipped
 * that way and nobody noticed until someone went looking.
 */
import * as fs from 'fs'
import * as path from 'path'

const source = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard/inventory.routes.ts'), 'utf8')

describe('export routes', () => {
  it('🔴 /raw-materials/export is declared before /raw-materials/:rawMaterialId', () => {
    expect(source.indexOf("'/raw-materials/export'")).toBeGreaterThan(-1)
    expect(source.indexOf("'/raw-materials/export'")).toBeLessThan(source.indexOf("'/raw-materials/:rawMaterialId'"))
  })

  it('requires inventory:read', () => {
    const at = source.indexOf("'/raw-materials/export'")
    expect(source.slice(at, at + 200)).toContain("checkPermission('inventory:read')")
  })
})
```

Run: `npx jest tests/unit/routes/inventory.export.routes.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 8: Formatear**

Run: `npx prettier --write src/controllers/dashboard/inventory/export.controller.ts src/services/dashboard/rawMaterial.service.ts src/routes/dashboard/inventory.routes.ts tests/unit/controllers/dashboard/export.rawMaterials.test.ts tests/unit/routes/inventory.export.routes.test.ts`

- [ ] **Step 9: Commit** — ⚠️ **PENDIENTE DE AUTORIZACIÓN DEL FUNDADOR.** No ejecutar.

```bash
git add src/controllers/dashboard/inventory/export.controller.ts src/services/dashboard/rawMaterial.service.ts src/routes/dashboard/inventory.routes.ts tests/unit/controllers/dashboard/export.rawMaterials.test.ts tests/unit/routes/inventory.export.routes.test.ts
git commit -m "feat(inventario): exportar existencias de insumos"
```

---

## Task 2: Exportación del kardex (movimientos de insumo)

**Files:**
- Modify: `src/controllers/dashboard/inventory/export.controller.ts` (agregar función)
- Modify: `src/routes/dashboard/inventory.routes.ts`
- Test: `tests/unit/controllers/dashboard/export.movements.test.ts`

**Interfaces:**
- Consumes: `getStockMovements` de `src/services/dashboard/rawMaterial.service.ts:799` — **leer su firma exacta antes de escribir el controlador** (`sed -n '799,815p' src/services/dashboard/rawMaterial.service.ts`), porque acepta paginación y hay que pasarle el tope como `limit`.
- Produces: `exportStockMovements(req, res, next)`.

- [ ] **Step 1: Leer la firma real del servicio**

Run: `sed -n '799,825p' src/services/dashboard/rawMaterial.service.ts`

**No adivines los nombres de los parámetros.** Si `getStockMovements` no acepta un límite, agrégale uno con el mismo patrón que `countRawMaterialsForExport` de la Tarea 1 y déjalo documentado.

- [ ] **Step 2: Escribir la prueba que falla**

Mismo esqueleto de mocks que la Tarea 1 (cópialo entero; no lo asumas), con estos casos:

```typescript
  it('🔴 the movement columns answer WHO moved stock and WHY', async () => {
    // A kardex without the actor and the reason is a list of numbers. The reason this report
    // exists is anti-fraud: someone adjusted stock and the owner wants to know who.
    const columns = encodeExport.mock.calls[0][1].allColumns.map((c: { id: string }) => c.id)
    expect(columns).toEqual(expect.arrayContaining(['createdAt', 'rawMaterialName', 'type', 'quantity', 'previousStock', 'newStock', 'reason', 'staffName']))
  })

  it('🔴 refuses over the cap instead of truncating', async () => { /* igual que Tarea 1 */ })

  it('TENANT: only ever asks for the venue in the auth context', async () => { /* igual que Tarea 1 */ })

  it('reports the movement type in Spanish, not the enum', async () => {
    // "SPOILAGE" in a column an owner reads is a leak of our schema into their report.
    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'type')
    expect(col.value({ type: 'SPOILAGE' })).toBe('Merma')
    expect(col.value({ type: 'PURCHASE' })).toBe('Compra')
  })
```

- [ ] **Step 3: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/dashboard/export.movements.test.ts --maxWorkers=1`
Expected: FAIL — "exportStockMovements is not a function"

- [ ] **Step 4: Implementar**

Agregar a `export.controller.ts`. El mapa de tipos va como constante a nivel de módulo:

```typescript
/**
 * Movement types in the reader's language. The enum value is our schema leaking into
 * someone else's report — "SPOILAGE" means nothing to the person counting the storeroom.
 */
const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  PURCHASE: 'Compra',
  USAGE: 'Consumo',
  ADJUSTMENT: 'Ajuste',
  SPOILAGE: 'Merma',
  TRANSFER: 'Traspaso',
  TRANSFER_OUT: 'Traspaso salida',
  TRANSFER_IN: 'Traspaso entrada',
  COUNT: 'Conteo físico',
  RETURN: 'Devolución',
}
```

El resto sigue exactamente la forma de `exportRawMaterials`: contar → rechazar sobre el tope → traer → columnas → `encodeExport` → `sendExport(res, encoded, 'kardex')`.

- [ ] **Step 5: Correr y verificar que pasa**

Run: `npx jest tests/unit/controllers/dashboard/export.movements.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 6: Montar la ruta**

```typescript
router.get('/raw-materials/:rawMaterialId/movements/export', checkPermission('inventory:read'), exportController.exportStockMovements)
```

⚠️ Va ANTES de `/raw-materials/:rawMaterialId/movements` si esa ruta existiera con un `:param` posterior. Verifica el orden con `grep -n "movements" src/routes/dashboard/inventory.routes.ts`.

- [ ] **Step 7: Formatear y correr las dos suites de export**

Run: `npx prettier --write src/controllers/dashboard/inventory/export.controller.ts src/routes/dashboard/inventory.routes.ts tests/unit/controllers/dashboard/export.movements.test.ts`
Run: `npx jest tests/unit/controllers/dashboard/export. tests/unit/routes/inventory.export --maxWorkers=1`

- [ ] **Step 8: Commit** — ⚠️ PENDIENTE DE AUTORIZACIÓN.

---

## Task 3: Exportación de órdenes de compra y de proveedores

**Files:**
- Modify: `src/controllers/dashboard/inventory/export.controller.ts`
- Modify: `src/services/dashboard/purchaseOrder.service.ts`
- Modify: `src/routes/dashboard/inventory.routes.ts`
- Test: `tests/unit/controllers/dashboard/export.purchasing.test.ts`

**Interfaces:**
- Consumes: `getPurchaseOrders(venueId, filters?: { status?: PurchaseOrderStatus[]; supplierId?: string; startDate?: Date; endDate?: Date }): Promise<PurchaseOrder[]>` (`purchaseOrder.service.ts:442`) y `getSuppliers(venueId, filters?: { active?: boolean; search?: string; rating?: number }): Promise<Supplier[]>` (`supplier.service.ts:11`).
- Produces: `exportPurchaseOrders(req, res, next)`, `exportSuppliers(req, res, next)`, `countPurchaseOrdersForExport(venueId, filters): Promise<number>`.

**Decisión de diseño ya tomada — no la re-litigues:** la exportación de órdenes va **una fila por RENGLÓN**, no por orden. Un contralor que compara contra facturas necesita el renglón; el total de la orden se repite en cada fila para que siga siendo agrupable en una tabla dinámica. Una exportación por orden esconde exactamente lo que se va a auditar.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
  it('🔴 one row per LINE, not per order', async () => {
    // A buyer reconciling against an invoice needs the line. An order-level export hides the
    // one thing being audited.
    getPurchaseOrders.mockResolvedValue([
      { id: 'po-1', orderNumber: 'OC-001', status: 'RECEIVED', total: 1000, items: [{ id: 'i1' }, { id: 'i2' }] },
    ])

    await exportPurchaseOrders(req(), res(), jest.fn())

    expect(encodeExport.mock.calls[0][1].rows).toHaveLength(2)
  })

  it('repeats the order header on every line so the file groups cleanly', async () => {
    const rows = encodeExport.mock.calls[0][1].rows
    expect(rows[0].orderNumber).toBe('OC-001')
    expect(rows[1].orderNumber).toBe('OC-001')
  })

  it('🔴 names the article for BOTH kinds of line', async () => {
    // A purchase-order line is either a raw material or a resale product (XOR). Reading only
    // `rawMaterial` leaves every convenience-store line anonymous — and the 18 stores are
    // resale merchandise.
    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'article')
    expect(col.value({ rawMaterial: { name: 'Harina' }, product: null })).toBe('Harina')
    expect(col.value({ rawMaterial: null, product: { name: 'Refresco 600ml' } })).toBe('Refresco 600ml')
  })

  it('🔴 refuses over the cap instead of truncating', async () => { /* igual que Tarea 1 */ })
  it('TENANT: only ever asks for the venue in the auth context', async () => { /* igual que Tarea 1 */ })
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/dashboard/export.purchasing.test.ts --maxWorkers=1`
Expected: FAIL

- [ ] **Step 3: Implementar el aplanado a renglones**

```typescript
    // One row per line. The order header repeats on each so the file stays groupable in a
    // pivot table without the reader reconstructing the relationship by hand.
    const rows = orders.flatMap(order =>
      order.items.map(item => ({
        ...item,
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        status: order.status,
        supplierName: order.supplier?.name ?? '',
        orderTotal: Number(order.total) || 0,
      })),
    )
```

Y la columna del artículo:

```typescript
      // XOR: a line is either a raw material or a resale product, never both and never
      // neither (there is a CHECK constraint on the table). Reading only `rawMaterial` is how
      // resale lines ended up anonymous everywhere else in this codebase.
      { id: 'article', label: 'Artículo', value: r => r.rawMaterial?.name ?? r.product?.name ?? '' },
```

⚠️ **Verifica que `getPurchaseOrders` incluya `items` con `rawMaterial` Y `product`.** Si su `include` sólo trae `rawMaterial`, agrégale `product: true` — es el mismo defecto que ya se corrigió en `purchaseOrderWorkflow.service.ts`.

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx jest tests/unit/controllers/dashboard/export.purchasing.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Exportación de proveedores**

Columnas: `name`, `contactName`, `email`, `phone`, `taxId` (RFC), `leadTimeDays`, `minimumOrder`, `rating`, `active`. Mismo patrón.

- [ ] **Step 6: Montar las dos rutas**

```typescript
router.get('/purchase-orders/export', checkPermission('inventory:read'), exportController.exportPurchaseOrders)
router.get('/suppliers/export', checkPermission('inventory:read'), exportController.exportSuppliers)
```

⚠️ Ambas ANTES de `/purchase-orders/:purchaseOrderId` y `/suppliers/:supplierId`. Agrega el caso a `tests/unit/routes/inventory.export.routes.test.ts`.

- [ ] **Step 7: Formatear y correr**

Run: `npx prettier --write src/controllers/dashboard/inventory/export.controller.ts src/services/dashboard/purchaseOrder.service.ts src/routes/dashboard/inventory.routes.ts tests/unit/controllers/dashboard/export.purchasing.test.ts tests/unit/routes/inventory.export.routes.test.ts`
Run: `npx jest tests/unit/controllers/dashboard/export. tests/unit/routes/inventory.export --maxWorkers=1`

- [ ] **Step 8: Commit** — ⚠️ PENDIENTE DE AUTORIZACIÓN.

---

## Task 4: Exportación de contabilidad (gastos y balanza)

**Files:**
- Create: `src/controllers/dashboard/accounting.export.controller.ts`
- Modify: `src/routes/dashboard/accounting.routes.ts`
- Test: `tests/unit/controllers/dashboard/export.accounting.test.ts`

**Interfaces:**
- Consumes: `listExpenses(venueId: string, filters?: ListExpensesFilters): Promise<ListExpensesResult>` (`src/services/fiscal/expense.service.ts:415`) y `getTrialBalance(venueId: string, period: string): Promise<TrialBalanceResult>` (`src/services/fiscal/trialBalance.service.ts:71`). **Lee las dos interfaces de resultado antes de escribir columnas** — no adivines los nombres de campo.
- Produces: `exportExpenses(req, res, next)`, `exportTrialBalance(req, res, next)`.

🔴 **La trampa de esta tarea, y es la única que importa:** el libro mayor guarda **enteros en centavos** (`debitCents`, `creditCents`, `totalCents`). TODA celda que salga hacia una persona divide entre 100. Un archivo 100× lo carga un contador a su sistema y el error aparece semanas después, si aparece. El resto de la plataforma trabaja en pesos 1:1 — el ledger es la excepción, no la regla.

- [ ] **Step 1: Escribir la prueba que falla — el caso de los centavos primero**

```typescript
  it('🔴 converts cents to pesos — a 100x file is the whole risk of this task', async () => {
    // The ledger stores whole cents. Everything leaving for a human divides by 100. This is
    // the one place in the platform where money is not already in pesos 1:1.
    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'debit')
    expect(col.value({ debitCents: 123456 })).toBe(1234.56)
  })

  it('a zero-cent amount exports as 0, not blank', async () => {
    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'debit')
    expect(col.value({ debitCents: 0 })).toBe(0)
  })

  it('a null amount exports as 0, not NaN', async () => {
    const col = encodeExport.mock.calls[0][1].allColumns.find((c: { id: string }) => c.id === 'debit')
    expect(col.value({ debitCents: null })).toBe(0)
  })

  it('🔴 the trial balance still balances after conversion', async () => {
    // If rounding breaks the debit/credit equality, the file is worthless to an accountant —
    // and worse, it looks fine until they try to load it.
    const rows = encodeExport.mock.calls[0][1].rows
    const debit = rows.reduce((s: number, r: { debitCents: number }) => s + r.debitCents, 0)
    const credit = rows.reduce((s: number, r: { creditCents: number }) => s + r.creditCents, 0)
    expect(debit).toBe(credit)
  })

  it('TENANT: only ever asks for the venue in the auth context', async () => { /* igual que Tarea 1 */ })
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/dashboard/export.accounting.test.ts --maxWorkers=1`

- [ ] **Step 3: Implementar, con el helper de centavos a nivel de módulo**

```typescript
/**
 * The ledger stores whole CENTS (`...Cents`). Everything leaving for a human divides by 100.
 * This is the ONE place in the platform where money is not already in pesos 1:1 — do not
 * "unify" the rest to cents, unify the OUTPUT to pesos.
 */
const pesosFromCents = (cents: number | null | undefined): number => (cents == null ? 0 : Math.round(cents) / 100)
```

- [ ] **Step 4: Correr y verificar que pasa**

- [ ] **Step 5: Montar las rutas, con el candado de plan correcto**

```typescript
// `checkFeatureAccess('CFDI')` va porque el resto del namespace fiscal ya lo lleva: una
// exportación que se salte el candado del módulo que la alimenta es un hueco de plan.
router.get('/expenses/export', checkFeatureAccess('CFDI'), checkPermission('accounting:read'), accountingExportController.exportExpenses)
router.get('/trial-balance/export', checkFeatureAccess('CFDI'), checkPermission('accounting:read'), accountingExportController.exportTrialBalance)
```

⚠️ Ambas ANTES de cualquier `/:param` de su familia. Verifica con `grep -n "'/expenses\|'/trial-balance" src/routes/dashboard/accounting.routes.ts`.

- [ ] **Step 6: Formatear y correr**

Run: `npx prettier --write src/controllers/dashboard/accounting.export.controller.ts src/routes/dashboard/accounting.routes.ts tests/unit/controllers/dashboard/export.accounting.test.ts`
Run: `npx jest tests/unit/controllers/dashboard/export. --maxWorkers=1`

- [ ] **Step 7: Commit** — ⚠️ PENDIENTE DE AUTORIZACIÓN.

---

## Task 5: "Recibir ninguno" devuelve la mercancía al almacén

> 🔴 **La única tarea con riesgo a producción.** Toca la deducción de inventario de ~70 puntos de venta cobrando hoy. **No la empieces hasta que las Tareas 1-4 estén verdes.**
>
> ⚠️ **ESTA TAREA NO ESTÁ LISTA PARA UN SUBAGENTE.** Auto-revisión del plan (2026-08-07): a
> diferencia de las Tareas 1-4, aquí los pasos 1, 3 y 4 describen QUÉ hacer sin mostrar el
> código. Eso es un hueco del plan, no un estilo — un subagente lo rellena adivinando, y el
> lugar donde va a adivinar es la reversión de inventario de 70 locales que están cobrando.
>
> Antes de despacharla: o se escribe completa (cuerpos de prueba y implementación literales),
> o la ejecuta alguien con el contexto del módulo en la cabeza. Dado el riesgo, lo segundo.

**Files:**
- Modify: `src/services/dashboard/purchaseOrder.service.ts:2012` (`receiveNoItems`)
- Test: `tests/unit/services/dashboard/purchaseOrder.receiveNone.test.ts`

**Interfaces:**
- Consumes: `prisma.stockBatch` (campos `purchaseOrderItemId`, `initialQuantity`, `remainingQuantity`, `status`), `prisma.inventoryMovement` (campos `purchaseOrderItemId`, `previousStock`, `newStock`), `prisma.inventory` (`productId` es `@unique`, campo `currentStock`).
- Produces: `receiveNoItems` con el mismo contrato público; internamente usa `revertReceiptForOrderInTx(tx, venueId, purchaseOrderId)`.

**El diseño ya está decidido — no lo re-litigues.** Está justificado en `docs/PITS-H0-PENDIENTES.md` §H0.9:

1. **Lo que se revierte sale del ESTADO REAL, nunca de `quantityReceived`.** Esa columna es un metadato mutable que esta misma función pone en 0. Calcular contra ella hace que "recibir 5 → recibir ninguno → recibir todo" deje **10 de existencia habiendo llegado 5**: un usuario, tres clics, sin concurrencia.
   - Mercancía de reventa: sumar `newStock − previousStock` de los `InventoryMovement` con ese `purchaseOrderItemId`. **Nunca `quantity`** — la convención de signo no es uniforme entre servicios.
   - Insumos: los `StockBatch` con ese `purchaseOrderItemId`.
2. **Se NIEGA si algo ya se consumió.** Regla universal para ambos caminos: *no puedes devolver más de lo que hoy existe*. Insumos: `remainingQuantity < initialQuantity` en cualquier lote de la orden. Mercancía: `inventory.currentStock < lo que entró`. Es el modelo de Odoo — cancelar es "esto nunca pasó", devolver es otro documento. Confundirlos destruye la trazabilidad.

- [ ] **Step 1: Escribir las pruebas que fallan**

```typescript
/**
 * "Receive none" has to put the merchandise back.
 *
 * It set every line to NOT_PROCESSED with `quantityReceived: 0`, cancelled the order, and
 * NEVER touched stock. If goods had already been received, inventory stayed inflated with
 * product the system now claimed never arrived — the warehouse and the system silently
 * stopped agreeing.
 */

describe('receiveNoItems', () => {
  it('🔴 puts a raw-material batch back by its ACTUAL remainder, not by quantityReceived', async () => {
    // `quantityReceived` is a mutable metadata column this very function zeroes out. Deriving
    // the delta from it makes "receive 5 → receive none → receive all" leave 10 in stock for 5
    // delivered.
  })

  it('🔴 REFUSES when any of the received stock was already consumed', async () => {
    // 100 arrived, 40 were sold. Reverting 100 drives stock to -40 and breaks the invariant
    // `currentStock === Σ remainingQuantity of ACTIVE batches`. Odoo forbids cancelling a
    // receipt whose goods moved — you file a return instead, which is a different document.
    // Expect: AppError 409, and NOT a partial revert.
  })

  it('the refusal says HOW MUCH was consumed, so the message is actionable', async () => {
    // "No se puede" sends someone to open a ticket. "Ya se consumieron 40 de 100" tells them
    // the answer is a return.
  })

  it('🔴 reverts resale merchandise from newStock − previousStock, never from `quantity`', async () => {
    // The sign convention for `quantity` is not uniform across services; each movement row
    // carries its own before and after, so the difference is correct without depending on it.
  })

  it('is a no-op on an order where nothing was ever received', async () => {
    // The common case: cancelling an order that never arrived must not write movements.
  })

  it('REGRESSION: still sets every line NOT_PROCESSED and the order CANCELLED', async () => {})

  it('TENANT: only ever touches the venue in the request', async () => {})

  it('everything happens in ONE transaction — a half-reverted order is worse than none', async () => {})
})
```

**Escribe los cuerpos completos.** El esqueleto de mocks se copia de `tests/unit/services/dashboard/fifoBatch.quarantine.test.ts` (`cablearTransaccion`, el patrón de `$transaction`) — ábrelo y cópialo; no lo reconstruyas de memoria.

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx jest tests/unit/services/dashboard/purchaseOrder.receiveNone.test.ts --maxWorkers=1`

- [ ] **Step 3: Implementar el guard de consumo primero**

Antes de revertir nada. Un `receiveNoItems` que revierte a medias y luego truena es peor que el defecto que estamos arreglando.

- [ ] **Step 4: Implementar la reversión**

Dentro de la MISMA `prisma.$transaction` que ya usa la función.

- [ ] **Step 5: Correr y verificar que pasan**

- [ ] **Step 6: Correr TODA la suite de compras e inventario — aquí sí, es el punto de riesgo**

Run: `npx jest tests/unit/services/dashboard/purchaseOrder tests/unit/services/dashboard/fifoBatch tests/unit/services/dashboard/autoReorder --maxWorkers=2`
Expected: PASS, sin regresiones.

- [ ] **Step 7: Formatear**

- [ ] **Step 8: Commit** — ⚠️ PENDIENTE DE AUTORIZACIÓN.

---

## Fuera de alcance, a propósito

- **Los botones del dashboard para estas cuatro exportaciones.** El backend primero; la UI se conecta después con el `ExportDialog` que ya existe. Meterlo aquí duplica el tamaño de cada tarea y mezcla dos ciclos de revisión.
- **Migración de bajada y ensayo de restore para la Tarea 5.** Son requisito ANTES de desplegar, no antes de implementar. Van en el paso de despliegue, con el fundador.
- **La decisión de `activity:read` para ADMIN** y **el tier que contrata PITS**. Son decisiones de producto del fundador, no de implementación.

## Verificación final (la corro yo, no los subagentes)

Una sola vez, cuando las cinco tareas estén verdes:

```bash
NODE_OPTIONS="--max-old-space-size=6144" npx tsc --noEmit
NODE_OPTIONS="--max-old-space-size=4096" npx jest --selectProjects unit --maxWorkers=2
npm run audit:permissions
```

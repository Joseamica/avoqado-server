/**
 * Los reportes de inventario del dashboard leen la merma del LIBRO de merma (spec §4.6), contra
 * Postgres real. Vive aparte de `inventory-waste.integration.test.ts` (ya pasa de 2 000 líneas).
 *
 * Qué fija, y por qué:
 *   - Reporte de materiales (`getIngredientUsageReport`): la merma de un folio cuenta lo
 *     DECLARADO una sola vez — incluida la parte «sin existencia», que no tiene movimiento —, y la
 *     legacy (movimiento SPOILAGE sin folio) cuenta una vez, como hoy.
 *   - 🔴 CAMBIO VISIBLE declarado: el costo de la merma deja de ser `cantidad × costo ACTUAL`
 *     (`RawMaterial.costPerUnit` de hoy) y pasa a ser el costo REAL de cada lote que se dio de baja
 *     (`costImpact` de cada movimiento). Un costo desconocido no se inventa: queda «sin valorar».
 *   - 🔴 Contrato viejo: quien no manda `limit` sigue recibiendo TODOS los ingredientes, sin recorte.
 *   - Varianza (`getCostVarianceReport`): costo real = USAGE a costo actual (como hoy) + merma a
 *     costo de lote (del libro, sin multiplicar), e incluye los productos (LOSS), que hoy no estaban.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logWaste, WasteInput } from '@/services/shared/inventoryWaste.service'
import { getCostVarianceReport, getIngredientUsageReport } from '@/services/dashboard/report.service'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const from = new Date('2000-01-01T00:00:00.000Z')
const to = new Date('2100-01-01T00:00:00.000Z')
const fixture = `waste-rep-${randomUUID()}`

let organizationId = ''
let venueId = ''
let otherVenueId = ''
let staffId = ''
let categoryId = ''

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function clearVenue(id: string): Promise<void> {
  if (!id) return
  await prisma.activityLog.deleteMany({ where: { venueId: id } })
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId: id } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: id } } })
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId: id } })
  await prisma.stockBatch.deleteMany({ where: { venueId: id } })
  await prisma.lowStockAlert.deleteMany({ where: { venueId: id } })
  await prisma.inventory.deleteMany({ where: { venueId: id } })
  await prisma.product.deleteMany({ where: { venueId: id } })
  await prisma.rawMaterial.deleteMany({ where: { venueId: id } })
}

async function clearAll(): Promise<void> {
  await clearVenue(venueId)
  await clearVenue(otherVenueId)
}

beforeAll(async () => {
  assertTestDatabase()
  const organization = await prisma.organization.create({
    data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
  })
  organizationId = organization.id
  const venue = await prisma.venue.create({
    data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  venueId = venue.id
  const other = await prisma.venue.create({
    data: { organizationId, name: `${fixture}-otro`, slug: `${fixture}-otro`, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  otherVenueId = other.id
  const staff = await prisma.staff.create({
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Reportes' },
  })
  staffId = staff.id
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId, role: 'MANAGER', active: true },
      { staffId, venueId: otherVenueId, role: 'MANAGER', active: true },
    ],
  })
  const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
  categoryId = category.id
})

beforeEach(clearAll)

afterAll(async () => {
  assertTestDatabase()
  await clearAll()
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: [venueId, otherVenueId].filter(Boolean) } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId].filter(Boolean) }, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

/** Ingrediente con un costo ACTUAL deliberadamente lejano al de sus lotes: así la prueba distingue
 *  «cantidad × costo actual» (lo de antes) de «costo real de cada lote» (lo de ahora). */
async function raw(stock: string | number, costPerUnit: string | number = 100, targetVenueId: string = venueId) {
  return prisma.rawMaterial.create({
    data: {
      venueId: targetVenueId,
      name: `Ingrediente ${randomUUID()}`,
      sku: randomUUID(),
      category: 'OTHER',
      unit: 'PIECE',
      unitType: 'COUNT',
      currentStock: D(stock),
      minimumStock: D(0),
      reorderPoint: D(0),
      costPerUnit: D(costPerUnit),
      avgCostPerUnit: D(costPerUnit),
      notifyOnLowStock: false,
    },
  })
}

async function batch(rawMaterialId: string, quantity: number, cost: number, receivedDate: Date, targetVenueId: string = venueId) {
  return prisma.stockBatch.create({
    data: {
      venueId: targetVenueId,
      rawMaterialId,
      batchNumber: randomUUID(),
      initialQuantity: D(quantity),
      remainingQuantity: D(quantity),
      unit: 'PIECE',
      costPerUnit: D(cost),
      receivedDate,
    },
  })
}

async function product(stock: string | number, cost: string | number | null = 10) {
  return prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Producto ${randomUUID()}`,
      sku: randomUUID(),
      price: D(100),
      cost: cost === null ? null : D(cost),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId, currentStock: D(stock) } },
    },
  })
}

function request(itemType: 'RAW_MATERIAL' | 'PRODUCT', itemId: string, quantity: string | number): WasteInput {
  return {
    itemType,
    itemId,
    quantity,
    unit: itemType === 'PRODUCT' ? 'UNIT' : 'PIECE',
    reasonCode: 'OTHER',
    note: 'Prueba de reportes',
    idempotencyKey: randomUUID(),
    source: 'POS',
  }
}

/** Movimiento directo (consumo o merma vieja del dashboard / del cron), sin folio. */
async function movement(
  rawMaterialId: string,
  type: 'USAGE' | 'SPOILAGE' | 'PURCHASE',
  quantity: number,
  costImpact: number | null,
  createdAt?: Date,
  targetVenueId: string = venueId,
) {
  return prisma.rawMaterialMovement.create({
    data: {
      venueId: targetVenueId,
      rawMaterialId,
      type,
      quantity: D(quantity),
      unit: 'PIECE',
      previousStock: D(10),
      newStock: D(10 + quantity),
      costImpact: costImpact === null ? null : D(costImpact),
      reason: 'Prueba',
      ...(createdAt && { createdAt }),
    },
  })
}

const str = (value: unknown) => (value === null || value === undefined ? value : String(value))

describe('reporte de materiales (getIngredientUsageReport)', () => {
  test('🔴 la merma nueva cuenta lo DECLARADO una vez y su costo es el de los LOTES, no cantidad × costo actual', async () => {
    // Costo actual 100 por pieza; los lotes costaron 2 y 4.
    const item = await raw(3, 100)
    await batch(item.id, 2, 2, new Date('2026-01-01T00:00:00Z'))
    await batch(item.id, 1, 4, new Date('2026-02-01T00:00:00Z'))
    // 5 declaradas: 3 salen de los dos lotes (dos movimientos hijos) y 2 no tenían existencia.
    await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 5))

    const report = await getIngredientUsageReport(venueId, from, to)
    expect(report.materials).toHaveLength(1)
    const row = report.materials[0]
    expect(row.rawMaterialId).toBe(item.id)
    // Declarado (5), no la suma de los hijos (3) ni hijos × folio.
    expect(row.waste).toBe(5)
    // Costo por lote: 2 × 2 + 1 × 4 = 8 (costImpact de los hijos, firmado: −4 y −4).
    // Con la fórmula vieja (cantidad × costo actual) habría sido −3 × 100 = −300.
    expect(row.totalCost).toBe(-8)
    expect(row.usage).toBe(0)
    expect(row.netChange).toBe(-3)

    expect(report.summary.totalWaste).toBe(5)
    expect(report.summary.valuedWasteCost).toBe('8')
    // Las 2 sin existencia no tienen costo conocido: se DICEN, no se inventan.
    expect(report.summary.unvaluedWasteQuantity).toBe('2')
    expect(report.summary.totalCost).toBe(-8)

    expect(report.waste.total).toBe(1)
    expect(report.waste.items).toHaveLength(1)
    expect(report.waste.items[0]).toMatchObject({ itemType: 'RAW_MATERIAL', itemId: item.id, name: item.name, unit: 'PIECE' })
    expect(str(report.waste.items[0].quantity)).toBe('5')
    expect(str(report.waste.items[0].cost)).toBe('8')
    expect(str(report.waste.items[0].unvaluedQuantity)).toBe('2')
  })

  test('una merma legacy (SPOILAGE sin folio) cuenta una vez con su costo GUARDADO; el consumo sigue a costo actual', async () => {
    const item = await raw(10, 5)
    await movement(item.id, 'SPOILAGE', -4, -12)
    await movement(item.id, 'USAGE', -2, -10)

    const report = await getIngredientUsageReport(venueId, from, to)
    expect(report.materials).toHaveLength(1)
    const row = report.materials[0]
    expect(row.waste).toBe(4)
    expect(row.usage).toBe(2)
    // SPOILAGE a su costImpact (−12) + USAGE a cantidad × costo actual (−2 × 5 = −10) = −22.
    // Con la fórmula vieja: −4 × 5 + −2 × 5 = −30.
    expect(row.totalCost).toBe(-22)
    expect(report.summary.totalWaste).toBe(4)
    expect(report.summary.valuedWasteCost).toBe('12')
    expect(report.summary.unvaluedWasteQuantity).toBe('0')
  })

  test('una merma legacy SIN costo guardado no se valora a costo actual: queda sin valorar', async () => {
    const item = await raw(10, 5)
    await movement(item.id, 'SPOILAGE', -3, null)

    const report = await getIngredientUsageReport(venueId, from, to)
    const row = report.materials.find(m => m.rawMaterialId === item.id)
    expect(row?.waste).toBe(3)
    // Antes: −3 × 5 = −15. Ahora el costo desconocido no suma: 0, y se declara como sin valorar.
    expect(row?.totalCost).toBe(0)
    expect(report.summary.valuedWasteCost).toBeNull()
    expect(report.summary.unvaluedWasteQuantity).toBe('3')
  })

  test('🔴 un ingrediente cuya merma no pudo descontar NADA (sin existencia) aparece en materiales', async () => {
    const item = await raw(0, 7)
    await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4))
    expect(await prisma.rawMaterialMovement.count({ where: { rawMaterialId: item.id } })).toBe(0)

    const report = await getIngredientUsageReport(venueId, from, to)
    const row = report.materials.find(m => m.rawMaterialId === item.id)
    expect(row).toBeDefined()
    expect(row).toMatchObject({ waste: 4, usage: 0, purchases: 0, netChange: 0, totalCost: 0 })
    expect(report.summary.totalWaste).toBe(4)
    expect(report.summary.valuedWasteCost).toBeNull()
    expect(report.summary.unvaluedWasteQuantity).toBe('4')
  })

  test('🔴 contrato viejo: SIN limit trae TODOS los ingredientes (no hay recorte por defecto)', async () => {
    const total = 101
    await prisma.rawMaterial.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        venueId,
        name: `Masivo ${String(i).padStart(3, '0')} ${randomUUID()}`,
        sku: randomUUID(),
        category: 'OTHER' as const,
        unit: 'PIECE' as const,
        unitType: 'COUNT' as const,
        currentStock: D(10),
        minimumStock: D(0),
        reorderPoint: D(0),
        costPerUnit: D(1),
        avgCostPerUnit: D(1),
        notifyOnLowStock: false,
      })),
    })
    const items = await prisma.rawMaterial.findMany({ where: { venueId }, select: { id: true } })
    await prisma.rawMaterialMovement.createMany({
      data: items.map(item => ({
        venueId,
        rawMaterialId: item.id,
        type: 'USAGE' as const,
        quantity: D(-1),
        unit: 'PIECE' as const,
        previousStock: D(10),
        newStock: D(9),
      })),
    })

    const all = await getIngredientUsageReport(venueId, from, to)
    expect(all.materials).toHaveLength(total)
    expect(all.pagination).toEqual({ limit: undefined, offset: undefined, hasMore: false })
    // Orden determinista con desempate único: el mismo orden en dos lecturas.
    const again = await getIngredientUsageReport(venueId, from, to)
    expect(again.materials.map(m => m.rawMaterialId)).toEqual(all.materials.map(m => m.rawMaterialId))

    // Con limit/offset explícitos, pagina como siempre y no repite ni salta.
    const first = await getIngredientUsageReport(venueId, from, to, { limit: 60 })
    const second = await getIngredientUsageReport(venueId, from, to, { limit: 60, offset: 60 })
    expect(first.materials).toHaveLength(60)
    expect(first.pagination).toEqual({ limit: 60, offset: undefined, hasMore: true })
    expect(second.materials).toHaveLength(41)
    expect(second.pagination.hasMore).toBe(false)
    expect([...first.materials, ...second.materials].map(m => m.rawMaterialId)).toEqual(all.materials.map(m => m.rawMaterialId))
  })

  test('los productos (LOSS) entran en el desglose y en el total de merma, no en la lista de ingredientes', async () => {
    const item = await product(10, 10)
    await logWaste(venueId, staffId, request('PRODUCT', item.id, 3))

    const report = await getIngredientUsageReport(venueId, from, to)
    expect(report.materials).toHaveLength(0)
    expect(report.summary.totalWaste).toBe(3)
    expect(report.summary.valuedWasteCost).toBe('30')
    expect(report.waste.items).toHaveLength(1)
    expect(report.waste.items[0]).toMatchObject({ itemType: 'PRODUCT', itemId: item.id, unit: 'UNIT' })
    expect(str(report.waste.items[0].cost)).toBe('30')
  })

  test('el filtro rawMaterialId acota los ingredientes Y la merma', async () => {
    const a = await raw(0, 1)
    const b = await raw(0, 1)
    await logWaste(venueId, staffId, request('RAW_MATERIAL', a.id, 2))
    await logWaste(venueId, staffId, request('RAW_MATERIAL', b.id, 7))
    const p = await product(10, 10)
    await logWaste(venueId, staffId, request('PRODUCT', p.id, 1))

    const report = await getIngredientUsageReport(venueId, from, to, { rawMaterialId: a.id })
    expect(report.materials.map(m => m.rawMaterialId)).toEqual([a.id])
    expect(report.summary.totalWaste).toBe(2)
    expect(report.waste.items.map(w => w.itemId)).toEqual([a.id])
  })

  test('la ventana manda: lo de fuera no entra y un ingrediente sin nada dentro no aparece', async () => {
    const dentro = await raw(10, 1)
    const fuera = await raw(10, 1)
    await movement(dentro.id, 'SPOILAGE', -2, -4, new Date('2026-03-10T12:00:00Z'))
    await movement(fuera.id, 'SPOILAGE', -9, -9, new Date('2026-03-01T12:00:00Z'))
    await movement(dentro.id, 'USAGE', -1, -1, new Date('2026-03-01T12:00:00Z'))

    const report = await getIngredientUsageReport(venueId, new Date('2026-03-05T06:00:00Z'), new Date('2026-03-20T05:59:59.999Z'))
    expect(report.materials.map(m => m.rawMaterialId)).toEqual([dentro.id])
    expect(report.materials[0]).toMatchObject({ waste: 2, usage: 0, totalCost: -4 })
    expect(report.summary.totalWaste).toBe(2)
  })

  test('🔴 aislamiento: ingredientes, movimientos y mermas de OTRO venue no aparecen', async () => {
    const mine = await raw(0, 1)
    await logWaste(venueId, staffId, request('RAW_MATERIAL', mine.id, 1))
    const theirs = await raw(10, 1, otherVenueId)
    await movement(theirs.id, 'SPOILAGE', -5, -5, undefined, otherVenueId)
    await movement(theirs.id, 'USAGE', -5, -5, undefined, otherVenueId)

    const report = await getIngredientUsageReport(venueId, from, to)
    expect(report.materials.map(m => m.rawMaterialId)).toEqual([mine.id])
    expect(report.summary.totalWaste).toBe(1)
    expect(report.waste.items.map(w => w.itemId)).toEqual([mine.id])
  })
})

describe('reporte de varianza (getCostVarianceReport)', () => {
  test('🔴 costo real = consumo a costo actual + merma a costo de LOTE, sin multiplicar, con productos y lo sin valorar a la vista', async () => {
    // Ingrediente A: costo actual 100; lotes a 2 y 4. Merma 5 = 3 por lotes (8) + 2 sin existencia.
    const a = await raw(3, 100)
    await batch(a.id, 2, 2, new Date('2026-01-01T00:00:00Z'))
    await batch(a.id, 1, 4, new Date('2026-02-01T00:00:00Z'))
    await logWaste(venueId, staffId, request('RAW_MATERIAL', a.id, 5))
    await movement(a.id, 'USAGE', -1, null) // consumo: 1 × 100 (costo actual, como hoy)
    // Ingrediente B: merma legacy con costo guardado 12.
    const b = await raw(10, 5)
    await movement(b.id, 'SPOILAGE', -4, -12)
    // Producto: merma de 3 a 10 = 30 (hoy los productos no entraban).
    const p = await product(10, 10)
    await logWaste(venueId, staffId, request('PRODUCT', p.id, 3))

    const report = await getCostVarianceReport(venueId, from, to)
    // 100 (USAGE) + 8 (lotes) + 12 (legacy) + 30 (producto) = 150.
    // Con la fórmula vieja: USAGE 100 + hijos 3 × 100 + legacy 4 × 5 = 420, sin el producto.
    expect(report.costs.actual).toBe(150)
    expect(report.costs.expected).toBe(0)
    expect(report.costs.variance).toBe(150)
    expect(report.costs.unvaluedWasteQuantity).toBe('2')
    // El porcentaje sigue siendo el de siempre (sin costo esperado ⇒ 0).
    expect(report.costs.variancePercentage).toBe(0)
  })

  test('sin merma, el costo real es el consumo a costo actual, exactamente como antes', async () => {
    const a = await raw(10, 3)
    await movement(a.id, 'USAGE', -2, null)
    await movement(a.id, 'PURCHASE', 5, null)

    const report = await getCostVarianceReport(venueId, from, to)
    expect(report.costs.actual).toBe(6)
    expect(report.costs.unvaluedWasteQuantity).toBe('0')
  })
})

import { randomInt, randomUUID } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getUserAccess } from '@/services/access/access.service'
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'
import { markExpiredBatches } from '@/services/dashboard/fifoBatch.service'
import * as rawMaterialService from '@/services/dashboard/rawMaterial.service'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'
import { create as createFromPos } from '@/controllers/mobile/inventoryWaste.mobile.controller'
import { adaptDashboardWaste } from '@/services/shared/dashboardWasteAdapter'
import {
  getWasteAccess,
  grantedPermissionsBeforeActivation,
  hasWastePermission,
  isWasteKeyCollision,
  logWaste,
  prepareWaste,
  recoverByKey,
  requireWasteActivation,
  requireWastePermission,
  voidWasteKey,
  WasteInput,
  WasteSummary,
} from '@/services/shared/inventoryWaste.service'
import {
  findWasteItem,
  getWasteBreakdown,
  getWasteTotals,
  listWasteItems,
  listWasteReports,
  wasteLedgerSql,
} from '@/services/shared/inventoryWasteRead.service'

// Aquí logWaste, la anulación (voidWasteKey) y los lectores (catálogo, totales, desglose y
// lista de folios); los choques con caducidad, conteo y venta entran con sus tareas.
const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
// Ventana que abarca todo: los lectores filtran por createdAt del servidor.
const from = new Date('2000-01-01T00:00:00.000Z')
const to = new Date('2100-01-01T00:00:00.000Z')
const fixture = `waste-${randomUUID()}`

let organizationId = ''
let venueId = ''
let staffId = ''
let categoryId = ''
// Para anular: dos meseros con `inventory:log-waste` DE FÁBRICA (Task 7, sin override del venue) y
// SIN `inventory:adjust`, un VIEWER sin ninguno de los dos, y alguien sin acceso al venue.
let waiterAId = ''
let waiterBId = ''
let viewerId = ''
let outsiderId = ''

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function clearInventory(): Promise<void> {
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.stockCount.deleteMany({ where: { venueId } })
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId } })
  await prisma.stockBatch.deleteMany({ where: { venueId } })
  await prisma.lowStockAlert.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
}

beforeAll(async () => {
  assertTestDatabase()

  const organization = await prisma.organization.create({
    data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
  })
  organizationId = organization.id

  const venue = await prisma.venue.create({
    data: {
      organizationId,
      name: fixture,
      slug: fixture,
      timezone: 'America/Mexico_City',
      currency: 'MXN',
    },
  })
  venueId = venue.id

  const staff = await prisma.staff.create({
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Merma' },
  })
  staffId = staff.id
  await prisma.staffVenue.create({
    data: { staffId, venueId, role: 'MANAGER', active: true },
  })

  const extra = async (label: string) =>
    (await prisma.staff.create({ data: { email: `${label}-${fixture}@example.test`, firstName: 'Prueba', lastName: label } })).id
  waiterAId = await extra('mesero-a')
  waiterBId = await extra('mesero-b')
  viewerId = await extra('viewer')
  outsiderId = await extra('ajeno')
  await prisma.staffVenue.createMany({
    data: [
      { staffId: waiterAId, venueId, role: 'WAITER', active: true },
      { staffId: waiterBId, venueId, role: 'WAITER', active: true },
      { staffId: viewerId, venueId, role: 'VIEWER', active: true },
    ],
  })
  // Sin VenueRolePermission a propósito: desde Task 7 el WAITER trae `inventory:log-waste` de fábrica
  // (y sigue sin `inventory:adjust`). Las pruebas que necesitan un override lo crean y lo borran.

  const category = await prisma.menuCategory.create({
    data: { venueId, name: fixture, slug: fixture },
  })
  categoryId = category.id
})

beforeEach(clearInventory)

afterAll(async () => {
  assertTestDatabase()
  await clearInventory()
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  if (venueId) await prisma.venueRolePermission.deleteMany({ where: { venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  const staffIds = [staffId, waiterAId, waiterBId, viewerId, outsiderId].filter(Boolean)
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })

  // Las pruebas de carrera y de rollback crean triggers temporales: ninguno puede sobrevivir.
  const leftovers = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT tgname::text AS name FROM pg_trigger
    WHERE starts_with(tgname::text, 'waste_race_') OR starts_with(tgname::text, 'waste_rollback_')
    UNION ALL
    SELECT proname::text AS name FROM pg_proc
    WHERE starts_with(proname::text, 'waste_race_') OR starts_with(proname::text, 'waste_rollback_')
  `
  expect(leftovers).toEqual([])
})

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
    include: { inventory: true },
  })
}

async function raw(stock: string | number) {
  return prisma.rawMaterial.create({
    data: {
      venueId,
      name: `Ingrediente ${randomUUID()}`,
      sku: randomUUID(),
      category: 'OTHER',
      unit: 'PIECE',
      unitType: 'COUNT',
      currentStock: D(stock),
      minimumStock: D(0),
      reorderPoint: D(0),
      costPerUnit: D(1),
      avgCostPerUnit: D(1),
      notifyOnLowStock: false,
    },
  })
}

async function batch(
  rawMaterialId: string,
  quantity: number,
  cost: number,
  receivedDate = new Date('2026-01-01T00:00:00.000Z'),
  expirationDate: Date | null = null,
) {
  return prisma.stockBatch.create({
    data: {
      venueId,
      rawMaterialId,
      batchNumber: randomUUID(),
      initialQuantity: D(quantity),
      remainingQuantity: D(quantity),
      unit: 'PIECE',
      costPerUnit: D(cost),
      receivedDate,
      expirationDate,
    },
  })
}

function request(
  itemType: 'RAW_MATERIAL' | 'PRODUCT',
  itemId: string,
  quantity: string | number,
  overrides: Partial<WasteInput> = {},
): WasteInput {
  return {
    itemType,
    itemId,
    quantity,
    unit: itemType === 'PRODUCT' ? 'UNIT' : 'PIECE',
    reasonCode: 'OTHER',
    note: 'Prueba de integración',
    idempotencyKey: randomUUID(),
    source: 'POS',
    ...overrides,
  }
}

async function productStock(productId: string): Promise<string> {
  const inventory = await prisma.inventory.findUniqueOrThrow({ where: { productId } })
  return inventory.currentStock.toString()
}

async function rawStock(rawMaterialId: string): Promise<string> {
  const item = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } })
  return item.currentStock.toString()
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('La operación debía fallar.')
}

test('mismo folio dos veces: un reporte, un movimiento y una auditoría', async () => {
  const item = await product(10)
  const input = request('PRODUCT', item.id, 3)
  const first = await logWaste(venueId, staffId, input)
  const second = await logWaste(venueId, staffId, input)

  expect(second).toEqual(first)
  expect(await productStock(item.id)).toBe('7')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
  expect(await prisma.inventoryMovement.count({ where: { wasteReportId: first.reportId } })).toBe(1)
  expect(
    await prisma.activityLog.count({
      where: { venueId, action: 'INVENTORY_WASTE_LOGGED', entityId: first.reportId },
    }),
  ).toBe(1)
})

test('dos peticiones concurrentes con el mismo folio descuentan una vez', async () => {
  const item = await product(10)
  const input = request('PRODUCT', item.id, 4)

  const [first, second] = await Promise.all([logWaste(venueId, staffId, input), logWaste(venueId, staffId, input)])

  expect(first).toEqual(second)
  expect(await productStock(item.id)).toBe('6')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
  expect(await prisma.inventoryMovement.count({ where: { wasteReportId: first.reportId } })).toBe(1)
})

test('otro payload y otro autor no recuperan el folio', async () => {
  const item = await product(10)
  const input = request('PRODUCT', item.id, 2)
  await logWaste(venueId, staffId, input)

  await expect(logWaste(venueId, staffId, { ...input, quantity: 3 })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_KEY_REUSED',
    statusCode: 409,
  })

  const hash = prepareWaste('otro-autor', input).payloadHash
  await expect(recoverByKey(venueId, input.idempotencyKey, 'otro-autor', hash)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

  expect(await productStock(item.id)).toBe('8')
})

test('el hash incluye costo recibido y proveedor; no incluye Product.cost', async () => {
  const item = await product(10, 12)
  const input = request('PRODUCT', item.id, 2, {
    source: 'DASHBOARD',
    unitCost: '15.25',
    supplier: 'Proveedor A',
    reference: 'R-1',
  })
  const first = await logWaste(venueId, staffId, input)

  await prisma.product.update({ where: { id: item.id }, data: { cost: D(99) } })
  expect(await logWaste(venueId, staffId, input)).toEqual(first)

  await expect(logWaste(venueId, staffId, { ...input, unitCost: '15.26' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  await expect(logWaste(venueId, staffId, { ...input, supplier: 'Proveedor B' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  await expect(logWaste(venueId, staffId, { ...input, reference: 'R-2' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: first.reportId } })
  expect(report.unitCostSnapshot?.toString()).toBe('15.25')
  expect(report.costImpact?.toString()).toBe('30.5')
})

test('P2002 real distingue el folio de la clave primaria', async () => {
  const key = randomUUID()
  const existing = await prisma.inventoryWasteReport.create({
    data: {
      venueId,
      idempotencyKey: key,
      status: 'VOIDED',
      costState: 'NONE',
      reportedByStaffId: staffId,
      source: 'POS',
    },
  })

  const duplicateKey = await captureError(
    prisma.inventoryWasteReport.create({
      data: {
        venueId,
        idempotencyKey: key,
        status: 'VOIDED',
        costState: 'NONE',
        reportedByStaffId: staffId,
        source: 'POS',
      },
    }),
  )
  expect(duplicateKey).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect(duplicateKey).toMatchObject({ code: 'P2002' })
  expect(isWasteKeyCollision(duplicateKey)).toBe(true)

  const duplicateId = await captureError(
    prisma.inventoryWasteReport.create({
      data: {
        id: existing.id,
        venueId,
        idempotencyKey: randomUUID(),
        status: 'VOIDED',
        costState: 'NONE',
        reportedByStaffId: staffId,
        source: 'POS',
      },
    }),
  )
  expect(duplicateId).toMatchObject({ code: 'P2002' })
  expect(isWasteKeyCollision(duplicateId)).toBe(false)

  // La forma por nombre se prueba aparte; no se presenta como respuesta real de este driver.
  const named = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { constraint: 'InventoryWasteReport_venueId_idempotencyKey_key' },
  })
  expect(isWasteKeyCollision(named)).toBe(true)

  const otherModel = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'OtherModel', target: ['venueId', 'idempotencyKey'] },
  })
  expect(isWasteKeyCollision(otherModel)).toBe(false)
})

test('varios lotes: costos firmados en hijos, magnitud en cabecera, sin multiplicar lectores', async () => {
  const item = await raw(5)
  await batch(item.id, 3, 2, new Date('2026-01-01T00:00:00Z'))
  await batch(item.id, 2, 5, new Date('2026-02-01T00:00:00Z'))

  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 5))
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  const movements = await prisma.rawMaterialMovement.findMany({
    where: { wasteReportId: report.id },
    orderBy: { costImpact: 'asc' },
  })

  expect(movements).toHaveLength(2)
  expect(movements.map(row => row.costImpact?.toString())).toEqual(['-10', '-6'])
  expect(report.costImpact?.toString()).toBe('16')
  expect(report.costState).toBe('KNOWN')
  expect(await rawStock(item.id)).toBe('0')
  expect(movements.every(row => row.createdAt.getTime() === report.createdAt.getTime())).toBe(true)

  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.quantity.toString()).toBe('5')
  expect(totals.cost?.toString()).toBe('16')
  expect(totals.unvaluedQuantity.toString()).toBe('0')
})

test('sin existencia persiste declaración sin inventar movimientos o costo', async () => {
  const item = await raw(0)
  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4))

  expect(result).toMatchObject({ declared: '4', deducted: '0', unrecorded: '4' })
  expect(await prisma.rawMaterialMovement.count({ where: { wasteReportId: result.reportId } })).toBe(0)

  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  expect(report.costState).toBe('NONE')
  expect(report.costImpact).toBeNull()

  const list = await listWasteReports(venueId, { page: 1, pageSize: 100 })
  expect(list.total).toBe(1)
  expect(list.items[0].id).toBe(result.reportId)
})

test('hueco legacy: lote conocido más ajuste directo sin costo', async () => {
  const item = await raw(5)
  await batch(item.id, 2, 3)

  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4))
  const movements = await prisma.rawMaterialMovement.findMany({ where: { wasteReportId: result.reportId } })
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })

  expect(result).toMatchObject({ deducted: '4', unrecorded: '0' })
  expect(await rawStock(item.id)).toBe('1')
  expect(movements).toHaveLength(2)
  expect(movements.find(row => row.batchId === null)?.quantity.toString()).toBe('-2')
  expect(movements.find(row => row.batchId === null)?.costImpact).toBeNull()
  expect(report.costImpact?.toString()).toBe('6')
  expect(report.costState).toBe('PARTIAL')

  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.unvaluedQuantity.toString()).toBe('2')
})

test('inverso legacy: los lotes no permiten exceder currentStock', async () => {
  const item = await raw(2)
  const lot = await batch(item.id, 5, 1)

  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4))
  expect(result).toMatchObject({ deducted: '2', unrecorded: '2' })
  expect(await rawStock(item.id)).toBe('0')
  const remaining = await prisma.stockBatch.findUniqueOrThrow({ where: { id: lot.id } })
  expect(remaining.remainingQuantity.toString()).toBe('3')
})

test('producto negativo queda intacto', async () => {
  const item = await product(-3)
  const result = await logWaste(venueId, staffId, request('PRODUCT', item.id, 2))

  expect(result).toMatchObject({ deducted: '0', unrecorded: '2' })
  expect(await productStock(item.id)).toBe('-3')
  expect(await prisma.inventoryMovement.count({ where: { wasteReportId: result.reportId } })).toBe(0)
})

test('producto con existencia positiva: descuenta hasta la existencia y el resto queda sin registrar', async () => {
  const item = await product(3, 10)
  const result = await logWaste(venueId, staffId, request('PRODUCT', item.id, 5))

  // Sin el tope, adjustInventoryStockInTx llevaría 3 → −2 y respondería 400 «Insufficient stock».
  expect(result).toMatchObject({ declared: '5', deducted: '3', unrecorded: '2' })
  expect(await productStock(item.id)).toBe('0')
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  expect(report.costState).toBe('PARTIAL')
  expect(report.costImpact?.toString()).toBe('30')
  const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { wasteReportId: result.reportId } })
  expect(movement.quantity.toString()).toBe('-3')
})

test('FEFO consume el vencimiento anterior aunque su recepción sea posterior', async () => {
  const item = await raw(10)
  const older = await batch(item.id, 5, 2, new Date('2026-01-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))
  const earlierExpiration = await batch(item.id, 5, 7, new Date('2026-02-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))

  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 3, { reasonCode: 'EXPIRED' }))
  const movement = await prisma.rawMaterialMovement.findFirstOrThrow({ where: { wasteReportId: result.reportId } })
  expect(movement.batchId).toBe(earlierExpiration.id)

  const untouched = await prisma.stockBatch.findUniqueOrThrow({ where: { id: older.id } })
  expect(untouched.remainingQuantity.toString()).toBe('5')
})

test('FEFO sin fechas usa recepción y finalmente id', async () => {
  const item = await raw(4)
  const received = new Date('2026-01-01T00:00:00Z')
  const first = await batch(item.id, 2, 1, received)
  const second = await batch(item.id, 2, 1, received)
  const expected = [first.id, second.id].sort()[0]

  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 1, { reasonCode: 'EXPIRED' }))
  const movement = await prisma.rawMaterialMovement.findFirstOrThrow({ where: { wasteReportId: result.reportId } })
  expect(movement.batchId).toBe(expected)
})

test('producto sin costo queda UNKNOWN; costo cero sí es conocido', async () => {
  const unknown = await product(3, null)
  const knownZero = await product(3, 0)

  const a = await logWaste(venueId, staffId, request('PRODUCT', unknown.id, 2))
  const b = await logWaste(venueId, staffId, request('PRODUCT', knownZero.id, 2))
  const reportA = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: a.reportId } })
  const reportB = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: b.reportId } })

  expect(reportA.costState).toBe('UNKNOWN')
  expect(reportA.costImpact).toBeNull()
  expect(reportB.costState).toBe('KNOWN')
  expect(reportB.costImpact?.toString()).toBe('0')
})

test('Decimal(22,5) admite la pérdida de 100000 unidades a 1000', async () => {
  const item = await product(100000, 1000)
  const result = await logWaste(venueId, staffId, request('PRODUCT', item.id, 100000))
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })

  expect(report.costImpact?.toString()).toBe('100000000')
  expect(await productStock(item.id)).toBe('0')
})

test.each(['0', '0.0001', '1.0001', '1000000000', 'NaN', 'Infinity'])('rechaza cantidad POS inválida %s sin efectos', async quantity => {
  const item = await product(10)
  await expect(logWaste(venueId, staffId, request('PRODUCT', item.id, quantity))).rejects.toMatchObject({
    statusCode: 422,
    code: 'QUANTITY_TOO_LARGE',
  })
  expect(await productStock(item.id)).toBe('10')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
})

test('costo de lote fuera de numeric(10,4) se rechaza sin efectos', async () => {
  const item = await raw(2)
  const lot = await batch(item.id, 2, 600000)

  await expect(logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 2))).rejects.toMatchObject({
    statusCode: 422,
    code: 'QUANTITY_TOO_LARGE',
  })

  expect(await rawStock(item.id)).toBe('2')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
  const stored = await prisma.stockBatch.findUniqueOrThrow({ where: { id: lot.id } })
  expect(stored.remainingQuantity.toString()).toBe('2')
})

test('motivo Otro sin nota se rechaza sin efectos', async () => {
  const item = await product(10)

  for (const note of [undefined, '   ']) {
    await expect(logWaste(venueId, staffId, request('PRODUCT', item.id, 2, { reasonCode: 'OTHER', note }))).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_WASTE_REASON',
    })
  }

  expect(await productStock(item.id)).toBe('10')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
})

test('Sin especificar fuera del dashboard se rechaza sin efectos', async () => {
  const item = await raw(5)
  const lot = await batch(item.id, 5, 2)

  // POS lo corta el catálogo (no es chip de mostrador); MCP lo corta la regla propia de UNSPECIFIED.
  for (const source of ['POS', 'MCP'] as const) {
    await expect(
      logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 2, { reasonCode: 'UNSPECIFIED', source })),
    ).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_WASTE_REASON' })
  }

  expect(await rawStock(item.id)).toBe('5')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
  const stored = await prisma.stockBatch.findUniqueOrThrow({ where: { id: lot.id } })
  expect(stored.remainingQuantity.toString()).toBe('5')
})

test('si la última escritura falla, la merma ya descontada se revierte entera', async () => {
  const ingredient = await raw(5)
  const lot = await batch(ingredient.id, 2, 3)
  const item = await product(4, 10)

  const suffix = randomUUID().replace(/-/g, '')
  const functionName = `waste_rollback_${suffix}`
  const triggerName = `waste_rollback_trigger_${suffix}`

  // La auditoría es la ÚLTIMA escritura de la tx: fallar ahí prueba que lotes y existencia ya
  // descontados se deshacen. Acotado a este venue; los literales vienen del propio test (cuid).
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.action = 'INVENTORY_WASTE_LOGGED' AND NEW."venueId" = '${venueId}' THEN
        RAISE EXCEPTION 'merma-rollback-probe';
      END IF;
      RETURN NEW;
    END
    $body$
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT ON "ActivityLog"
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `)

  try {
    // Ingrediente: un lote (2) y el hueco sin lotes (2) — los dos caminos de escritura.
    await expect(logWaste(venueId, staffId, request('RAW_MATERIAL', ingredient.id, 4))).rejects.toThrow('merma-rollback-probe')
    await expect(logWaste(venueId, staffId, request('PRODUCT', item.id, 3))).rejects.toThrow('merma-rollback-probe')
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ActivityLog"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
  }

  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
  expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)
  expect(await rawStock(ingredient.id)).toBe('5')
  expect(await productStock(item.id)).toBe('4')
  const stored = await prisma.stockBatch.findUniqueOrThrow({ where: { id: lot.id } })
  expect(stored.remainingQuantity.toString()).toBe('2')
  expect(stored.status).toBe('ACTIVE')
})

test('createdAt lo pone el servidor; clientOccurredAt sólo se guarda', async () => {
  const item = await raw(5)
  await batch(item.id, 2, 3)
  const clientOccurredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

  const before = new Date()
  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4, { clientOccurredAt }))
  const after = new Date()

  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  expect(report.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
  expect(report.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
  expect(report.clientOccurredAt?.toISOString()).toBe(clientOccurredAt.toISOString())

  const movements = await prisma.rawMaterialMovement.findMany({ where: { wasteReportId: report.id } })
  expect(movements).toHaveLength(2)
  expect(movements.every(row => row.createdAt.getTime() === report.createdAt.getTime())).toBe(true)
  const log = await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: report.id } })
  expect(log.createdAt.getTime()).toBe(report.createdAt.getTime())
})

test('merma de producto con costo recibido no toca Product.cost; el movimiento guarda la foto', async () => {
  const item = await product(5, 12)
  const result = await logWaste(venueId, staffId, request('PRODUCT', item.id, 2, { source: 'DASHBOARD', unitCost: '15.25' }))

  const stored = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
  expect(stored.cost?.toString()).toBe('12')
  const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { wasteReportId: result.reportId } })
  expect(movement.unitCost?.toString()).toBe('15.25')
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  expect(report.unitCostSnapshot?.toString()).toBe('15.25')
  expect(movement.createdAt.getTime()).toBe(report.createdAt.getTime())
})

test('los movimientos hijos llevan motivo legible, autor, referencia y su tipo', async () => {
  const ingredient = await raw(5)
  await batch(ingredient.id, 2, 3)
  const rawResult = await logWaste(
    venueId,
    staffId,
    request('RAW_MATERIAL', ingredient.id, 4, { reasonCode: 'SPOILED', note: 'Olía mal', reference: 'REF-9' }),
  )
  const rawMovements = await prisma.rawMaterialMovement.findMany({ where: { wasteReportId: rawResult.reportId } })
  expect(rawMovements).toHaveLength(2)
  expect(rawMovements.every(row => row.type === 'SPOILAGE' && row.createdBy === staffId && row.reference === 'REF-9')).toBe(true)
  expect(rawMovements.find(row => row.batchId !== null)?.reason).toBe('Se echó a perder: Olía mal')
  expect(rawMovements.find(row => row.batchId === null)?.reason).toBe('Se echó a perder: Olía mal (ajuste directo, sin lotes)')

  const item = await product(5)
  const productResult = await logWaste(
    venueId,
    staffId,
    request('PRODUCT', item.id, 1, { reasonCode: 'DROPPED', note: 'Se rompió', reference: 'REF-10' }),
  )
  const productMovement = await prisma.inventoryMovement.findFirstOrThrow({ where: { wasteReportId: productResult.reportId } })
  expect(productMovement).toMatchObject({ type: 'LOSS', reason: 'Se cayó / derramó: Se rompió', createdBy: staffId, reference: 'REF-10' })

  // Sin nota, el motivo es sólo la etiqueta.
  const noNote = await logWaste(venueId, staffId, request('PRODUCT', item.id, 1, { reasonCode: 'EXPIRED', note: undefined }))
  const noNoteMovement = await prisma.inventoryMovement.findFirstOrThrow({ where: { wasteReportId: noNote.reportId } })
  expect(noNoteMovement.reason).toBe('Caducó')
})

test('unitCost null es AUSENTE: usa Product.cost y recupera el mismo folio que sin el campo', async () => {
  const item = await product(5, 12)
  const input = request('PRODUCT', item.id, 2, { source: 'DASHBOARD', unitCost: null })

  // El null de JSON no es una cantidad: antes respondía 422 QUANTITY_TOO_LARGE.
  const first = await logWaste(venueId, staffId, input)
  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: first.reportId } })
  expect(report.unitCost).toBeNull()
  expect(report.unitCostSnapshot?.toString()).toBe('12')
  expect(report.costImpact?.toString()).toBe('24')

  const withoutField: WasteInput = { ...input }
  delete withoutField.unitCost
  expect(await logWaste(venueId, staffId, withoutField)).toEqual(first)
  expect(await productStock(item.id)).toBe('3')
})

test('la auditoría dice qué artículo, motivo y unidad se mermaron', async () => {
  const ingredient = await raw(5)
  const rawResult = await logWaste(venueId, staffId, request('RAW_MATERIAL', ingredient.id, 2, { reasonCode: 'SPOILED', note: undefined }))
  const item = await product(5)
  const productResult = await logWaste(venueId, staffId, request('PRODUCT', item.id, 1, { reasonCode: 'DROPPED', note: undefined }))

  const rawLog = await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: rawResult.reportId } })
  expect(rawLog).toMatchObject({ action: 'INVENTORY_WASTE_LOGGED', entity: 'InventoryWasteReport', staffId, actorStaffId: staffId })
  expect(rawLog.data).toMatchObject({
    itemType: 'RAW_MATERIAL',
    itemId: ingredient.id,
    // Opus menor 1: el NOMBRE, como guardaba el camino viejo — la pantalla del dueño lo lee de aquí.
    itemName: ingredient.name,
    reasonCode: 'SPOILED',
    unit: 'PIECE',
    declared: '2',
  })

  const productLog = await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: productResult.reportId } })
  expect(productLog.data).toMatchObject({
    itemType: 'PRODUCT',
    itemId: item.id,
    itemName: item.name,
    reasonCode: 'DROPPED',
    unit: 'UNIT',
    declared: '1',
  })
})

test('la auditoría de una anulación guarda el folio anulado', async () => {
  const key = randomUUID().toUpperCase()
  const result = await voidWasteKey(venueId, staffId, key)
  expect(result).toMatchObject({ outcome: 'VOIDED' })

  const log = await prisma.activityLog.findFirstOrThrow({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })
  // El folio normalizado: el mismo que ocupa el índice único y el que el aparato vuelve a mandar.
  expect(log.data).toMatchObject({ idempotencyKey: key.toLowerCase(), source: 'POS' })
})

// ─── Alerta de existencia baja (Opus I1) ─────────────────────────────────────────────────
// Ventas, modificadores, conteo móvil y la merma vieja la disparan; la merma del libro la dispara
// en logWaste, DESPUÉS del COMMIT, para las tres entradas (POS, dashboard y MCP). Nunca convierte
// la merma en error: ya está confirmada, y un error haría que el cliente reintentara.

/** La cadena real de `POST /mobile/.../inventory/waste` después de los candados: el controlador `create`. */
async function postFromPos(body: Record<string, unknown>, userId: string = staffId) {
  const captured: { status: number; body: unknown; error: unknown } = { status: 200, body: undefined, error: undefined }
  const req = { params: { venueId }, body, authContext: { userId, venueId, orgId: organizationId, role: 'MANAGER' } }
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(payload: unknown) {
      captured.body = JSON.parse(JSON.stringify(payload))
      return this
    },
  }
  await createFromPos(req as never, res as never, error => {
    captured.error = error
  })
  return captured
}

async function rawWithReorderPoint(stock: number, reorderPoint: number) {
  const item = await raw(stock)
  return prisma.rawMaterial.update({ where: { id: item.id }, data: { reorderPoint: D(reorderPoint) } })
}

test('🔴 /mobile: la merma de un insumo que lo deja bajo el punto de reorden crea la alerta de existencia baja', async () => {
  const item = await rawWithReorderPoint(6, 5)
  await batch(item.id, 6, 1)

  const r = await postFromPos({
    itemType: 'RAW_MATERIAL',
    itemId: item.id,
    quantity: '3',
    unit: 'PIECE',
    reasonCode: 'SPOILED',
    idempotencyKey: randomUUID(),
  })

  expect(r.error).toBeUndefined()
  expect(r.status).toBe(201)
  expect(r.body).toMatchObject({ declared: '3', deducted: '3', unrecorded: '0' })
  const alerts = await prisma.lowStockAlert.findMany({ where: { venueId, rawMaterialId: item.id } })
  expect(alerts).toHaveLength(1)
  expect(alerts[0]).toMatchObject({ status: 'ACTIVE', alertType: 'LOW_STOCK' })
  expect(alerts[0].currentLevel.toString()).toBe('3')
})

test('🔴 si la alerta falla DESPUÉS del COMMIT, la merma se devuelve igual y queda aplicada', async () => {
  const item = await rawWithReorderPoint(6, 5)
  await batch(item.id, 6, 1)
  const alerta = jest.spyOn(rawMaterialService, 'checkAndCreateLowStockAlert').mockRejectedValue(new Error('smtp caído'))
  try {
    const summary = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 3))

    expect(summary).toMatchObject({ declared: '3', deducted: '3', unrecorded: '0' })
    expect(alerta).toHaveBeenCalledTimes(1)
    expect(alerta).toHaveBeenCalledWith(venueId, item.id)
    expect(await rawStock(item.id)).toBe('3')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'APPLIED' } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_LOGGED' } })).toBe(1)
  } finally {
    alerta.mockRestore()
  }
})

// La alerta corre DESPUÉS del commit y `logWaste` no la espera más de su tope (Codex, ronda final de
// fase 1): con un proveedor de correo lento, la merma ya confirmada no puede quedar retenida detrás
// de una notificación. El mock nunca se resuelve solo — sólo el tope de producción hace avanzar la
// prueba — así el tiempo medido no depende de correr dos temporizadores en carrera bajo carga.
test(
  '🔴 si la alerta tarda, logWaste responde dentro de su tope de 1s y la deja corriendo de fondo sin unhandled rejection',
  async () => {
    const item = await rawWithReorderPoint(6, 5)
    await batch(item.id, 6, 1)

    let settleSlowAlert: ((error: Error) => void) | undefined
    const slowAlert = new Promise<void>((_, reject) => {
      settleSlowAlert = reject
    })
    const alerta = jest.spyOn(rawMaterialService, 'checkAndCreateLowStockAlert').mockReturnValue(slowAlert)
    const onUnhandledRejection = jest.fn()
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const start = Date.now()
      const summary = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 3))
      const elapsed = Date.now() - start

      // Margen holgado (3x el tope de 1000ms) para no ser frágil bajo carga de la máquina.
      expect(elapsed).toBeLessThan(3000)
      expect(summary).toMatchObject({ declared: '3', deducted: '3', unrecorded: '0' })
      expect(await rawStock(item.id)).toBe('3')
      expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'APPLIED' } })).toBe(1)
      expect(alerta).toHaveBeenCalledTimes(1)
      expect(alerta).toHaveBeenCalledWith(venueId, item.id)

      // La evaluación de fondo se resuelve DESPUÉS de que logWaste ya contestó (rechazo tardío):
      // `alertLowStockAfterWaste` ya la atrapa, así que no debe escapar como unhandled rejection.
      settleSlowAlert?.(new Error('proveedor de correo lento'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      expect(onUnhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      alerta.mockRestore()
    }
  },
  8000,
)

test('la alerta sólo se evalúa cuando ESTA llamada descontó un insumo: ni productos, ni nada descontado, ni recuperar el folio', async () => {
  const alerta = jest.spyOn(rawMaterialService, 'checkAndCreateLowStockAlert').mockResolvedValue()
  try {
    // Producto: el camino viejo de productos no tenía alerta (LowStockAlert es de insumos).
    const item = await product(5)
    await logWaste(venueId, staffId, request('PRODUCT', item.id, 2))
    // Insumo sin existencia: no se descontó nada, la existencia no cambió.
    const empty = await raw(0)
    await logWaste(venueId, staffId, request('RAW_MATERIAL', empty.id, 2))
    expect(alerta).not.toHaveBeenCalled()

    // Insumo con existencia: una evaluación; recuperar el MISMO folio no vuelve a evaluar.
    const ingredient = await raw(5)
    const input = request('RAW_MATERIAL', ingredient.id, 2)
    const first = await logWaste(venueId, staffId, input)
    expect(await logWaste(venueId, staffId, input)).toEqual(first)
    expect(alerta).toHaveBeenCalledTimes(1)
    expect(alerta).toHaveBeenCalledWith(venueId, ingredient.id)
  } finally {
    alerta.mockRestore()
  }
})

// ─── La respuesta se arma DENTRO de la transacción (Codex P2-2) ─────────────────────────
// El dashboard de hoy no manda folio: si la ruta contestara error DESPUÉS del COMMIT, el reintento
// generaría otro folio y descontaría otra vez. Por eso lo que responde la entrada se lee dentro de la
// transacción de logWaste, antes del COMMIT: o sale la respuesta, o no queda nada aplicado.

test('🔴 si falla la lectura de la respuesta, revierte toda la merma', async () => {
  const item = await product(5)
  const input = request('PRODUCT', item.id, 2)
  const failure = new Error('No se pudo construir la respuesta')

  await expect(
    logWaste(venueId, staffId, input, async tx => {
      // Los efectos ya están escritos dentro de la transacción…
      const current = await tx.inventory.findUniqueOrThrow({ where: { productId: item.id } })
      expect(current.currentStock.toString()).toBe('3')
      throw failure
    }),
  ).rejects.toBe(failure)

  // …y caen con ella: nada aplicado sin respuesta.
  expect(await productStock(item.id)).toBe('5')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_LOGGED' } })).toBe(0)
})

test('la respuesta leída en la transacción ve los efectos y es lo que devuelve logWaste, también al recuperar el folio', async () => {
  const ingredient = await raw(5)
  const input = request('RAW_MATERIAL', ingredient.id, 2)
  const read = async (tx: Prisma.TransactionClient, summary: WasteSummary) => {
    const row = await tx.rawMaterial.findUniqueOrThrow({ where: { id: ingredient.id } })
    return { summary, stock: row.currentStock.toString() }
  }

  const first = await logWaste(venueId, staffId, input, read)
  expect(first.stock).toBe('3')
  expect(first.summary).toMatchObject({ declared: '2', deducted: '2', unrecorded: '0' })

  // El mismo folio: no descuenta otra vez y la respuesta se arma sobre el folio recuperado.
  expect(await logWaste(venueId, staffId, input, read)).toEqual(first)
  expect(await rawStock(ingredient.id)).toBe('3')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
})

test('dos peticiones concurrentes con el mismo folio y lectura de respuesta: descuentan una vez y contestan lo mismo', async () => {
  const item = await product(10)
  const input = request('PRODUCT', item.id, 4)
  const read = async (tx: Prisma.TransactionClient, summary: WasteSummary) => {
    const inventory = await tx.inventory.findUniqueOrThrow({ where: { productId: item.id } })
    return { summary, stock: inventory.currentStock.toString() }
  }

  const [first, second] = await Promise.all([logWaste(venueId, staffId, input, read), logWaste(venueId, staffId, input, read)])

  expect(first).toEqual(second)
  expect(first.stock).toBe('6')
  expect(await productStock(item.id)).toBe('6')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
})

// ─── Anular un folio (voidWasteKey) ───────────────────────────────────────────────────────

test('void no necesita plan y devuelve la autoría canónica al repetirlo', async () => {
  // Premisa: el venue de prueba NO tiene el plan de inventario. Anular no lo pide (spec §4.3).
  expect(await venueHasFeatureAccess(venueId, 'INVENTORY_TRACKING')).toBe(false)

  const key = randomUUID()
  const before = new Date()
  const first = await voidWasteKey(venueId, staffId, key)
  const after = new Date()
  const second = await voidWasteKey(venueId, staffId, key)

  expect(first).toMatchObject({ outcome: 'VOIDED', voidedByStaffId: staffId })
  expect(second).toEqual(first)

  // La lápida: sin artículo ni cantidades, con la hora del SERVIDOR y una sola auditoría.
  const tombstone = await prisma.inventoryWasteReport.findUniqueOrThrow({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: key } },
  })
  expect(tombstone).toMatchObject({
    status: 'VOIDED',
    costState: 'NONE',
    itemType: null,
    declaredQuantity: null,
    payloadHash: null,
    reportedByStaffId: staffId,
    source: 'POS',
  })
  expect(tombstone.deductedQuantity.toString()).toBe('0')
  expect(tombstone.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
  expect(tombstone.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())
  expect(first).toMatchObject({ voidedAt: tombstone.createdAt.toISOString() })
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED', entityId: tombstone.id } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId } })).toBe(1)

  // POST tardío sobre la lápida: 409 WASTE_VOIDED, sin descontar nada.
  const item = await product(10)
  await expect(logWaste(venueId, staffId, request('PRODUCT', item.id, 2, { idempotencyKey: key }))).rejects.toMatchObject({
    code: 'WASTE_VOIDED',
    statusCode: 409,
  })
  expect(await productStock(item.id)).toBe('10')
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
})

test('otra persona que repite la anulación recibe la autoría canónica, no la suya', async () => {
  const key = randomUUID()
  // Un mesero de fábrica (log-waste sin adjust) puede anular.
  const first = await voidWasteKey(venueId, waiterAId, key)
  expect(first).toMatchObject({ outcome: 'VOIDED', voidedByStaffId: waiterAId })

  // El gerente la repite con el folio en mayúsculas: es el MISMO folio.
  const repeated = await voidWasteKey(venueId, staffId, key.toUpperCase())
  expect(repeated).toEqual(first)

  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })).toBe(1)
  const log = await prisma.activityLog.findFirstOrThrow({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })
  expect(log).toMatchObject({ staffId: waiterAId, actorStaffId: waiterAId })
})

test('void de APPLIED no revierte el stock', async () => {
  const item = await product(10)
  const input = request('PRODUCT', item.id, 2)
  const report = await logWaste(venueId, staffId, input)
  const stored = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: report.reportId } })

  expect(await voidWasteKey(venueId, staffId, input.idempotencyKey)).toEqual({
    outcome: 'ALREADY_APPLIED',
    report,
  })
  expect(await productStock(item.id)).toBe('8')

  // El folio aplicado queda EXACTAMENTE como estaba: ni cambia de estado ni se escribe nada.
  expect(await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: report.reportId } })).toEqual(stored)
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })).toBe(0)
})

test('el resumen de un APPLIED sólo lo recibe el autor o quien tiene inventory:adjust', async () => {
  // Premisa: los dos meseros tienen log-waste DE FÁBRICA (no hay override del rol) y NO adjust.
  expect(await prisma.venueRolePermission.count({ where: { venueId, role: 'WAITER' } })).toBe(0)
  for (const id of [waiterAId, waiterBId]) {
    const access = await getWasteAccess(id, venueId)
    expect(hasWastePermission(access, 'inventory:log-waste')).toBe(true)
    expect(hasWastePermission(access, 'inventory:adjust')).toBe(false)
  }

  const item = await product(10)
  const input = request('PRODUCT', item.id, 3)
  const report = await logWaste(venueId, waiterAId, input)

  // El autor, aunque no sea gerente.
  expect(await voidWasteKey(venueId, waiterAId, input.idempotencyKey)).toStrictEqual({ outcome: 'ALREADY_APPLIED', report })
  // Otro mesero: sabe que ya se registró, pero no ve cuánto ni el id del reporte.
  expect(await voidWasteKey(venueId, waiterBId, input.idempotencyKey)).toStrictEqual({ outcome: 'ALREADY_APPLIED' })
  // El gerente, aunque no sea el autor.
  expect(await voidWasteKey(venueId, staffId, input.idempotencyKey)).toStrictEqual({ outcome: 'ALREADY_APPLIED', report })

  expect(await productStock(item.id)).toBe('7')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
})

test('sin ninguno de los dos permisos, sin acceso o con folio inválido: rechazo sin lápida', async () => {
  // Premisa: el VIEWER tiene acceso vigente pero ni log-waste ni adjust.
  const viewerAccess = await getWasteAccess(viewerId, venueId)
  expect(hasWastePermission(viewerAccess, 'inventory:log-waste')).toBe(false)
  expect(hasWastePermission(viewerAccess, 'inventory:adjust')).toBe(false)

  const key = randomUUID()
  await expect(voidWasteKey(venueId, viewerId, key)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_PERMISSION_DENIED' })
  await expect(voidWasteKey(venueId, outsiderId, key)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_ACCESS_REVOKED' })
  await expect(voidWasteKey(venueId, staffId, 'no-es-un-uuid')).rejects.toMatchObject({
    statusCode: 422,
    code: 'INVALID_WASTE_KEY',
  })
  expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)

  // El folio no quedó inutilizado: el POST original todavía se aplica.
  const item = await product(10)
  const applied = await logWaste(venueId, staffId, request('PRODUCT', item.id, 2, { idempotencyKey: key }))
  expect(applied).toMatchObject({ deducted: '2' })

  // Y sobre un APPLIED el VIEWER tampoco se entera de nada.
  await expect(voidWasteKey(venueId, viewerId, key)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_PERMISSION_DENIED' })
  expect(await productStock(item.id)).toBe('8')
})

test('🔴 con log-waste QUITADO por el venue: el gerente anula por inventory:adjust; el mesero se queda sin camino', async () => {
  // Desde Task 7 el gerente trae los DOS permisos de fábrica, así que sin esta exclusión nada
  // distinguiría el brazo `inventory:adjust` del OR de voidWasteKey (Ruling 15-b).
  const item = await product(10)
  const input = request('PRODUCT', item.id, 2)
  const report = await logWaste(venueId, waiterAId, input)

  await prisma.venueRolePermission.createMany({
    data: [
      { venueId, role: 'MANAGER', permissions: [], deniedPermissions: ['inventory:log-waste'], modifiedBy: staffId },
      { venueId, role: 'WAITER', permissions: [], deniedPermissions: ['inventory:log-waste'], modifiedBy: staffId },
    ],
  })
  try {
    // Premisa: la exclusión muerde — al gerente le queda adjust y ya no log-waste; al mesero, ninguno.
    const manager = await getWasteAccess(staffId, venueId)
    expect(hasWastePermission(manager, 'inventory:adjust')).toBe(true)
    expect(hasWastePermission(manager, 'inventory:log-waste')).toBe(false)
    expect(await grantedPermissionsBeforeActivation(staffId, venueId, 'MANAGER')).not.toContain('inventory:log-waste')
    const waiter = await getWasteAccess(waiterBId, venueId)
    expect(hasWastePermission(waiter, 'inventory:log-waste')).toBe(false)
    expect(hasWastePermission(waiter, 'inventory:adjust')).toBe(false)

    // El gerente anula un folio nuevo por el brazo adjust…
    const key = randomUUID()
    await expect(voidWasteKey(venueId, staffId, key)).resolves.toMatchObject({ outcome: 'VOIDED', voidedByStaffId: staffId })
    // …y sobre un APPLIED ajeno recibe el resumen, porque administra inventario.
    await expect(voidWasteKey(venueId, staffId, input.idempotencyKey)).resolves.toStrictEqual({ outcome: 'ALREADY_APPLIED', report })

    // Contraste: el mesero, sin ninguno de los dos, recibe 403 y no deja lápida.
    const deniedKey = randomUUID()
    await expect(voidWasteKey(venueId, waiterBId, deniedKey)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_PERMISSION_DENIED' })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId, idempotencyKey: deniedKey } })).toBe(0)
    expect(await productStock(item.id)).toBe('8')
  } finally {
    await prisma.venueRolePermission.deleteMany({ where: { venueId, role: { in: ['MANAGER', 'WAITER'] } } })
  }
})

/**
 * Plazo del ARNÉS para ver en Postgres el bloqueo que fuerza la carrera (Codex P3-1). Holgado para la
 * Mac cargada, pero por debajo de los 10 s con que `withSerializableRetry` cierra las transacciones de
 * los dos contendientes: si se agota, la observación quedó INCONCLUSA — no es un fallo de concurrencia
 * y ninguna aserción de la carrera llegó a evaluarse.
 */
const PLAZO_OBSERVACION_MS = 8000

async function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + PLAZO_OBSERVACION_MS
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Observación inconclusa del arnés: no se vio ${what} en ${PLAZO_OBSERVACION_MS} ms (no es un fallo de concurrencia).`)
}

/**
 * Fuerza el orden de una carrera por el folio: el GANADOR inserta su fila y se queda detenido
 * por un trigger (advisory lock que retiene otra conexión); el PERDEDOR arranca y se bloquea
 * contra el índice único del folio; entonces se suelta al ganador. El trigger sólo actúa sobre
 * ESTE folio y ESTE estado, y se borra en `finally` pase lo que pase. `whileBlocked` corre con el
 * perdedor TODAVÍA detenido en el índice (recibe su pid), para observar qué alcanzó a hacer.
 */
async function forceOrder(
  key: string,
  winnerStatus: 'APPLIED' | 'VOIDED',
  startWinner: () => Promise<unknown>,
  startLoser: () => Promise<unknown>,
  whileBlocked?: (loserPid: number) => Promise<void>,
): Promise<{ winner: PromiseSettledResult<unknown>; loser: PromiseSettledResult<unknown> }> {
  const suffix = randomUUID().replace(/-/g, '')
  const functionName = `waste_race_${suffix}`
  const triggerName = `waste_race_trigger_${suffix}`
  const gate = randomInt(1, 2_000_000_000)
  const blocker = new PrismaClient({
    datasources: { db: { url: process.env.TEST_DATABASE_URL } },
  })

  let release: () => void = () => undefined
  let acquired: () => void = () => undefined
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const held = new Promise<void>(resolve => {
    acquired = resolve
  })
  let blockerTransaction: Promise<void> | undefined
  let winner: Promise<unknown> | undefined
  let loser: Promise<unknown> | undefined

  try {
    // Los identificadores y literales proceden exclusivamente de UUID, enum e integer del test.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW."idempotencyKey" = '${key.toLowerCase()}'
           AND NEW.status::text = '${winnerStatus}' THEN
          PERFORM pg_advisory_xact_lock(${gate}::bigint);
        END IF;
        RETURN NEW;
      END
      $body$
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      AFTER INSERT ON "InventoryWasteReport"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)

    blockerTransaction = blocker.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${gate}::bigint)`
        acquired()
        await released
      },
      { timeout: 30000 },
    )
    // Si el bloqueador no llega a tomar el candado, falla en vez de colgarse.
    await Promise.race([
      held,
      blockerTransaction.then(() => {
        throw new Error('El bloqueador terminó sin retener el candado.')
      }),
    ])

    winner = startWinner()
    void winner.catch(() => undefined)

    const winnerPid = await waitFor('al ganador detenido en su trigger', async () => {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 0
          AND objid = ${gate}::oid
          AND granted = FALSE
      `
      return rows[0]?.pid
    })

    loser = startLoser()
    void loser.catch(() => undefined)

    // El perdedor está detenido POR el ganador: el orden quedó forzado, no a la suerte.
    const loserPid = await waitFor('al perdedor detenido por el ganador', async () => {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE ${winnerPid}::int = ANY(pg_blocking_pids(pid))
        LIMIT 1
      `
      return rows[0]?.pid
    })
    if (whileBlocked) await whileBlocked(loserPid)

    release()
    await blockerTransaction
    const results = await Promise.allSettled([winner, loser])
    return { winner: results[0], loser: results[1] }
  } finally {
    release()
    await Promise.allSettled([blockerTransaction ?? Promise.resolve(), winner ?? Promise.resolve(), loser ?? Promise.resolve()])
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "InventoryWasteReport"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    await blocker.$disconnect()
  }
}

async function racePostAndVoid(
  input: WasteInput,
  winnerStatus: 'APPLIED' | 'VOIDED',
  whileLoserBlocked?: (loserPid: number) => Promise<void>,
): Promise<{ post: PromiseSettledResult<unknown>; cancel: PromiseSettledResult<unknown> }> {
  const post = () => logWaste(venueId, staffId, input)
  const cancel = () => voidWasteKey(venueId, staffId, input.idempotencyKey)
  if (winnerStatus === 'APPLIED') {
    const { winner, loser } = await forceOrder(input.idempotencyKey, 'APPLIED', post, cancel, whileLoserBlocked)
    return { post: winner, cancel: loser }
  }
  const { winner, loser } = await forceOrder(input.idempotencyKey, 'VOIDED', cancel, post, whileLoserBlocked)
  return { post: loser, cancel: winner }
}

/** Tablas en las que `pid` ya ESCRIBIÓ dentro de su transacción abierta (RowExclusiveLock concedido). */
async function tablesWrittenBy(pid: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ relation: string }>>`
    SELECT DISTINCT c.relname::text AS relation
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    WHERE l.pid = ${pid}::int
      AND l.locktype = 'relation'
      AND l.mode = 'RowExclusiveLock'
      AND l.granted
      AND c.relkind IN ('r', 'p')
    ORDER BY 1
  `
  return rows.map(row => row.relation)
}

test('carrera real POST–void: gana APPLIED y void devuelve ALREADY_APPLIED', async () => {
  const item = await product(5)
  const result = await racePostAndVoid(request('PRODUCT', item.id, 2), 'APPLIED')

  expect(result.post.status).toBe('fulfilled')
  expect(result.cancel.status).toBe('fulfilled')
  if (result.cancel.status === 'fulfilled' && result.post.status === 'fulfilled') {
    expect(result.cancel.value).toEqual({ outcome: 'ALREADY_APPLIED', report: result.post.value })
  }
  expect(await productStock(item.id)).toBe('3')
  expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'APPLIED' } })).toBe(1)
  expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'VOIDED' } })).toBe(0)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_LOGGED' } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })).toBe(0)
})

// Codex P3-1: la guardia de orden de escrituras también por el camino de INSUMO (lote + hueco legacy:
// los dos tipos de descuento). Un POST que adelantara los efectos de insumo antes del folio seguiría
// terminando revertido; sólo esta observación, con el perdedor DETENIDO en el índice, lo ve.
const CARRERA_VOIDED = {
  PRODUCT: { effects: ['Inventory', 'InventoryMovement'] },
  RAW_MATERIAL: { effects: ['RawMaterial', 'RawMaterialMovement', 'StockBatch'] },
} as const

test.each(['PRODUCT', 'RAW_MATERIAL'] as const)('carrera real POST–void (%s): gana VOIDED y el POST no deja efectos', async itemType => {
  let item: { id: string }
  let lotId: string | undefined
  let input: WasteInput
  if (itemType === 'PRODUCT') {
    item = await product(5)
    input = request('PRODUCT', item.id, 2)
  } else {
    // Existencia 5 con un lote de 2: descontar 3 toca el lote Y el ajuste directo sin lotes.
    item = await raw(5)
    lotId = (await batch(item.id, 2, 2)).id
    input = request('RAW_MATERIAL', item.id, 3)
  }
  let writtenWhileBlocked: string[] = []
  const result = await racePostAndVoid(input, 'VOIDED', async loserPid => {
    writtenWhileBlocked = await tablesWrittenBy(loserPid)
  })

  // 🔴 El índice único se disputa ANTES de escribir los efectos: detenido en él, el POST sólo ha
  // tocado la tabla de folios; ni la existencia, ni el kardex, ni los lotes, ni la auditoría.
  // (Control positivo: sí ve su folio.)
  expect(writtenWhileBlocked).toContain('InventoryWasteReport')
  for (const table of [...CARRERA_VOIDED[itemType].effects, 'ActivityLog']) {
    expect(writtenWhileBlocked).not.toContain(table)
  }

  expect(result.cancel.status).toBe('fulfilled')
  if (result.cancel.status === 'fulfilled') {
    expect(result.cancel.value).toMatchObject({ outcome: 'VOIDED', voidedByStaffId: staffId })
  }
  expect(result.post.status).toBe('rejected')
  if (result.post.status === 'rejected') {
    expect(result.post.reason).toMatchObject({ code: 'WASTE_VOIDED', statusCode: 409 })
  }
  if (itemType === 'PRODUCT') {
    expect(await productStock(item.id)).toBe('5')
  } else {
    expect(await rawStock(item.id)).toBe('5')
    expect((await prisma.stockBatch.findUniqueOrThrow({ where: { id: lotId } })).remainingQuantity.toString()).toBe('2')
  }
  expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'VOIDED' } })).toBe(1)
  expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'APPLIED' } })).toBe(0)
  expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
  expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_VOIDED' } })).toBe(1)
  expect(await prisma.activityLog.count({ where: { venueId, action: 'INVENTORY_WASTE_LOGGED' } })).toBe(0)
})

test('colisión P2002 real: la anulación que pierde lee lo que quedó y no deja rastro propio', async () => {
  // Entre dos escritores SERIALIZABLE, Postgres responde al perdedor con un fallo de serialización
  // (se reintenta y ve la fila). Aquí el ganador escribe FUERA de SERIALIZABLE, así que el perdedor
  // recibe el 23505 real (P2002) y se ejerce la recuperación por el índice único.
  const key = randomUUID()
  // Espía que conserva la implementación real: no fabrica errores, sólo cuenta los intentos.
  const transactions = jest.spyOn(prisma, '$transaction')
  try {
    const result = await forceOrder(
      key,
      'VOIDED',
      () =>
        prisma.inventoryWasteReport.create({
          data: { venueId, idempotencyKey: key, status: 'VOIDED', costState: 'NONE', reportedByStaffId: waiterAId, source: 'POS' },
        }),
      () => voidWasteKey(venueId, staffId, key),
    )

    expect(result.winner.status).toBe('fulfilled')
    // UNA sola transacción, y terminó en P2002: si un 40001 + reintento la hubiera salvado (el
    // reintento ve la fila DENTRO de la transacción), esta prueba no estaría probando el catch.
    expect(transactions).toHaveBeenCalledTimes(1)
    expect(await captureError(transactions.mock.results[0].value as Promise<unknown>)).toMatchObject({ code: 'P2002' })

    expect(result.loser.status).toBe('fulfilled')
    if (result.loser.status === 'fulfilled') {
      // La autoría es la de la fila que ganó, no la de quien perdió.
      expect(result.loser.value).toMatchObject({ outcome: 'VOIDED', voidedByStaffId: waiterAId })
    }
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
    // El perdedor revirtió entero: su auditoría no existe.
    expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)
  } finally {
    transactions.mockRestore()
  }
})

// ─── Auditoría Codex #1 · P2-4: el catch P2002 de logWaste, con un P2002 REAL ─────────────

test.each(['APPLIED', 'VOIDED'] as const)(
  'logWaste recupera FUERA de la transacción tras un P2002 real, sin reintento; ganador=%s',
  async status => {
    const item = await raw(0)
    const input = request('RAW_MATERIAL', item.id, 2)
    const prepared = prepareWaste(staffId, input)

    // El ganador escribe DIRECTO (READ COMMITTED, sin auditoría): así el perdedor SERIALIZABLE recibe
    // el 23505 real en vez de un 40001, y lo único que puede salvarlo es el catch de logWaste.
    const data: Prisma.InventoryWasteReportUncheckedCreateInput =
      status === 'VOIDED'
        ? {
            venueId,
            idempotencyKey: prepared.idempotencyKey,
            status: 'VOIDED',
            costState: 'NONE',
            reportedByStaffId: waiterAId,
            source: 'POS',
          }
        : {
            venueId,
            idempotencyKey: prepared.idempotencyKey,
            status: 'APPLIED',
            payloadHash: prepared.payloadHash,
            itemType: 'RAW_MATERIAL',
            rawMaterialId: item.id,
            unit: prepared.unit,
            reasonCode: prepared.reasonCode,
            note: prepared.note,
            declaredQuantity: prepared.quantity,
            deductedQuantity: D(0),
            unrecordedQuantity: prepared.quantity,
            costState: 'NONE',
            reportedByStaffId: staffId,
            source: 'POS',
          }

    // Espía que conserva la implementación real: no fabrica errores, sólo cuenta los intentos.
    const transactions = jest.spyOn(prisma, '$transaction')
    try {
      const result = await forceOrder(
        prepared.idempotencyKey,
        status,
        () => prisma.inventoryWasteReport.create({ data }),
        () => logWaste(venueId, staffId, input),
      )
      expect(result.winner.status).toBe('fulfilled')

      // UNA sola transacción, y terminó en P2002: si un 40001 + reintento la hubiera salvado,
      // esta prueba no estaría probando el catch.
      expect(transactions).toHaveBeenCalledTimes(1)
      expect(await captureError(transactions.mock.results[0].value as Promise<unknown>)).toMatchObject({ code: 'P2002' })

      const persisted = await prisma.inventoryWasteReport.findUniqueOrThrow({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey: prepared.idempotencyKey } },
      })
      if (status === 'APPLIED') {
        expect(result.loser).toEqual({
          status: 'fulfilled',
          value: { reportId: persisted.id, declared: '2', deducted: '0', unrecorded: '2' },
        })
      } else {
        expect(result.loser.status).toBe('rejected')
        if (result.loser.status === 'rejected') {
          expect(result.loser.reason).toMatchObject({ code: 'WASTE_VOIDED', statusCode: 409 })
        }
        expect(persisted.reportedByStaffId).toBe(waiterAId)
      }

      // El perdedor revirtió entero: ni existencia, ni movimientos, ni auditoría propia.
      expect(await rawStock(item.id)).toBe('0')
      expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
      expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
      expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
      expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)
    } finally {
      transactions.mockRestore()
    }
  },
)

// Duda 2 de la ronda final: la rama «colisión P2002 → recuperar fuera → la respuesta se arma en una
// transacción PROPIA» (Codex P2-2) con la ruta del DASHBOARD de perdedora. Mismo patrón: el ganador
// inserta DIRECTO (READ COMMITTED), así el perdedor recibe el 23505 real y sólo el catch lo salva.
test('🔴 la ruta del dashboard que pierde el folio por un P2002 real arma su respuesta en una transacción propia', async () => {
  const item = await raw(0)
  const key = randomUUID()
  // La MISMA entrada que arma adaptDashboardWaste para { quantity: -2 } sobre un insumo en piezas.
  const prepared = prepareWaste(staffId, {
    itemType: 'RAW_MATERIAL',
    itemId: item.id,
    quantity: D(2),
    unit: 'PIECE',
    reasonCode: 'UNSPECIFIED',
    idempotencyKey: key,
    source: 'DASHBOARD',
  })
  const data: Prisma.InventoryWasteReportUncheckedCreateInput = {
    venueId,
    idempotencyKey: prepared.idempotencyKey,
    status: 'APPLIED',
    payloadHash: prepared.payloadHash,
    itemType: 'RAW_MATERIAL',
    rawMaterialId: item.id,
    unit: prepared.unit,
    reasonCode: prepared.reasonCode,
    declaredQuantity: prepared.quantity,
    deductedQuantity: D(0),
    unrecordedQuantity: prepared.quantity,
    costState: 'NONE',
    reportedByStaffId: staffId,
    source: 'DASHBOARD',
  }

  const transactions = jest.spyOn(prisma, '$transaction')
  try {
    const result = await forceOrder(
      prepared.idempotencyKey,
      'APPLIED',
      () => prisma.inventoryWasteReport.create({ data }),
      () => adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', item.id, { quantity: -2, idempotencyKey: key }),
    )
    expect(result.winner.status).toBe('fulfilled')

    // DOS transacciones y la primera terminó en P2002: la respuesta NO salió de un reintento (que la
    // habría leído dentro de la primera), sino de la transacción propia del catch.
    expect(transactions).toHaveBeenCalledTimes(2)
    expect(await captureError(transactions.mock.results[0].value as Promise<unknown>)).toMatchObject({ code: 'P2002' })
    await expect(transactions.mock.results[1].value as Promise<unknown>).resolves.toBeDefined()

    const persisted = await prisma.inventoryWasteReport.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: prepared.idempotencyKey } },
    })
    expect(result.loser.status).toBe('fulfilled')
    if (result.loser.status === 'fulfilled') {
      const value = result.loser.value as { waste: WasteSummary; item: { id: string; currentStock: Prisma.Decimal } }
      expect(value.waste).toEqual({ reportId: persisted.id, declared: '2', deducted: '0', unrecorded: '2' })
      expect(value.item.id).toBe(item.id)
      expect(value.item.currentStock.toString()).toBe('0')
    }

    // El perdedor revirtió entero.
    expect(await rawStock(item.id)).toBe('0')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
    expect(await prisma.rawMaterialMovement.count({ where: { venueId } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)
  } finally {
    transactions.mockRestore()
  }
})

// ─── Auditoría Codex #1 · P2-1: la merma de producto no espera candados (NOWAIT) ──────────

class SoltarCandado extends Error {}

/**
 * Otra transacción —en la vida real, una compra: actualiza Inventory y después Product.cost—
 * bloquea la fila de `tabla` y la RETIENE hasta que termina la observación de la merma. Sin NOWAIT
 * la merma se quedaría esperando (y ahí está la espera circular con la compra); con NOWAIT cada
 * intento aborta con 55P03 y se agotan los reintentos mientras el candado sigue tomado.
 *
 * Determinista a propósito (P3 de la verificación de Codex #1):
 *  - A no suelta el candado por reloj: un plazo que libera a A dejaría pasar la merma bajo carga
 *    (falso rojo). El plazo del arnés es un ERROR explícito que tumba la prueba, no una liberación.
 *  - Las transacciones REALES de la merma corren con `SET LOCAL lock_timeout = '0'` (espera sin
 *    límite). Con un `lock_timeout` chico heredado del entorno, quitar NOWAIT daría el MISMO
 *    `lock_not_available` y la prueba pasaría sin NOWAIT (falso verde). Sólo se neutraliza ese
 *    parámetro: las transacciones y las consultas son las del servicio.
 */
async function mermaMientrasOtraTxRetiene(
  tabla: 'Inventory' | 'Product',
  filaId: string,
  input: WasteInput,
): Promise<{ merma: PromiseSettledResult<WasteSummary>; seguiaRetenido: boolean }> {
  const PLAZO_MS = 30_000
  const ejecutarTx = prisma.$transaction.bind(prisma) as unknown as <T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ) => Promise<T>

  let avisar: () => void = () => undefined
  const tomado = new Promise<void>(resolve => {
    avisar = resolve
  })
  let soltar: () => void = () => undefined
  const liberacion = new Promise<void>(resolve => {
    soltar = resolve
  })

  let retiene = false
  let errorDeA: unknown
  let temporizador: NodeJS.Timeout | undefined
  let restaurar: (() => void) | undefined
  let b: Promise<PromiseSettledResult<WasteSummary>[]> | undefined
  let resultado: { merma: PromiseSettledResult<WasteSummary>; seguiaRetenido: boolean } | undefined

  const a = ejecutarTx(
    async txA => {
      if (tabla === 'Inventory') await txA.$queryRaw`SELECT id FROM "Inventory" WHERE id = ${filaId} FOR UPDATE`
      else await txA.$queryRaw`SELECT id FROM "Product" WHERE id = ${filaId} FOR UPDATE`
      retiene = true
      avisar()
      await liberacion
      retiene = false
      throw new SoltarCandado()
    },
    { timeout: PLAZO_MS + 15_000, maxWait: 10_000 },
  ).catch(error => {
    if (!(error instanceof SoltarCandado)) errorDeA = error
  })

  try {
    const adquirido = await Promise.race([tomado.then(() => true), a.then(() => false)])
    if (!adquirido) throw errorDeA ?? new Error('La otra transacción terminó sin tomar el candado.')

    const transactions = jest.spyOn(prisma, '$transaction')
    restaurar = () => transactions.mockRestore()
    transactions.mockImplementation(((
      operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) =>
      ejecutarTx(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '0'`
        return operation(tx)
      }, options)) as never)

    const plazo = new Promise<never>((_, reject) => {
      temporizador = setTimeout(() => reject(new Error(`El arnés agotó ${PLAZO_MS} ms mientras A retenía el candado.`)), PLAZO_MS)
    })

    b = Promise.allSettled([logWaste(venueId, staffId, input)])
    const [merma] = await Promise.race([
      b,
      plazo,
      a.then(() => {
        throw errorDeA ?? new Error('A liberó el candado antes de terminar la observación.')
      }),
    ])
    resultado = { merma, seguiaRetenido: retiene }
  } finally {
    clearTimeout(temporizador)
    soltar()
    await Promise.allSettled([a, b ?? Promise.resolve()])
    restaurar?.()
  }

  if (errorDeA) throw errorDeA
  if (!resultado) throw new Error('La observación no produjo un resultado.')
  return resultado
}

test.each(['Inventory', 'Product'] as const)(
  'merma de producto no espera la fila de %s que otra transacción retiene: se rinde sin efectos y el folio sigue usable',
  async tabla => {
    const item = await product(5)
    const input = request('PRODUCT', item.id, 2)
    const filaId = tabla === 'Inventory' ? (item.inventory?.id ?? '') : item.id
    expect(filaId).not.toBe('')

    const { merma, seguiaRetenido } = await mermaMientrasOtraTxRetiene(tabla, filaId, input)

    expect(merma.status).toBe('rejected')
    if (merma.status === 'rejected') {
      expect(merma.reason).toMatchObject({ code: 'WASTE_RETRYABLE_CONFLICT', statusCode: 409 })
    }
    // Respondió mientras la otra transacción TODAVÍA tenía el candado: no la esperó.
    expect(seguiaRetenido).toBe(true)

    expect(await productStock(item.id)).toBe('5')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
    expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)

    // Sin el candado, el aparato reintenta con el MISMO folio y se aplica una sola vez.
    await expect(logWaste(venueId, staffId, input)).resolves.toMatchObject({ deducted: '2' })
    expect(await productStock(item.id)).toBe('3')
  },
)

// ─── Auditoría Codex #1 · P2-2 (Ruling 12): anular no depende de la activación white-label ──

test('los permisos previos a la activación son EXACTAMENTE los de getUserAccess sin white-label', async () => {
  // Premisa: sin white-label, getUserAccess no filtra nada, así que su lista es la de antes del filtro.
  expect((await getUserAccess(staffId, venueId)).whiteLabelEnabled).toBe(false)

  const owner = await prisma.staff.create({
    data: { email: `owner-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Dueña' },
  })
  let permissionSetId: string | undefined
  try {
    await prisma.staffVenue.create({ data: { staffId: owner.id, venueId, role: 'OWNER', active: true } })
    // (b) Override del rol con adiciones Y exclusiones. Desde Task 7 log-waste es de fábrica en WAITER,
    // así que la adición es otro permiso que el mesero no trae (`reports:read`), para que la rama
    // aditiva del override siga ejercitada.
    await prisma.venueRolePermission.create({
      data: { venueId, role: 'WAITER', permissions: ['reports:read'], deniedPermissions: ['reviews:read'], modifiedBy: staffId },
    })
    // (c) Conjunto de permisos: manda sobre el rol.
    const set = await prisma.permissionSet.create({
      data: { venueId, name: `Conjunto ${randomUUID()}`, permissions: ['inventory:log-waste', 'orders:read'] },
    })
    permissionSetId = set.id
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: waiterBId, venueId } },
      data: { permissionSetId },
    })

    // (a) Rol por defecto: MANAGER, VIEWER y OWNER. En OWNER, resolver las dependencias a un solo
    // nivel ya da una lista distinta (medido): por eso no se usa resolveStaffVenuePermissions.
    const casos: Array<[string, string]> = [
      ['MANAGER por defecto', staffId],
      ['VIEWER por defecto', viewerId],
      ['OWNER por defecto', owner.id],
      ['WAITER con override y exclusiones', waiterAId],
      ['Conjunto de permisos', waiterBId],
    ]
    for (const [caso, id] of casos) {
      const access = await getUserAccess(id, venueId)
      const antes = await grantedPermissionsBeforeActivation(id, venueId, access.role)
      expect({ caso, permisos: [...antes].sort() }).toEqual({ caso, permisos: [...access.corePermissions].sort() })
    }

    // Las premisas de cada caso sí se aplicaron (si no, la igualdad no probaría nada).
    const waiterA = await grantedPermissionsBeforeActivation(waiterAId, venueId, 'WAITER')
    expect(waiterA).toContain('inventory:log-waste') // de fábrica
    expect(waiterA).toContain('reports:read') // la adición del override
    expect(waiterA).not.toContain('reviews:read') // la exclusión del override
    const conjunto = await grantedPermissionsBeforeActivation(waiterBId, venueId, 'WAITER')
    expect(conjunto).toContain('inventory:log-waste')
    expect(conjunto).not.toContain('orders:create')
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: waiterBId, venueId } }, data: { permissionSetId: null } })
    if (permissionSetId) await prisma.permissionSet.deleteMany({ where: { id: permissionSetId, venueId } })
    await prisma.venueRolePermission.deleteMany({ where: { venueId, role: 'WAITER' } })
    await prisma.staffVenue.deleteMany({ where: { staffId: owner.id } })
    await prisma.staff.deleteMany({ where: { id: owner.id } })
  }
})

test('🔴 requireWasteActivation (paso previo HTTP, Ruling 18) mira acceso, cuenta y activación, NUNCA el permiso', async () => {
  // Sin white-label: el VIEWER no tiene log-waste, pero la activación no lo evalúa — eso le toca a
  // checkPermission, que es la única autoridad que respeta el PIN de gerente.
  await expect(requireWasteActivation(viewerId, venueId)).resolves.toMatchObject({ role: 'VIEWER' })
  await expect(requireWastePermission(viewerId, venueId, 'inventory:log-waste')).rejects.toMatchObject({
    statusCode: 403,
    code: 'WASTE_PERMISSION_DENIED',
  })
  // Con permiso, el camino completo (el del MCP) pasa.
  await expect(requireWastePermission(waiterAId, venueId, 'inventory:log-waste')).resolves.toMatchObject({ role: 'WAITER' })

  // Sin acceso al venue.
  await expect(requireWasteActivation(outsiderId, venueId)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_ACCESS_REVOKED' })

  // Cuenta dada de baja con la membresía todavía activa.
  await prisma.staff.update({ where: { id: waiterBId }, data: { active: false } })
  try {
    await expect(requireWasteActivation(waiterBId, venueId)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_ACCOUNT_INACTIVE' })
    await expect(requireWastePermission(waiterBId, venueId, 'inventory:log-waste')).rejects.toMatchObject({
      statusCode: 403,
      code: 'WASTE_ACCOUNT_INACTIVE',
    })
  } finally {
    await prisma.staff.update({ where: { id: waiterBId }, data: { active: true } })
  }
})

test('anular cierra folios aunque el white-label apague el inventario; permisos y privacidad se respetan', async () => {
  const item = await product(5)
  const byManager = await logWaste(venueId, staffId, request('PRODUCT', item.id, 2))
  const byWaiter = await logWaste(venueId, waiterAId, request('PRODUCT', item.id, 1))
  const managerReport = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: byManager.reportId } })
  const waiterReport = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: byWaiter.reportId } })

  const previousModule = await prisma.module.findUnique({ where: { code: 'WHITE_LABEL_DASHBOARD' } })
  const module = await prisma.module.upsert({
    where: { code: 'WHITE_LABEL_DASHBOARD' },
    update: {},
    create: { code: 'WHITE_LABEL_DASHBOARD', name: 'White label', defaultConfig: {} },
  })
  let permissionSetId: string | undefined

  try {
    // White-label ENCENDIDO y sin AVOQADO_INVENTORY entre sus funciones: el inventario queda apagado.
    await prisma.venueModule.create({
      data: { venueId, moduleId: module.id, enabled: true, enabledBy: staffId, config: { enabledFeatures: [] } },
    })

    // Premisa: la lista filtrada ya no concede inventario a nadie…
    const filtered = await getWasteAccess(staffId, venueId)
    expect(filtered.whiteLabelEnabled).toBe(true)
    expect(hasWastePermission(filtered, 'inventory:adjust')).toBe(false)
    expect(hasWastePermission(await getWasteAccess(waiterAId, venueId), 'inventory:log-waste')).toBe(false)
    // …y la LISTA que leen el dashboard y las apps tampoco trae log-waste (PERMISSION_TO_FEATURE_MAP
    // la filtra con AVOQADO_INVENTORY): el botón no se pinta para ninguno de los dos.
    expect(filtered.corePermissions).not.toContain('inventory:log-waste')
    expect((await getWasteAccess(waiterAId, venueId)).corePermissions).not.toContain('inventory:log-waste')
    // …y registrar una merma NUEVA sigue exigiendo la activación: eso no cambia.
    await expect(requireWastePermission(waiterAId, venueId, 'inventory:log-waste')).rejects.toMatchObject({
      statusCode: 403,
      code: 'WASTE_INVENTORY_DISABLED',
    })
    // …y el paso previo de las rutas HTTP (Ruling 18) corta ANTES de checkPermission: el PIN de gerente no se quema.
    await expect(requireWasteActivation(waiterAId, venueId)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_INVENTORY_DISABLED' })
    await expect(requireWasteActivation(staffId, venueId)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_INVENTORY_DISABLED' })

    // Anular sí: el gerente y el mesero cierran folios pendientes.
    await expect(voidWasteKey(venueId, staffId, randomUUID())).resolves.toMatchObject({ outcome: 'VOIDED', voidedByStaffId: staffId })
    await expect(voidWasteKey(venueId, waiterAId, randomUUID())).resolves.toMatchObject({ outcome: 'VOIDED', voidedByStaffId: waiterAId })

    // Privacidad: el mesero no ve el resumen ajeno; el gerente sí (inventory:adjust CONCEDIDO, aunque filtrado).
    await expect(voidWasteKey(venueId, waiterAId, managerReport.idempotencyKey)).resolves.toStrictEqual({ outcome: 'ALREADY_APPLIED' })
    await expect(voidWasteKey(venueId, staffId, waiterReport.idempotencyKey)).resolves.toStrictEqual({
      outcome: 'ALREADY_APPLIED',
      report: byWaiter,
    })

    // Sin nada concedido sigue el 403 sin lápida: el VIEWER, y un mesero con un Conjunto vacío.
    const viewerKey = randomUUID()
    await expect(voidWasteKey(venueId, viewerId, viewerKey)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_PERMISSION_DENIED' })
    const set = await prisma.permissionSet.create({ data: { venueId, name: `Sin permisos ${randomUUID()}`, permissions: [] } })
    permissionSetId = set.id
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: waiterAId, venueId } }, data: { permissionSetId } })
    const deniedKey = randomUUID()
    await expect(voidWasteKey(venueId, waiterAId, deniedKey)).rejects.toMatchObject({ statusCode: 403, code: 'WASTE_PERMISSION_DENIED' })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId, idempotencyKey: { in: [viewerKey, deniedKey] } } })).toBe(0)

    // Anular no movió existencia: 5 − 2 − 1, y sólo los dos movimientos de las mermas.
    expect(await productStock(item.id)).toBe('2')
    expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId } } })).toBe(2)
    expect(await prisma.inventoryWasteReport.count({ where: { venueId, status: 'VOIDED' } })).toBe(2)
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: waiterAId, venueId } }, data: { permissionSetId: null } })
    if (permissionSetId) await prisma.permissionSet.deleteMany({ where: { id: permissionSetId, venueId } })
    await prisma.venueModule.deleteMany({ where: { venueId, moduleId: module.id } })
    if (!previousModule) {
      await prisma.module.deleteMany({ where: { id: module.id, venueModules: { none: {} }, organizationModules: { none: {} } } })
    }
  }
})

test('🔴 white-label CON AVOQADO_INVENTORY conserva inventory:log-waste para los roles que su config permite', async () => {
  const previousModule = await prisma.module.findUnique({ where: { code: 'WHITE_LABEL_DASHBOARD' } })
  const module = await prisma.module.upsert({
    where: { code: 'WHITE_LABEL_DASHBOARD' },
    update: {},
    create: { code: 'WHITE_LABEL_DASHBOARD', name: 'White label', defaultConfig: {} },
  })

  try {
    // Inventario ACTIVADO en la config white-label y abierto al mesero. El plan (INVENTORY_TRACKING)
    // NO está: este venue no lo tiene, y no debe importar para el filtro de la lista (spec §4.4).
    expect(await venueHasFeatureAccess(venueId, 'INVENTORY_TRACKING')).toBe(false)
    await prisma.venueModule.create({
      data: {
        venueId,
        moduleId: module.id,
        enabled: true,
        enabledBy: staffId,
        config: {
          enabledFeatures: [
            { code: 'AVOQADO_INVENTORY', source: 'avoqado', access: { allowedRoles: ['MANAGER', 'WAITER'], dataScope: 'user-venues' } },
          ],
        },
      },
    })

    const waiter = await getWasteAccess(waiterAId, venueId)
    expect(waiter.whiteLabelEnabled).toBe(true)
    expect(waiter.corePermissions).toContain('inventory:log-waste')
    expect(waiter.corePermissions).not.toContain('inventory:adjust')
    await expect(requireWastePermission(waiterAId, venueId, 'inventory:log-waste')).resolves.toMatchObject({ userId: waiterAId })

    // Misma función SIN `access` en la config: el default white-label (OWNER/ADMIN/MANAGER) deja al
    // gerente y le quita el botón al mesero. Hay que abrírselo en la config, no en el rol.
    await prisma.venueModule.updateMany({
      where: { venueId, moduleId: module.id },
      data: { config: { enabledFeatures: [{ code: 'AVOQADO_INVENTORY', source: 'avoqado' }] } },
    })
    expect((await getWasteAccess(staffId, venueId)).corePermissions).toContain('inventory:log-waste')
    expect((await getWasteAccess(waiterAId, venueId)).corePermissions).not.toContain('inventory:log-waste')
  } finally {
    await prisma.venueModule.deleteMany({ where: { venueId, moduleId: module.id } })
    if (!previousModule) {
      await prisma.module.deleteMany({ where: { id: module.id, venueModules: { none: {} }, organizationModules: { none: {} } } })
    }
  }
})

// ─── Auditoría Codex #1 · P2-3 (Ruling 13): una merma no impide limpiar el live demo ───────

test.each([null, 'OTRO_VENUE', 'MISMO_DEMO'] as const)(
  'limpieza del live demo con merma y lápida; historia protegida ajena a la merma=%s',
  async externalProvenance => {
    const suffix = randomUUID()
    const demoEmail = `demo-${suffix}@example.test`
    let demoStaffId: string | undefined
    let demoVenueId: string | undefined

    try {
      demoStaffId = (await prisma.staff.create({ data: { email: demoEmail, firstName: 'Demo', lastName: 'Merma', active: true } })).id
      demoVenueId = (
        await prisma.venue.create({
          data: {
            organizationId,
            name: `Demo ${suffix}`,
            slug: `demo-${suffix}`,
            status: 'LIVE_DEMO',
            timezone: 'America/Mexico_City',
            currency: 'MXN',
          },
        })
      ).id
      await prisma.staffVenue.create({ data: { staffId: demoStaffId, venueId: demoVenueId, role: 'OWNER', active: true } })
      const category = await prisma.menuCategory.create({ data: { venueId: demoVenueId, name: 'Demo', slug: `categoria-${suffix}` } })
      const item = await prisma.product.create({
        data: {
          venueId: demoVenueId,
          categoryId: category.id,
          name: 'Producto demo',
          sku: randomUUID(),
          price: D(100),
          cost: D(10),
          unit: 'UNIT',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { create: { venueId: demoVenueId, currentStock: D(5) } },
        },
      })
      const session = await prisma.liveDemoSession.create({
        data: { sessionId: randomUUID(), venueId: demoVenueId, staffId: demoStaffId, expiresAt: new Date(Date.now() - 60_000) },
      })

      // El visitante del demo registra una merma y anula otro folio: dos folios, dos auditorías.
      await logWaste(demoVenueId, demoStaffId, request('PRODUCT', item.id, 2))
      await voidWasteKey(demoVenueId, demoStaffId, randomUUID())
      expect(await prisma.inventoryWasteReport.count({ where: { venueId: demoVenueId } })).toBe(2)
      expect(await prisma.activityLog.count({ where: { venueId: demoVenueId } })).toBe(2)

      if (externalProvenance) {
        // La misma persona tiene OTRA historia protegida —en otro venue, o en el propio demo pero
        // que no es merma—: eso sigue impidiendo borrarla. La purga sólo alcanza a la merma.
        const whereVenue = externalProvenance === 'OTRO_VENUE' ? venueId : demoVenueId
        await prisma.activityLog.create({
          data: {
            staffId: demoStaffId,
            actorStaffId: demoStaffId,
            actorType: 'HUMAN',
            organizationId,
            venueId: whereVenue,
            action: 'EXTERNAL_PROTECTED_EVENT',
            entity: 'Venue',
            entityId: whereVenue,
            data: {},
          },
        })

        await expect(deleteDisposableDemoSession(session)).rejects.toMatchObject({ code: 'LIVE_DEMO_STAFF_HAS_H1_PROVENANCE' })

        // El rechazo revierte también la purga de la merma.
        expect(await prisma.inventoryWasteReport.count({ where: { venueId: demoVenueId } })).toBe(2)
        expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId: demoVenueId } } })).toBe(1)
        expect(
          await prisma.activityLog.count({
            where: { venueId: demoVenueId, action: { in: ['INVENTORY_WASTE_LOGGED', 'INVENTORY_WASTE_VOIDED'] } },
          }),
        ).toBe(2)
        expect(
          await prisma.activityLog.count({ where: { venueId: whereVenue, actorStaffId: demoStaffId, action: 'EXTERNAL_PROTECTED_EVENT' } }),
        ).toBe(1)
        expect(await prisma.staff.findUnique({ where: { id: demoStaffId } })).toMatchObject({ active: true, email: demoEmail })
        expect(await prisma.venue.count({ where: { id: demoVenueId } })).toBe(1)
        expect(await prisma.liveDemoSession.count({ where: { id: session.id } })).toBe(1)
      } else {
        // Otra persona también registró merma en el demo: su folio muere con el venue, pero su
        // AUDITORÍA no es del visitante y se conserva, como todo ActivityLog de un venue borrado.
        await prisma.staffVenue.create({ data: { staffId, venueId: demoVenueId, role: 'MANAGER', active: true } })
        const ajena = await logWaste(demoVenueId, staffId, request('PRODUCT', item.id, 1))

        await expect(deleteDisposableDemoSession(session)).resolves.toBeGreaterThan(0)

        expect(await prisma.venue.findUnique({ where: { id: demoVenueId } })).toBeNull()
        expect(await prisma.staff.findUnique({ where: { id: demoStaffId } })).toBeNull()
        expect(await prisma.inventoryWasteReport.count({ where: { venueId: demoVenueId } })).toBe(0)
        expect(await prisma.inventoryMovement.count({ where: { inventory: { venueId: demoVenueId } } })).toBe(0)
        expect(await prisma.activityLog.count({ where: { venueId: demoVenueId, actorStaffId: demoStaffId } })).toBe(0)
        expect(await prisma.activityLog.count({ where: { venueId: demoVenueId, actorStaffId: staffId, entityId: ajena.reportId } })).toBe(1)
        expect(await prisma.staff.count({ where: { id: staffId } })).toBe(1)
        expect(await prisma.liveDemoSession.count({ where: { id: session.id } })).toBe(0)
      }
    } finally {
      if (demoStaffId) await prisma.activityLog.deleteMany({ where: { actorStaffId: demoStaffId } })
      if (demoVenueId) {
        await prisma.activityLog.deleteMany({ where: { venueId: demoVenueId } })
        await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: demoVenueId } } })
        await prisma.inventoryWasteReport.deleteMany({ where: { venueId: demoVenueId } })
        await prisma.inventory.deleteMany({ where: { venueId: demoVenueId } })
        await prisma.product.deleteMany({ where: { venueId: demoVenueId } })
        await prisma.menuCategory.deleteMany({ where: { venueId: demoVenueId } })
        await prisma.venue.deleteMany({ where: { id: demoVenueId, status: 'LIVE_DEMO' } })
      }
      if (demoStaffId) await prisma.staff.deleteMany({ where: { id: demoStaffId } })
    }
  },
)

// ── Lectores (Task 9a): catálogo que baja el aparato, totales, desglose y lista de folios ──
// Merma = declaración de cada folio APPLIED + |movimiento| SPOILAGE/LOSS SIN folio (legacy y
// cron), cada término agregado por su cuenta: un folio NUNCA se une a sus movimientos hijos.

test('🔴 los totales no se multiplican: 2 movimientos hijos + sin existencia cuentan UNA vez', async () => {
  const item = await raw(3)
  await batch(item.id, 2, 2, new Date('2026-01-01T00:00:00Z'))
  await batch(item.id, 1, 4, new Date('2026-02-01T00:00:00Z'))
  await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 5)) // 3 por lotes + 2 sin existencia

  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.quantity.toString()).toBe('5')
  expect(totals.cost?.toString()).toBe('8')
  expect(totals.unvaluedQuantity.toString()).toBe('2')
})

test('una merma legacy (movimiento SPOILAGE sin reporte) cuenta una vez, en positivo', async () => {
  const item = await raw(10)
  await prisma.rawMaterialMovement.create({
    data: {
      venueId,
      rawMaterialId: item.id,
      type: 'SPOILAGE',
      quantity: D(-4),
      unit: 'PIECE',
      previousStock: D(10),
      newStock: D(6),
      costImpact: D(-12),
      reason: 'Expired',
    },
  })
  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.quantity.toString()).toBe('4')
  expect(totals.cost?.toString()).toBe('12')
})

test('los productos (LOSS) entran en los totales', async () => {
  const item = await product(10, 10)
  await logWaste(venueId, staffId, request('PRODUCT', item.id, 3))
  const totals = await getWasteTotals(venueId, from, to, { itemType: 'PRODUCT', itemId: item.id })
  expect(totals.quantity.toString()).toBe('3')
  expect(totals.cost?.toString()).toBe('30')
})

test('🔴 el catálogo pagina con total, respeta el tope y no trae existencias', async () => {
  for (let i = 0; i < 3; i++) await product(5)
  const pagina = await listWasteItems(venueId, { page: 1, pageSize: 2 })
  expect(pagina.total).toBe(3)
  expect(pagina.items).toHaveLength(2)
  expect(Object.keys(pagina.items[0]).sort()).toEqual(['itemId', 'itemType', 'name', 'sku', 'unit'])
  expect((await listWasteItems(venueId, { page: 1, pageSize: 100000 })).pageSize).toBe(200)
})

test('🔴 el catálogo filtra por tipo ANTES de paginar: total y página cuentan sólo ese tipo', async () => {
  // El MCP busca «por nombre» con itemType: si el tipo se filtrara después de paginar, una primera
  // página llena de insumos dejaría fuera al único producto que coincide.
  const tag = randomUUID().slice(0, 8)
  for (let i = 0; i < 3; i++) {
    await prisma.rawMaterial.create({
      data: {
        venueId,
        name: `Leche ${tag} insumo ${i}`,
        sku: randomUUID(),
        category: 'OTHER',
        unit: 'PIECE',
        unitType: 'COUNT',
        currentStock: D(1),
        minimumStock: D(0),
        reorderPoint: D(0),
        costPerUnit: D(1),
        avgCostPerUnit: D(1),
        notifyOnLowStock: false,
      },
    })
  }
  const goods = await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Leche ${tag} producto`,
      sku: randomUUID(),
      price: D(10),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId, currentStock: D(1) } },
    },
  })

  const products = await listWasteItems(venueId, { page: 1, pageSize: 2, search: `Leche ${tag}`, itemType: 'PRODUCT' })
  expect(products.total).toBe(1)
  expect(products.items.map(row => row.itemId)).toEqual([goods.id])

  const rawOnly = await listWasteItems(venueId, { page: 1, pageSize: 2, search: `Leche ${tag}`, itemType: 'RAW_MATERIAL' })
  expect(rawOnly.total).toBe(3)
  expect(rawOnly.items.every(row => row.itemType === 'RAW_MATERIAL')).toBe(true)

  // Sin tipo, como siempre: los cuatro.
  expect((await listWasteItems(venueId, { page: 1, pageSize: 2, search: `Leche ${tag}` })).total).toBe(4)
})

test('un costo desconocido NO es cero: va a «sin valorar», y sin ningún costo conocido el total es null', async () => {
  // Legacy sin costo: ingrediente con costImpact null y producto con unitCost null.
  const legacyRaw = await raw(10)
  await prisma.rawMaterialMovement.create({
    data: {
      venueId,
      rawMaterialId: legacyRaw.id,
      type: 'SPOILAGE',
      quantity: D(-3),
      unit: 'PIECE',
      previousStock: D(10),
      newStock: D(7),
      costImpact: null,
      reason: 'Legacy sin costo',
    },
  })
  const legacyProduct = await product(10, 10)
  await prisma.inventoryMovement.createMany({
    data: [
      { inventoryId: legacyProduct.inventory!.id, type: 'LOSS', quantity: D(-2), previousStock: D(10), newStock: D(8), unitCost: null },
      { inventoryId: legacyProduct.inventory!.id, type: 'LOSS', quantity: D(-2), previousStock: D(8), newStock: D(6), unitCost: D(7) },
    ],
  })
  // Folios de producto: sin costo (UNKNOWN) y con costo pero parcial (PARTIAL: 3 de 5).
  const noCost = await product(5, null)
  await logWaste(venueId, staffId, request('PRODUCT', noCost.id, 2))
  const partial = await product(3, 10)
  await logWaste(venueId, staffId, request('PRODUCT', partial.id, 5))

  const totals = await getWasteTotals(venueId, from, to)
  // 3 + (2 + 2) + 2 + 5 declarados; costo conocido: 2 × 7 legacy + 3 × 10 del parcial.
  expect(totals.quantity.toString()).toBe('14')
  expect(totals.cost?.toString()).toBe('44')
  // Sin valorar: 3 (legacy ingrediente) + 2 (legacy producto sin costo) + 2 (UNKNOWN) + 2 (lo no descontado del parcial).
  expect(totals.unvaluedQuantity.toString()).toBe('9')

  const onlyUnknown = await getWasteTotals(venueId, from, to, { itemType: 'RAW_MATERIAL', itemId: legacyRaw.id })
  expect(onlyUnknown.quantity.toString()).toBe('3')
  expect(onlyUnknown.cost).toBeNull()
  expect(onlyUnknown.unvaluedQuantity.toString()).toBe('3')

  const unknownReport = await getWasteTotals(venueId, from, to, { itemType: 'PRODUCT', itemId: noCost.id })
  expect(unknownReport.cost).toBeNull()
  expect(unknownReport.unvaluedQuantity.toString()).toBe('2')

  const empty = await getWasteTotals(venueId, from, to, { itemType: 'PRODUCT', itemId: randomUUID() })
  expect(empty.quantity.toString()).toBe('0')
  expect(empty.cost).toBeNull()
  expect(empty.unvaluedQuantity.toString()).toBe('0')
})

test('la ventana compara en UTC real: el borde entra y lo de afuera no, en folios y en legacy', async () => {
  const item = await raw(10)
  const legacyAt = new Date('2026-03-10T12:00:00.000Z')
  await prisma.rawMaterialMovement.create({
    data: {
      venueId,
      rawMaterialId: item.id,
      type: 'SPOILAGE',
      quantity: D(-4),
      unit: 'PIECE',
      previousStock: D(10),
      newStock: D(6),
      costImpact: D(-4),
      reason: 'Legacy',
      createdAt: legacyAt,
    },
  })
  const goods = await product(5, 10)
  const report = await logWaste(venueId, staffId, request('PRODUCT', goods.id, 1))
  const reportAt = new Date('2026-03-10T12:30:00.000Z')
  await prisma.inventoryWasteReport.update({ where: { id: report.reportId }, data: { createdAt: reportAt } })

  const at = (iso: string) => new Date(iso)
  const quantity = async (start: Date, end: Date) => (await getWasteTotals(venueId, start, end)).quantity.toString()

  expect(await quantity(at('2026-03-10T11:00:00.000Z'), at('2026-03-10T13:00:00.000Z'))).toBe('5')
  expect(await quantity(legacyAt, legacyAt)).toBe('4')
  expect(await quantity(reportAt, reportAt)).toBe('1')
  expect(await quantity(at('2026-03-10T12:00:00.001Z'), at('2026-03-10T12:29:59.999Z'))).toBe('0')
  await expect(getWasteTotals(venueId, new Date('no es fecha'), to)).rejects.toMatchObject({ statusCode: 422 })

  // 🔴 La misma ventana bajo la zona de sesión LOCAL (México) y la de PRODUCCIÓN (UTC): con un
  // `Date` pelón en vez de utcTs, México corre el filtro seis horas y estos bordes cambian.
  const ledgerQuantityUnder = (zone: string, start: Date, end: Date) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
      const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>(
        Prisma.sql`SELECT COALESCE(SUM(quantity), 0) AS quantity FROM (${wasteLedgerSql(venueId, start, end)}) ledger`,
      )
      return rows[0].quantity.toString()
    })
  for (const zone of ['America/Mexico_City', 'UTC']) {
    expect(await ledgerQuantityUnder(zone, legacyAt, legacyAt)).toBe('4')
    expect(await ledgerQuantityUnder(zone, reportAt, reportAt)).toBe('1')
    expect(await ledgerQuantityUnder(zone, at('2026-03-10T12:00:00.001Z'), at('2026-03-10T12:29:59.999Z'))).toBe('0')
    expect(await ledgerQuantityUnder(zone, at('2026-03-10T12:30:00.001Z'), at('2026-03-10T13:00:00.000Z'))).toBe('0')
    expect(await ledgerQuantityUnder(zone, at('2026-03-10T11:00:00.000Z'), at('2026-03-10T11:59:59.999Z'))).toBe('0')
  }
})

test('🔴 la rama legacy de PRODUCTOS (LATERAL, T9c) respeta los dos bordes de la ventana en las dos zonas', async () => {
  const goods = await product(10, 10)
  const lossAt = new Date('2026-04-02T18:00:00.000Z')
  await prisma.inventoryMovement.create({
    data: {
      inventoryId: goods.inventory!.id,
      type: 'LOSS',
      quantity: D(-3),
      previousStock: D(10),
      newStock: D(7),
      unitCost: D(10),
      createdAt: lossAt,
    },
  })
  const at = (iso: string) => new Date(iso)
  const quantityUnder = (zone: string, start: Date, end: Date) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
      const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>(
        Prisma.sql`SELECT COALESCE(SUM(quantity), 0) AS quantity FROM (${wasteLedgerSql(venueId, start, end)}) ledger`,
      )
      return rows[0].quantity.toString()
    })
  for (const zone of ['America/Mexico_City', 'UTC']) {
    expect(await quantityUnder(zone, lossAt, lossAt)).toBe('3') // los dos bordes son inclusivos
    expect(await quantityUnder(zone, at('2026-04-02T12:00:00.000Z'), at('2026-04-02T17:59:59.999Z'))).toBe('0') // termina antes
    expect(await quantityUnder(zone, at('2026-04-02T18:00:00.001Z'), at('2026-04-03T00:00:00.000Z'))).toBe('0') // empieza después
  }
  const totals = await getWasteTotals(venueId, at('2026-04-02T00:00:00.000Z'), lossAt)
  expect(totals.quantity.toString()).toBe('3')
  expect(totals.cost?.toString()).toBe('30')
  expect((await getWasteTotals(venueId, at('2026-04-02T00:00:00.000Z'), at('2026-04-02T17:59:59.999Z'))).quantity.toString()).toBe('0')
})

test('🔴 la rama legacy de PRODUCTOS sólo suma LOSS: una venta o un ajuste sin folio NO son merma', async () => {
  // El filtro `mv.type = 'LOSS'` del LATERAL es literal (lo exige el índice parcial): sin él, cada
  // venta y cada ajuste del producto entrarían a los totales como merma.
  const goods = await product(20, 10)
  const at = new Date('2026-05-05T15:00:00.000Z')
  const movement = (type: 'SALE' | 'ADJUSTMENT' | 'LOSS', quantity: number, previous: number) => ({
    inventoryId: goods.inventory!.id,
    type,
    quantity: D(quantity),
    previousStock: D(previous),
    newStock: D(previous + quantity),
    unitCost: D(10),
    createdAt: at,
  })
  await prisma.inventoryMovement.createMany({
    data: [movement('SALE', -4, 20), movement('ADJUSTMENT', -2, 16), movement('LOSS', -1, 14)],
  })

  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.quantity.toString()).toBe('1') // sólo la LOSS
  expect(totals.cost?.toString()).toBe('10')
  expect(totals.unvaluedQuantity.toString()).toBe('0')
  const breakdown = await getWasteBreakdown(venueId, from, to)
  expect(breakdown.total).toBe(1)
  expect(breakdown.items[0].quantity.toString()).toBe('1')
})

test('el desglose agrupa por artículo sin multiplicar, trae el nombre y pagina con total', async () => {
  const ingredient = await raw(3)
  await batch(ingredient.id, 3, 2)
  await logWaste(venueId, staffId, request('RAW_MATERIAL', ingredient.id, 5)) // 3 por lote ($6) + 2 sin existencia
  await prisma.rawMaterialMovement.create({
    data: {
      venueId,
      rawMaterialId: ingredient.id,
      type: 'SPOILAGE',
      quantity: D(-1),
      unit: 'PIECE',
      previousStock: D(1),
      newStock: D(0),
      costImpact: D(-2),
      reason: 'Legacy',
    },
  })
  const goods = await product(10, 10)
  await logWaste(venueId, staffId, request('PRODUCT', goods.id, 3))

  const breakdown = await getWasteBreakdown(venueId, from, to)
  expect(breakdown.total).toBe(2)
  const byId = new Map(breakdown.items.map(row => [row.itemId, row]))
  expect(byId.get(ingredient.id)).toMatchObject({ itemType: 'RAW_MATERIAL', name: ingredient.name, unit: 'PIECE' })
  expect(byId.get(ingredient.id)?.quantity.toString()).toBe('6')
  expect(byId.get(ingredient.id)?.cost?.toString()).toBe('8')
  expect(byId.get(ingredient.id)?.unvaluedQuantity.toString()).toBe('2')
  expect(byId.get(goods.id)).toMatchObject({ itemType: 'PRODUCT', name: goods.name, unit: 'UNIT' })
  expect(byId.get(goods.id)?.quantity.toString()).toBe('3')
  expect(byId.get(goods.id)?.cost?.toString()).toBe('30')
  expect(byId.get(goods.id)?.unvaluedQuantity.toString()).toBe('0')

  const first = await getWasteBreakdown(venueId, from, to, 1, 0)
  const second = await getWasteBreakdown(venueId, from, to, 1, 1)
  expect(first).toMatchObject({ total: 2, limit: 1, offset: 0 })
  expect(first.items).toHaveLength(1)
  expect(second.items).toHaveLength(1)
  expect(new Set([first.items[0].itemId, second.items[0].itemId])).toEqual(new Set([ingredient.id, goods.id]))
  expect((await getWasteBreakdown(venueId, from, to, 100000, 0)).limit).toBe(200)
  expect((await getWasteBreakdown(venueId, from, to, 100, 0, { itemType: 'PRODUCT', itemId: goods.id })).total).toBe(1)
  await expect(getWasteBreakdown(venueId, from, to, 100, -1)).rejects.toMatchObject({ statusCode: 422 })
})

test('el catálogo sólo trae ingredientes activos y productos por cantidad, en orden estable, y busca en el servidor', async () => {
  const ingredient = await raw(1)
  const inactive = await raw(1)
  await prisma.rawMaterial.update({ where: { id: inactive.id }, data: { active: false } })
  const deleted = await raw(1)
  await prisma.rawMaterial.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
  const goods = await product(1)
  const deletedGoods = await product(1)
  await prisma.product.update({ where: { id: deletedGoods.id }, data: { deletedAt: new Date() } })
  const inactiveGoods = await product(1)
  await prisma.product.update({ where: { id: inactiveGoods.id }, data: { active: false } })
  const untracked = await product(1)
  await prisma.product.update({ where: { id: untracked.id }, data: { trackInventory: false } })
  const recipe = await product(1)
  await prisma.product.update({ where: { id: recipe.id }, data: { inventoryMethod: 'RECIPE' } })
  await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Sin inventario ${randomUUID()}`,
      sku: randomUUID(),
      price: D(10),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })

  const all = await listWasteItems(venueId, { page: 1, pageSize: 200 })
  expect(all.total).toBe(2)
  // «Ingrediente …» < «Producto …»: el orden es por nombre.
  expect(all.items).toEqual([
    { itemType: 'RAW_MATERIAL', itemId: ingredient.id, name: ingredient.name, sku: ingredient.sku, unit: 'PIECE' },
    { itemType: 'PRODUCT', itemId: goods.id, name: goods.name, sku: goods.sku, unit: 'UNIT' },
  ])

  expect((await listWasteItems(venueId, { page: 1, pageSize: 200, search: goods.sku })).items.map(row => row.itemId)).toEqual([goods.id])
  expect((await listWasteItems(venueId, { page: 1, pageSize: 200, search: 'iNgReDiEnTe' })).total).toBe(1)
  // Un comodín que teclea el usuario se busca literal, no como «todo».
  expect((await listWasteItems(venueId, { page: 1, pageSize: 200, search: '%' })).total).toBe(0)
  expect((await listWasteItems(venueId, { page: 1, pageSize: 200, search: '   ' })).total).toBe(2)

  const pageTwo = await listWasteItems(venueId, { page: 2, pageSize: 1 })
  expect(pageTwo).toMatchObject({ total: 2, page: 2, pageSize: 1 })
  expect(pageTwo.items.map(row => row.itemId)).toEqual([goods.id])
  expect((await listWasteItems(venueId, { page: 9, pageSize: 1 })).items).toEqual([])
  await expect(listWasteItems(venueId, { page: 0, pageSize: 1 })).rejects.toMatchObject({ statusCode: 422 })
})

test('🔴 empates de nombre: el catálogo desempata por id y tipo y ninguna página repite ni salta', async () => {
  const same = `Mismo nombre ${randomUUID()}`
  const a = await raw(1)
  const b = await raw(1)
  const c = await product(1)
  await prisma.rawMaterial.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { name: same } })
  await prisma.product.update({ where: { id: c.id }, data: { name: same } })

  const seen: string[] = []
  for (let page = 1; page <= 3; page++) {
    const result = await listWasteItems(venueId, { page, pageSize: 1 })
    expect(result.total).toBe(3)
    seen.push(...result.items.map(row => row.itemId))
  }
  expect(seen).toEqual([a.id, b.id, c.id].sort())
  expect((await listWasteItems(venueId, { page: 1, pageSize: 200 })).items.map(row => row.itemId)).toEqual(seen)
})

test('la lista de folios pagina con total, excluye lápidas, desempata por id, busca por artículo y acota fechas', async () => {
  const goods = await product(10)
  const empty = await raw(0)
  const r1 = await logWaste(venueId, staffId, request('PRODUCT', goods.id, 1))
  const r2 = await logWaste(venueId, staffId, request('PRODUCT', goods.id, 1))
  const r3 = await logWaste(venueId, staffId, request('RAW_MATERIAL', empty.id, 2)) // sin existencia
  await voidWasteKey(venueId, staffId, randomUUID()) // una lápida no es merma

  const tie = new Date('2026-03-10T12:00:00.000Z')
  const later = new Date('2026-03-10T13:00:00.000Z')
  await prisma.inventoryWasteReport.updateMany({ where: { id: { in: [r1.reportId, r2.reportId] } }, data: { createdAt: tie } })
  await prisma.inventoryWasteReport.update({ where: { id: r3.reportId }, data: { createdAt: later } })
  const tied = [r1.reportId, r2.reportId].sort().reverse()

  const first = await listWasteReports(venueId, { page: 1, pageSize: 2 })
  const second = await listWasteReports(venueId, { page: 2, pageSize: 2 })
  expect(first.total).toBe(3)
  expect(first.items.map(row => row.id)).toEqual([r3.reportId, tied[0]])
  expect(second.items.map(row => row.id)).toEqual([tied[1]])
  expect(first.items[0]).toMatchObject({
    itemType: 'RAW_MATERIAL',
    rawMaterialId: empty.id,
    reasonCode: 'OTHER',
    costState: 'NONE',
    reportedByStaffId: staffId,
    reportedByStaff: { firstName: 'Prueba', lastName: 'Merma' },
    rawMaterial: { name: empty.name, sku: empty.sku },
  })
  expect(first.items[0].declaredQuantity?.toString()).toBe('2')
  expect(first.items[0].unrecordedQuantity.toString()).toBe('2')
  expect(first.items[0]).not.toHaveProperty('payloadHash')
  expect((await listWasteReports(venueId, { page: 1, pageSize: 100000 })).pageSize).toBe(200)

  const search = await listWasteReports(venueId, { page: 1, pageSize: 100, search: empty.name.toUpperCase() })
  expect(search.items.map(row => row.id)).toEqual([r3.reportId])

  const window = await listWasteReports(venueId, {
    page: 1,
    pageSize: 100,
    startDate: '2026-03-10T06:00:00-06:00', // = 12:00 UTC: el borde entra
    endDate: '2026-03-10T12:59:59.999Z',
  })
  expect(window.total).toBe(2)
  expect(window.items.map(row => row.id).sort()).toEqual([r1.reportId, r2.reportId].sort())
  // Una fecha sin hora ni zona no dice de qué día local hablamos: se rechaza en vez de adivinar.
  await expect(listWasteReports(venueId, { page: 1, pageSize: 100, startDate: '2026-03-10' })).rejects.toMatchObject({
    statusCode: 422,
  })
})

test('🔴 la búsqueda de folios busca `%`, `_` y `\\` literales, no como comodines', async () => {
  const goods = await product(10)
  const ingredient = await raw(10)
  const r1 = await logWaste(venueId, staffId, request('PRODUCT', goods.id, 1))
  const r2 = await logWaste(venueId, staffId, request('RAW_MATERIAL', ingredient.id, 1))
  const search = async (term: string) =>
    (await listWasteReports(venueId, { page: 1, pageSize: 100, search: term })).items.map(row => row.id).sort()

  // Ningún nombre ni SKU contiene `%`, `_` ni `\`: un comodín sin escapar traería los dos folios.
  expect(await search('%')).toEqual([])
  expect(await search('_')).toEqual([])
  expect(await search('%%')).toEqual([])
  // Control positivo: el nombre real sigue encontrando su folio (sin distinguir mayúsculas).
  expect(await search(goods.name.toUpperCase())).toEqual([r1.reportId])
  expect(await search(ingredient.sku)).toEqual([r2.reportId])

  // Con los caracteres en el nombre, se encuentran LITERALES y sólo en ese folio.
  const label = `Salsa 100% casera_${randomUUID()}`
  await prisma.product.update({ where: { id: goods.id }, data: { name: label } })
  await prisma.rawMaterial.update({ where: { id: ingredient.id }, data: { name: `Ingrediente C:\\ruta ${randomUUID()}` } })
  expect(await search('%')).toEqual([r1.reportId])
  expect(await search('100% casera_')).toEqual([r1.reportId])
  expect(await search('_')).toEqual([r1.reportId])
  expect(await search('\\')).toEqual([r2.reportId])
  expect(await search('C:\\ruta')).toEqual([r2.reportId])
  // `1_0` con `_` como comodín encontraría «100»; literal, no.
  expect(await search('1_0')).toEqual([])
})

test('🔴 aislamiento: artículos, mermas y folios de OTRO venue no aparecen', async () => {
  const label = `otro-${fixture}`
  const other = await prisma.venue.create({
    data: { organizationId, name: label, slug: label, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  try {
    const otherCategory = await prisma.menuCategory.create({ data: { venueId: other.id, name: label, slug: label } })
    const foreignRaw = await prisma.rawMaterial.create({
      data: {
        venueId: other.id,
        name: `Ingrediente ajeno ${randomUUID()}`,
        sku: randomUUID(),
        category: 'OTHER',
        unit: 'PIECE',
        unitType: 'COUNT',
        currentStock: D(5),
        minimumStock: D(0),
        reorderPoint: D(0),
        costPerUnit: D(1),
        avgCostPerUnit: D(1),
        notifyOnLowStock: false,
      },
    })
    await prisma.stockBatch.create({
      data: {
        venueId: other.id,
        rawMaterialId: foreignRaw.id,
        batchNumber: randomUUID(),
        initialQuantity: D(5),
        remainingQuantity: D(5),
        unit: 'PIECE',
        costPerUnit: D(3),
        receivedDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    })
    const foreignProduct = await prisma.product.create({
      data: {
        venueId: other.id,
        categoryId: otherCategory.id,
        name: `Producto ajeno ${randomUUID()}`,
        sku: randomUUID(),
        price: D(100),
        cost: D(10),
        unit: 'UNIT',
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        inventory: { create: { venueId: other.id, currentStock: D(5) } },
      },
      include: { inventory: true },
    })
    await logWaste(other.id, staffId, request('RAW_MATERIAL', foreignRaw.id, 2)) // 2 × 3 = 6
    const foreignReport = await logWaste(other.id, staffId, request('PRODUCT', foreignProduct.id, 1)) // 10
    await prisma.rawMaterialMovement.create({
      data: {
        venueId: other.id,
        rawMaterialId: foreignRaw.id,
        type: 'SPOILAGE',
        quantity: D(-1),
        unit: 'PIECE',
        previousStock: D(3),
        newStock: D(2),
        costImpact: D(-3),
        reason: 'Legacy ajeno',
      },
    })
    await prisma.inventoryMovement.create({
      data: {
        inventoryId: foreignProduct.inventory!.id,
        type: 'LOSS',
        quantity: D(-1),
        previousStock: D(4),
        newStock: D(3),
        unitCost: D(5),
      },
    })

    const own = await product(5, 10)
    const ownReport = await logWaste(venueId, staffId, request('PRODUCT', own.id, 1))

    const catalog = await listWasteItems(venueId, { page: 1, pageSize: 200 })
    expect(catalog.total).toBe(1)
    expect(catalog.items.map(row => row.itemId)).toEqual([own.id])
    expect(await findWasteItem(venueId, 'RAW_MATERIAL', foreignRaw.id)).toBeNull()
    expect(await findWasteItem(venueId, 'PRODUCT', foreignProduct.id)).toBeNull()
    expect(await findWasteItem(venueId, 'PRODUCT', own.id)).toEqual({
      itemType: 'PRODUCT',
      itemId: own.id,
      name: own.name,
      sku: own.sku,
      unit: 'UNIT',
    })

    const totals = await getWasteTotals(venueId, from, to)
    expect(totals.quantity.toString()).toBe('1')
    expect(totals.cost?.toString()).toBe('10')
    const foreignFiltered = await getWasteTotals(venueId, from, to, { itemType: 'RAW_MATERIAL', itemId: foreignRaw.id })
    expect(foreignFiltered.quantity.toString()).toBe('0')
    expect((await getWasteBreakdown(venueId, from, to)).items.map(row => row.itemId)).toEqual([own.id])

    const list = await listWasteReports(venueId, { page: 1, pageSize: 200 })
    expect(list.items.map(row => row.id)).toEqual([ownReport.reportId])
    expect(list.items.map(row => row.id)).not.toContain(foreignReport.reportId)

    // Control positivo: el otro venue sí ve lo suyo (2 + 1 folios, 1 + 1 legacy).
    const foreignTotals = await getWasteTotals(other.id, from, to)
    expect(foreignTotals.quantity.toString()).toBe('5')
    expect(foreignTotals.cost?.toString()).toBe('24')
    expect((await listWasteItems(other.id, { page: 1, pageSize: 200 })).total).toBe(2)
    expect((await listWasteReports(other.id, { page: 1, pageSize: 200 })).total).toBe(2)
  } finally {
    await prisma.activityLog.deleteMany({ where: { venueId: other.id } })
    await prisma.rawMaterialMovement.deleteMany({ where: { venueId: other.id } })
    await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: other.id } } })
    await prisma.inventoryWasteReport.deleteMany({ where: { venueId: other.id } })
    await prisma.stockBatch.deleteMany({ where: { venueId: other.id } })
    await prisma.lowStockAlert.deleteMany({ where: { venueId: other.id } })
    await prisma.inventory.deleteMany({ where: { venueId: other.id } })
    await prisma.product.deleteMany({ where: { venueId: other.id } })
    await prisma.rawMaterial.deleteMany({ where: { venueId: other.id } })
    await prisma.menuCategory.deleteMany({ where: { venueId: other.id } })
    await prisma.venue.deleteMany({ where: { id: other.id, organizationId } })
  }
})

// ── Limitaciones aceptadas (spec §7, D6): L1, L3 y L4 ─────────────────────────────────────────
// La merma es una resta con motivo que se aplica AL LLEGAR; no se concilia contra conteos ni contra
// el cron de caducidad (tres diseños para conciliarlo fueron rechazados). L2, L5 y L6 no son de este
// servidor o no se prueban aquí: L2 es del conteo, L5 del aparato y L6 lo fija la ventana por createdAt.

// LIMITACIÓN ACEPTADA (spec §7, decisión D6 del founder, 21-sep-2026). Esta prueba no dice que
// el resultado sea deseable: FIJA el comportamiento para que cambiarlo sea una decisión y no un accidente.
test('L1: el conteo fija 8 y la merma tardía de 2 deja 6', async () => {
  const item = await product(10)
  // La merma OCURRIÓ antes del conteo (así lo dice el aparato), pero LLEGA después.
  const input = request('PRODUCT', item.id, 2, { clientOccurredAt: new Date('2026-01-01T00:00:00Z') })
  const count = await prisma.stockCount.create({
    data: {
      venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      createdById: staffId,
      items: { create: { productId: item.id, expected: D(10), counted: D(8), countedAt: new Date() } },
    },
  })

  await confirmStockCount(count.id, venueId, staffId, 0)
  expect(await productStock(item.id)).toBe('8')

  const result = await logWaste(venueId, staffId, input)
  expect(result).toMatchObject({ declared: '2', deducted: '2', unrecorded: '0' })
  expect(await productStock(item.id)).toBe('6')
})

// LIMITACIÓN ACEPTADA (spec §7, decisión D6 del founder, 21-sep-2026). Esta prueba no dice que
// el resultado sea deseable: FIJA el comportamiento para que cambiarlo sea una decisión y no un accidente.
test('L3: cron de 5 y declaración posterior sin stock suman 10', async () => {
  const item = await raw(5)
  await batch(item.id, 5, 2, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-02T00:00:00Z'))

  // El cron da de baja el lote vencido: la existencia queda en 0 y deja su SPOILAGE sin folio.
  expect(await markExpiredBatches(venueId)).toBe(1)
  expect(await rawStock(item.id)).toBe('0')

  // Alguien declara «Caducó» por lo mismo: ya no hay qué descontar, pero la declaración cuenta.
  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 5, { reasonCode: 'EXPIRED' }))
  expect(result).toMatchObject({ declared: '5', deducted: '0', unrecorded: '5' })
  expect(await rawStock(item.id)).toBe('0')

  const totals = await getWasteTotals(venueId, from, to)
  expect(totals.quantity.toString()).toBe('10') // 5 del cron + 5 declaradas: la misma pérdida, dos veces
  expect(totals.cost?.toString()).toBe('10') // sólo el cron tiene costo (5 × 2)
  expect(totals.unvaluedQuantity.toString()).toBe('5') // la declaración sin existencia no tiene costo
})

// LIMITACIÓN ACEPTADA (spec §7, decisión D6 del founder, 21-sep-2026). Esta prueba no dice que
// el resultado sea deseable: FIJA el comportamiento para que cambiarlo sea una decisión y no un accidente.
test('L4: merma antes de venta deja -3; venta antes deja 0 y 3 sin existencia', async () => {
  const first = await product(10)
  const second = await product(10)

  // Orden 1: merma de 5 y después venta de 8. La venta descuenta siempre, aunque quede negativa.
  const wasteFirst = await logWaste(venueId, staffId, request('PRODUCT', first.id, 5))
  await deductInventoryForProduct(venueId, first.id, 8, randomUUID(), staffId)

  // Orden 2: venta de 8 y después merma de 5. La merma se trunca en 0 y el resto queda sin existencia.
  await deductInventoryForProduct(venueId, second.id, 8, randomUUID(), staffId)
  const saleFirst = await logWaste(venueId, staffId, request('PRODUCT', second.id, 5))

  expect(wasteFirst).toMatchObject({ declared: '5', deducted: '5', unrecorded: '0' })
  expect(await productStock(first.id)).toBe('-3')
  expect(saleFirst).toMatchObject({ declared: '5', deducted: '2', unrecorded: '3' })
  expect(await productStock(second.id)).toBe('0')
})

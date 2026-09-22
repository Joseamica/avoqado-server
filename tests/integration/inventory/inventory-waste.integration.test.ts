import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { isWasteKeyCollision, logWaste, prepareWaste, recoverByKey, WasteInput } from '@/services/shared/inventoryWaste.service'

// Los lectores (getWasteTotals, listWasteReports), la anulación (voidWasteKey) y los
// choques con caducidad, conteo y venta entran con sus tareas; aquí sólo logWaste.
const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `waste-${randomUUID()}`

let organizationId = ''
let venueId = ''
let staffId = ''
let categoryId = ''

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
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
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
})

test('sin existencia persiste declaración sin inventar movimientos o costo', async () => {
  const item = await raw(0)
  const result = await logWaste(venueId, staffId, request('RAW_MATERIAL', item.id, 4))

  expect(result).toMatchObject({ declared: '4', deducted: '0', unrecorded: '4' })
  expect(await prisma.rawMaterialMovement.count({ where: { wasteReportId: result.reportId } })).toBe(0)

  const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: result.reportId } })
  expect(report.costState).toBe('NONE')
  expect(report.costImpact).toBeNull()
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
    reasonCode: 'SPOILED',
    unit: 'PIECE',
    declared: '2',
  })

  const productLog = await prisma.activityLog.findFirstOrThrow({ where: { venueId, entityId: productResult.reportId } })
  expect(productLog.data).toMatchObject({ itemType: 'PRODUCT', itemId: item.id, reasonCode: 'DROPPED', unit: 'UNIT', declared: '1' })
})

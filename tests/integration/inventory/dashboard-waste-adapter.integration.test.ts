/*
  tests/integration/inventory/dashboard-waste-adapter.integration.test.ts

  Tarea 10 — la merma del dashboard entra al MISMO libro que la del POS (spec §4.5 y §4.6).

  Las dos rutas `adjust-stock` del dashboard siguen con su contrato de siempre (lo fija
  dashboard-adjust-stock-contract.integration.test.ts), pero una merma (SPOILAGE/LOSS negativa) ya
  no escribe el movimiento suelto: pasa por `adaptDashboardWaste` → `logWaste`, que la guarda como
  folio, descuenta lo que haya y marca el excedente. Decisión del founder: la merma NUNCA se
  rechaza por existencia.

  🔴 UN SOLO candado de permiso (Rulings 18 y 20): el adaptador NO re-evalúa el permiso. Lo decide
  `checkPermission('inventory:adjust')` de la ruta (tests/api-tests/dashboard/adjust-stock-waste
  .api.test.ts), igual que en las rutas hermanas del dashboard.
*/
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { adaptDashboardWaste } from '@/services/shared/dashboardWasteAdapter'
import { adjustInventoryStock, getGlobalMovements } from '@/services/dashboard/productInventory.service'
import { fetchStockMovementsForExport } from '@/services/dashboard/rawMaterial.service'
import { voidWasteKey } from '@/services/shared/inventoryWaste.service'
import { validateRequest } from '@/middlewares/validation'
import { AdjustProductInventoryStockSchema, AdjustStockSchema } from '@/schemas/dashboard/inventory.schema'
import { adjustStock } from '@/controllers/dashboard/inventory/rawMaterial.controller'
import { adjustInventoryStockHandler } from '@/controllers/dashboard/productInventory.controller'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `waste-dash-${randomUUID()}`

let organizationId = ''
let venueId = ''
let otherVenueId = ''
let staffId = ''
let waiterId = ''
let categoryId = ''
let otherCategoryId = ''

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

async function clearInventory(): Promise<void> {
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
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Merma' },
  })
  staffId = staff.id
  const waiter = await prisma.staff.create({
    data: { email: `mesero-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Mesero' },
  })
  waiterId = waiter.id
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId, role: 'MANAGER', active: true },
      { staffId: waiterId, venueId, role: 'WAITER', active: true },
    ],
  })

  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })).id
  otherCategoryId = (await prisma.menuCategory.create({ data: { venueId: otherVenueId, name: fixture, slug: `${fixture}-otro` } })).id
})

beforeEach(clearInventory)

afterAll(async () => {
  assertTestDatabase()
  // El camino viejo (el principal sintético) audita con logAction sin esperar.
  await new Promise(resolve => setTimeout(resolve, 300))
  await clearInventory()
  await prisma.menuCategory.deleteMany({ where: { id: { in: [categoryId, otherCategoryId].filter(Boolean) } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: [venueId, otherVenueId].filter(Boolean) } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId].filter(Boolean) }, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.staff.deleteMany({ where: { id: { in: [staffId, waiterId].filter(Boolean) } } })
})

async function product(stock: string | number, cost: string | number | null = 10, venue = venueId, category = categoryId) {
  return prisma.product.create({
    data: {
      venueId: venue,
      categoryId: category,
      name: `Producto ${randomUUID()}`,
      sku: randomUUID(),
      price: D(100),
      cost: cost === null ? null : D(cost),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId: venue, currentStock: D(stock) } },
    },
    include: { inventory: true },
  })
}

async function raw(stock: string | number, over: Partial<Prisma.RawMaterialUncheckedCreateInput> = {}, venue = venueId) {
  return prisma.rawMaterial.create({
    data: {
      venueId: venue,
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
      ...over,
    },
  })
}

async function batch(
  rawMaterialId: string,
  quantity: number,
  cost: number,
  receivedDate = new Date('2026-01-01T00:00:00.000Z'),
  venue = venueId,
) {
  return prisma.stockBatch.create({
    data: {
      venueId: venue,
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

type Captured = { status: number; body: any; error: unknown }

/** Cadena real `validateRequest(schema) → controlador`; el cuerpo pasa por JSON como en `res.json`. */
async function call(
  schema: typeof AdjustStockSchema | typeof AdjustProductInventoryStockSchema,
  controller: (req: Request, res: Response, next: NextFunction) => unknown,
  params: Record<string, string>,
  body: unknown,
  userId: string = staffId,
): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined, error: undefined }
  const req = {
    params,
    body,
    query: {},
    correlationId: 'corr-merma',
    authContext: { userId, venueId, orgId: organizationId, role: 'MANAGER' },
  } as unknown as Request
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(payload: unknown) {
      captured.body = JSON.parse(JSON.stringify(payload))
      return this
    },
  } as unknown as Response
  let passed = false
  await validateRequest(schema)(req, res, (error?: unknown) => {
    if (error) captured.error = error
    else passed = true
  })
  if (!passed) return captured
  await controller(req, res, (error?: unknown) => {
    captured.error = error
  })
  return captured
}

/** Deja correr cualquier auditoría «fire-and-forget» antes de contar la bitácora. */
const flush = () => new Promise(resolve => setTimeout(resolve, 300))

describe('adaptDashboardWaste — el contrato viejo entra al libro de merma', () => {
  test('🔴 contrato viejo SIN motivo: entra como UNSPECIFIED y descuenta', async () => {
    const item = await product(10)
    const r = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -3 })
    expect(r).toMatchObject({ declared: '3', deducted: '3' })
    const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: r.reportId } })
    expect(report).toMatchObject({ reasonCode: 'UNSPECIFIED', source: 'DASHBOARD', note: null })
  })

  test('un motivo viejo de 400 caracteres se conserva íntegro en la nota', async () => {
    const item = await raw(10)
    await batch(item.id, 10, 1)
    const reason = 'x'.repeat(400)
    const r = await adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', item.id, { quantity: -1, reason })
    expect((await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: r.reportId } })).note).toBe(reason)
  })

  test('conserva reference, unitCost y supplier; el costo recibido manda sobre Product.cost', async () => {
    const item = await product(10, 5)
    const r = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, {
      quantity: -2,
      reasonCode: 'DEFECTIVE',
      reference: 'R-9',
      unitCost: 7.5,
      supplier: 'Proveedor X',
    })
    const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: r.reportId } })
    expect(report).toMatchObject({ reference: 'R-9', supplier: 'Proveedor X' })
    expect(report.unitCostSnapshot?.toString()).toBe('7.5')
    expect(report.costImpact?.toString()).toBe('15')
  })

  test('🔴 un costo recibido de 0 es un costo CONOCIDO, no «sin costo»', async () => {
    const item = await product(10, 5)
    const r = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, unitCost: 0 })
    const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: r.reportId } })
    expect(report.unitCostSnapshot?.toString()).toBe('0')
    expect(report.costImpact?.toString()).toBe('0')
    expect(report.costState).toBe('KNOWN')
  })

  test('🔴 más merma que existencia ya NO se rechaza desde el dashboard', async () => {
    const item = await product(1)
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -4 })).resolves.toMatchObject({
      deducted: '1',
      unrecorded: '3',
    })
    expect((await prisma.inventory.findFirstOrThrow({ where: { productId: item.id } })).currentStock.toString()).toBe('0')
  })

  test('🔴 ADJUSTMENT sigue rechazando llevar una existencia ≥ 0 a negativo', async () => {
    const item = await product(1)
    await expect(adjustInventoryStock(venueId, item.id, { type: 'ADJUSTMENT', quantity: -4 } as never, staffId)).rejects.toThrow(
      /Insufficient stock/,
    )
  })

  test('acepta la cantidad máxima del contrato viejo', async () => {
    const item = await product(0)
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -999999999.999 })).resolves.toMatchObject({
      declared: '999999999.999',
      deducted: '0',
    })
  })

  test('el folio del cuerpo hace idempotente el reintento: un solo reporte y un solo descuento', async () => {
    const item = await product(10)
    const idempotencyKey = randomUUID()
    const first = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })
    const again = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })
    expect(again).toEqual(first)
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
    expect((await prisma.inventory.findFirstOrThrow({ where: { productId: item.id } })).currentStock.toString()).toBe('8')
  })

  test('el reintento se reconoce aunque la unidad del artículo haya cambiado entre medio', async () => {
    const item = await product(10)
    const idempotencyKey = randomUUID()
    const first = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })
    await prisma.product.update({ where: { id: item.id }, data: { unit: 'KILOGRAM' } })
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })).resolves.toEqual(first)
  })

  test('un folio reutilizado con otra cantidad es 409 IDEMPOTENCY_KEY_REUSED, no un segundo descuento', async () => {
    const item = await product(10)
    const idempotencyKey = randomUUID()
    await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -3, idempotencyKey })).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    })
    expect((await prisma.inventory.findFirstOrThrow({ where: { productId: item.id } })).currentStock.toString()).toBe('8')
  })

  test('un folio anulado es 409 WASTE_VOIDED', async () => {
    const item = await product(10)
    const idempotencyKey = randomUUID()
    await voidWasteKey(venueId, staffId, idempotencyKey, 'DASHBOARD')
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2, idempotencyKey })).rejects.toMatchObject({
      statusCode: 409,
      code: 'WASTE_VOIDED',
    })
    expect((await prisma.inventory.findFirstOrThrow({ where: { productId: item.id } })).currentStock.toString()).toBe('10')
  })

  test('🔴 UN solo candado: el adaptador no re-evalúa el permiso (lo decide checkPermission de la ruta)', async () => {
    // El mesero NO trae inventory:adjust. Si el adaptador volviera a evaluar el permiso, rechazaría
    // aquí — y en HTTP gastaría el PIN de gerente que checkPermission ya aceptó (Ruling 18). La
    // prueba HTTP de la ruta demuestra que sin permiso ni PIN la petición no llega hasta aquí.
    const item = await product(10)
    await expect(adaptDashboardWaste(venueId, waiterId, 'PRODUCT', item.id, { quantity: -1 })).resolves.toMatchObject({ deducted: '1' })
  })

  test('sin autor humano el adaptador no inventa uno', async () => {
    const item = await product(10)
    await expect(adaptDashboardWaste(venueId, undefined, 'PRODUCT', item.id, { quantity: -1 })).rejects.toMatchObject({ statusCode: 401 })
    await expect(adaptDashboardWaste(venueId, MASTER_ADMIN_PRINCIPAL_ID, 'PRODUCT', item.id, { quantity: -1 })).rejects.toMatchObject({
      statusCode: 401,
    })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  })

  test('🔴 aislamiento: un artículo de OTRO venue es 404 y no se toca', async () => {
    const foreign = await raw(10, {}, otherVenueId)
    await batch(foreign.id, 10, 1, undefined, otherVenueId)
    await expect(adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', foreign.id, { quantity: -2 })).rejects.toMatchObject({
      statusCode: 404,
    })
    const foreignProduct = await product(10, 10, otherVenueId, otherCategoryId)
    await expect(adaptDashboardWaste(venueId, staffId, 'PRODUCT', foreignProduct.id, { quantity: -2 })).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId: { in: [venueId, otherVenueId] } } })).toBe(0)
    expect((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: foreign.id } })).currentStock.toString()).toBe('10')
  })
})

describe('las rutas del dashboard desvían la merma al libro', () => {
  test('🔴 insumo: SPOILAGE negativa crea el folio, respeta reasonCode/idempotencyKey y responde con `waste`', async () => {
    const item = await raw(10)
    await batch(item.id, 10, 1)
    const idempotencyKey = randomUUID()
    const r = await call(
      AdjustStockSchema,
      adjustStock,
      { venueId, rawMaterialId: item.id },
      {
        type: 'SPOILAGE',
        quantity: -12,
        reason: 'Caducaron',
        reasonCode: 'EXPIRED',
        idempotencyKey,
      },
    )

    expect(r.error).toBeUndefined()
    const report = await prisma.inventoryWasteReport.findFirstOrThrow({ where: { venueId } })
    expect(report).toMatchObject({
      idempotencyKey,
      reasonCode: 'EXPIRED',
      note: 'Caducaron',
      source: 'DASHBOARD',
      reportedByStaffId: staffId,
    })
    expect(r.body.waste).toEqual({ reportId: report.id, declared: '12', deducted: '10', unrecorded: '2' })
    expect(r.body.data.currentStock).toBe('0')
  })

  test('🔴 producto: LOSS negativa crea el folio y responde con `waste`', async () => {
    const item = await product(3)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'LOSS',
        quantity: -5,
        reasonCode: 'DROPPED',
      },
    )

    expect(r.error).toBeUndefined()
    const report = await prisma.inventoryWasteReport.findFirstOrThrow({ where: { venueId } })
    expect(r.body.waste).toEqual({ reportId: report.id, declared: '5', deducted: '3', unrecorded: '2' })
    expect(r.body.data).toMatchObject({ currentStock: 0 })
  })

  test('🔴 auditoría: UNA fila INVENTORY_WASTE_LOGGED por merma, sin el STOCK_ADJUSTED viejo duplicado', async () => {
    const rawItem = await raw(10)
    await batch(rawItem.id, 10, 1)
    const productItem = await product(10)
    await call(AdjustStockSchema, adjustStock, { venueId, rawMaterialId: rawItem.id }, { type: 'SPOILAGE', quantity: -1 })
    await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: productItem.id },
      {
        type: 'LOSS',
        quantity: -1,
      },
    )
    await flush()

    const logs = await prisma.activityLog.findMany({ where: { venueId }, select: { action: true, entity: true, staffId: true } })
    expect(logs).toHaveLength(2)
    expect(
      logs.every(log => log.action === 'INVENTORY_WASTE_LOGGED' && log.entity === 'InventoryWasteReport' && log.staffId === staffId),
    ).toBe(true)
  })

  test('la alerta de existencia baja se sigue creando como en el camino viejo', async () => {
    const item = await raw(6, { reorderPoint: D(5) })
    await batch(item.id, 6, 1)
    const r = await call(AdjustStockSchema, adjustStock, { venueId, rawMaterialId: item.id }, { type: 'SPOILAGE', quantity: -3 })

    expect(r.error).toBeUndefined()
    const alerts = await prisma.lowStockAlert.findMany({ where: { venueId, rawMaterialId: item.id } })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ status: 'ACTIVE', alertType: 'LOW_STOCK' })
    expect(alerts[0].currentLevel.toString()).toBe('3')
  })

  test('el acceso de emergencia (principal sintético, sin fila Staff) sigue por el camino de siempre', async () => {
    // `reportedByStaffId` es una llave a Staff: no hay autor que registrar y no se inventa uno.
    const item = await raw(10)
    await batch(item.id, 10, 1)
    const r = await call(
      AdjustStockSchema,
      adjustStock,
      { venueId, rawMaterialId: item.id },
      { type: 'SPOILAGE', quantity: -2 },
      MASTER_ADMIN_PRINCIPAL_ID,
    )

    expect(r.error).toBeUndefined()
    expect(Object.keys(r.body).sort()).toEqual(['data', 'message', 'success'])
    expect(r.body.data.currentStock).toBe('8')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
    const movements = await prisma.rawMaterialMovement.findMany({ where: { venueId, rawMaterialId: item.id } })
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({ type: 'SPOILAGE', wasteReportId: null })
  })

  test('un motivo inválido o un folio que no es UUID se rechaza con 400 en español', async () => {
    const item = await raw(10)
    const bad = await call(
      AdjustStockSchema,
      adjustStock,
      { venueId, rawMaterialId: item.id },
      {
        type: 'SPOILAGE',
        quantity: -1,
        reasonCode: 'NOPE',
      },
    )
    expect(bad.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('El motivo de la merma no es válido.') })
    const badKey = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: 'clproductoinexistente0001' },
      {
        type: 'LOSS',
        quantity: -1,
        idempotencyKey: 'no-es-uuid',
      },
    )
    expect(badKey.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('El folio (idempotencyKey) debe ser un UUID.') })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
  })

  test('null en los campos nuevos es «ausente», no un error', async () => {
    const item = await product(10)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'LOSS',
        quantity: -1,
        reasonCode: null,
        idempotencyKey: null,
      },
    )
    expect(r.error).toBeUndefined()
    expect(await prisma.inventoryWasteReport.findFirstOrThrow({ where: { venueId } })).toMatchObject({ reasonCode: 'UNSPECIFIED' })
  })
})

describe('Historial y export leen el folio y no inventan costo', () => {
  test('🔴 producto sin costo: totalCost null («sin valorar»), con motivo, folio y excedente', async () => {
    const item = await product(2, null)
    const r = await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -5, reasonCode: 'DEFECTIVE' })
    const { data } = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    const row = data.find(m => m.itemName === item.name)!
    expect(row).toMatchObject({
      type: 'LOSS',
      quantity: -2,
      totalCost: null,
      wasteReportId: r.reportId,
      wasteReasonCode: 'DEFECTIVE',
      wasteUnrecorded: 3,
    })
  })

  test('producto con costo congelado: totalCost = costo del folio × cantidad, con signo', async () => {
    const item = await product(10, 4)
    await adaptDashboardWaste(venueId, staffId, 'PRODUCT', item.id, { quantity: -2 })
    await prisma.product.update({ where: { id: item.id }, data: { cost: D(99) } })
    const { data } = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    // Con el costo ACTUAL (99) saldría −198: se usa el que congeló el folio.
    expect(data.find(m => m.itemName === item.name)).toMatchObject({ totalCost: -8, wasteUnrecorded: 0 })
  })

  test('🔴 insumo con varios lotes: cada renglón trae SU costo y el excedente del folio sale UNA vez', async () => {
    const item = await raw(5)
    await batch(item.id, 2, 3, new Date('2026-01-01T00:00:00.000Z'))
    await batch(item.id, 3, 4, new Date('2026-02-01T00:00:00.000Z'))
    const r = await adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', item.id, { quantity: -7 })
    const report = await prisma.inventoryWasteReport.findUniqueOrThrow({ where: { id: r.reportId } })

    const rows = (await getGlobalMovements(venueId, { page: 1, limit: 50 })).data.filter(m => m.itemName === item.name)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.wasteReportId === r.reportId && row.wasteReasonCode === 'UNSPECIFIED')).toBe(true)
    // El total del folio no se repite por cada movimiento hijo.
    expect(rows.map(row => row.wasteUnrecorded).sort()).toEqual([2, null].sort())
    const sum = rows.reduce((acc, row) => acc + (row.totalCost as number), 0)
    expect(sum).toBeCloseTo(-Number(report.costImpact))
    expect(sum).toBeCloseTo(-18)
  })

  test('🔴 insumo con existencia pero sin lotes: el ajuste directo sale «sin valorar», no costo actual × cantidad', async () => {
    const item = await raw(4, { costPerUnit: D(9) })
    const r = await adaptDashboardWaste(venueId, staffId, 'RAW_MATERIAL', item.id, { quantity: -3 })
    const row = (await getGlobalMovements(venueId, { page: 1, limit: 50 })).data.find(m => m.itemName === item.name)!
    expect(row).toMatchObject({ quantity: -3, totalCost: null, wasteReportId: r.reportId, wasteUnrecorded: 0 })

    // El export tiene el folio en la fila: la columna de costo puede distinguir «sin valorar» de 0.
    const exported = await fetchStockMovementsForExport(venueId, item.id, undefined, 100)
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({ wasteReportId: r.reportId, costImpact: null })
  })

  test('los movimientos que NO son merma quedan exactamente como hoy', async () => {
    const item = await product(10, 20)
    await adjustInventoryStock(venueId, item.id, { type: 'ADJUSTMENT', quantity: -2 } as never, staffId)
    const rawItem = await raw(10, { costPerUnit: D(3) })
    await prisma.rawMaterialMovement.create({
      data: {
        venueId,
        rawMaterialId: rawItem.id,
        type: 'SPOILAGE',
        quantity: D(-2),
        unit: 'PIECE',
        previousStock: D(10),
        newStock: D(8),
        costImpact: null,
        reason: 'Merma vieja, sin folio',
      },
    })
    const { data } = await getGlobalMovements(venueId, { page: 1, limit: 50 })
    expect(data.find(m => m.itemName === item.name)).toMatchObject({
      totalCost: -40,
      wasteReportId: null,
      wasteReasonCode: null,
      wasteUnrecorded: null,
    })
    // Una merma VIEJA (sin folio) sigue con la cuenta de siempre: costo actual × cantidad.
    expect(data.find(m => m.itemName === rawItem.name)).toMatchObject({ totalCost: -6, wasteReportId: null })
  })
})

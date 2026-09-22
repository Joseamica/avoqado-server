/*
  tests/integration/inventory/dashboard-adjust-stock-contract.integration.test.ts

  El CONTRATO de las dos rutas `adjust-stock` del dashboard (spec §4.5): la forma de la respuesta
  que el dashboard web recibe HOY, capturada contra Postgres real, con el middleware de validación
  real y los controladores reales. Se escribió y se corrió en verde ANTES de desviar la merma a
  `logWaste` (tarea 10) y se vuelve a correr después: si el desvío le quita o le renombra un campo
  a la respuesta, esta suite se pone roja.

  Lo único que el desvío puede AGREGAR es `waste` (el resumen del folio), y sólo en la merma.

  Este archivo no importa el adaptador a propósito: así pudo correr contra el código de antes.
*/
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { validateRequest } from '@/middlewares/validation'
import { AdjustProductInventoryStockSchema, AdjustStockSchema } from '@/schemas/dashboard/inventory.schema'
import { adjustStock } from '@/controllers/dashboard/inventory/rawMaterial.controller'
import { adjustInventoryStockHandler } from '@/controllers/dashboard/productInventory.controller'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `waste-contract-${randomUUID()}`

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
    data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Contrato' },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER', active: true } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
  categoryId = category.id
})

beforeEach(clearInventory)

afterAll(async () => {
  assertTestDatabase()
  // Las rutas viejas auditan con logAction sin esperar: se les da un momento antes de borrar.
  await new Promise(resolve => setTimeout(resolve, 300))
  await clearInventory()
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

async function product(stock: number) {
  return prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Producto ${randomUUID()}`,
      sku: randomUUID(),
      price: D(100),
      cost: D(10),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId, currentStock: D(stock), minimumStock: D(2) } },
    },
  })
}

async function raw(stock: number) {
  const item = await prisma.rawMaterial.create({
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
  if (stock > 0) {
    await prisma.stockBatch.create({
      data: {
        venueId,
        rawMaterialId: item.id,
        batchNumber: randomUUID(),
        initialQuantity: D(stock),
        remainingQuantity: D(stock),
        unit: 'PIECE',
        costPerUnit: D(1),
        receivedDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    })
  }
  return item
}

type Captured = { status: number; body: any; error: unknown }

/**
 * Corre la cadena real `validateRequest(schema) → controlador` y devuelve lo que viajaría por el
 * cable: el cuerpo pasa por JSON igual que en `res.json` (los Decimal salen como texto).
 */
async function call(
  schema: typeof AdjustStockSchema | typeof AdjustProductInventoryStockSchema,
  controller: (req: Request, res: Response, next: NextFunction) => unknown,
  params: Record<string, string>,
  body: unknown,
): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined, error: undefined }
  const req = {
    params,
    body,
    query: {},
    correlationId: 'corr-contrato',
    authContext: { userId: staffId, venueId, orgId: organizationId, role: 'MANAGER' },
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

/** La fila del insumo tal como la serializa `res.json` (los Decimal salen como texto). */
async function rawRowAsJson(id: string) {
  return JSON.parse(JSON.stringify(await prisma.rawMaterial.findUniqueOrThrow({ where: { id } })))
}

const keysWithoutWaste = (body: Record<string, unknown>) =>
  Object.keys(body)
    .filter(key => key !== 'waste')
    .sort()

describe('POST …/raw-materials/:id/adjust-stock — la forma de la respuesta', () => {
  it('🔴 merma (SPOILAGE negativa): { success, message, data: <fila del insumo> } — igual que hoy', async () => {
    const item = await raw(10)
    const r = await call(
      AdjustStockSchema,
      adjustStock,
      { venueId, rawMaterialId: item.id },
      {
        type: 'SPOILAGE',
        quantity: -2,
        reason: 'Se cayó',
        reference: '',
      },
    )

    expect(r.error).toBeUndefined()
    expect(r.status).toBe(200)
    expect(keysWithoutWaste(r.body)).toEqual(['data', 'message', 'success'])
    expect(r.body.success).toBe(true)
    expect(r.body.message).toBe('Stock adjusted successfully')
    // `data` es la fila COMPLETA del insumo, ya con la existencia nueva: mismas llaves y mismos
    // tipos que produce Prisma al leerla (el dashboard la usa tal cual).
    expect(r.body.data).toEqual(await rawRowAsJson(item.id))
    expect(r.body.data.currentStock).toBe('8')
  })

  it('ADJUSTMENT negativo (camino que no se toca): la misma forma, sin `waste`', async () => {
    const item = await raw(10)
    const r = await call(AdjustStockSchema, adjustStock, { venueId, rawMaterialId: item.id }, { type: 'ADJUSTMENT', quantity: -2 })

    expect(r.error).toBeUndefined()
    expect(Object.keys(r.body).sort()).toEqual(['data', 'message', 'success'])
    expect(r.body).toEqual({ success: true, message: 'Stock adjusted successfully', data: await rawRowAsJson(item.id) })
  })

  it('una entrada (SPOILAGE positiva) sigue por el camino de siempre y no trae `waste`', async () => {
    const item = await raw(0)
    const r = await call(AdjustStockSchema, adjustStock, { venueId, rawMaterialId: item.id }, { type: 'SPOILAGE', quantity: 3 })

    expect(r.error).toBeUndefined()
    expect(Object.keys(r.body).sort()).toEqual(['data', 'message', 'success'])
    expect(r.body.data.currentStock).toBe('3')
  })

  it('un insumo que no existe sigue siendo 404 con el mismo mensaje', async () => {
    const missing = 'cl' + 'x'.repeat(23)
    const r = await call(AdjustStockSchema, adjustStock, { venueId, rawMaterialId: missing }, { type: 'SPOILAGE', quantity: -1 })

    expect(r.error).toMatchObject({ statusCode: 404, message: `Raw material with ID ${missing} not found` })
  })
})

describe('POST …/products/:id/adjust-stock — la forma de la respuesta', () => {
  it('🔴 merma (LOSS negativa): { message, data: { currentStock, minimumStock, reservedStock }, correlationId } — igual que hoy', async () => {
    const item = await product(10)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'LOSS',
        quantity: -2,
        reason: 'Roto',
      },
    )

    expect(r.error).toBeUndefined()
    expect(r.status).toBe(200)
    expect(keysWithoutWaste(r.body)).toEqual(['correlationId', 'data', 'message'])
    expect(r.body.message).toBe('Inventory stock adjusted successfully')
    expect(r.body.correlationId).toBe('corr-contrato')
    expect(r.body.data).toEqual({ currentStock: 8, minimumStock: 2, reservedStock: 0 })
  })

  it('ADJUSTMENT negativo (camino que no se toca): la misma forma, sin `waste`', async () => {
    const item = await product(10)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'ADJUSTMENT',
        quantity: -2,
      },
    )

    expect(r.error).toBeUndefined()
    expect(r.body).toEqual({
      message: 'Inventory stock adjusted successfully',
      data: { currentStock: 8, minimumStock: 2, reservedStock: 0 },
      correlationId: 'corr-contrato',
    })
  })

  it('🔴 ADJUSTMENT que lleva una existencia ≥ 0 a negativo se sigue rechazando con 400', async () => {
    const item = await product(1)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'ADJUSTMENT',
        quantity: -4,
      },
    )

    expect(r.error).toMatchObject({ statusCode: 400, message: expect.stringMatching(/Insufficient stock/) })
    expect((await prisma.inventory.findFirstOrThrow({ where: { productId: item.id } })).currentStock.toString()).toBe('1')
  })

  it('un producto sin control por cantidad sigue siendo 400 con el mismo mensaje, también en la merma', async () => {
    const item = await product(5)
    await prisma.product.update({ where: { id: item.id }, data: { inventoryMethod: 'RECIPE' } })
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: item.id },
      {
        type: 'LOSS',
        quantity: -1,
      },
    )

    expect(r.error).toMatchObject({ statusCode: 400, message: `Product ${item.id} does not use QUANTITY tracking` })
  })

  it('un producto que no existe sigue siendo 404 con el mismo mensaje, también en la merma', async () => {
    const missing = 'cl' + 'y'.repeat(23)
    const r = await call(
      AdjustProductInventoryStockSchema,
      adjustInventoryStockHandler,
      { venueId, productId: missing },
      {
        type: 'LOSS',
        quantity: -1,
      },
    )

    expect(r.error).toMatchObject({ statusCode: 404, message: `Product with ID ${missing} not found` })
  })
})

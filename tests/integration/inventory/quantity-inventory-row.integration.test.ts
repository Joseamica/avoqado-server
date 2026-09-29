import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { setProductInventoryMethod } from '@/services/dashboard/productInventoryIntegration.service'
import { configureInventoryStep2, setupSimpleStockStep3, switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { updateProduct as updateFromPos } from '@/controllers/mobile/product.mobile.controller'
import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { findWasteItem } from '@/services/shared/inventoryWasteRead.service'

// 🔴 Invariante: producto «por cantidad» (trackInventory + QUANTITY) ⇒ tiene fila de Inventory.
// Sin ella no aparece en «Registrar merma» (INNER JOIN del catálogo) y la venta lanza
// «No inventory record for product». Cada camino que puede activar el inventario por cantidad
// se prueba aquí contra Postgres real: el ON CONFLICT que protege un saldo existente no se ve con mocks.
const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `qty-row-${randomUUID()}`
const humanActor = () => ({ type: 'HUMAN' as const, staffId, impersonating: false })

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

async function clearProducts(): Promise<void> {
  if (!venueId) return
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
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
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Inventario' },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER', active: true } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })).id
})

beforeEach(clearProducts)

afterAll(async () => {
  assertTestDatabase()
  await clearProducts()
  if (venueId) await prisma.activityLog.deleteMany({ where: { venueId } })
  // La importación crea el menú por defecto del venue si no existe.
  if (venueId) await prisma.menu.deleteMany({ where: { venueId } })
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

async function product(data: Partial<Prisma.ProductUncheckedCreateInput> = {}) {
  return prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Pan de muerto ${randomUUID()}`,
      sku: randomUUID(),
      price: D(45),
      trackInventory: false,
      inventoryMethod: null,
      ...data,
    },
  })
}

/** Importación en modo merge del MISMO SKU, dentro de la categoría del fixture (no crea otra). */
function importOf(item: { name: string; sku: string | null }, stock: { currentStock: number; minStock?: number }) {
  return {
    mode: 'merge' as const,
    categories: [
      { name: fixture, slug: fixture, products: [{ name: item.name, sku: item.sku!, price: 45, trackInventory: true, ...stock }] },
    ],
  }
}

async function expectEmptyRow(productId: string) {
  const row = await prisma.inventory.findUnique({ where: { productId } })
  expect(row).toMatchObject({ venueId })
  expect(row!.currentStock.toString()).toBe('0')
  expect(row!.minimumStock.toString()).toBe('0')
  // Saldo 0 no es un movimiento: el kardex no se ensucia (misma regla que el asistente).
  expect(await prisma.inventoryMovement.count({ where: { inventoryId: row!.id } })).toBe(0)
}

async function putFromPos(productId: string, body: Record<string, unknown>) {
  const captured: { status: number; body: any; error: unknown } = { status: 200, body: undefined, error: undefined }
  const req = { params: { venueId, productId }, body, authContext: { userId: staffId, venueId, orgId: organizationId, role: 'MANAGER' } }
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
  await updateFromPos(req as never, res as never, error => {
    captured.error = error
  })
  return captured
}

test('🔴 dashboard: activar «Rastrear por cantidad» crea la fila en 0 y el producto aparece en Registrar merma', async () => {
  const item = await product()

  await updateProduct(venueId, item.id, { trackInventory: true, inventoryMethod: 'QUANTITY' }, humanActor())

  await expectEmptyRow(item.id)
  expect(await findWasteItem(venueId, 'PRODUCT', item.id)).toMatchObject({ itemId: item.id })
})

test('🔴 /mobile (Artículos de Android e iOS): activar por cantidad crea la fila en 0', async () => {
  const item = await product()

  const result = await putFromPos(item.id, { trackInventory: true, inventoryMethod: 'QUANTITY' })

  expect(result.error).toBeUndefined()
  await expectEmptyRow(item.id)
  // La respuesta describe lo que quedó en la base, no el producto de antes de crear la fila.
  expect(result.body.data.inventory).toMatchObject({ productId: item.id, currentStock: '0' })
})

test('🔴 importar existencias DESPUÉS de activar por cantidad carga el saldo: la fila vacía es una apertura pendiente', async () => {
  const item = await product()
  await updateProduct(venueId, item.id, { trackInventory: true, inventoryMethod: 'QUANTITY' }, humanActor())

  await importMenu(venueId, importOf(item, { currentStock: 12, minStock: 2 }), humanActor())

  const row = await prisma.inventory.findUniqueOrThrow({ where: { productId: item.id }, include: { movements: true } })
  expect(row.currentStock.toString()).toBe('12')
  expect(row.minimumStock.toString()).toBe('2')
  expect(row.movements).toHaveLength(1)
  expect(row.movements[0]).toMatchObject({ reason: 'Saldo inicial (importación de menú)' })
  expect(row.movements[0].quantity.toString()).toBe('12')
})

test('re-importar NO toca el saldo de un inventario con historia, aunque esté en 0 (auditoría 2026-08-12)', async () => {
  const conSaldo = await product({ trackInventory: true, inventoryMethod: 'QUANTITY' })
  await prisma.inventory.create({ data: { productId: conSaldo.id, venueId, currentStock: D(7) } })
  const agotado = await product({ trackInventory: true, inventoryMethod: 'QUANTITY' })
  const fila = await prisma.inventory.create({ data: { productId: agotado.id, venueId, currentStock: D(0) } })
  await prisma.inventoryMovement.create({
    data: { inventoryId: fila.id, type: 'SALE', quantity: D(-5), previousStock: D(5), newStock: D(0), reason: 'venta previa' },
  })

  await importMenu(venueId, importOf(conSaldo, { currentStock: 20 }), humanActor())
  await importMenu(venueId, importOf(agotado, { currentStock: 20 }), humanActor())

  expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: conSaldo.id } })).currentStock.toString()).toBe('7')
  expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: agotado.id } })).currentStock.toString()).toBe('0')
  expect(await prisma.inventoryMovement.count({ where: { inventory: { productId: { in: [conSaldo.id, agotado.id] } } } })).toBe(1)
})

test('🔴 PUT inventory-method (paso 2 del asistente, aunque se abandone ahí) crea la fila en 0', async () => {
  const item = await product()

  await setProductInventoryMethod(item.id, 'QUANTITY')

  await expectEmptyRow(item.id)
})

test('🔴 switch-inventory-method de RECETA a CANTIDAD crea la fila en 0', async () => {
  const item = await product({ trackInventory: true, inventoryMethod: 'RECIPE' })

  await switchInventoryMethod(venueId, item.id, 'QUANTITY')

  await expectEmptyRow(item.id)
})

test('una fila existente NO se toca: ni saldo, ni mínimo, ni movimientos', async () => {
  const item = await product({ trackInventory: true, inventoryMethod: 'QUANTITY' })
  await prisma.inventory.create({ data: { productId: item.id, venueId, currentStock: D(7), minimumStock: D(3) } })

  await updateProduct(venueId, item.id, { trackInventory: true, inventoryMethod: 'QUANTITY' }, humanActor())
  expect((await putFromPos(item.id, { trackInventory: true, inventoryMethod: 'QUANTITY' })).error).toBeUndefined()

  const row = await prisma.inventory.findUniqueOrThrow({ where: { productId: item.id } })
  expect(row.currentStock.toString()).toBe('7')
  expect(row.minimumStock.toString()).toBe('3')
  expect(await prisma.inventoryMovement.count({ where: { inventoryId: row.id } })).toBe(0)
})

test('sin inventario o por RECETA no nace fila', async () => {
  const plain = await product()
  const recipe = await product()

  await updateProduct(venueId, plain.id, { price: 50 }, humanActor())
  await updateProduct(venueId, recipe.id, { trackInventory: true, inventoryMethod: 'RECIPE' }, humanActor())

  expect(await prisma.inventory.count({ where: { productId: { in: [plain.id, recipe.id] } } })).toBe(0)
})

test('asistente completo (paso 2 + paso 3): el primer saldo sigue anotándose como «Saldo inicial»', async () => {
  const item = await product()

  await configureInventoryStep2(item.id, { useInventory: true, inventoryMethod: 'QUANTITY' })
  await setupSimpleStockStep3(venueId, item.id, { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })

  const row = await prisma.inventory.findUniqueOrThrow({ where: { productId: item.id }, include: { movements: true } })
  expect(row.currentStock.toString()).toBe('12')
  expect(row.movements).toHaveLength(1)
  expect(row.movements[0]).toMatchObject({ reason: 'Saldo inicial (asistente de producto)' })
  expect(row.movements[0].quantity.toString()).toBe('12')
})

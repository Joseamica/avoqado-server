import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { setupSimpleStockStep3 } from '@/services/dashboard/productWizard.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

// PR #273 del DASHBOARD, ronda 5, contra Postgres real:
// - Codex r4 #1: una activación de inventario atrasada no vuelve a prender lo que otra ventana ya apagó (versión esperada → 409).
// - El paso 3 acepta mínimo y costo SIN existencias: el saldo queda como esté, sin movimiento.
const fixture = `wiz-version-${randomUUID()}`
const actor = { type: 'SERVICE' as const, servicePrincipalId: 'DEMO_VENUE_SEED' }
const ids = { org: '', venue: '', category: '', product: '' }

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

const producto = () => prisma.product.findUniqueOrThrow({ where: { id: ids.product } })
const inventario = () => prisma.inventory.findUniqueOrThrow({ where: { productId: ids.product } })
const movimientos = () => prisma.inventoryMovement.count({ where: { inventory: { productId: ids.product } } })

beforeAll(async () => {
  assertTestDatabase()
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: fixture, slug: fixture, timezone: 'America/Mexico_City' },
  })
  Object.assign(ids, { org: org.id, venue: venue.id })
  ids.category = (await prisma.menuCategory.create({ data: { venueId: ids.venue, name: fixture, slug: fixture } })).id
})

beforeEach(async () => {
  if (!ids.venue) return
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: ids.venue } } })
  await prisma.inventory.deleteMany({ where: { venueId: ids.venue } })
  await prisma.product.deleteMany({ where: { venueId: ids.venue } })
  ids.product = (
    await prisma.product.create({ data: { venueId: ids.venue, categoryId: ids.category, name: 'Libreta', sku: randomUUID(), price: 85 } })
  ).id
  // Por cantidad con 7 en existencia, como lo deja el asistente.
  await setupSimpleStockStep3(ids.venue, ids.product, { initialStock: 7, reorderPoint: 3, costPerUnit: 20 })
})

afterAll(async () => {
  assertTestDatabase()
  if (!ids.venue) return
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: ids.venue } } })
  await prisma.inventory.deleteMany({ where: { venueId: ids.venue } })
  await prisma.product.deleteMany({ where: { venueId: ids.venue } })
  await prisma.activityLog.deleteMany({ where: { venueId: ids.venue } })
  await prisma.menuCategory.deleteMany({ where: { venueId: ids.venue } })
  await prisma.venue.deleteMany({ where: { id: ids.venue } })
  await prisma.organization.deleteMany({ where: { id: ids.org } })
})

describe('paso 3 sin existencias', () => {
  it('guarda mínimo y costo y deja el saldo (con lo vendido) como está, sin movimiento', async () => {
    await prisma.inventory.update({ where: { productId: ids.product }, data: { currentStock: 5 } }) // se vendieron 2
    const antes = await movimientos()

    const r = await setupSimpleStockStep3(ids.venue, ids.product, { reorderPoint: 4, costPerUnit: 12 })

    const inv = await inventario()
    expect(inv.currentStock.toString()).toBe('5')
    expect(inv.minimumStock.toString()).toBe('4')
    expect((await producto()).cost?.toString()).toBe('12')
    expect(await movimientos()).toBe(antes)
    expect(r.initialStock).toBe(5)
  })
})

describe('versión esperada (Codex r4 #1)', () => {
  it('🔴 una activación atrasada no vuelve a prender el inventario que otra ventana apagó', async () => {
    const vistaPorElGuardadoViejo = (await updateProduct(ids.venue, ids.product, { name: 'Libreta A5' }, actor)).updatedAt
    await updateProduct(ids.venue, ids.product, { trackInventory: false }, actor) // la otra ventana apaga

    await expect(
      updateProduct(
        ids.venue,
        ids.product,
        { trackInventory: true, inventoryMethod: 'QUANTITY', expectedUpdatedAt: vistaPorElGuardadoViejo.toISOString() } as any,
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
    const p = await producto()
    expect(p.trackInventory).toBe(false)
    expect(p.inventoryMethod).toBeNull()
  })

  it('🔴 el paso 3 con versión vieja no toca existencias, mínimo ni seguimiento', async () => {
    const vieja = (await producto()).updatedAt
    await updateProduct(ids.venue, ids.product, { trackInventory: false }, actor)

    await expect(
      setupSimpleStockStep3(ids.venue, ids.product, {
        initialStock: 33,
        reorderPoint: 6,
        costPerUnit: 20,
        expectedUpdatedAt: vieja.toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
    const inv = await inventario()
    expect(inv.currentStock.toString()).toBe('7')
    expect(inv.minimumStock.toString()).toBe('3')
    expect((await producto()).trackInventory).toBe(false)
  })

  it('la cadena del asistente no da un 409 falso: cada paso usa la versión que contestó el anterior', async () => {
    const v1 = (await updateProduct(ids.venue, ids.product, { name: 'Libreta A4' }, actor)).updatedAt
    const v2 = (
      await updateProduct(
        ids.venue,
        ids.product,
        { trackInventory: true, inventoryMethod: 'QUANTITY', expectedUpdatedAt: v1.toISOString() } as any,
        actor,
      )
    ).updatedAt
    // La respuesta trae la versión FINAL: nada vuelve a escribir el producto después dentro de la transacción.
    expect(v2.getTime()).toBe((await producto()).updatedAt.getTime())

    await setupSimpleStockStep3(ids.venue, ids.product, {
      initialStock: 9,
      reorderPoint: 3,
      costPerUnit: 20,
      expectedUpdatedAt: v2.toISOString(),
    })
    expect((await inventario()).currentStock.toString()).toBe('9')
  })

  // Codex r1 #4: el panel repite la MISMA petición si se pierde la respuesta. No es un cambio ajeno.
  it('repetir una activación y un paso 3 ya aplicados no da 409 falso ni toca el kardex', async () => {
    const v1 = (await updateProduct(ids.venue, ids.product, { name: 'Libreta B5' }, actor)).updatedAt.toISOString()
    const activar = { trackInventory: true, inventoryMethod: 'QUANTITY', expectedUpdatedAt: v1 } as any
    const v2 = (await updateProduct(ids.venue, ids.product, activar, actor)).updatedAt.toISOString()
    await updateProduct(ids.venue, ids.product, activar, actor) // la repetición

    const paso3 = { initialStock: 9, reorderPoint: 4, costPerUnit: 20, expectedUpdatedAt: v2 }
    await setupSimpleStockStep3(ids.venue, ids.product, paso3)
    const movimientosTrasAplicar = await movimientos()
    await setupSimpleStockStep3(ids.venue, ids.product, paso3) // la repetición

    const inv = await inventario()
    expect(inv.currentStock.toString()).toBe('9')
    expect(inv.minimumStock.toString()).toBe('4')
    expect(await movimientos()).toBe(movimientosTrasAplicar)
  })

  it('una repetición NO pasa si otra ventana ya apagó el inventario en medio', async () => {
    const v1 = (await updateProduct(ids.venue, ids.product, { name: 'Libreta B6' }, actor)).updatedAt.toISOString()
    const activar = { trackInventory: true, inventoryMethod: 'QUANTITY', expectedUpdatedAt: v1 } as any
    await updateProduct(ids.venue, ids.product, activar, actor)
    await updateProduct(ids.venue, ids.product, { trackInventory: false }, actor)
    await expect(updateProduct(ids.venue, ids.product, activar, actor)).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_CHANGED' })
    expect((await producto()).trackInventory).toBe(false)
  })

  it('sin versión (ANDROID, MCP, paneles viejos): se comporta como hoy', async () => {
    await updateProduct(ids.venue, ids.product, { trackInventory: false }, actor)
    await updateProduct(ids.venue, ids.product, { trackInventory: true, inventoryMethod: 'QUANTITY' }, actor)
    expect((await producto()).trackInventory).toBe(true)
  })
})

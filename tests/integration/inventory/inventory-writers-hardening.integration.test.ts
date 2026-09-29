import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createProduct } from '@/services/dashboard/product.dashboard.service'
import { setupSimpleStockStep3, switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { createProduct as createFromPos } from '@/controllers/mobile/product.mobile.controller'
import { createTpvQuickAddProductHandler } from '@/routes/tpv.routes'

// Defectos preexistentes de inventario (auditoría de Codex, 29-sep-2026), contra Postgres real:
//  - el paso 3 del asistente leía el saldo fuera de transacción: una venta simultánea descuadraba el
//    kardex, y un fallo al anotar el movimiento dejaba saldo sin kardex;
//  - las ALTAS (Artículos de Android/iOS, dashboard, alta rápida del TPV) tiraban `inventoryMethod`:
//    el producto nacía «con inventario» pero sin método (ni merma ni descuento en la venta);
//  - dos cambios de RECETA a CANTIDAD a la vez: el segundo tronaba con P2025.
const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `inv-hard-${randomUUID()}`
const humanActor = () => ({ type: 'HUMAN' as const, staffId, impersonating: false })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  await prisma.recipe.deleteMany({ where: { product: { venueId } } })
  await prisma.product.deleteMany({ where: { venueId } })
}

beforeAll(async () => {
  assertTestDatabase()
  organizationId = (await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })).id
  venueId = (
    await prisma.venue.create({ data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN' } })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Inventario' } }))
    .id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER', active: true } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })).id
})

beforeEach(clearProducts)

afterAll(async () => {
  assertTestDatabase()
  await clearProducts()
  if (venueId) await prisma.activityLog.deleteMany({ where: { venueId } })
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  const sobrantes = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT tgname::text AS name FROM pg_trigger WHERE starts_with(tgname::text, 'inv_hard_')
    UNION ALL SELECT proname::text AS name FROM pg_proc WHERE starts_with(proname::text, 'inv_hard_')`
  expect(sobrantes).toEqual([])
})

async function porCantidadConFila(stock = 0) {
  const p = await prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Pan ${randomUUID()}`,
      sku: randomUUID(),
      price: D(45),
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId, currentStock: D(stock) } },
    },
  })
  return p
}

async function kardex(productId: string) {
  const fila = await prisma.inventory.findUniqueOrThrow({ where: { productId }, include: { movements: true } })
  const suma = fila.movements.reduce((s, m) => s.plus(m.quantity), D(0))
  return { saldo: fila.currentStock.toString(), suma: suma.toString(), movimientos: fila.movements.length }
}

/** Un controlador con `req`/`res` mínimos: status, cuerpo y error del `next`. */
async function call(handler: any, params: Record<string, string>, body: Record<string, unknown>) {
  const out: { status: number; body: any; error: any } = { status: 200, body: undefined, error: undefined }
  const res = {
    status(code: number) {
      out.status = code
      return this
    },
    json(payload: unknown) {
      out.body = JSON.parse(JSON.stringify(payload))
      return this
    },
  }
  const req = { params, body, authContext: { userId: staffId, venueId, orgId: organizationId, role: 'MANAGER' }, correlationId: fixture }
  await handler(req, res, (error: unknown) => {
    out.error = error
  })
  return out
}

async function filaEnCero(productId: string) {
  const fila = await prisma.inventory.findUnique({ where: { productId } })
  expect(fila?.currentStock.toString()).toBe('0')
}

describe('paso 3 del asistente: saldo y kardex en UNA transacción', () => {
  it('🔴 si anotar el movimiento falla, el saldo NO queda cambiado', async () => {
    const item = await porCantidadConFila(0)
    const { id: inventoryId } = await prisma.inventory.findUniqueOrThrow({ where: { productId: item.id } })
    const sufijo = randomUUID().replace(/-/g, '').slice(0, 12)
    const fn = `inv_hard_falla_${sufijo}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${fn}"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'movimiento rechazado a propósito'; END $$ LANGUAGE plpgsql`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${fn}" BEFORE INSERT ON "InventoryMovement" FOR EACH ROW WHEN (NEW."inventoryId" = '${inventoryId}') EXECUTE FUNCTION "${fn}"()`,
    )
    try {
      await expect(setupSimpleStockStep3(venueId, item.id, { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fn}" ON "InventoryMovement"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
    }

    expect(await kardex(item.id)).toEqual({ saldo: '0', suma: '0', movimientos: 0 })
  })

  it('🔴 una venta simultánea no descuadra el kardex (saldo = suma de movimientos)', async () => {
    const item = await porCantidadConFila(0)
    let liberar!: () => void
    const puerta = new Promise<void>(r => (liberar = r))
    // Una venta que descuenta 1 y sostiene el candado de la fila hasta que la soltemos.
    const venta = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${item.id}`
        const inv = await tx.inventory.findUniqueOrThrow({ where: { productId: item.id } })
        await tx.inventoryMovement.create({
          data: { inventoryId: inv.id, type: 'SALE', quantity: D(-1), previousStock: D(0), newStock: D(-1), reason: 'venta simultánea' },
        })
        await puerta
      },
      { timeout: 20_000 },
    )
    await sleep(300)
    const paso3 = setupSimpleStockStep3(venueId, item.id, { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })
    await sleep(800)
    liberar()
    await venta
    await paso3

    const k = await kardex(item.id)
    expect(k.saldo).toBe('12')
    expect(k.suma).toBe('12') // −1 de la venta + 13 del asistente
  })
})

describe('las ALTAS guardan el método y la fila de inventario', () => {
  it('🔴 Artículos de Android/iOS: alta «por cantidad» ⇒ QUANTITY y fila en 0', async () => {
    const out = await call(
      createFromPos,
      { venueId },
      { name: 'Pan móvil', price: 45, categoryId, trackInventory: true, inventoryMethod: 'QUANTITY' },
    )

    expect(out.error).toBeUndefined()
    const p = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'Pan móvil' } })
    expect(p.inventoryMethod).toBe('QUANTITY')
    await filaEnCero(p.id)
  })

  it('🔴 Artículos: con inventario pero sin método (app vieja) ⇒ QUANTITY y fila', async () => {
    const out = await call(createFromPos, { venueId }, { name: 'Pan viejo', price: 45, categoryId, trackInventory: true })

    expect(out.error).toBeUndefined()
    const p = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'Pan viejo' } })
    expect(p.inventoryMethod).toBe('QUANTITY')
    await filaEnCero(p.id)
  })

  it('Artículos: por RECETA ⇒ RECIPE y SIN fila de cantidad', async () => {
    await call(createFromPos, { venueId }, { name: 'Pan receta', price: 45, categoryId, trackInventory: true, inventoryMethod: 'RECIPE' })

    const p = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'Pan receta' } })
    expect(p.inventoryMethod).toBe('RECIPE')
    expect(await prisma.inventory.count({ where: { productId: p.id } })).toBe(0)
  })

  it('🔴 dashboard: alta «por cantidad» ⇒ QUANTITY y fila en 0', async () => {
    const creado = await createProduct(
      venueId,
      {
        name: 'Pan dashboard',
        price: 45,
        type: 'REGULAR',
        categoryId,
        sku: randomUUID(),
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      } as any,
      humanActor(),
    )

    const p = await prisma.product.findUniqueOrThrow({ where: { id: creado.id } })
    expect(p.trackInventory).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
    await filaEnCero(p.id)
  })

  it('🔴 alta rápida del TPV por código de barras con inventario ⇒ QUANTITY y fila en 0', async () => {
    const barcode = `75${Date.now()}`
    const out = await call(
      createTpvQuickAddProductHandler,
      { venueId },
      { barcode, name: 'Pan TPV', price: 45, categoryId, trackInventory: true },
    )

    expect(out.error).toBeUndefined()
    const p = await prisma.product.findFirstOrThrow({ where: { venueId, sku: barcode } })
    expect(p.inventoryMethod).toBe('QUANTITY')
    await filaEnCero(p.id)
  })

  it('sin inventario, ninguna alta crea fila ni método', async () => {
    await call(createFromPos, { venueId }, { name: 'Pan sin inv', price: 45, categoryId })

    const p = await prisma.product.findFirstOrThrow({ where: { venueId, name: 'Pan sin inv' } })
    expect(p.trackInventory).toBe(false)
    expect(p.inventoryMethod).toBeNull()
    expect(await prisma.inventory.count({ where: { productId: p.id } })).toBe(0)
  })
})

describe('cambiar de RECETA a CANTIDAD con otro cambio a la vez', () => {
  it('🔴 si la receta la borró otro proceso en medio, el cambio termina bien (no P2025)', async () => {
    const item = await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: `Pan receta ${randomUUID()}`,
        sku: randomUUID(),
        price: D(45),
        trackInventory: true,
        inventoryMethod: 'RECIPE',
      },
    })
    const receta = await prisma.recipe.create({ data: { productId: item.id, totalCost: D(0) } })
    let liberar!: () => void
    const puerta = new Promise<void>(r => (liberar = r))
    // Otro cambio que ya borró la receta y sostiene el candado hasta que lo soltemos.
    const otro = prisma.$transaction(
      async tx => {
        await tx.recipe.delete({ where: { id: receta.id } })
        await puerta
      },
      { timeout: 20_000 },
    )
    await sleep(300)
    const cambio = switchInventoryMethod(venueId, item.id, 'QUANTITY')
    await sleep(800)
    liberar()
    await otro

    await expect(cambio).resolves.toMatchObject({ success: true, newMethod: 'QUANTITY' })
    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect(await prisma.recipe.count({ where: { productId: item.id } })).toBe(0)
    await filaEnCero(item.id)
  })
})

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createProduct } from '@/services/dashboard/product.dashboard.service'
import { setupSimpleStockStep3, switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { createProduct as createFromPos, updateProduct as updateFromPos } from '@/controllers/mobile/product.mobile.controller'
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

/**
 * Barrera verificable (no un `sleep`): espera a que OTRA conexión esté bloqueada precisamente por la
 * transacción competidora (`pid`). Así la prueba sabe que la operación llegó al punto de la carrera, y
 * no la confunde con un bloqueo cualquiera de otra suite que corra a la par.
 */
async function esperarBloqueadoPor(pid: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (fila.n > 0) return
    await sleep(25)
  }
  throw new Error(`nadie llegó a esperar a la transacción ${pid}`)
}

/** El `pid` de la conexión de una transacción: lo que la barrera usa para reconocerla. */
async function pidDe(tx: Prisma.TransactionClient): Promise<number> {
  const [fila] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  return fila.pid
}

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
    let avisarCandado!: (pid: number) => void
    const conCandado = new Promise<number>(r => (avisarCandado = r))
    // Una venta que descuenta 1 y sostiene el candado de la fila hasta que la soltemos.
    const venta = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${item.id}`
        avisarCandado(await pidDe(tx))
        const inv = await tx.inventory.findUniqueOrThrow({ where: { productId: item.id } })
        await tx.inventoryMovement.create({
          data: { inventoryId: inv.id, type: 'SALE', quantity: D(-1), previousStock: D(0), newStock: D(-1), reason: 'venta simultánea' },
        })
        await puerta
      },
      { timeout: 20_000 },
    )
    const competidor = await conCandado
    const paso3 = setupSimpleStockStep3(venueId, item.id, { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })
    try {
      await esperarBloqueadoPor(competidor)
    } finally {
      liberar()
    }
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

  it('Artículos sin inventario: no crea fila ni método', async () => {
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
    let avisarCandado!: (pid: number) => void
    const conCandado = new Promise<number>(r => (avisarCandado = r))
    const otro = prisma.$transaction(
      async tx => {
        await tx.recipe.delete({ where: { id: receta.id } })
        avisarCandado(await pidDe(tx))
        await puerta
      },
      { timeout: 20_000 },
    )
    const competidor = await conCandado
    const cambio = switchInventoryMethod(venueId, item.id, 'QUANTITY')
    try {
      await esperarBloqueadoPor(competidor)
    } finally {
      liberar()
    }
    await otro

    await expect(cambio).resolves.toMatchObject({ success: true, newMethod: 'QUANTITY' })
    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect(await prisma.recipe.count({ where: { productId: item.id } })).toBe(0)
    await filaEnCero(item.id)
  })
})

describe('tipos que no llevan existencias (clase, cita, digital, donativo)', () => {
  it('🔴 Artículos: alta de una CLASE con inventario ⇒ 400 y no se crea nada', async () => {
    const out = await call(
      createFromPos,
      { venueId },
      { name: 'Clase de yoga', price: 150, categoryId, type: 'CLASS', trackInventory: true, inventoryMethod: 'QUANTITY' },
    )

    expect(out.status).toBe(400)
    expect(out.body?.message).toBe('Este tipo de producto no puede tener seguimiento de inventario')
    expect(await prisma.product.count({ where: { venueId, name: 'Clase de yoga' } })).toBe(0)
  })

  it('🔴 Artículos: activar inventario en una CITA existente ⇒ 400, sin cambios ni fila', async () => {
    const cita = await prisma.product.create({
      data: { venueId, categoryId, name: `Corte ${randomUUID()}`, sku: randomUUID(), price: D(200), type: 'APPOINTMENTS_SERVICE' },
    })

    const out = await call(updateFromPos, { venueId, productId: cita.id }, { trackInventory: true, inventoryMethod: 'QUANTITY' })

    expect(out.error?.statusCode).toBe(400)
    const p = await prisma.product.findUniqueOrThrow({ where: { id: cita.id } })
    expect(p.trackInventory).toBe(false)
    expect(p.inventoryMethod).toBeNull()
    expect(await prisma.inventory.count({ where: { productId: cita.id } })).toBe(0)
  })

  it('un producto normal sigue activando «por cantidad» desde Artículos', async () => {
    const pan = await prisma.product.create({ data: { venueId, categoryId, name: `Pan ${randomUUID()}`, sku: randomUUID(), price: D(45) } })

    const out = await call(updateFromPos, { venueId, productId: pan.id }, { trackInventory: true, inventoryMethod: 'QUANTITY' })

    expect(out.error).toBeUndefined()
    await filaEnCero(pan.id)
  })
})

describe('paso 3 del asistente: el cambio de RECETA a CANTIDAD va en la MISMA transacción', () => {
  async function conRecetaQueFalla(item: { id: string }) {
    const sufijo = randomUUID().replace(/-/g, '').slice(0, 12)
    const fn = `inv_hard_falla_${sufijo}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${fn}"() RETURNS trigger AS $$ BEGIN
         IF EXISTS (SELECT 1 FROM "Inventory" WHERE id = NEW."inventoryId" AND "productId" = '${item.id}') THEN
           RAISE EXCEPTION 'movimiento rechazado a propósito';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
    )
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
    return async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fn}" ON "InventoryMovement"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
    }
  }

  it('🔴 si el paso 3 falla, la receta y el método RECETA siguen intactos', async () => {
    const item = await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: `Latte ${randomUUID()}`,
        sku: randomUUID(),
        price: D(60),
        trackInventory: true,
        inventoryMethod: 'RECIPE',
      },
    })
    await prisma.recipe.create({ data: { productId: item.id, totalCost: D(0) } })
    const quitar = await conRecetaQueFalla(item)
    try {
      await expect(setupSimpleStockStep3(venueId, item.id, { initialStock: 8, reorderPoint: 1, costPerUnit: 10 })).rejects.toThrow()
    } finally {
      await quitar()
    }

    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.inventoryMethod).toBe('RECIPE')
    expect(await prisma.recipe.count({ where: { productId: item.id } })).toBe(1)
    expect(await prisma.inventory.count({ where: { productId: item.id } })).toBe(0)
  })

  it('🔴 un producto RECETA todavía sin receta queda «por cantidad» (no sólo lo dice la respuesta)', async () => {
    const item = await prisma.product.create({
      data: {
        venueId,
        categoryId,
        name: `Latte ${randomUUID()}`,
        sku: randomUUID(),
        price: D(60),
        trackInventory: true,
        inventoryMethod: 'RECIPE',
      },
    })

    const r = await setupSimpleStockStep3(venueId, item.id, { initialStock: 8, reorderPoint: 1, costPerUnit: 10 })

    expect(r.inventoryMethod).toBe('QUANTITY')
    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.trackInventory).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect((await kardex(item.id)).saldo).toBe('8')
  })

  it('🔴 un producto sin inventario queda con inventario «por cantidad» tras el paso 3', async () => {
    const item = await prisma.product.create({
      data: { venueId, categoryId, name: `Pan ${randomUUID()}`, sku: randomUUID(), price: D(45) },
    })

    await setupSimpleStockStep3(venueId, item.id, { initialStock: 3, reorderPoint: 1, costPerUnit: 10 })

    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.trackInventory).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
  })
})

describe('cambiar a RECETA mientras otro proceso rehace la fila de inventario', () => {
  it('🔴 no queda una fila de cantidad colgando de un producto por RECETA', async () => {
    const item = await porCantidadConFila(5)
    const vieja = await prisma.inventory.findUniqueOrThrow({ where: { productId: item.id } })
    let liberar!: () => void
    const puerta = new Promise<void>(r => (liberar = r))
    let avisarCandado!: (pid: number) => void
    const conCandado = new Promise<number>(r => (avisarCandado = r))
    // Otro cambio (vuelta a «por cantidad») que ya reemplazó la fila y sostiene sus candados.
    const otro = prisma.$transaction(
      async tx => {
        await tx.product.update({ where: { id: item.id }, data: { trackInventory: true, inventoryMethod: 'QUANTITY' } })
        await tx.inventory.delete({ where: { id: vieja.id } })
        await tx.inventory.create({ data: { productId: item.id, venueId, currentStock: D(0) } })
        avisarCandado(await pidDe(tx))
        await puerta
      },
      { timeout: 20_000 },
    )
    const competidor = await conCandado
    const cambio = switchInventoryMethod(venueId, item.id, 'RECIPE')
    try {
      await esperarBloqueadoPor(competidor)
    } finally {
      liberar()
    }
    await otro
    await cambio

    const p = await prisma.product.findUniqueOrThrow({ where: { id: item.id } })
    expect(p.inventoryMethod).toBe('RECIPE')
    expect(await prisma.inventory.count({ where: { productId: item.id } })).toBe(0)
  })
})

describe('paso 3: tipos sin existencias y el orden de los candados', () => {
  it('🔴 una CLASE no se vuelve «por cantidad» por el paso 3: 400 y nada escrito', async () => {
    const clase = await prisma.product.create({
      data: { venueId, categoryId, name: `Yoga ${randomUUID()}`, sku: randomUUID(), price: D(150), type: 'CLASS' },
    })

    await expect(setupSimpleStockStep3(venueId, clase.id, { initialStock: 5, reorderPoint: 1, costPerUnit: 10 })).rejects.toMatchObject({
      statusCode: 400,
    })

    const p = await prisma.product.findUniqueOrThrow({ where: { id: clase.id } })
    expect(p.trackInventory).toBe(false)
    expect(p.inventoryMethod).toBeNull()
    expect(await prisma.inventory.count({ where: { productId: clase.id } })).toBe(0)
  })

  it('🔴 una entrada de mercancía a la vez (inventario y luego costo) no se traba con el paso 3', async () => {
    const item = await porCantidadConFila(4)
    let liberar!: () => void
    const puerta = new Promise<void>(r => (liberar = r))
    let avisarCandado!: (pid: number) => void
    const conCandado = new Promise<number>(r => (avisarCandado = r))
    // Como `adjustInventoryStockInTx` con PURCHASE: primero la fila de inventario, al final el costo.
    const entrada = prisma.$transaction(
      async tx => {
        await tx.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" + 2 WHERE "productId" = ${item.id}`
        avisarCandado(await pidDe(tx))
        await puerta
        await tx.product.update({ where: { id: item.id }, data: { cost: D(18) } })
      },
      { timeout: 20_000 },
    )
    const competidor = await conCandado
    const paso3 = setupSimpleStockStep3(venueId, item.id, { initialStock: 9, reorderPoint: 1, costPerUnit: 20 })
    try {
      await esperarBloqueadoPor(competidor)
    } finally {
      liberar()
    }

    await expect(entrada).resolves.toBeUndefined()
    await expect(paso3).resolves.toMatchObject({ success: true })
  })
})

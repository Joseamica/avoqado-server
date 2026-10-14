/**
 * MCP de clientes — catálogo en bloque contra Postgres real y por el catálogo de producción (`configureToolCatalog`, token de dos
 * pasos): `resolveScope` → guard → servicios reales → base. Sin mocks (la bitácora se restaura: el setup de integración la apaga).
 *
 * Qué fija, y por qué:
 *   - 🔴 Existencias: la cantidad final queda, con UN movimiento COUNT firmado por quien confirmó, dentro de un conteo COMPLETED con
 *     su nota; repetir la misma carga no mueve nada.
 *   - 🔴 Una venta entre la vista previa y la confirmación: no se aplica NADA ni se crea el conteo.
 *   - 🔴 Ligado a Shopify con 2 piezas apartadas: contar 9 deja 7, la respuesta lo dice, y el guardia de la tabla encola −3.
 *   - 🔴 Reenviar la MISMA confirmación ya aplicada (las ventas regresaron el número): no se vuelve a contar.
 *   - 🔴 Un producto en un conteo abierto no se carga; el resto sí, y el conteo abierto queda como estaba.
 *   - 🔴 Otro negocio con el mismo SKU y el mismo código de barras: nunca se encuentra ni se cambia.
 *   - Precios: cambian con UNA bitácora del lote; si otra persona cambió el precio, no se pisa.
 *   - Altas: nacen con su código de barras y su inventario en 0; repetir la lista (con o sin SKU) no crea duplicados.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveScope } from '@/mcp/scope'
import { registerCatalogInBulkTools } from '@/mcp/tools/catalogInBulk'
import { createStockCount } from '@/services/mobile/inventory.mobile.service'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'
import { confirmarPorElCatalogo } from '../../__helpers__/catalogo-en-bloque'
import { assertTestDatabase, crearEscenarioShopify, limpiarEscenarioShopify, type EscenarioShopify } from '../shopify/fixtures'

// El setup de integración cambia la bitácora por jest.fn(): aquí se restaura la real y se juntan sus escrituras (algunas son
// «dispara y olvida» en los servicios) para esperarlas antes de afirmar y antes de limpiar.
const mockAuditWrites: Promise<unknown>[] = []
jest.mock('@/services/dashboard/activity-log.service', () => {
  const actual = jest.requireActual('@/services/dashboard/activity-log.service')
  return {
    ...actual,
    logAction: (...args: unknown[]) => {
      const result = actual.logAction(...args)
      mockAuditWrites.push(result)
      return result
    },
  }
})
const flushAudit = () => Promise.all(mockAuditWrites.splice(0))

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const fixture = `mcp-bloque-${randomUUID()}`

let organizationId = ''
let venueId = ''
let staffId = ''
let categoryId = ''

// La guardia de la base es la de las pruebas de Shopify: nunca imprime la URL (la copia local imprimía las dos, con contraseña).

async function clearVenue(id: string): Promise<void> {
  if (!id) return
  await flushAudit()
  await prisma.activityLog.deleteMany({ where: { venueId: id } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: id } } })
  await prisma.stockCountItem.deleteMany({ where: { stockCount: { venueId: id } } })
  await prisma.stockCount.deleteMany({ where: { venueId: id } })
  await prisma.inventory.deleteMany({ where: { venueId: id } })
  await prisma.product.deleteMany({ where: { venueId: id } })
}

beforeAll(async () => {
  assertTestDatabase()
  const organization = await prisma.organization.create({
    data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
  })
  organizationId = organization.id
  // Exento de plan (grandfathered): el resolver real le concede INVENTORY_TRACKING.
  const venue = await prisma.venue.create({
    data: { organizationId, name: fixture, slug: fixture, timezone: 'America/Mexico_City', currency: 'MXN', seatCapExempt: true },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({ data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Bloque' } })
  staffId = staff.id
  // ADMIN trae products:*, inventory:* y menu:* (MANAGER no trae products:update ni products:create).
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'ADMIN', active: true } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Vestidos', slug: fixture } })
  categoryId = category.id
})

beforeEach(() => clearVenue(venueId))

afterAll(async () => {
  assertTestDatabase()
  await clearVenue(venueId)
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  if (venueId) await prisma.staffVenue.deleteMany({ where: { venueId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

async function producto(o: { sku: string; gtin?: string; price?: number; stock?: number }) {
  return prisma.product.create({
    data: {
      venueId,
      categoryId,
      name: `Prenda ${o.sku}`,
      sku: o.sku,
      gtin: o.gtin ?? null,
      price: D(o.price ?? 1000),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId, currentStock: D(o.stock ?? 0) } },
    },
    include: { inventory: true },
  })
}

async function conexion(sid = staffId, oid = organizationId) {
  const scope = await resolveScope(sid, oid)
  scope.scopes = ['mcp:read', 'mcp:write']
  return conectarPorElCatalogo(server => registerCatalogInBulkTools(server, scope), scope)
}

const stockDe = async (productId: string) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { productId }, select: { currentStock: true } })).currentStock.toString()

describe('set_stock_by_code contra la base real', () => {
  test('🔴 la cantidad final queda, con UN movimiento COUNT de quien confirmó, en un conteo COMPLETED; repetir no mueve nada', async () => {
    const a = await producto({ sku: 'MAILEN-M', gtin: '8445000000017', stock: 0 })
    const b = await producto({ sku: 'DUENAS-M', stock: 2 })
    const c = await conexion()
    try {
      const items = [
        { code: '8445000000017', quantity: 5 },
        { code: 'DUEÑAS-M', quantity: 2 },
      ]
      const { vista, resultado } = await confirmarPorElCatalogo(c, 'set_stock_by_code', { venueId, items })
      expect(vista.changes).toEqual([expect.objectContaining({ sku: 'MAILEN-M', from: 0, to: 5 })])
      expect(resultado).toMatchObject({ ok: true, applied: 2, unchanged: 1, held: [], notApplied: [] })
      expect(resultado.changes).toEqual([expect.objectContaining({ sku: 'MAILEN-M', productId: a.id, from: 0, to: 5 })])
      expect(await stockDe(a.id)).toBe('5')
      expect(await stockDe(b.id)).toBe('2')
      const movimientos = await prisma.inventoryMovement.findMany({ where: { inventoryId: a.inventory!.id }, take: 5 })
      expect(movimientos).toHaveLength(1)
      expect(movimientos[0]).toMatchObject({ type: 'COUNT', createdBy: staffId })
      expect(movimientos[0].quantity.toString()).toBe('5')
      const conteo = await prisma.stockCount.findUniqueOrThrow({
        where: { id: resultado.countId },
        select: { status: true, note: true, createdById: true },
      })
      expect(conteo).toEqual({ status: 'COMPLETED', note: 'Conteo cargado desde la IA', createdById: staffId })
      await flushAudit()
      expect(await prisma.activityLog.count({ where: { venueId, action: 'STOCK_LEVELS_SET_BULK' } })).toBe(1)
      // Repetir la misma carga: ya no hay nada que cambiar.
      const otra = await c.call('set_stock_by_code', { venueId, items })
      expect(otra).toMatchObject({ ok: true, applied: 0, unchanged: 2 })
    } finally {
      await c.close()
    }
  })

  test('🔴 una venta entre la vista previa y la confirmación: no se aplica NADA ni se crea el conteo', async () => {
    const a = await producto({ sku: 'VENTA-M', stock: 10 })
    const c = await conexion()
    try {
      const vista = await c.call('set_stock_by_code', { venueId, items: [{ code: 'VENTA-M', quantity: 7 }] })
      expect(vista.requiresConfirmation).toBe(true)
      await prisma.inventory.update({ where: { productId: a.id }, data: { currentStock: { decrement: 1 } } }) // la venta
      const out = await c.call('set_stock_by_code', {
        ...vista.confirmationArguments,
        confirm: true,
        confirmationToken: vista.confirmationToken,
      })
      expect(out).toMatchObject({ ok: false, stale: true })
      expect(await stockDe(a.id)).toBe('9')
      expect(await prisma.stockCount.count({ where: { venueId } })).toBe(0)
    } finally {
      await c.close()
    }
  })

  test('🔴 ligado a Shopify con 2 apartadas: contar 9 deja 7, la respuesta lo dice y el guardia encola −3', async () => {
    let e: EscenarioShopify | null = null
    try {
      // En pausa (desde ACTIVE): el conteo no llama a Shopify y usa lo apartado que ya sabe; el guardia encola igual que en ACTIVE.
      e = await crearEscenarioShopify({ stock: 10, linkStatus: 'PAUSED', pausedFrom: 'ACTIVE', mirrorAvailable: 10, mirrorCommitted: 2 })
      await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } }) // plan de inventario
      const { sku } = await prisma.product.findUniqueOrThrow({ where: { id: e.productId }, select: { sku: true } })
      const c = await conexion(e.staffId, e.organizationId)
      try {
        const { vista, resultado } = await confirmarPorElCatalogo(c, 'set_stock_by_code', {
          venueId: e.venueId,
          items: [{ code: sku, quantity: 9 }],
        })
        expect(vista.changes[0]).toMatchObject({ from: 10, to: 9, shopify: true })
        expect(resultado.changes).toEqual([expect.objectContaining({ from: 10, to: 7, shopify: true })])
        expect(resultado.message).toContain('apartadas')
      } finally {
        await c.close()
      }
      expect(await stockDe(e.productId)).toBe('7')
      const buzon = await prisma.shopifyStockOutbox.findMany({
        where: { productId: e.productId },
        select: { delta: true, status: true },
        take: 5,
      })
      expect(buzon.map(f => [f.delta.toString(), f.status])).toEqual([['-3', 'PENDING']])
      const movimientos = await prisma.inventoryMovement.findMany({ where: { inventoryId: e.inventoryId, type: 'COUNT' }, take: 5 })
      expect(movimientos).toHaveLength(1)
      expect(movimientos[0]).toMatchObject({ createdBy: e.staffId })
      expect(movimientos[0].reason).toContain('apartadas')
    } finally {
      await flushAudit()
      if (e) await limpiarEscenarioShopify(e)
    }
  })

  test('🔴 reenviar la MISMA confirmación ya aplicada, con las ventas de regreso en el número de la vista previa, no vuelve a contar', async () => {
    const a = await producto({ sku: 'REENVIO-M', stock: 5 })
    const c = await conexion()
    try {
      const vista = await c.call('set_stock_by_code', { venueId, items: [{ code: 'REENVIO-M', quantity: 9 }] })
      expect(vista.requiresConfirmation).toBe(true)
      const confirmacion = { ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken }
      expect(await c.call('set_stock_by_code', confirmacion)).toMatchObject({ ok: true, applied: 1 })
      expect(await stockDe(a.id)).toBe('9')
      // Cuatro ventas lo regresan a las 5 de la vista previa; la misma confirmación (el token vive 10 min) llega otra vez.
      await prisma.inventory.update({ where: { productId: a.id }, data: { currentStock: D(5) } })
      const otra = await c.call('set_stock_by_code', confirmacion)
      expect(otra).toMatchObject({ ok: false, stale: true, needsInput: true })
      expect(otra.message).toContain('revisa primero los conteos recientes (stock_counts)')
      expect(await stockDe(a.id)).toBe('5')
      expect(await prisma.stockCount.count({ where: { venueId } })).toBe(1)
    } finally {
      await c.close()
    }
  })

  test('🔴 un producto que ya está en un conteo abierto no se carga: sale con ese conteo, se aplica sólo lo demás y el abierto queda igual', async () => {
    const p = await producto({ sku: 'ABIERTO-P', stock: 3 })
    const q = await producto({ sku: 'ABIERTO-Q', stock: 1 })
    const abierto = await createStockCount(venueId, staffId, 'CYCLE', [p.id]) // el del POS, sin terminar
    const c = await conexion()
    try {
      const { vista, resultado } = await confirmarPorElCatalogo(c, 'set_stock_by_code', {
        venueId,
        items: [
          { code: 'ABIERTO-P', quantity: 8 },
          { code: 'ABIERTO-Q', quantity: 4 },
        ],
      })
      expect(vista.inOpenCount).toEqual([{ code: 'ABIERTO-P', sku: 'ABIERTO-P', name: 'Prenda ABIERTO-P', countId: abierto.id }])
      expect(vista.changes).toEqual([expect.objectContaining({ sku: 'ABIERTO-Q', from: 1, to: 4 })])
      expect(vista.message).toContain('en un conteo abierto 1')
      expect(resultado).toMatchObject({ ok: true, applied: 1, inOpenCount: [expect.objectContaining({ countId: abierto.id })] })
      expect(resultado.countId).not.toBe(abierto.id)
    } finally {
      await c.close()
    }
    expect(await stockDe(q.id)).toBe('4')
    expect(await stockDe(p.id)).toBe('3')
    const despues = await prisma.stockCount.findUniqueOrThrow({
      where: { id: abierto.id },
      select: { status: true, revision: true, items: { select: { productId: true, countedAt: true, appliedAt: true } } },
    })
    expect(despues).toEqual({
      status: 'IN_PROGRESS',
      revision: abierto.revision,
      items: [{ productId: p.id, countedAt: null, appliedAt: null }],
    })
  })
})

describe('otro negocio con el mismo SKU y el mismo código de barras', () => {
  test('🔴 buscar, poner precios y cargar existencias en este negocio nunca encuentran ni cambian el producto del otro', async () => {
    const a = await producto({ sku: 'CRUCE-M', gtin: '8445000000123', price: 1000, stock: 2 })
    let otroId = ''
    let c: Awaited<ReturnType<typeof conexion>> | null = null
    try {
      // Mismo dueño en los dos negocios: su alcance incluye al otro, así que lo único que lo separa es el negocio de la llamada.
      const otro = await prisma.venue.create({
        data: { organizationId, name: `${fixture}-otro`, slug: `${fixture}-otro`, timezone: 'America/Mexico_City', currency: 'MXN' },
      })
      otroId = otro.id
      await prisma.staffVenue.create({ data: { staffId, venueId: otroId, role: 'ADMIN', active: true } })
      const categoriaOtro = await prisma.menuCategory.create({ data: { venueId: otroId, name: 'Vestidos', slug: `${fixture}-otro` } })
      const b = await prisma.product.create({
        data: {
          venueId: otroId,
          categoryId: categoriaOtro.id,
          name: 'Prenda del otro negocio',
          sku: 'CRUCE-M',
          gtin: '8445000000123',
          price: D(777),
          unit: 'UNIT',
          trackInventory: true,
          inventoryMethod: 'QUANTITY',
          inventory: { create: { venueId: otroId, currentStock: D(4) } },
        },
      })
      c = await conexion()

      const encontrados = await c.call('find_products_by_code', { venueId, codes: ['CRUCE-M', '8445000000123'] })
      expect(encontrados.found.map((f: { productId: string }) => f.productId)).toEqual([a.id, a.id])
      expect(encontrados).toMatchObject({ notFound: [], ambiguous: [], archived: [] })

      const precios = await confirmarPorElCatalogo(c, 'set_prices_by_code', { venueId, items: [{ code: 'CRUCE-M', price: 1290 }] })
      expect(precios.resultado).toMatchObject({ ok: true, applied: 1, appliedChanges: [expect.objectContaining({ productId: a.id })] })

      const existencias = await confirmarPorElCatalogo(c, 'set_stock_by_code', {
        venueId,
        items: [{ code: '8445000000123', quantity: 9 }],
      })
      expect(existencias.resultado).toMatchObject({ ok: true, applied: 1, changes: [expect.objectContaining({ productId: a.id })] })

      expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).price.toString()).toBe('1290')
      expect(await stockDe(a.id)).toBe('9')
      expect((await prisma.product.findUniqueOrThrow({ where: { id: b.id } })).price.toString()).toBe('777')
      expect(await stockDe(b.id)).toBe('4')
      expect(await prisma.stockCount.count({ where: { venueId: otroId } })).toBe(0)
    } finally {
      if (c) await c.close()
      await clearVenue(otroId)
      if (otroId) {
        await prisma.menuCategory.deleteMany({ where: { venueId: otroId } })
        await prisma.staffVenue.deleteMany({ where: { venueId: otroId } })
        await prisma.venue.deleteMany({ where: { id: otroId, organizationId } })
      }
    }
  })
})

describe('set_prices_by_code contra la base real', () => {
  test('cambia los precios y deja UNA bitácora del lote', async () => {
    const a = await producto({ sku: 'PRECIO-A', gtin: '8445000000079', price: 1000 })
    const b = await producto({ sku: 'PRECIO-B', price: 1500 })
    const c = await conexion()
    try {
      const { resultado } = await confirmarPorElCatalogo(c, 'set_prices_by_code', {
        venueId,
        items: [
          { code: '8445000000079', price: 1290.5 },
          { code: 'PRECIO-B', price: 1500 },
        ],
      })
      expect(resultado).toMatchObject({ ok: true, applied: 1, unchanged: 1 })
    } finally {
      await c.close()
    }
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).price.toString()).toBe('1290.5')
    expect((await prisma.product.findUniqueOrThrow({ where: { id: b.id } })).price.toString()).toBe('1500')
    await flushAudit()
    expect(await prisma.activityLog.count({ where: { venueId, action: 'MENU_PRICES_SET_BULK' } })).toBe(1)
  })

  test('si otra persona cambió el precio entre la vista previa y la confirmación, no se pisa', async () => {
    const a = await producto({ sku: 'PRECIO-C', price: 1000 })
    const c = await conexion()
    try {
      const vista = await c.call('set_prices_by_code', { venueId, items: [{ code: 'PRECIO-C', price: 1290 }] })
      await prisma.product.update({ where: { id: a.id }, data: { price: D(1100) } })
      const out = await c.call('set_prices_by_code', {
        ...vista.confirmationArguments,
        confirm: true,
        confirmationToken: vista.confirmationToken,
      })
      expect(out).toMatchObject({ ok: false, stale: true })
    } finally {
      await c.close()
    }
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).price.toString()).toBe('1100')
  })
})

describe('create_products contra la base real', () => {
  test('nacen con su código de barras y su inventario en 0; repetir la lista no crea duplicados', async () => {
    const items = [
      { name: 'Vestido Mailen MEX - M', price: 1290, category: 'vestidos', sku: 'MAILEN-MEX-M', barcode: '8445000000086' },
      { name: 'Vestido Mailen MEX - L', price: 1290, category: 'Vestidos', sku: 'MAILEN-MEX-L', barcode: '8445000000093' },
    ]
    const c = await conexion()
    try {
      const { resultado } = await confirmarPorElCatalogo(c, 'create_products', { venueId, items })
      expect(resultado).toMatchObject({ ok: true, created: 2, failed: [] })
      const creados = await prisma.product.findMany({
        where: { venueId, sku: { in: ['MAILEN-MEX-M', 'MAILEN-MEX-L'] } },
        select: {
          gtin: true,
          trackInventory: true,
          inventoryMethod: true,
          categoryId: true,
          inventory: { select: { currentStock: true } },
        },
        take: 5,
      })
      expect(creados).toHaveLength(2)
      for (const p of creados) {
        expect(p).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY', categoryId })
        expect(p.inventory?.currentStock.toString()).toBe('0')
      }
      expect(creados.map(p => p.gtin).sort()).toEqual(['8445000000086', '8445000000093'])
      // Repetirla (p. ej. tras perder la respuesta) no es un error: todo ya existe.
      const otra = await c.call('create_products', { venueId, items })
      expect(otra).toMatchObject({ ok: true, created: 0 })
      expect(otra.message).toContain('ya existen')
      expect(otra.invalid.map((i: { problem: string }) => i.problem)).toEqual(['SKU_YA_USADO', 'SKU_YA_USADO'])
    } finally {
      await c.close()
    }
  })

  test('🔍 repetir el alta sin SKU ni código no crea otro producto', async () => {
    const items = [{ name: 'Blusa Lino', price: 890, category: 'Vestidos' }]
    const c = await conexion()
    try {
      const { resultado } = await confirmarPorElCatalogo(c, 'create_products', { venueId, items })
      expect(resultado).toMatchObject({ ok: true, created: 1 })
      const otra = await confirmarPorElCatalogo(c, 'create_products', { venueId, items })
      expect(otra.resultado).toBeNull()
      expect(otra.vista).toMatchObject({ ok: true, created: 0 })
      expect(otra.vista.invalid[0].problem).toBe('SKU_YA_USADO')
      expect(await prisma.product.count({ where: { venueId, name: 'Blusa Lino' } })).toBe(1)
    } finally {
      await c.close()
    }
  })
})

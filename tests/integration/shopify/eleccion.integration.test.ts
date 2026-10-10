// tests/integration/shopify/eleccion.integration.test.ts
/**
 * D1 (spec 2026-10-10-conector-shopify-d1-eleccion-por-producto-design.md): al conectar o reconectar, cada producto que ya
 * existía en Avoqado y no cuadra con «Shopify al importar + pendientes» espera la elección del dueño, y «Aplicar» se niega
 * mientras falte alguna. Postgres real; Shopify por deps.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  applyConnectPage,
  devolverAVistaPrevia,
  getConnectReview,
  requestApplyShopifyConnect,
  saveConnectChoices,
  type VistaConexion,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import { importCatalogPage } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { claimShopifyOutbox, runShopifyOutboxRow } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import { getShopifyOverview } from '@/services/commerce-channels/shopify/shopify.overview.service'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
  UBICACION_PRUEBA,
} from './fixtures'
import { conPlan, nivel, nivelesFalsos, paginaDeVariantes, tiendaFalsa, variante } from './fixturesB'

jest.setTimeout(120_000)

let escenarios: EscenarioShopify[] = []
beforeAll(() => assertTestDatabase())
beforeEach(() => (logAction as jest.Mock).mockClear())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

/** Sucursal en «Así quedará tu stock»: Avoqado `stock`, Shopify al importar `importado` y, si viene, una venta en camino. */
async function enRevision(o: { stock: number; importado: number; pendiente?: number }): Promise<EscenarioShopify> {
  // El espejo es entero (Int): con un stock con decimales se deja en su parte entera; la pareja está sin iniciar y no lo lee.
  const e = await crearEscenarioShopify({
    linkStatus: 'REVIEWING',
    initialized: false,
    stock: o.stock,
    mirrorAvailable: Math.trunc(o.stock),
  })
  escenarios.push(e)
  await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { importedAvailable: o.importado } })
  if (o.pendiente) {
    await prisma.shopifyStockOutbox.create({
      data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation: 1, productId: e.productId, delta: o.pendiente },
    })
  }
  return e
}
const vista = (e: EscenarioShopify, offset = 0, limit = 20) => getConnectReview({ venueId: e.venueId, offset, limit, filtro: 'CAMBIAN' })
/** La conexión que la pantalla tiene en la mano (la devuelve la vista previa). */
const vistaDe = async (e: EscenarioShopify): Promise<VistaConexion> => (await vista(e)).conexion!
async function elegir(
  e: EscenarioShopify,
  choice: 'AVOQADO' | 'SHOPIFY',
  avoqado: string,
  shopify: number,
  o: { variantLinkId?: string; vista?: VistaConexion } = {},
) {
  return saveConnectChoices(
    {
      venueId: e.venueId,
      staffId: e.staffId,
      vista: o.vista ?? (await vistaDe(e)),
      elecciones: [{ variantLinkId: o.variantLinkId ?? e.variantLinkId, choice, expectedAvoqadoQty: avoqado, expectedShopifyQty: shopify }],
    },
    { hasAccess: conPlan },
  )
}
const enTodos = async (e: EscenarioShopify, todos: 'AVOQADO' | 'SHOPIFY') =>
  saveConnectChoices({ venueId: e.venueId, staffId: e.staffId, vista: await vistaDe(e), todos }, { hasAccess: conPlan })
const aplicar = (e: EscenarioShopify) => requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
/** Una venta en caja durante la vista previa: el guardia la encola (REVIEWING encola cualquier producto, 12 bis.2). */
const venta = (e: EscenarioShopify, inventoryId = e.inventoryId) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${inventoryId}`

describe('D1 · la vista previa dice qué productos piden elegir', () => {
  it('🔴 pide elegir el que ya existía y no cuadra (también con cero); los nuevos, los que cuadran, sin Inventory o suspendidos, no', async () => {
    const e = await enRevision({ stock: 0, importado: 4 })
    const nuevo = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
    await prisma.shopifyVariantLink.update({ where: { id: nuevo.variantLinkId! }, data: { importedAvailable: 4 } })
    const igual = await agregarProductoShopify(e, { stock: 5, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: igual.variantLinkId! }, data: { importedAvailable: 5 } })
    const sinInventario = await agregarProductoShopify(e, { stock: 3, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: sinInventario.variantLinkId! }, data: { importedAvailable: 5 } })
    await prisma.inventory.delete({ where: { id: sinInventario.inventoryId } })
    // Review Focus 5: una pareja suspendida (pasó a receta, por ejemplo) no pide elegir.
    const suspendida = await agregarProductoShopify(e, { stock: 3, initialized: false })
    await prisma.shopifyVariantLink.update({
      where: { id: suspendida.variantLinkId! },
      data: { importedAvailable: 5, suspendedReason: 'SIN_INVENTARIO', suspendedAt: new Date() },
    })

    const v = await vista(e, 0, 50)
    expect(v.resumen.porDecidir).toBe(1)
    expect(v.conexion).toEqual({ linkId: e.locationLinkId, generation: 1, tokenVersion: 1 })
    const fila = (id: string) => v.items.find(i => i.variantLinkId === id)
    expect(fila(e.variantLinkId)).toMatchObject({ avoqadoQty: '0', shopifyQty: 4, quedara: '4', requiereDecision: true, eleccion: null })
    expect(fila(sinInventario.variantLinkId!)).toMatchObject({ requiereDecision: false })
    expect(fila(suspendida.variantLinkId!)).toMatchObject({ requiereDecision: false })
    expect(fila(igual.variantLinkId!)).toBeUndefined() // ya cuadra: no «cambia»
    const todos = await getConnectReview({ venueId: e.venueId, offset: 0, limit: 50, filtro: 'TODOS' })
    expect(todos.items.find(i => i.variantLinkId === nuevo.variantLinkId)).toMatchObject({ nuevo: true, requiereDecision: false })
  })

  it('con ids trae sólo esos productos (≤ 50) y el resumen sigue siendo el de TODAS las páginas', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const otro = await agregarProductoShopify(e, { stock: 1, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: otro.variantLinkId! }, data: { importedAvailable: 3 } })
    const v = await getConnectReview({ venueId: e.venueId, offset: 0, limit: 50, filtro: 'TODOS', ids: [e.variantLinkId] })
    expect(v.items.map(i => i.variantLinkId)).toEqual([e.variantLinkId])
    expect(v.total).toBe(1)
    expect(v.resumen.porDecidir).toBe(2)
  })
})

describe('D1 · guardar la elección', () => {
  it('guarda la elección con los números vistos: la vista previa la enseña, ya no falta y queda en la bitácora', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    expect(await elegir(e, 'AVOQADO', '5', 6)).toEqual({ guardadas: 1, porDecidir: 0 })
    const v = await vista(e)
    expect(v.resumen.porDecidir).toBe(0)
    expect(v.items[0]).toMatchObject({ requiereDecision: true, eleccion: 'AVOQADO' })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      connectChoice: 'AVOQADO',
      connectChoiceGeneration: 1,
      connectChoiceTokenVersion: 1,
      connectSeenShopifyQty: 6,
      connectChoiceById: e.staffId,
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_CONNECT_CHOICES_SAVED',
        entity: 'ShopifyLocationLink',
        entityId: e.locationLinkId,
        staffId: e.staffId,
        data: { elecciones: [{ productId: e.productId, eleccion: 'AVOQADO', avoqado: '5', shopify: 6 }] },
      }),
    )
    // Cambiar de opinión antes de aplicar: la última gana.
    expect(await elegir(e, 'SHOPIFY', '5', 6)).toEqual({ guardadas: 1, porDecidir: 0 })
    expect((await vista(e)).items[0].eleccion).toBe('SHOPIFY')
  })

  it('🔴 números distintos de los vistos ⇒ 409 SHOPIFY_REVISION_CAMBIO y no se guarda nada', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await expect(elegir(e, 'SHOPIFY', '4', 6)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_REVISION_CAMBIO' })
    await expect(elegir(e, 'SHOPIFY', '5', 7)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_REVISION_CAMBIO' })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).connectChoice).toBeNull()
  })

  it('🔴 P1-2: una pantalla vieja (reconectó o reautorizó) ⇒ 409 SHOPIFY_CONEXION_CAMBIO «vuelve a cargar» y nada se guarda', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const vieja = await vistaDe(e)
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } }) // reautorizar
    await expect(elegir(e, 'AVOQADO', '5', 6, { vista: vieja })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_CONEXION_CAMBIO',
      message: expect.stringContaining('vuelve a cargar'),
    })
    await expect(
      saveConnectChoices({ venueId: e.venueId, staffId: e.staffId, vista: vieja, todos: 'AVOQADO' }, { hasAccess: conPlan }),
    ).rejects.toMatchObject({ code: 'SHOPIFY_CONEXION_CAMBIO' })
    await expect(elegir(e, 'AVOQADO', '5', 6, { vista: { ...(await vistaDe(e)), generation: 2 } })).rejects.toMatchObject({
      code: 'SHOPIFY_CONEXION_CAMBIO',
    })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).connectChoice).toBeNull()
    expect(await elegir(e, 'AVOQADO', '5', 6)).toEqual({ guardadas: 1, porDecidir: 0 }) // con la vista vigente, sí
  })

  it('🔴 Review Focus 4: «Avoqado» con decimales ⇒ 422 al guardar (nunca nace una fila no entera); «Shopify» sí se puede', async () => {
    const e = await enRevision({ stock: 2.5, importado: 4 })
    await expect(elegir(e, 'AVOQADO', '2.5', 4)).rejects.toMatchObject({ statusCode: 422, code: 'SHOPIFY_DIFERENCIA_NO_ENTERA' })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).connectChoice).toBeNull()
    expect(await elegir(e, 'SHOPIFY', '2.5', 4)).toEqual({ guardadas: 1, porDecidir: 0 })
  })

  it('sólo con plan, en «Así quedará» sin aplicar, en esta sucursal y sin productos repetidos', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const v = await vistaDe(e)
    const una = { variantLinkId: e.variantLinkId, choice: 'SHOPIFY' as const, expectedAvoqadoQty: '5', expectedShopifyQty: 6 }
    await expect(
      saveConnectChoices({ venueId: e.venueId, staffId: e.staffId, vista: v, elecciones: [una] }, { hasAccess: async () => false }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'SHOPIFY_SIN_PLAN' })
    await expect(
      saveConnectChoices({ venueId: e.venueId, staffId: e.staffId, vista: v, elecciones: [una, una] }, { hasAccess: conPlan }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SHOPIFY_CANTIDAD_INVALIDA' })
    const otra = await enRevision({ stock: 1, importado: 2 })
    await expect(elegir(e, 'SHOPIFY', '1', 2, { variantLinkId: otra.variantLinkId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_SIN_PAREJA',
    })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    await expect(elegir(e, 'SHOPIFY', '5', 6)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_NO_EN_REVISION' })
  })
})

describe('D1 · «Usar … en todos»', () => {
  it('🔴 elige en TODOS los que faltan, también en páginas que nadie abrió; los ya elegidos se quedan y un cambio después por producto gana', async () => {
    const e = await enRevision({ stock: 10, importado: 10 }) // éste cuadra: no pide elegir
    const productos = []
    for (let n = 0; n < 21; n++) {
      const p = await agregarProductoShopify(e, { stock: 3, initialized: false })
      await prisma.shopifyVariantLink.update({ where: { id: p.variantLinkId! }, data: { importedAvailable: 5 } })
      productos.push(p)
    }
    // Uno ya elegido a mano antes: «en todos» no lo pisa.
    await elegir(e, 'SHOPIFY', '3', 5, { variantLinkId: productos[0].variantLinkId! })
    expect(await enTodos(e, 'AVOQADO')).toEqual({ guardadas: 20, porDecidir: 0 })
    const eleccionDe = async (variantLinkId: string) =>
      (await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: variantLinkId } })).connectChoice
    expect(await eleccionDe(productos[0].variantLinkId!)).toBe('SHOPIFY')
    expect(await eleccionDe(productos[20].variantLinkId!)).toBe('AVOQADO') // en la página 2, que nadie abrió
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_CONNECT_CHOICES_SAVED', data: { todos: 'AVOQADO', guardadas: 20 } }),
    )
    // Un cambio por producto después gana sobre «en todos».
    await elegir(e, 'SHOPIFY', '3', 5, { variantLinkId: productos[5].variantLinkId! })
    expect(await eleccionDe(productos[5].variantLinkId!)).toBe('SHOPIFY')
    await expect(aplicar(e)).resolves.toMatchObject({ applyRequestedAt: expect.any(Date) })
  })

  it('«en todos» sin ninguno por elegir no escribe nada ni deja rastro en la bitácora (un no-op no se registra)', async () => {
    const e = await enRevision({ stock: 6, importado: 6 }) // cuadra: no pide elegir
    expect(await enTodos(e, 'AVOQADO')).toEqual({ guardadas: 0, porDecidir: 0 })
    expect((logAction as jest.Mock).mock.calls.map(c => c[0]).filter(a => a.action === 'SHOPIFY_CONNECT_CHOICES_SAVED')).toEqual([])
    expect(await prisma.activityLog.count({ where: { venueId: e.venueId, action: 'SHOPIFY_CONNECT_CHOICES_SAVED' } })).toBe(0)
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).connectChoice).toBeNull()
  })

  it('Review Focus 4: «Usar Avoqado en todos» se salta el producto con decimales; ése se queda por elegir y «Aplicar» lo espera', async () => {
    const e = await enRevision({ stock: 2.5, importado: 4 })
    const entero = await agregarProductoShopify(e, { stock: 3, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: entero.variantLinkId! }, data: { importedAvailable: 5 } })
    expect(await enTodos(e, 'AVOQADO')).toEqual({ guardadas: 1, porDecidir: 1 })
    await expect(aplicar(e)).rejects.toMatchObject({ code: 'SHOPIFY_FALTAN_DECISIONES' })
    expect(await enTodos(e, 'SHOPIFY')).toEqual({ guardadas: 1, porDecidir: 0 })
  })
})

describe('D1 · «Aplicar» se niega mientras falte alguna', () => {
  it('🔴 una venta durante la vista previa invalida la elección: vuelve a faltar y «Aplicar» contesta 422', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await elegir(e, 'AVOQADO', '5', 6)
    await venta(e)
    const v = await vista(e)
    expect(v.resumen.porDecidir).toBe(1)
    expect(v.items[0]).toMatchObject({ avoqadoQty: '4', quedara: '5', requiereDecision: true, eleccion: null })
    await expect(aplicar(e)).rejects.toMatchObject({
      statusCode: 422,
      code: 'SHOPIFY_FALTAN_DECISIONES',
      message: expect.stringContaining('1 producto'),
    })
    expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).applyRequestedAt).toBeNull()
    await elegir(e, 'AVOQADO', '4', 6) // vuelve a elegir con lo de ahora
    await expect(aplicar(e)).resolves.toMatchObject({ applyRequestedAt: expect.any(Date) })
  })

  it('🔴 una elección de otra generación o de otra credencial no cuenta', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await elegir(e, 'SHOPIFY', '5', 6)
    expect((await vista(e)).resumen.porDecidir).toBe(0)
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } }) // reconectar
    expect((await vista(e)).resumen.porDecidir).toBe(1)
    await expect(aplicar(e)).rejects.toMatchObject({ code: 'SHOPIFY_FALTAN_DECISIONES' })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 1 } })
    expect((await vista(e)).resumen.porDecidir).toBe(0)
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } }) // reautorizar
    expect((await vista(e)).resumen.porDecidir).toBe(1)
    expect((await vista(e)).items[0].eleccion).toBeNull()
  })

  it('🔴 una decisión que falta en una página que nadie abrió también bloquea «Aplicar»', async () => {
    const e = await enRevision({ stock: 10, importado: 10 })
    for (let n = 0; n < 21; n++) {
      const p = await agregarProductoShopify(e, { stock: 3, initialized: false })
      await prisma.shopifyVariantLink.update({ where: { id: p.variantLinkId! }, data: { importedAvailable: 5 } })
    }
    const pagina1 = await vista(e, 0, 20)
    expect(pagina1).toMatchObject({ total: 21, nextOffset: 20 })
    expect(pagina1.resumen.porDecidir).toBe(21)
    const r = await saveConnectChoices(
      {
        venueId: e.venueId,
        staffId: e.staffId,
        vista: pagina1.conexion!,
        elecciones: pagina1.items.map(i => ({
          variantLinkId: i.variantLinkId,
          choice: 'SHOPIFY' as const,
          expectedAvoqadoQty: i.avoqadoQty,
          expectedShopifyQty: i.shopifyQty!,
        })),
      },
      { hasAccess: conPlan },
    )
    expect(r).toEqual({ guardadas: 20, porDecidir: 1 })
    await expect(aplicar(e)).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining('1 producto') })
    const pagina2 = await vista(e, 20, 20)
    expect(pagina2.items).toHaveLength(1)
    await elegir(e, 'AVOQADO', pagina2.items[0].avoqadoQty, pagina2.items[0].shopifyQty!, { variantLinkId: pagina2.items[0].variantLinkId })
    await expect(aplicar(e)).resolves.toMatchObject({ applyRequestedAt: expect.any(Date) })
  })

  it('sin nada que elegir, «Aplicar» se pide como siempre (regresión)', async () => {
    const e = await enRevision({ stock: 6, importado: 6 })
    expect((await vista(e)).resumen.porDecidir).toBe(0)
    await expect(aplicar(e)).resolves.toMatchObject({ applyRequestedAt: expect.any(Date) })
    expect(new Prisma.Decimal((await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock).toString()).toBe(
      '6',
    )
  })
})

const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const stock = async (inventoryId: string) =>
  new Prisma.Decimal((await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).currentStock).toString()
const espejo = async (productId: string) => (await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId } })).mirrorAvailable
const vivas = async (productId: string) =>
  prisma.shopifyStockOutbox.findMany({
    where: { productId, status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10,
  })
const deltas = async (productId: string) => (await vivas(productId)).map(f => f.delta.toString())
type TiendaFalsa = ReturnType<typeof tiendaFalsa>
/** Corre las tandas de «Aplicar» hasta ACTIVE (o 5 vueltas). */
async function aplicarTodo(e: EscenarioShopify, fetchLevels: TiendaFalsa['fetchLevels']) {
  for (let n = 0; n < 5 && (await sucursal(e)).status !== 'ACTIVE'; n++)
    await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })
}
/** El mensajero contra una Shopify CON estado (`tiendaFalsa`): cada envío mueve su `s.available`. */
async function enviar(t: TiendaFalsa) {
  for (let n = 0; n < 20; n++) {
    const c = await claimShopifyOutbox(new Date())
    if (c.kind === 'VACIO') return
    if (c.kind === 'FILA') await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: t.graphql as never, hasAccess: conPlan })
  }
  throw new Error('el buzón no se vació')
}
const inicios = (productId: string) =>
  (logAction as jest.Mock).mock.calls.map(c => c[0]).filter(a => a.action === 'SHOPIFY_STOCK_INITIALIZED' && a.entityId === productId)
/** El conteo REAL del POS (`confirmStockCount`) de un producto. */
async function contarProducto(e: EscenarioShopify, productId: string, contado: string) {
  const c = await prisma.stockCount.create({
    data: {
      venueId: e.venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      createdById: e.staffId,
      items: { create: { productId, expected: new Prisma.Decimal(5), counted: new Prisma.Decimal(contado), countedAt: new Date() } },
    },
  })
  return confirmStockCount(c.id, e.venueId, e.staffId, 0, { hasAccess: conPlan })
}

describe('D1 · aplicar la elección dentro de la tx de cada producto', () => {
  it('🔴 spec: Avoqado 5, Shopify 6 ⇒ «Avoqado»: Inventory 5, espejo 6 y −1 en camino; ACTIVE sin esperar el envío; enviado, Shopify 5', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const t = tiendaFalsa(6, 0)
    await elegir(e, 'AVOQADO', '5', 6)
    await aplicar(e)
    await aplicarTodo(e, t.fetchLevels)
    expect((await sucursal(e)).status).toBe('ACTIVE') // la fila sigue PENDING: ACTIVE no espera a SENT
    expect(await stock(e.inventoryId)).toBe('5')
    expect(await espejo(e.productId)).toBe(6)
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(await huecoDelInvariante(e.productId)).toBe('0') // N3: 5 = 6 + (−1)
    const [hecho] = inicios(e.productId)
    expect(hecho).toMatchObject({
      staffId: e.staffId,
      data: {
        previo: '5',
        nuevo: '5',
        eleccion: 'AVOQADO',
        shopify: 6,
        pendientes: '0',
        ajuste: '-1',
        envio: (await vivas(e.productId))[0].id,
      },
    })
    await enviar(t)
    expect([await stock(e.inventoryId), t.s.available, await espejo(e.productId)]).toEqual(['5', 5, 5])
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('🔴 no descuenta dos veces: con una venta en camino, «Avoqado» encola A − S − pendientes y Shopify termina en A', async () => {
    // Durante la conexión se vendió 1 (Avoqado 4 y su −1 en camino); Shopify al importar tenía 6.
    const e = await enRevision({ stock: 4, importado: 6, pendiente: -1 })
    const t = tiendaFalsa(6, 0)
    expect((await vista(e)).items[0]).toMatchObject({ avoqadoQty: '4', quedara: '5', requiereDecision: true })
    await elegir(e, 'AVOQADO', '4', 6)
    await aplicar(e)
    await aplicarTodo(e, t.fetchLevels)
    expect(await deltas(e.productId)).toEqual(['-1', '-1']) // la venta y el ajuste: 4 − 6 − (−1) = −1, nunca −2
    expect(await huecoDelInvariante(e.productId)).toBe('0')
    await enviar(t)
    expect([await stock(e.inventoryId), t.s.available]).toEqual(['4', 4])
  })

  it('«Shopify» es la mecánica de siempre: Inventory = S + pendientes, Shopify termina igual y la bitácora dice quién lo eligió', async () => {
    const e = await enRevision({ stock: 3, importado: 5, pendiente: -1 })
    const t = tiendaFalsa(5, 0)
    await elegir(e, 'SHOPIFY', '3', 5)
    await aplicar(e)
    await aplicarTodo(e, t.fetchLevels)
    expect(await stock(e.inventoryId)).toBe('4')
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(inicios(e.productId)).toEqual([
      expect.objectContaining({
        staffId: e.staffId,
        data: expect.objectContaining({ previo: '3', nuevo: '4', eleccion: 'SHOPIFY', shopify: 5, envio: null }),
      }),
    ])
    expect((await prisma.inventoryMovement.findFirstOrThrow({ where: { inventoryId: e.inventoryId } })).createdBy).toBe(e.staffId)
    await enviar(t)
    expect([await stock(e.inventoryId), t.s.available]).toEqual(['4', 4])
  })

  it('🔴 P1-1: un producto que se vio 5/5 (no pedía elegir) y cuya lectura fresca da 6 NO se aplica en silencio: vuelve a pedir elegir', async () => {
    const e = await enRevision({ stock: 5, importado: 5 })
    expect((await vista(e)).resumen.porDecidir).toBe(0)
    await aplicar(e)
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: nivelesFalsos(() => nivel(6)), hasAccess: conPlan })).toEqual({
      done: false,
      procesadas: 0,
      devuelta: true,
    })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      importedAvailable: 6,
      initializedAt: null,
    })
    expect(await stock(e.inventoryId)).toBe('5')
    expect((await sucursal(e)).applyRequestedAt).toBeNull()
    expect((await vista(e)).items[0]).toMatchObject({ avoqadoQty: '5', shopifyQty: 6, requiereDecision: true, eleccion: null })
  })

  it('🔴 P1-3: al primer producto que ya no vale, la tanda termina y la conexión regresa; tres vueltas más no la dejan en «Aplicando»', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const otro = await agregarProductoShopify(e, { stock: 3, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: otro.variantLinkId! }, data: { importedAvailable: 5 } })
    await enTodos(e, 'AVOQADO')
    await aplicar(e)
    await venta(e) // la elección del primero (vio 5) ya no vale
    await venta(e, otro.inventoryId) // ni la del segundo
    const lectura = nivelesFalsos(item => nivel(item === 'gid://shopify/InventoryItem/1' ? 6 : 5))
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: lectura, hasAccess: conPlan })).toMatchObject({ devuelta: true })
    for (let n = 0; n < 3; n++) {
      expect(await applyConnectPage(e.locationLinkId, { fetchLevels: lectura, hasAccess: conPlan })).toEqual({ done: false, procesadas: 0 })
    }
    expect(lectura).toHaveBeenCalledTimes(1) // la tanda terminó en el primero: nadie vuelve a leer las mismas filas
    expect((await getShopifyOverview(e.venueId)).connection).toMatchObject({ estado: 'POR_APLICAR' })
    expect(await deltas(e.productId)).toEqual(['-1'])
    expect(await deltas(otro.productId)).toEqual(['-1'])
    expect((logAction as jest.Mock).mock.calls.map(c => c[0]).filter(a => a.action === 'SHOPIFY_APPLY_RETURNED')).toHaveLength(1)
  })

  it('🔴 lo ya aplicado no se repite: el ajuste conserva su ÚNICO id aunque la conexión regrese a la vista previa y se vuelva a aplicar', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    const otro = await agregarProductoShopify(e, { stock: 3, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: otro.variantLinkId! }, data: { importedAvailable: 5 } })
    await enTodos(e, 'AVOQADO')
    await aplicar(e)
    await venta(e, otro.inventoryId) // sólo la del segundo deja de valer
    const lectura = nivelesFalsos(item => nivel(item === 'gid://shopify/InventoryItem/1' ? 6 : 5))
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: lectura, hasAccess: conPlan })).toMatchObject({ devuelta: true })
    // Vuelve a elegir el segundo (Avoqado 2, Shopify 5, venta −1 ⇒ ajuste −2) y aplica hasta ACTIVE.
    await elegir(e, 'AVOQADO', '2', 5, { variantLinkId: otro.variantLinkId! })
    await aplicar(e)
    await aplicarTodo(e, lectura)
    expect((await sucursal(e)).status).toBe('ACTIVE')
    const delPrimero = await vivas(e.productId)
    expect(delPrimero.map(f => f.delta.toString())).toEqual(['-1'])
    expect(inicios(e.productId)).toHaveLength(1)
    expect(inicios(e.productId)[0].data.envio).toBe(delPrimero[0].id) // la MISMA fila, una sola vez
    expect(await deltas(otro.productId)).toEqual(['-1', '-2'])
    // Otra vuelta ya en ACTIVE no toca nada.
    await applyConnectPage(e.locationLinkId, { fetchLevels: lectura, hasAccess: conPlan })
    expect((await vivas(e.productId)).map(f => f.id)).toEqual([delPrimero[0].id])
  })

  it('🔴 Review Focus 2: Shopify vendió en línea entre la vista previa y el aplicar ⇒ nada se aplica y la vista previa enseña el número nuevo', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await elegir(e, 'AVOQADO', '5', 6)
    await aplicar(e)
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: nivelesFalsos(() => nivel(7)), hasAccess: conPlan })).toMatchObject({
      devuelta: true,
    })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      importedAvailable: 7,
      initializedAt: null,
      mirrorAvailable: 5, // el espejo no se tocó (el del escenario)
    })
    expect(await stock(e.inventoryId)).toBe('5')
    expect(await deltas(e.productId)).toEqual([])
    expect((await vista(e)).items[0]).toMatchObject({ shopifyQty: 7, quedara: '7', requiereDecision: true, eleccion: null })
  })

  it('🔴 Review Focus 1: reautorizar entre elegir y aplicar ⇒ la elección vieja no se aplica con la credencial nueva', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await elegir(e, 'AVOQADO', '5', 6)
    await aplicar(e)
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } })
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: nivelesFalsos(() => nivel(6)), hasAccess: conPlan })).toMatchObject({
      devuelta: true,
    })
    expect(await deltas(e.productId)).toEqual([])
    expect((await sucursal(e)).applyRequestedAt).toBeNull()
  })

  it('🔴 P2-4: regresar a la vista previa exige el cerco completo y una aplicación pedida; si no, no toca nada', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const cerco = { generation: 1, storeId: e.storeId, shopifyLocationId: UBICACION_PRUEBA, tokenVersion: 1 }
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } }) // credencial renovada
    expect(await devolverAVistaPrevia(e.locationLinkId, cerco, e.variantLinkId)).toBe(false)
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 1, status: 'REVOKED' } }) // tienda revocada
    expect(await devolverAVistaPrevia(e.locationLinkId, cerco, e.variantLinkId)).toBe(false)
    expect((await sucursal(e)).applyRequestedAt).not.toBeNull()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE' } })
    expect(await devolverAVistaPrevia(e.locationLinkId, cerco, e.variantLinkId)).toBe(true)
    expect((await sucursal(e)).applyRequestedAt).toBeNull()
    expect(await devolverAVistaPrevia(e.locationLinkId, cerco, e.variantLinkId)).toBe(false) // ya no hay aplicación pedida
  })

  it('Review Focus 5: el producto elegido pasó a receta antes de aplicar ⇒ se suspende sin encolar ajuste y no frena el ACTIVE', async () => {
    const e = await enRevision({ stock: 5, importado: 6 })
    await elegir(e, 'AVOQADO', '5', 6)
    await aplicar(e)
    await prisma.product.update({ where: { id: e.productId }, data: { inventoryMethod: 'RECIPE' } }) // por SQL, sin los ayudantes
    await aplicarTodo(
      e,
      nivelesFalsos(() => nivel(6)),
    )
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await deltas(e.productId)).toEqual([])
    expect((await sucursal(e)).status).toBe('ACTIVE')
  })

  it.each([
    ['AVOQADO', '8', ['3', '-5'], 8],
    ['SHOPIFY', '13', ['3'], 13],
  ] as const)(
    '🔴 hueco de la ronda 3: un producto SIN pareja contado (conteo real) durante CONNECTING y ligado después; con «%s» los dos lados quedan en %s',
    async (eleccion, avoqadoFinal, deltasEsperados, shopifyFinal) => {
      const e = await crearEscenarioShopify({ linkStatus: 'CONNECTING', initialized: false })
      escenarios.push(e)
      const p = await agregarProductoShopify(e, { sku: 'R3-SKU', stock: 5, pareja: false })
      // El conteo de un producto sin pareja no se retiene (§7): queda Inventory = 8 y el guardia encola +3.
      expect(await contarProducto(e, p.productId, '8')).not.toHaveProperty('noAplicados')
      expect(await stock(p.inventoryId)).toBe('8')
      const pagina = graphqlFalso(() => paginaDeVariantes([variante(1, { sku: 'R3-SKU', barcode: null, available: 10 })], null))
      expect(await importCatalogPage(e.locationLinkId, { graphql: pagina, hasAccess: conPlan })).toEqual({ done: true, procesadas: 1 })
      const ligada = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId: p.productId } })
      expect((await vista(e)).items.find(i => i.variantLinkId === ligada.id)).toMatchObject({
        avoqadoQty: '8',
        shopifyQty: 10,
        quedara: '13', // «Usar el de Shopify» dejaría 13: el dueño lo ve antes de aplicar
        requiereDecision: true,
      })
      const t = tiendaFalsa(10, 0)
      await elegir(e, eleccion, '8', 10, { variantLinkId: ligada.id })
      await aplicar(e)
      await aplicarTodo(e, t.fetchLevels)
      expect((await sucursal(e)).status).toBe('ACTIVE')
      expect(await stock(p.inventoryId)).toBe(avoqadoFinal)
      expect(await deltas(p.productId)).toEqual(deltasEsperados)
      await enviar(t)
      expect(t.s.available).toBe(shopifyFinal)
      expect(await huecoDelInvariante(p.productId)).toBe('0')
    },
  )
})

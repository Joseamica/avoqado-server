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
  getConnectReview,
  requestApplyShopifyConnect,
  saveConnectChoices,
  type VistaConexion,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import { agregarProductoShopify, assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'
import { conPlan } from './fixturesB'

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

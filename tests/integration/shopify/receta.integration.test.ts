/**
 * Pasar un producto ligado a receta (B7, 12 bis.5): la pareja se suspende ANTES de borrar su Inventory; nada viaja a
 * Shopify. Al volver a cantidad, el cuadre la reactiva COMPARANDO. Receta y archivo a la vez no se traban (N24).
 * Postgres real.
 */
import prisma from '@/utils/prismaClient'
import { switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { setProductInventoryMethod } from '@/services/dashboard/productInventoryIntegration.service'
import { archiveShopifyProduct } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { reconcileVenue } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import { agregarProductoShopify, assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'
import { conPlan, dormir, graphqlDelCatalogo, nivel, nivelesFalsos, variantesDeLaSucursal } from './fixturesB'

jest.setTimeout(120_000)
let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})
const pareja = (e: EscenarioShopify) => prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const sinCuadrePedido = (e: EscenarioShopify) =>
  prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { needsReconcile: false } })
/** Los DOS caminos que pasan un producto a receta o a cantidad (12 bis.5): el interruptor del asistente y el PUT inventory-method / MCP. */
const caminos = [
  ['switchInventoryMethod', (e: EscenarioShopify, m: 'RECIPE' | 'QUANTITY') => switchInventoryMethod(e.venueId, e.productId, m)],
  ['setProductInventoryMethod', (e: EscenarioShopify, m: 'RECIPE' | 'QUANTITY') => setProductInventoryMethod(e.venueId, e.productId, m)],
] as const

it('a receta: la pareja queda SIN_INVENTARIO, el Inventory se borra, nada viaja y aparece en «Productos sin pareja»', async () => {
  const e = await escenario()
  await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // una fila viva
  await switchInventoryMethod(e.venueId, e.productId, 'RECIPE')
  expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
  expect(await prisma.inventory.count({ where: { productId: e.productId } })).toBe(0)
  expect(await prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { status: true }, take: 5 })).toEqual([
    { status: 'DISCARDED' },
  ])
  expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({
    reason: 'SIN_INVENTARIO',
    productId: e.productId,
  })
})

it('de vuelta a cantidad + cuadre ⇒ se reactiva COMPARANDO y abre «Por revisar» si Shopify tiene otro número', async () => {
  const e = await escenario()
  await switchInventoryMethod(e.venueId, e.productId, 'RECIPE')
  await switchInventoryMethod(e.venueId, e.productId, 'QUANTITY')
  expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: e.productId } })).currentStock.toString()).toBe('0')
  expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId, status: 'PENDING' } })).toBe(0)
  expect(await sucursal(e)).toMatchObject({ needsReconcile: true }) // volver a cantidad pide el cuadre: no espera a la ronda de la mañana
  const deps = {
    fetchLevels: nivelesFalsos(() => nivel(10)),
    graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
    hasAccess: conPlan,
  }
  let terminado = false
  for (let i = 0; i < 10 && !terminado; i++) terminado = (await reconcileVenue(e.venueId, deps)).terminado
  expect(terminado).toBe(true)
  expect((await pareja(e)).suspendedReason).toBeNull()
  expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId, reason: 'SIN_INVENTARIO' } })).toBe(0) // ya no está en «Productos sin pareja»
  expect(await prisma.shopifyReviewItem.findFirst({ where: { productId: e.productId, status: 'OPEN' } })).toMatchObject({
    reason: 'REACTIVADA',
    shopifyQty: 10,
  })
})

it('N24: receta y archivo a la vez sobre el mismo producto terminan los dos, sin trabarse (Product primero en los dos)', async () => {
  for (let ronda = 0; ronda < 5; ronda++) {
    const e = await escenario()
    const resultados = await Promise.allSettled([
      archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1'),
      switchInventoryMethod(e.venueId, e.productId, 'RECIPE'),
    ])
    expect(resultados.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await prisma.shopifyVariantLink.count({ where: { productId: e.productId } })).toBe(0)
  }
})

it('un producto sin Shopify pasa a receta igual que siempre', async () => {
  const e = await escenario()
  const p = await agregarProductoShopify(e, { pareja: false })
  await switchInventoryMethod(e.venueId, p.productId, 'RECIPE')
  expect(await prisma.inventory.count({ where: { productId: p.productId } })).toBe(0)
  expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
})

it('U3: un producto que el conector archivó con un envío en camino conserva NIVEL_INEXISTENTE al pasar a receta (el reintento de R5 lo sigue viendo)', async () => {
  const e = await escenario()
  const enCamino = await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: -1,
      status: 'IN_PROGRESS',
      claimToken: 'm',
    },
  })
  expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')).toEqual({ archivadas: 0, suspendidas: 1 })
  expect(await pareja(e)).toMatchObject({ suspendedReason: 'NIVEL_INEXISTENTE' })
  const filasAntes = await prisma.shopifyStockOutbox.count({ where: { productId: e.productId } })

  await switchInventoryMethod(e.venueId, e.productId, 'RECIPE')

  expect(await pareja(e)).toMatchObject({ suspendedReason: 'NIVEL_INEXISTENTE' }) // no se pisa con SIN_INVENTARIO
  expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({ reason: 'NIVEL_INEXISTENTE' })
  expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: enCamino.id } })).status).toBe('IN_PROGRESS') // la barrera sigue
  expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId } })).toBe(filasAntes) // ni se descartó ni se creó nada
  expect(await prisma.inventory.count({ where: { productId: e.productId } })).toBe(0) // y lo demás de la receta sí pasó
})

it('una pareja suspendida por otro motivo (NO_RASTREADO) de un producto normal sí pasa a SIN_INVENTARIO al irse a receta', async () => {
  const e = await escenario()
  await prisma.shopifyVariantLink.update({
    where: { id: e.variantLinkId },
    data: { suspendedReason: 'NO_RASTREADO', suspendedAt: new Date() },
  })
  await switchInventoryMethod(e.venueId, e.productId, 'RECIPE')
  expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
})

it.each(caminos)(
  'BR-6 / K14 (%s): la pareja se toca sólo DESPUÉS de bloquear su sucursal (si no, esperaría en cruz con desconectar)',
  async (_nombre, camino) => {
    const e = await escenario()
    let soltar!: () => void
    const suelta = new Promise<void>(r => (soltar = r))
    let tomado!: () => void
    const yaTomada = new Promise<void>(r => (tomado = r))
    // Quien desconecta: toma la sucursal FOR UPDATE y la sostiene.
    const sostiene = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "ShopifyLocationLink" WHERE id = ${e.locationLinkId} FOR UPDATE`
        tomado()
        await suelta
      },
      { timeout: 30_000 },
    )
    await yaTomada
    let terminado = false
    const cambio = camino(e, 'RECIPE').then(() => (terminado = true))
    try {
      await dormir(500)
      // Con la sucursal ajena el cambio ESPERA (no terminó) ANTES de la pareja: su fila sigue libre (NOWAIT no falla).
      expect(terminado).toBe(false)
      await expect(
        prisma.$transaction(async tx => tx.$queryRaw`SELECT id FROM "ShopifyVariantLink" WHERE id = ${e.variantLinkId} FOR UPDATE NOWAIT`),
      ).resolves.toBeDefined()
    } finally {
      soltar() // aunque la aserción falle, la sucursal se suelta y el cambio termina
      await sostiene
    }
    await cambio
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
  },
)

describe('setProductInventoryMethod: el otro camino a receta (PUT inventory-method, paso 2 del asistente, MCP) — ronda de arreglos 1', () => {
  it('a receta suspende la pareja y descarta lo que no salió: bajo receta la venta ya no escribe Inventory, así que Shopify no se enteraría', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // una fila viva
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { status: true }, take: 5 })).toEqual([
      { status: 'DISCARDED' },
    ])
    expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({
      reason: 'SIN_INVENTARIO',
      productId: e.productId,
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ inventoryMethod: 'RECIPE' })
  })

  it('U3 también aquí: un producto archivado por el conector con un envío en camino conserva NIVEL_INEXISTENTE', async () => {
    const e = await escenario()
    await prisma.shopifyStockOutbox.create({
      data: {
        venueId: e.venueId,
        locationLinkId: e.locationLinkId,
        generation: 1,
        productId: e.productId,
        delta: -1,
        status: 'IN_PROGRESS',
        claimToken: 'm',
      },
    })
    await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    expect(await pareja(e)).toMatchObject({ suspendedReason: 'NIVEL_INEXISTENTE' })
  })

  it.each(caminos)('%s: volver a cantidad pide el cuadre de la sucursal de la pareja suspendida', async (_nombre, camino) => {
    const e = await escenario()
    await camino(e, 'RECIPE')
    await sinCuadrePedido(e)
    const antes = (await sucursal(e)).reconcileVersion
    await camino(e, 'QUANTITY')
    expect(await sucursal(e)).toMatchObject({ needsReconcile: true, reconcileVersion: antes + 1 })
  })

  it.each(caminos)(
    '%s: a cantidad una pareja que NO está suspendida por receta no pide cuadre (un PUT repetido no dispara vueltas)',
    async (_nombre, camino) => {
      const e = await escenario()
      await sinCuadrePedido(e)
      const antes = await sucursal(e)
      await camino(e, 'QUANTITY')
      expect(await sucursal(e)).toMatchObject({ needsReconcile: false, reconcileVersion: antes.reconcileVersion })
      expect((await pareja(e)).suspendedReason).toBeNull()
    },
  )

  it('un producto sin Shopify pasa a receta y vuelve a cantidad igual que siempre', async () => {
    const e = await escenario()
    const p = await agregarProductoShopify(e, { pareja: false })
    await sinCuadrePedido(e)
    await setProductInventoryMethod(e.venueId, p.productId, 'RECIPE')
    await setProductInventoryMethod(e.venueId, p.productId, 'QUANTITY')
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
    expect(await sucursal(e)).toMatchObject({ needsReconcile: false })
  })

  it.each(caminos)(
    '%s: recetas y vueltas a cantidad a la vez en la MISMA sucursal terminan todas, sin deadlock',
    async (_nombre, camino) => {
      for (let ronda = 0; ronda < 4; ronda++) {
        const e = await escenario()
        const otro = await agregarProductoShopify(e)
        const deOtro = (m: 'RECIPE' | 'QUANTITY') => camino({ ...e, productId: otro.productId }, m)
        await deOtro('RECIPE')
        const resultados = await Promise.allSettled([camino(e, 'RECIPE'), deOtro('QUANTITY'), camino(e, 'QUANTITY'), deOtro('RECIPE')])
        expect(resultados.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
      }
    },
  )
})

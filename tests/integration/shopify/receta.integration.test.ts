/**
 * Pasar un producto ligado a receta (B7, 12 bis.5): la pareja se suspende ANTES de borrar su Inventory; nada viaja a
 * Shopify. Al volver a cantidad, el cuadre la reactiva COMPARANDO. Receta y archivo a la vez no se traban (N24).
 * Postgres real.
 */
import prisma from '@/utils/prismaClient'
import { switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { archiveShopifyProduct } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { pedirCuadre } from '@/services/commerce-channels/shopify/shopify.store.service'
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
  await pedirCuadre(e.locationLinkId)
  const deps = {
    fetchLevels: nivelesFalsos(() => nivel(10)),
    graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
    hasAccess: conPlan,
  }
  let terminado = false
  for (let i = 0; i < 10 && !terminado; i++) terminado = (await reconcileVenue(e.venueId, deps)).terminado
  expect(terminado).toBe(true)
  expect((await pareja(e)).suspendedReason).toBeNull()
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

  await switchInventoryMethod(e.venueId, e.productId, 'RECIPE')

  expect(await pareja(e)).toMatchObject({ suspendedReason: 'NIVEL_INEXISTENTE' }) // no se pisa con SIN_INVENTARIO
  expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({ reason: 'NIVEL_INEXISTENTE' })
  expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: enCamino.id } })).status).toBe('IN_PROGRESS') // la barrera sigue
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

it('BR-6 / K14: la pareja se toca sólo DESPUÉS de bloquear su sucursal (si no, esperaría en cruz con desconectar)', async () => {
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
  const cambio = switchInventoryMethod(e.venueId, e.productId, 'RECIPE').then(() => (terminado = true))
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
  expect(await prisma.inventory.count({ where: { productId: e.productId } })).toBe(0)
})

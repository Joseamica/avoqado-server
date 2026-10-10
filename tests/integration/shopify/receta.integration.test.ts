/**
 * Pasar un producto ligado a receta (B7, 12 bis.5): la pareja se suspende ANTES de borrar su Inventory; nada viaja a
 * Shopify. Al volver a cantidad, el cuadre la reactiva COMPARANDO. Receta y archivo a la vez no se traban (N24).
 * Postgres real.
 */
import prisma from '@/utils/prismaClient'
import { switchInventoryMethod } from '@/services/dashboard/productWizard.service'
import { setProductInventoryMethod } from '@/services/dashboard/productInventoryIntegration.service'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { updateProduct as updateFromPos } from '@/controllers/mobile/product.mobile.controller'
import { archiveShopifyProduct, syncShopifyProduct } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { reconcileVenue, resolveShopifyReview } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import { applyShopifyLevel, suspendPair } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { pedirCuadre } from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  limpiarEscenarioShopify,
} from './fixtures'
import { conPlan, dormir, graphqlDelCatalogo, nivel, nivelesFalsos, paginaDeVariantes, variantesDeLaSucursal } from './fixturesB'

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
  // R-M2: la pareja queda SIN_INVENTARIO, pero «Productos sin pareja» dice el motivo real: pasó a receta.
  expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({
    reason: 'METODO_RECETA',
    detail: expect.stringMatching(/receta/),
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
  expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0) // ya no está en «Productos sin pareja», con ningún motivo
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
      reason: 'METODO_RECETA',
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

describe('FF-I1: pasar a receta por setProductInventoryMethod conserva la fila de Inventory; nada revive la pareja por eso', () => {
  /** La variante del escenario como la tendría Shopify hoy, con `available` piezas (otro número que Avoqado). */
  async function laVarianteEn(e: EscenarioShopify, available: number) {
    const [v] = await variantesDeLaSucursal(e.locationLinkId)
    const quantities = [
      { name: 'available', quantity: available },
      { name: 'committed', quantity: 0 },
    ]
    return { ...v, inventoryItem: { ...v.inventoryItem, inventoryLevel: { isActive: true, quantities } } }
  }
  /** Una vuelta entera del cuadre con Shopify en `available` y su catálogo igual al de las parejas de hoy. */
  async function cuadrarCon(e: EscenarioShopify, available: number) {
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(available)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    let terminado = false
    for (let i = 0; i < 10 && !terminado; i++) terminado = (await reconcileVenue(e.venueId, deps)).terminado
    expect(terminado).toBe(true)
  }
  const stockDe = async (e: EscenarioShopify) =>
    (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
  const movimientos = (e: EscenarioShopify) => prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId } })

  it('a receta → reconcileVenue: la pareja sigue SIN_INVENTARIO, sin REACTIVADA, y el Inventory no se toca', async () => {
    const e = await escenario()
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    expect(await prisma.inventory.count({ where: { productId: e.productId } })).toBe(1) // este camino conserva la fila
    const antes = await movimientos(e)
    await cuadrarCon(e, 7)
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
    expect(await stockDe(e)).toBe('10')
    expect(await movimientos(e)).toBe(antes)
    expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({ reason: 'METODO_RECETA' })
  })

  it('a receta → products/update (syncShopifyProduct) con la variante en Shopify: el sync no la revive', async () => {
    const e = await escenario()
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    const antes = await movimientos(e)
    const pagina = paginaDeVariantes([await laVarianteEn(e, 7)], null)
    const graphql = graphqlFalso(() => pagina)
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/1', { graphql, hasAccess: conPlan })).toEqual({ ok: true })
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
    expect(await stockDe(e)).toBe('10')
    expect(await movimientos(e)).toBe(antes)
  })

  it('a receta con una duda muerta en «Por revisar» (U2): resolver contesta 409 SHOPIFY_SIN_INVENTARIO y la pareja sigue suspendida', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // A = 9, fila −1
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: {
        status: 'DEAD_LETTER',
        ambiguous: true,
        sentInventoryItemId: 'gid://shopify/InventoryItem/1',
        sentLocationId: 'gid://shopify/Location/1',
        firstAttemptAt: new Date(),
        processedAt: new Date(),
        lastError: 'VENTANA_24H',
      },
    })
    await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'NIVEL_INEXISTENTE'))
    await cuadrarCon(e, 10)
    const r = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId, status: 'OPEN' } })
    expect(r).toMatchObject({ reason: 'INCIERTO' })
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    const filas = () =>
      prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
    const filasAntes = await filas()
    const resolver = resolveShopifyReview(
      {
        venueId: e.venueId,
        reviewId: r.id,
        choice: 'AVOQADO',
        expectedAvoqadoQty: r.avoqadoQty.toString(),
        expectedShopifyQty: r.shopifyQty,
        staffId: e.staffId,
      },
      { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess: conPlan },
    )
    await expect(resolver).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_SIN_INVENTARIO' })
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect((await prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('OPEN')
    expect(await filas()).toEqual(filasAntes) // ni se descartó la duda ni salió una fila nueva
    expect(await stockDe(e)).toBe('9')
  })

  it('applyShopifyLevel: un cambio de Shopify sobre la pareja VIVA de un producto que dejó de llevar existencias la suspende y no toca Inventory', async () => {
    const e = await escenario()
    // Otro camino que no pasa por los ayudantes de B7 (una edición directa del producto): la pareja sigue viva.
    await prisma.product.update({ where: { id: e.productId }, data: { trackInventory: false } })
    const antes = await movimientos(e)
    const o = await applyShopifyLevel(
      { variantLinkId: e.variantLinkId, nivel: nivel(7), fetchedAt: new Date(), cause: 'aviso' },
      { hasAccess: conPlan },
    )
    expect(o).toBe('SUSPENDIDO')
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await stockDe(e)).toBe('10')
    expect(await movimientos(e)).toBe(antes)
  })

  it('regresión: de vuelta a CANTIDAD por el mismo camino, el cuadre SÍ la reactiva comparando (REACTIVADA)', async () => {
    const e = await escenario()
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    await setProductInventoryMethod(e.venueId, e.productId, 'QUANTITY')
    expect(await sucursal(e)).toMatchObject({ needsReconcile: true })
    await cuadrarCon(e, 7)
    expect((await pareja(e)).suspendedReason).toBeNull()
    expect(await prisma.shopifyReviewItem.findFirst({ where: { productId: e.productId, status: 'OPEN' } })).toMatchObject({
      reason: 'REACTIVADA',
      shopifyQty: 7,
    })
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0) // R-M2: la de «receta» se limpia
  })

  /** Los cuatro motivos por los que un producto deja de sincronizarse, cómo se provoca cada uno y cómo se reconoce su texto. */
  const inelegibles = [
    ['METODO_RECETA', { inventoryMethod: 'RECIPE' }, /receta/],
    ['UNIDAD_NO_PIEZA', { unit: 'KILOGRAM' }, /otra unidad/],
    ['TIPO_SIN_INVENTARIO', { type: 'APPOINTMENTS_SERVICE' }, /no lleva inventario/],
    ['SIN_INVENTARIO_EN_AVOQADO', { trackInventory: false }, /control de existencias/],
  ] as const
  const incidencia = (e: EscenarioShopify) => prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })

  it.each(inelegibles)(
    '🔴 R-M2 (%s): la pareja queda SIN_INVENTARIO, pero «Productos sin pareja» dice el motivo real con su propio texto',
    async (motivo, cambio, texto) => {
      const e = await escenario()
      await prisma.product.update({ where: { id: e.productId }, data: cambio }) // sin los ayudantes de B7: la pareja sigue viva
      const o = await applyShopifyLevel(
        { variantLinkId: e.variantLinkId, nivel: nivel(7), fetchedAt: new Date(), cause: 'aviso' },
        { hasAccess: conPlan },
      )
      expect(o).toBe('SUSPENDIDO')
      expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
      expect(await incidencia(e)).toMatchObject({ reason: motivo, detail: expect.stringMatching(texto), productId: e.productId })
    },
  )

  it.each(inelegibles)(
    '🔴 R-M2 (%s): resolver una duda muerta de un producto que dejó de sincronizarse contesta 409 con el motivo real',
    async (motivo, cambio, texto) => {
      const e = await escenario()
      await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // A = 9, fila −1
      await prisma.shopifyStockOutbox.updateMany({
        where: { productId: e.productId },
        data: {
          status: 'DEAD_LETTER',
          ambiguous: true,
          sentInventoryItemId: 'gid://shopify/InventoryItem/1',
          sentLocationId: 'gid://shopify/Location/1',
          firstAttemptAt: new Date(),
          processedAt: new Date(),
          lastError: 'VENTANA_24H',
        },
      })
      await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'NIVEL_INEXISTENTE'))
      await cuadrarCon(e, 10)
      const r = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId, status: 'OPEN' } })
      await prisma.product.update({ where: { id: e.productId }, data: cambio })
      const resolver = resolveShopifyReview(
        {
          venueId: e.venueId,
          reviewId: r.id,
          choice: 'AVOQADO',
          expectedAvoqadoQty: r.avoqadoQty.toString(),
          expectedShopifyQty: r.shopifyQty,
          staffId: e.staffId,
        },
        { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess: conPlan },
      )
      await expect(resolver).rejects.toMatchObject({
        statusCode: 409,
        code: 'SHOPIFY_SIN_INVENTARIO',
        message: expect.stringMatching(texto),
      })
      expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
      expect(await incidencia(e)).toMatchObject({ reason: motivo })
    },
  )

  it('🔴 R-M2: al reactivarse por la resolución (U2), la incidencia con el motivo real se limpia', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // A = 9, fila −1
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: {
        status: 'DEAD_LETTER',
        ambiguous: true,
        sentInventoryItemId: 'gid://shopify/InventoryItem/1',
        sentLocationId: 'gid://shopify/Location/1',
        firstAttemptAt: new Date(),
        processedAt: new Date(),
        lastError: 'VENTANA_24H',
      },
    })
    // Suspendida antes, cuando se medía en kilos; el producto ya volvió a contarse por pieza.
    await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'SIN_INVENTARIO'))
    await prisma.shopifyImportIssue.updateMany({ where: { venueId: e.venueId }, data: { reason: 'UNIDAD_NO_PIEZA' } })
    await cuadrarCon(e, 10)
    const r = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId, status: 'OPEN' } })
    expect(r).toMatchObject({ reason: 'INCIERTO' })
    await resolveShopifyReview(
      {
        venueId: e.venueId,
        reviewId: r.id,
        choice: 'SHOPIFY',
        expectedAvoqadoQty: r.avoqadoQty.toString(),
        expectedShopifyQty: r.shopifyQty,
        staffId: e.staffId,
      },
      { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess: conPlan },
    )
    expect((await pareja(e)).suspendedReason).toBeNull()
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
  })

  it('🔴 R-M2: si mientras sigue suspendida cambia el motivo (de receta a kilos), la incidencia dice el de hoy', async () => {
    const e = await escenario()
    await setProductInventoryMethod(e.venueId, e.productId, 'RECIPE')
    expect(await incidencia(e)).toMatchObject({ reason: 'METODO_RECETA' })
    await prisma.product.update({ where: { id: e.productId }, data: { inventoryMethod: 'QUANTITY', unit: 'KILOGRAM' } })
    await cuadrarCon(e, 7)
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidencia(e)).toMatchObject({ reason: 'UNIDAD_NO_PIEZA', detail: expect.stringMatching(/otra unidad/) })
  })

  it('🔴 R-M3: el sync del producto suspende una pareja VIVA cuyo producto dejó de llevar existencias desde la ficha (sin B7), aunque Shopify siga igual', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // una venta sin mandar
    await prisma.product.update({ where: { id: e.productId }, data: { trackInventory: false } }) // ninguna ayuda de B7
    const antes = await movimientos(e)
    const pagina = paginaDeVariantes([await laVarianteEn(e, 10)], null) // Shopify sigue en el espejo: nada que aplicar
    expect(
      await syncShopifyProduct(e.storeId, 'gid://shopify/Product/1', { graphql: graphqlFalso(() => pagina), hasAccess: conPlan }),
    ).toEqual({
      ok: true,
    })
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidencia(e)).toMatchObject({ reason: 'SIN_INVENTARIO_EN_AVOQADO', productId: e.productId })
    // Lo que nunca salió se descarta, como en toda suspensión; Avoqado no se toca.
    expect(await prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { status: true }, take: 5 })).toEqual([
      { status: 'DISCARDED' },
    ])
    expect(await stockDe(e)).toBe('9')
    expect(await movimientos(e)).toBe(antes)
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
  })

  it('🔴 R-M3: la tanda de stock manda a A una pareja VIVA cuyo producto ya no se sincroniza aunque Shopify no cambió, y A la suspende', async () => {
    const e = await escenario()
    await prisma.product.update({ where: { id: e.productId }, data: { unit: 'KILOGRAM' } }) // ninguna ayuda de B7
    const antes = await movimientos(e)
    // Directo a la tanda de stock, sin barrido (el barrido entra por el catálogo, la otra puerta).
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { catalogSweepCursor: null, reconcileCursor: '' } })
    const r = await reconcileVenue(e.venueId, { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess: conPlan }) // = espejo
    expect(r).toMatchObject({ etapa: 'STOCK' })
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidencia(e)).toMatchObject({ reason: 'UNIDAD_NO_PIEZA' })
    expect(await stockDe(e)).toBe('10')
    expect(await movimientos(e)).toBe(antes)
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
  })

  it('R-M3 (regresión): una pareja viva de un producto elegible que Shopify no cambió no pasa por A ni se suspende', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { catalogSweepCursor: null, reconcileCursor: '' } })
    const r = await reconcileVenue(e.venueId, { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess: conPlan })
    expect(r).toMatchObject({ etapa: 'STOCK', aplicados: 0 })
    expect((await pareja(e)).suspendedReason).toBeNull()
    expect(await incidencia(e)).toBeNull()
  })
})

describe('🔴 P1-2: el PATCH genérico del producto (ficha del dashboard y PATCH móvil) también suspende o pide el cuadre', () => {
  const actor = (e: EscenarioShopify) => ({ type: 'HUMAN' as const, staffId: e.staffId, impersonating: false })
  const incidenciaDe = (e: EscenarioShopify) =>
    prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId, productId: e.productId } })
  const filasDe = (e: EscenarioShopify) =>
    prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { status: true, lastError: true }, take: 5 })
  /** El PATCH móvil real (`/mobile/venues/:venueId/products/:productId`), con un req/res de prueba. */
  async function patchMovil(e: EscenarioShopify, body: Record<string, unknown>) {
    const r: { status: number; error: unknown } = { status: 200, error: undefined }
    const req = {
      params: { venueId: e.venueId, productId: e.productId },
      body,
      authContext: { userId: e.staffId, venueId: e.venueId, orgId: e.organizationId, role: 'MANAGER' },
    }
    const res = {
      status(code: number) {
        r.status = code
        return this
      },
      json() {
        return this
      },
    }
    await updateFromPos(req as never, res as never, err => {
      r.error = err
    })
    if (r.error) throw r.error
    return r
  }

  it('dashboard: «Se vende por peso» sobre una pareja viva ⇒ SIN_INVENTARIO con UNIDAD_NO_PIEZA y lo que no salió se descarta', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // una fila viva
    await updateProduct(e.venueId, e.productId, { soldByWeight: true } as never, actor(e))
    expect((await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).unit).toBe('KILOGRAM')
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidenciaDe(e)).toMatchObject({ reason: 'UNIDAD_NO_PIEZA' })
    expect(await filasDe(e)).toEqual([{ status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA' }])
    // Ya suspendida, la venta de 1 kg no viaja: el guardia no encola nada de una pareja suspendida.
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId, status: 'PENDING' } })).toBe(0)
  })

  it('móvil: a receta ⇒ METODO_RECETA; sin control de existencias ⇒ SIN_INVENTARIO_EN_AVOQADO', async () => {
    const receta = await escenario()
    await patchMovil(receta, { inventoryMethod: 'RECIPE' })
    expect((await pareja(receta)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidenciaDe(receta)).toMatchObject({ reason: 'METODO_RECETA' })

    const sinSeguimiento = await escenario()
    await patchMovil(sinSeguimiento, { trackInventory: false })
    expect((await pareja(sinSeguimiento)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidenciaDe(sinSeguimiento)).toMatchObject({ reason: 'SIN_INVENTARIO_EN_AVOQADO' })
  })

  it('móvil: «se vende por peso» sin mandar la unidad (el PATCH no la fuerza) también suspende: la venta descuenta kilos', async () => {
    const e = await escenario()
    await patchMovil(e, { soldByWeight: true })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ soldByWeight: true, unit: 'UNIT' })
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await incidenciaDe(e)).toMatchObject({ reason: 'UNIDAD_NO_PIEZA' })
  })

  it('de vuelta a pieza por la ficha ⇒ pide el cuadre (que la reactiva comparando)', async () => {
    const e = await escenario()
    await updateProduct(e.venueId, e.productId, { soldByWeight: true } as never, actor(e))
    await sinCuadrePedido(e)
    await updateProduct(e.venueId, e.productId, { soldByWeight: false, unit: 'UNIT' } as never, actor(e))
    expect((await pareja(e)).suspendedReason).toBe('SIN_INVENTARIO') // la reactiva el cuadre, no el PATCH
    expect(await sucursal(e)).toMatchObject({ needsReconcile: true })
  })

  it('regresión: editar el nombre de un producto elegible no toca la pareja ni pide cuadre; uno sin Shopify, igual que siempre', async () => {
    const e = await escenario()
    await sinCuadrePedido(e)
    await updateProduct(e.venueId, e.productId, { name: 'Otro nombre' } as never, actor(e))
    await patchMovil(e, { name: 'Otro nombre 2' })
    expect(await pareja(e)).toMatchObject({ suspendedReason: null })
    expect(await sucursal(e)).toMatchObject({ needsReconcile: false })
    expect(await incidenciaDe(e)).toBeNull()

    const sin = await agregarProductoShopify(e, { pareja: false })
    await updateProduct(e.venueId, sin.productId, { soldByWeight: true } as never, actor(e))
    expect((await prisma.product.findUniqueOrThrow({ where: { id: sin.productId } })).unit).toBe('KILOGRAM')
  })
})

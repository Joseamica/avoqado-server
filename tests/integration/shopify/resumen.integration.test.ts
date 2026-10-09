/**
 * Lo que lee la página (B9): las formas exactas de C, contadas en la base; listas con tope, total y búsqueda en el
 * servidor; «Por revisar» con las elecciones que siguen en camino. Postgres real.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  getShopifyOverview,
  getShopifyReviewEnvios,
  listShopifyIssues,
  listShopifyReviews,
  SHOPIFY_IMPORT_ERRORES_VISIBLES,
} from '@/services/commerce-channels/shopify/shopify.overview.service'
import { SHOPIFY_IMPORT_ERRORES_TERMINALES } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { agregarProductoShopify, assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'

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
const venta = (inventoryId: string) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${inventoryId}`
const hace = (min: number) => new Date(Date.now() - min * 60_000)
const conexion = async (e: EscenarioShopify) => (await getShopifyOverview(e.venueId)).connection!
const fila = (
  e: EscenarioShopify,
  status: 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'DEAD_LETTER' | 'SENT' | 'DISCARDED',
  o: { generation?: number; createdAt?: Date; processedAt?: Date | null } = {},
) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: o.generation ?? 1,
      productId: e.productId,
      delta: 1,
      status,
      createdAt: o.createdAt,
      processedAt: o.processedAt ?? null,
    },
  })
const revisionResuelta = (e: EscenarioShopify, resolutionOutboxId: string | null, createdAt = new Date()) =>
  prisma.shopifyReviewItem.create({
    data: {
      venueId: e.venueId,
      productId: e.productId,
      reason: 'DIFERENCIA',
      avoqadoQty: new Prisma.Decimal(5),
      shopifyQty: 4,
      suggestion: 'AVOQADO',
      status: 'RESOLVED',
      choice: 'AVOQADO',
      resolutionOutboxId,
      createdAt,
    },
  })

it('sin conexión, o desconectada ⇒ connection null y el plan dicho tal cual', async () => {
  const e = await escenario({ linkStatus: 'DISCONNECTED' })
  expect(await getShopifyOverview(e.venueId)).toEqual({ planActive: false, connection: null })
})

it('ACTIVE: la forma completa, con conteos de la generación vigente, retraso y el estado del cuadre', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  await prisma.shopifyStockOutbox.updateMany({ where: { productId: e.productId }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } })
  const otro = await agregarProductoShopify(e)
  await venta(otro.inventoryId)
  await prisma.shopifyStockOutbox.updateMany({ where: { productId: otro.productId }, data: { status: 'DEAD_LETTER', ambiguous: true } })
  await prisma.shopifyReviewItem.create({
    data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 9, shopifyQty: 10, suggestion: 'SHOPIFY' },
  })
  await prisma.shopifyImportIssue.create({
    data: {
      venueId: e.venueId,
      shopifyVariantId: 'gid://shopify/ProductVariant/77',
      shopifyProductId: 'gid://shopify/Product/77',
      title: 'Sin SKU',
      reason: 'SIN_SKU',
    },
  })
  const { planActive, connection } = await getShopifyOverview(e.venueId)
  expect(planActive).toBe(false)
  expect(connection).toEqual({
    fase: 'ACTIVE',
    pausedFrom: null,
    estado: 'ACTIVA',
    shopDomain: e.shopDomain,
    locationName: 'Tienda México',
    importacion: { variantes: 3, error: null },
    aplicacion: null,
    conteos: { emparejados: 2, pendientes: 1, atorados: 1, inciertos: 1, porRevisar: 1, sinPareja: 1 },
    retrasoMin: expect.any(Number),
    cuadre: { pendiente: false, ultimo: null },
    proximoIntento: null,
  })
  expect(connection!.retrasoMin).toBeGreaterThanOrEqual(19)

  // U5: «pendiente» = pedido sin consumir, o una vuelta que empezó (versión > hecha) y todavía no cierra; «último» es
  // `lastReconciledAt` (durante una vuelta, hecha = versión − 1, no sirve para decir cuándo terminó la última).
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { needsReconcile: true } })
  expect((await conexion(e)).cuadre.pendiente).toBe(true)
  const hora = new Date('2026-10-08T12:00:00Z')
  await prisma.shopifyLocationLink.update({
    where: { id: e.locationLinkId },
    data: { needsReconcile: false, reconcileVersion: 3, reconcileDoneVersion: 2, lastReconciledAt: hora },
  })
  expect((await conexion(e)).cuadre).toEqual({ pendiente: true, ultimo: hora.toISOString() })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { reconcileDoneVersion: 3 } })
  expect((await conexion(e)).cuadre).toEqual({ pendiente: false, ultimo: hora.toISOString() })
})

it('estado por fase y el error de importación con su código exacto; la tienda revocada gana', async () => {
  const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
  const estado = () => conexion(e)
  expect((await estado()).estado).toBe('IMPORTANDO')
  for (const [guardado, visto] of [
    ['CATALOGO_MUY_GRANDE', 'CATALOGO_MUY_GRANDE'],
    ['FALTA_PERMISO', 'FALTA_PERMISO'],
    ['CATALOGO_MAESTRO', 'CATALOGO_MAESTRO'],
    ['HTTP_5XX: <html>error 502 de la tienda</html>', 'HTTP_5XX'],
    ['TOKEN_ILEGIBLE', 'TOKEN_ILEGIBLE'],
    // Lo que deja la importación al fallar una variante: sin código, con el mensaje crudo de la excepción.
    ['Variante gid://shopify/ProductVariant/9: Invalid `prisma.product.create()` invocation', 'VARIANTE_FALLO'],
    ['algo raro sin código: texto crudo', 'ERROR'],
  ]) {
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: guardado } })
    expect((await estado()).importacion.error).toBe(visto)
  }
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'REVIEWING', importError: null } })
  expect(await estado()).toMatchObject({ estado: 'POR_APLICAR', aplicacion: null })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
  expect(await estado()).toMatchObject({ estado: 'APLICANDO', aplicacion: { hechas: 0, total: 1 } })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'REVIEWING' } })
  expect(await estado()).toMatchObject({ fase: 'PAUSED', pausedFrom: 'REVIEWING', estado: 'PAUSADA' })
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } })
  expect((await estado()).estado).toBe('REVOCADA')
})

it('U5: la lista de errores que se enseñan ES la de A (un alias, no una copia)', () => {
  expect(SHOPIFY_IMPORT_ERRORES_VISIBLES).toBe(SHOPIFY_IMPORT_ERRORES_TERMINALES)
  expect([...SHOPIFY_IMPORT_ERRORES_VISIBLES].sort()).toEqual(['CATALOGO_MAESTRO', 'CATALOGO_MUY_GRANDE', 'FALTA_PERMISO'])
})

it('«pendiente» del cuadre sólo se enseña en ACTIVE o PAUSED (U5): importando o por aplicar no esperan ninguna vuelta', async () => {
  const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
  // Renovar la credencial sube la versión de TODAS las sucursales de la tienda, también las que aún importan.
  await prisma.shopifyLocationLink.update({
    where: { id: e.locationLinkId },
    data: { reconcileVersion: 3, reconcileDoneVersion: 0, needsReconcile: true },
  })
  expect((await conexion(e)).cuadre.pendiente).toBe(false)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'REVIEWING' } })
  expect((await conexion(e)).cuadre.pendiente).toBe(false)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } })
  expect((await conexion(e)).cuadre.pendiente).toBe(true)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'ACTIVE', pausedFrom: null } })
  expect((await conexion(e)).cuadre.pendiente).toBe(true)
})

it('Y1: una sucursal DETENIDA (tienda revocada o error terminal) se enseña detenida, no esperando', async () => {
  const e = await escenario()
  await fila(e, 'PENDING', { createdAt: hace(90) })
  const espera = new Date(Date.now() + 30 * 60_000)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { needsReconcile: true, nextWorkAt: espera } })
  // Trabajando con normalidad: cuadre pedido, la fila más vieja con su edad y el próximo intento (la ÚNICA espera guardada).
  expect(await conexion(e)).toMatchObject({
    cuadre: { pendiente: true },
    retrasoMin: expect.any(Number),
    proximoIntento: espera.toISOString(),
    conteos: { pendientes: 1 },
  })
  expect((await conexion(e)).retrasoMin).toBeGreaterThanOrEqual(89)

  for (const error of SHOPIFY_IMPORT_ERRORES_TERMINALES) {
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: error } })
    const c = await conexion(e)
    expect(c).toMatchObject({
      estado: 'ACTIVA',
      importacion: { error },
      cuadre: { pendiente: false },
      retrasoMin: null,
      proximoIntento: null,
    })
    expect(c.conteos.pendientes).toBe(1) // los hechos siguen contándose: la fila está ahí, sólo que nadie la va a enviar
  }
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } })
  expect(await conexion(e)).toMatchObject({ estado: 'REVOCADA', cuadre: { pendiente: false }, retrasoMin: null, proximoIntento: null })

  // Una espera que ya pasó no es espera.
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE' } })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { nextWorkAt: hace(5) } })
  expect((await conexion(e)).proximoIntento).toBeNull()
})

it('T3: lo «pendiente» se cuenta y se enseña sólo de la generación vigente del enlace', async () => {
  const e = await escenario({ generation: 2 })
  await fila(e, 'PENDING', { generation: 1, createdAt: hace(600) })
  await fila(e, 'DEAD_LETTER', { generation: 1, processedAt: hace(10) })
  await fila(e, 'PENDING', { generation: 2, createdAt: hace(30) })
  const c = await conexion(e)
  expect(c.conteos).toMatchObject({ pendientes: 1, atorados: 0, inciertos: 0 })
  expect(c.retrasoMin).toBeLessThan(60) // la de la generación 1 (10 h) no cuenta

  // Una elección en camino cuya fila es de una generación anterior ya no es de esta conexión.
  const vieja = await fila(e, 'PENDING', { generation: 1 })
  const vieja2 = await fila(e, 'DEAD_LETTER', { generation: 1, processedAt: hace(1) })
  const vigente = await fila(e, 'PENDING', { generation: 2 })
  const r1 = await revisionResuelta(e, vieja.id)
  const r2 = await revisionResuelta(e, vieja2.id)
  const r3 = await revisionResuelta(e, vigente.id)
  const lista = await listShopifyReviews(e.venueId, {})
  expect(lista.items.map(i => [i.id, i.envio])).toEqual([[r3.id, 'PENDIENTE']])
  const envios = await getShopifyReviewEnvios(e.venueId, [r1.id, r2.id, r3.id])
  expect(new Map(envios.items.map(i => [i.id, i.envio]))).toEqual(
    new Map([
      [r1.id, null],
      [r2.id, null],
      [r3.id, 'PENDIENTE'],
    ]),
  )
})

it('Y1: una pareja cuenta una vez aunque tenga también su motivo en «Productos sin pareja»', async () => {
  const e = await escenario()
  // La pareja suspendida (p. ej. el producto pasó a receta) deja una fila en `ShopifyImportIssue` CON productId.
  await prisma.shopifyVariantLink.update({
    where: { id: e.variantLinkId },
    data: { suspendedReason: 'SIN_INVENTARIO', suspendedAt: new Date() },
  })
  await prisma.shopifyImportIssue.createMany({
    data: [
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/1',
        shopifyProductId: 'gid://shopify/Product/1',
        title: 'Camisa · M',
        reason: 'SIN_INVENTARIO',
        productId: e.productId,
      },
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/88',
        shopifyProductId: 'gid://shopify/Product/88',
        title: 'Gorra',
        reason: 'SIN_SKU',
      },
    ],
  })
  const c = await conexion(e)
  expect(c.importacion.variantes).toBe(2) // 1 pareja + 1 variante sin pareja; no 3
  expect(c.conteos).toMatchObject({ emparejados: 1, sinPareja: 2 })
})

it('listas: tope de 50 con un límite hostil, total y nextOffset, búsqueda en el servidor y filtro por motivo', async () => {
  const e = await escenario()
  for (let i = 0; i < 55; i++) {
    await prisma.shopifyReviewItem.create({
      data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: '2.5', shopifyQty: 3, suggestion: 'AVOQADO' },
    })
  }
  const p1 = await listShopifyReviews(e.venueId, { offset: 0, limit: 1000 })
  expect(p1).toMatchObject({ total: 55, nextOffset: 50 })
  expect(p1.items).toHaveLength(50)
  expect(Object.keys(p1.items[0]).sort()).toEqual([
    'atorados',
    'avoqadoQty',
    'choice',
    'createdAt',
    'envio',
    'id',
    'product',
    'reason',
    'shopifyQty',
    'status',
    'suggestion',
  ])
  expect(p1.items[0]).toMatchObject({
    status: 'OPEN',
    avoqadoQty: '2.5',
    shopifyQty: 3,
    choice: null,
    envio: null,
    product: { id: e.productId, name: 'Camisa · M' },
  })
  // Las fechas viajan como ISO en UTC: el cliente las formatea.
  expect(p1.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expect(await listShopifyReviews(e.venueId, { offset: 50, limit: 50 })).toMatchObject({ total: 55, nextOffset: null })
  expect((await listShopifyReviews(e.venueId, { q: 'camisa' })).total).toBe(55)
  expect((await listShopifyReviews(e.venueId, { q: 'zzz' })).total).toBe(0)

  await prisma.shopifyImportIssue.createMany({
    data: [
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/71',
        shopifyProductId: 'gid://shopify/Product/7',
        title: 'Gorra',
        sku: null,
        reason: 'SIN_SKU',
      },
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/72',
        shopifyProductId: 'gid://shopify/Product/7',
        title: 'Gorra roja',
        sku: 'G-R',
        reason: 'SIN_PRECIO',
        detail: 'Ponle precio',
      },
    ],
  })
  const sinSku = await listShopifyIssues(e.venueId, { reason: 'SIN_SKU' })
  expect(sinSku).toMatchObject({ total: 1, nextOffset: null })
  expect(Object.keys(sinSku.items[0]).sort()).toEqual(['createdAt', 'detail', 'id', 'productId', 'reason', 'sku', 'title'])
  expect(sinSku.items[0].createdAt).toMatch(/Z$/)
  expect((await listShopifyIssues(e.venueId, { q: 'roja' })).items.map(i => i.sku)).toEqual(['G-R'])
  expect((await listShopifyIssues(e.venueId, {})).total).toBe(2)
})

it('paginación estable: con la misma fecha en todas, recorrer las páginas no repite ni pierde ninguna', async () => {
  const e = await escenario()
  const mismaHora = new Date('2026-10-01T12:00:00Z')
  const datos = (i: number) => ({
    venueId: e.venueId,
    productId: e.productId,
    reason: 'DIFERENCIA' as const,
    avoqadoQty: 1,
    shopifyQty: i,
    suggestion: 'AVOQADO' as const,
    createdAt: mismaHora,
  })
  await prisma.shopifyReviewItem.createMany({ data: Array.from({ length: 150 }, (_, i) => datos(i)) })
  await prisma.shopifyImportIssue.createMany({
    data: Array.from({ length: 150 }, (_, i) => ({
      venueId: e.venueId,
      shopifyVariantId: `gid://shopify/ProductVariant/5${i}`,
      shopifyProductId: 'gid://shopify/Product/5',
      title: `Variante ${i}`,
      reason: 'SIN_SKU' as const,
      createdAt: mismaHora,
    })),
  })
  const recorrer = async (
    pedir: (offset: number) => Promise<{ items: Array<{ id: string }>; total: number; nextOffset: number | null }>,
  ) => {
    const ids: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const p: Awaited<ReturnType<typeof pedir>> = await pedir(offset)
      expect(p.total).toBe(150)
      ids.push(...p.items.map(i => i.id))
      offset = p.nextOffset
    }
    return ids
  }
  const revisiones = await recorrer(offset => listShopifyReviews(e.venueId, { offset, limit: 7 }))
  expect(revisiones).toHaveLength(150)
  expect(new Set(revisiones).size).toBe(150)
  expect(await recorrer(offset => listShopifyReviews(e.venueId, { offset, limit: 7 }))).toEqual(revisiones)
  const problemas = await recorrer(offset => listShopifyIssues(e.venueId, { offset, limit: 7 }))
  expect(problemas).toHaveLength(150)
  expect(new Set(problemas).size).toBe(150)
})

it('entradas hostiles: límite y desplazamiento absurdos se acotan; un motivo desconocido no revienta; % y _ se buscan tal cual', async () => {
  const e = await escenario()
  await prisma.shopifyImportIssue.createMany({
    data: [
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/61',
        shopifyProductId: 'gid://shopify/Product/6',
        title: '100% algodón',
        reason: 'SIN_SKU',
      },
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/62',
        shopifyProductId: 'gid://shopify/Product/6',
        title: 'Gorra',
        reason: 'SIN_SKU',
      },
    ],
  })
  await prisma.shopifyReviewItem.create({
    data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 1, shopifyQty: 2, suggestion: 'AVOQADO' },
  })
  for (const limit of [0, -4, NaN, 'abc', Infinity, 51, 10 ** 12]) {
    const r = await listShopifyIssues(e.venueId, { limit })
    expect(r.items.length).toBeLessThanOrEqual(50)
    expect(r.total).toBe(2)
  }
  expect((await listShopifyIssues(e.venueId, { limit: 1 })).items).toHaveLength(1)
  for (const offset of [-7, NaN, 'abc', 1e20, Infinity]) {
    await expect(listShopifyIssues(e.venueId, { offset })).resolves.toMatchObject({ total: 2 })
    await expect(listShopifyReviews(e.venueId, { offset })).resolves.toMatchObject({ total: 1 })
  }
  expect(await listShopifyIssues(e.venueId, { reason: 'NO_EXISTE' as never })).toEqual({ items: [], total: 0, nextOffset: null })
  expect((await listShopifyIssues(e.venueId, { q: '%' })).items.map(i => i.title)).toEqual(['100% algodón'])
  expect((await listShopifyIssues(e.venueId, { q: '_' })).total).toBe(0)
  expect((await listShopifyReviews(e.venueId, { q: '%' })).total).toBe(0)
  expect((await listShopifyReviews(e.venueId, { q: '_' })).total).toBe(0)
  await expect(listShopifyReviews(e.venueId, { q: 'x'.repeat(5000) })).resolves.toMatchObject({ total: 0 })
})

it('una lista vacía es vacía, con su forma: sin elementos, total 0 y sin siguiente página', async () => {
  const e = await escenario()
  const vacia = { items: [], total: 0, nextOffset: null }
  expect(await listShopifyReviews(e.venueId, {})).toEqual(vacia)
  expect(await listShopifyIssues(e.venueId, {})).toEqual(vacia)
  expect(await getShopifyReviewEnvios(e.venueId, [])).toEqual({ items: [] })
  expect((await conexion(e)).conteos).toEqual({ emparejados: 1, pendientes: 0, atorados: 0, inciertos: 0, porRevisar: 0, sinPareja: 0 })
})

it('aislamiento: cada negocio ve sólo lo suyo (resumen, listas y envíos)', async () => {
  const mio = await escenario()
  const ajeno = await escenario()
  await prisma.shopifyReviewItem.create({
    data: { venueId: ajeno.venueId, productId: ajeno.productId, reason: 'DIFERENCIA', avoqadoQty: 1, shopifyQty: 2, suggestion: 'AVOQADO' },
  })
  await prisma.shopifyImportIssue.create({
    data: {
      venueId: ajeno.venueId,
      shopifyVariantId: 'gid://shopify/ProductVariant/55',
      shopifyProductId: 'gid://shopify/Product/5',
      title: 'Ajena',
      reason: 'SIN_SKU',
    },
  })
  await fila(ajeno, 'DEAD_LETTER', { processedAt: hace(1) })
  const suya = await revisionResuelta(ajeno, (await fila(ajeno, 'PENDING')).id)

  expect(await listShopifyReviews(mio.venueId, {})).toEqual({ items: [], total: 0, nextOffset: null })
  expect(await listShopifyIssues(mio.venueId, {})).toEqual({ items: [], total: 0, nextOffset: null })
  expect((await getShopifyReviewEnvios(mio.venueId, [suya.id])).items).toEqual([])
  expect((await conexion(mio)).conteos).toMatchObject({ pendientes: 0, atorados: 0, porRevisar: 0, sinPareja: 0 })
  expect((await conexion(ajeno)).conteos).toMatchObject({ pendientes: 1, atorados: 1, porRevisar: 1, sinPareja: 1 })
  // Una revisión que apuntara al producto de OTRO negocio no lo enseña (ni su nombre ni su SKU).
  await prisma.shopifyReviewItem.create({
    data: { venueId: mio.venueId, productId: ajeno.productId, reason: 'DIFERENCIA', avoqadoQty: 1, shopifyQty: 2, suggestion: 'AVOQADO' },
  })
  expect((await listShopifyReviews(mio.venueId, {})).total).toBe(0)
  // Una elección cuya fila del buzón es de otro negocio no se enseña como en camino.
  const enOtroNegocio = await revisionResuelta(mio, (await fila(ajeno, 'PENDING')).id)
  expect((await getShopifyReviewEnvios(mio.venueId, [enOtroNegocio.id])).items).toEqual([
    { id: enOtroNegocio.id, status: 'RESOLVED', choice: 'AVOQADO', envio: null },
  ])
})

it('«Por revisar» también enseña las elecciones en camino, con el estado de SU fila: PENDIENTE, ATORADO, ENVIADO (< 24 h)', async () => {
  const e = await escenario()
  const resuelta = async (outboxId: string | null, creada: Date) => revisionResuelta(e, outboxId, creada)
  const abierta = await prisma.shopifyReviewItem.create({
    data: {
      venueId: e.venueId,
      productId: e.productId,
      reason: 'ATORADO',
      avoqadoQty: 3,
      shopifyQty: 4,
      suggestion: 'AVOQADO',
      createdAt: hace(500),
    },
  })
  const pendiente = await resuelta((await fila(e, 'PENDING')).id, hace(10))
  const atorada = await resuelta((await fila(e, 'DEAD_LETTER', { processedAt: hace(5) })).id, hace(20))
  const enviada = await resuelta((await fila(e, 'SENT', { processedAt: hace(60) })).id, hace(30))
  await resuelta((await fila(e, 'SENT', { processedAt: hace(25 * 60) })).id, hace(40)) // vieja: no sale
  await resuelta((await fila(e, 'DISCARDED', { processedAt: hace(5) })).id, hace(50)) // descartada: no sale
  await resuelta(null, hace(60)) // resuelta con el número de Shopify: no sale

  const lista = await listShopifyReviews(e.venueId, { offset: 0, limit: 20 })
  expect(lista.total).toBe(4)
  expect(lista.items.map(i => [i.id, i.status, i.envio])).toEqual([
    [abierta.id, 'OPEN', null],
    [pendiente.id, 'RESOLVED', 'PENDIENTE'],
    [atorada.id, 'RESOLVED', 'ATORADO'],
    [enviada.id, 'RESOLVED', 'ENVIADO'],
  ])
  expect(lista.items[1]).toMatchObject({ choice: 'AVOQADO', avoqadoQty: '5', shopifyQty: 4 })
  expect((await listShopifyReviews(e.venueId, { q: 'camisa', limit: 2 })).nextOffset).toBe(2)
})

it('Y1: la fila del buzón se borra a los 30 días: la elección que la apuntaba no es «se enviará» (ni en la lista ni en los envíos)', async () => {
  const e = await escenario()
  const purgada = await fila(e, 'SENT', { processedAt: hace(40 * 24 * 60) })
  const sinFila = await revisionResuelta(e, purgada.id)
  await prisma.shopifyStockOutbox.delete({ where: { id: purgada.id } }) // lo que hace la limpieza
  const nuncaExistio = await revisionResuelta(e, 'fila-que-ya-no-existe')
  expect((await listShopifyReviews(e.venueId, {})).total).toBe(0)
  const r = await getShopifyReviewEnvios(e.venueId, [sinFila.id, nuncaExistio.id])
  expect(r.items.map(i => i.envio)).toEqual([null, null])
})

it('V4: una revisión de una pareja suspendida se enseña igual, con lo guardado (motivo y sugerencia pueden estar viejos)', async () => {
  const e = await escenario()
  await prisma.shopifyVariantLink.update({
    where: { id: e.variantLinkId },
    data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
  })
  await prisma.shopifyReviewItem.create({
    data: { venueId: e.venueId, productId: e.productId, reason: 'INCIERTO', avoqadoQty: 7, shopifyQty: 3, suggestion: 'SHOPIFY' },
  })
  const r = await listShopifyReviews(e.venueId, {})
  expect(r.items).toHaveLength(1)
  expect(r.items[0]).toMatchObject({ reason: 'INCIERTO', suggestion: 'SHOPIFY', avoqadoQty: '7', shopifyQty: 3 })
})

it('R10 y S8: nada interno sale — ni la hora «nunca leída» de una pareja sin iniciar ni el avance de un evento', async () => {
  const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
  await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { mirrorAt: new Date(0) } })
  await prisma.shopifyInboundEvent.create({
    data: {
      dedupKey: `resumen-${e.venueId}`,
      appKey: 'PILOTO',
      topic: 'products/update',
      shopDomain: e.shopDomain,
      payload: { id: 77, _avoqadoAvance: { cursor: 'abc', vistas: ['x'] } },
      status: 'RECEIVED',
      error: 'SIN_TIEMPO',
    },
  })
  await prisma.shopifyReviewItem.create({
    data: { venueId: e.venueId, productId: e.productId, reason: 'REACTIVADA', avoqadoQty: 1, shopifyQty: 1, suggestion: 'AVOQADO' },
  })
  await prisma.shopifyImportIssue.create({
    data: {
      venueId: e.venueId,
      shopifyVariantId: 'gid://shopify/ProductVariant/3',
      shopifyProductId: 'gid://shopify/Product/3',
      title: 'Algo',
      reason: 'SIN_SKU',
    },
  })
  const todo = JSON.stringify([
    await getShopifyOverview(e.venueId),
    await listShopifyReviews(e.venueId, {}),
    await listShopifyIssues(e.venueId, {}),
  ])
  expect(todo).not.toContain('1970')
  expect(todo).not.toContain('_avoqadoAvance')
  expect(todo).not.toContain('mirrorAt')
  expect((await conexion(e)).retrasoMin).toBeNull() // sin filas ni fase ACTIVE: nada que retrasar
})

it('el texto crudo de un error de importación no sale en «Productos sin pareja» (sólo la razón)', async () => {
  const e = await escenario()
  await prisma.shopifyImportIssue.createMany({
    data: [
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/41',
        shopifyProductId: 'gid://shopify/Product/4',
        title: 'Fallida',
        reason: 'ERROR_IMPORTACION',
        detail:
          'Variante gid://shopify/ProductVariant/41: Invalid `prisma.product.create()` invocation: Unique constraint failed on "Product_sku_key"',
      },
      {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/42',
        shopifyProductId: 'gid://shopify/Product/4',
        title: 'Choca',
        reason: 'SKU_CHOCA',
        detail: 'El SKU nuevo (X) ya es de otro producto',
      },
    ],
  })
  const r = await listShopifyIssues(e.venueId, {})
  expect(Object.fromEntries(r.items.map(i => [i.reason, i.detail]))).toEqual({
    ERROR_IMPORTACION: null,
    SKU_CHOCA: 'El SKU nuevo (X) ya es de otro producto',
  })
})

describe('envíos de «Por revisar» (C2 GET /reviews/envios)', () => {
  const ESTADOS = ['PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER', 'SENT', 'DISCARDED'] as const
  const ESPERADO: Record<(typeof ESTADOS)[number], 'PENDIENTE' | 'ATORADO' | 'ENVIADO' | null> = {
    PENDING: 'PENDIENTE',
    IN_PROGRESS: 'PENDIENTE',
    FAILED: 'PENDIENTE',
    DEAD_LETTER: 'ATORADO',
    SENT: 'ENVIADO',
    DISCARDED: null,
  }
  const revision = (e: EscenarioShopify, o: { resuelta?: boolean; outboxId?: string | null } = {}) =>
    prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: e.productId,
        reason: 'DIFERENCIA',
        avoqadoQty: 5,
        shopifyQty: 4,
        suggestion: 'AVOQADO',
        ...(o.resuelta ? { status: 'RESOLVED' as const, choice: 'AVOQADO' as const, resolutionOutboxId: o.outboxId ?? null } : {}),
      },
    })

  it('cada estado de SU fila del buzón da su envío (SENT sin ventana de 24 h); sin fila, DISCARDED u OPEN ⇒ null', async () => {
    const e = await escenario()
    const hace2dias = new Date(Date.now() - 48 * 3600_000)
    const ids = new Map<string, (typeof ESTADOS)[number]>()
    for (const status of ESTADOS) {
      const f = await prisma.shopifyStockOutbox.create({
        data: {
          venueId: e.venueId,
          locationLinkId: e.locationLinkId,
          generation: 1,
          productId: e.productId,
          delta: 1,
          status,
          claimToken: status === 'IN_PROGRESS' ? 'm' : null,
          processedAt: status === 'SENT' || status === 'DISCARDED' || status === 'DEAD_LETTER' ? hace2dias : null,
        },
      })
      ids.set((await revision(e, { resuelta: true, outboxId: f.id })).id, status)
    }
    const sinFila = await revision(e, { resuelta: true, outboxId: null })
    const abierta = await revision(e)
    const r = await getShopifyReviewEnvios(e.venueId, [...ids.keys(), sinFila.id, abierta.id])
    expect(r.items).toHaveLength(ESTADOS.length + 2)
    const por = new Map(r.items.map(i => [i.id, i]))
    for (const [id, status] of ids) expect(por.get(id)).toEqual({ id, status: 'RESOLVED', choice: 'AVOQADO', envio: ESPERADO[status] })
    expect(por.get(sinFila.id)).toEqual({ id: sinFila.id, status: 'RESOLVED', choice: 'AVOQADO', envio: null })
    expect(por.get(abierta.id)).toEqual({ id: abierta.id, status: 'OPEN', choice: null, envio: null })
  })

  it('las revisiones de OTRO venue y los ids desconocidos no salen', async () => {
    const e = await escenario()
    const otro = await escenario()
    const mia = await revision(e)
    const ajena = await revision(otro)
    const r = await getShopifyReviewEnvios(e.venueId, [mia.id, ajena.id, 'no-existe'])
    expect(r.items.map(i => i.id)).toEqual([mia.id])
  })

  it('tope de 50 ids aunque pidan más (una sola consulta acotada); los repetidos y lo que no es texto no cuentan', async () => {
    const e = await escenario()
    const creadas = []
    for (let i = 0; i < 55; i++) creadas.push((await revision(e)).id)
    expect((await getShopifyReviewEnvios(e.venueId, creadas)).items).toHaveLength(50)
    expect((await getShopifyReviewEnvios(e.venueId, [])).items).toEqual([])
    const r = await getShopifyReviewEnvios(e.venueId, [creadas[0], creadas[0], '', 7 as never, null as never])
    expect(r.items.map(i => i.id)).toEqual([creadas[0]])
  })
})

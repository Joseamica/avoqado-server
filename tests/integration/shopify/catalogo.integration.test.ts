// tests/integration/shopify/catalogo.integration.test.ts
/**
 * El traductor (B1): variante → producto plano, emparejar sin convertir y con candados, importar por páginas sin perder
 * variantes ni aceptar respuestas raras, respuestas cercadas por generación y lease, y el sync que lee TODAS las páginas
 * antes de archivar sin romper la barrera de un envío en camino. Postgres real; Shopify por deps.graphql.
 */
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { fetchLevels } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import {
  ARCHIVADO_POR_SHOPIFY,
  archivarPareja,
  archiveShopifyProduct,
  FIN_PAGINAS,
  importCatalogPage,
  nivelDeVariante,
  normalizeSku,
  syncShopifyProduct,
  upsertShopifyVariant,
  type AvanceSync,
  type VarianteShopify,
} from '@/services/commerce-channels/shopify/shopify.catalog.service'
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
import { atenderFalla, leerNiveles, MIN_HTTP_MS, TOKEN_ILEGIBLE } from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  conPlan,
  contexto,
  dormir,
  falla,
  graphqlConEfecto,
  limpiarOtraSucursal,
  otraSucursalDeLaTienda,
  paginaDeVariantes,
  procesando,
  variante,
} from './fixturesB'

jest.setTimeout(120_000)

let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
beforeAll(() => assertTestDatabase())
beforeEach(() => (logAction as jest.Mock).mockClear())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

const conectando = () => escenario({ linkStatus: 'CONNECTING', initialized: false })
/** Una página de la importación con el plan puesto (sin `hasAccess` el traductor mira el plan real, Minor 5). */
const importar = (id: string, deps: Parameters<typeof importCatalogPage>[1] = {}) => importCatalogPage(id, { hasAccess: conPlan, ...deps })
const porSku = (e: EscenarioShopify, sku: string) =>
  prisma.product.findUniqueOrThrow({
    where: { venueId_sku: { venueId: e.venueId, sku } },
    include: { inventory: true, category: true, shopifyVariantLink: true },
  })
const problema = (e: EscenarioShopify, n: number) =>
  prisma.shopifyImportIssue.findUnique({ where: { venueId_shopifyVariantId: { venueId: e.venueId, shopifyVariantId: variante(n).id } } })
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const filaDelBuzon = (e: EscenarioShopify, productId: string, status: 'IN_PROGRESS' | 'PENDING', ambiguous = false) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId,
      delta: -1,
      status,
      ambiguous,
      claimToken: status === 'IN_PROGRESS' ? 'm' : null,
    },
  })

describe('emparejar y crear (12 bis.13, #11, #20, N07, N05)', () => {
  it('normaliza el SKU con la regla de Avoqado', () => {
    expect(normalizeSku(' CAM/AZ.M 1 ')).toBe('CAM-AZ-M-1')
    expect(normalizeSku('A--B_c')).toBe('A--B_c')
    expect(normalizeSku('')).toBeNull()
    expect(normalizeSku('///')).toBeNull()
    expect(normalizeSku(null)).toBeNull()
  })

  it('el nivel de la página: inactivo o ausente ⇒ SIN_NIVEL; sin rastrear ⇒ NO_RASTREADO; nunca un cero inventado', () => {
    expect(nivelDeVariante(variante(1, { available: 4, committed: 2 }))).toEqual({ kind: 'OK', available: 4, committed: 2 })
    expect(nivelDeVariante(variante(1, { inactivo: true }))).toEqual({ kind: 'SIN_NIVEL' })
    expect(nivelDeVariante(variante(1, { sinNivel: true }))).toEqual({ kind: 'SIN_NIVEL' })
    expect(nivelDeVariante(variante(1, { tracked: false }))).toEqual({ kind: 'NO_RASTREADO' })
  })

  it('variante nueva ⇒ producto plano con imagen de la variante, precio en pesos, stock 0 y pareja sin iniciar; nada viaja', async () => {
    const e = await conectando()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { catalogSweepId: 4 } })
    expect(await upsertShopifyVariant(await contexto(e), variante(1))).toMatchObject({
      kind: 'CREADO',
      iniciada: false,
      creadaPorConector: true,
    })
    const p = await porSku(e, 'CAM-AZ-1')
    expect(p).toMatchObject({
      name: 'Camisa lino · M1',
      gtin: '7500000000001',
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      originSystem: 'SHOPIFY',
      active: true,
      imageUrl: 'https://cdn.test/v1.jpg',
    })
    expect(p.price.toFixed(2)).toBe('499.00')
    expect(p.category.name).toBe('Camisas')
    expect(p.inventory!.currentStock.toString()).toBe('0')
    expect(p.shopifyVariantLink).toMatchObject({
      importedAvailable: 6,
      initializedAt: null,
      createdProduct: true,
      lastSeenSweepId: 4,
      shopifyProductId: 'gid://shopify/Product/77',
      originalSku: 'CAM-AZ-1',
    })
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: p.id } })).toBe(0)
  })

  it('sin imagen propia usa la del producto; sin ninguna, null', async () => {
    const e = await conectando()
    await upsertShopifyVariant(await contexto(e), variante(2, { imagenVariante: null }))
    expect((await porSku(e, 'CAM-AZ-2')).imageUrl).toBe('https://cdn.test/p.jpg')
    await upsertShopifyVariant(await contexto(e), variante(3, { imagenVariante: null, imagenProducto: null }))
    expect((await porSku(e, 'CAM-AZ-3')).imageUrl).toBeNull()
  })

  it('sin precio en MXN ⇒ se importa sin poder venderse y queda SIN_PRECIO, con su pareja', async () => {
    const e = await conectando()
    await upsertShopifyVariant(await contexto(e), variante(4, { precio: { amount: '30.00', currencyCode: 'EUR' } }))
    const p = await porSku(e, 'CAM-AZ-4')
    expect(p.active).toBe(false)
    expect(p.price.toFixed(2)).toBe('0.00')
    expect(p.shopifyVariantLink).not.toBeNull()
    expect(await problema(e, 4)).toMatchObject({ reason: 'SIN_PRECIO', productId: p.id })
  })

  it('sin SKU ⇒ SIN_SKU y no crea nada', async () => {
    const e = await conectando()
    expect(await upsertShopifyVariant(await contexto(e), variante(5, { sku: '  ' }))).toEqual({ kind: 'PROBLEMA', reason: 'SIN_SKU' })
    expect(await problema(e, 5)).toMatchObject({ reason: 'SIN_SKU' })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('dos variantes con el mismo SKU ⇒ la segunda es SKU_REPETIDO y no pisa la pareja de la primera', async () => {
    const e = await conectando()
    await upsertShopifyVariant(await contexto(e), variante(6))
    expect(await upsertShopifyVariant(await contexto(e), variante(7, { sku: 'CAM-AZ-6', barcode: null }))).toEqual({
      kind: 'PROBLEMA',
      reason: 'SKU_REPETIDO',
    })
    expect((await porSku(e, 'CAM-AZ-6')).shopifyVariantLink!.shopifyVariantId).toBe(variante(6).id)
  })

  it('el SKU apunta a un producto y el código de barras a otro ⇒ IDENTIDAD_EN_CONFLICTO; ninguno se liga', async () => {
    const e = await conectando()
    const a = await agregarProductoShopify(e, { sku: 'ID-A', pareja: false })
    const b = await agregarProductoShopify(e, { sku: 'ID-B', pareja: false })
    await prisma.product.update({ where: { id: b.productId }, data: { gtin: '7509999999999' } })
    expect(await upsertShopifyVariant(await contexto(e), variante(8, { sku: 'ID-A', barcode: '7509999999999' }))).toEqual({
      kind: 'PROBLEMA',
      reason: 'IDENTIDAD_EN_CONFLICTO',
    })
    expect(await prisma.shopifyVariantLink.count({ where: { productId: { in: [a.productId, b.productId] } } })).toBe(0)
  })

  it('un producto existente con el mismo SKU ⇒ LIGADO (ya existía); al importar su stock no se toca', async () => {
    const e = await conectando()
    const ex = await agregarProductoShopify(e, { sku: 'EXIST-1', stock: 4, pareja: false })
    expect(await upsertShopifyVariant(await contexto(e), variante(9, { sku: 'EXIST-1' }))).toMatchObject({
      kind: 'LIGADO',
      productId: ex.productId,
      creadaPorConector: false,
    })
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: ex.inventoryId } })).currentStock.toString()).toBe('4')
  })

  it('el SKU sólo coincide después de normalizar ⇒ SKU_CHOCA: es otro producto de Avoqado y no se liga', async () => {
    const e = await conectando()
    const ex = await agregarProductoShopify(e, { sku: 'CAM-AZ', pareja: false })
    expect(await upsertShopifyVariant(await contexto(e), variante(10, { sku: 'CAM/AZ', barcode: null }))).toEqual({
      kind: 'PROBLEMA',
      reason: 'SKU_CHOCA',
    })
    expect(await prisma.shopifyVariantLink.count({ where: { productId: ex.productId } })).toBe(0)
  })

  it.each([
    ['archivado por el dueño', 'PRODUCTO_ARCHIVADO', { deletedAt: new Date(), deletedBy: 'staff-dueno', active: false }],
    ['de receta', 'METODO_RECETA', { inventoryMethod: 'RECIPE' }],
    ['de tipo clase', 'TIPO_SIN_INVENTARIO', { type: 'CLASS' }],
    ['sin inventario', 'SIN_INVENTARIO_EN_AVOQADO', { trackInventory: false, inventoryMethod: null }],
    ['vendido por kilo', 'UNIDAD_NO_PIEZA', { unit: 'KILOGRAM' }],
    [
      'archivado por el conector y luego pasado a receta (N07)',
      'METODO_RECETA',
      { deletedAt: new Date(), deletedBy: 'SHOPIFY_SYNC', active: false, inventoryMethod: 'RECIPE' },
    ],
  ] as const)('un existente %s ⇒ %s y el producto queda igual (nunca se convierte ni se restaura)', async (_n, motivo, cambio) => {
    const e = await conectando()
    const ex = await agregarProductoShopify(e, { sku: 'NO-LIGA', pareja: false })
    await prisma.product.update({ where: { id: ex.productId }, data: { originSystem: 'SHOPIFY', ...cambio } })
    const antes = await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })
    expect(await upsertShopifyVariant(await contexto(e), variante(11, { sku: 'NO-LIGA', barcode: null }))).toEqual({
      kind: 'PROBLEMA',
      reason: motivo,
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })).toEqual(antes)
    expect(await problema(e, 11)).toMatchObject({ reason: motivo, productId: ex.productId })
  })

  it('#14: el plan se revisa DENTRO de la transacción común, con la sucursal ya bloqueada: sin plan, nada se escribe', async () => {
    const e = await conectando()
    // K20: muerde si el plan se mira fuera de la tx: desde OTRA conexión, la sucursal sólo está ocupada mientras la
    // transacción del upsert la tiene (FOR SHARE del cerco).
    let sucursalOcupada: boolean | null = null
    const hasAccess = async () => {
      sucursalOcupada = await prisma.$queryRaw`SELECT id FROM "ShopifyLocationLink" WHERE id = ${e.locationLinkId} FOR UPDATE NOWAIT`.then(
        () => false,
        () => true,
      )
      return false
    }
    expect(await upsertShopifyVariant({ ...(await contexto(e)), hasAccess }, variante(31))).toEqual({ kind: 'OBSOLETO' })
    expect(sucursalOcupada).toBe(true)
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
    expect(await problema(e, 31)).toBeNull()
  })

  it('N07: el producto pasa a receta mientras el upsert espera su candado ⇒ METODO_RECETA y no recrea Inventory', async () => {
    const e = await conectando()
    const ex = await agregarProductoShopify(e, { sku: 'CARRERA-1', pareja: false })
    let tomado!: () => void
    const tomadoP = new Promise<void>(r => (tomado = r))
    let soltar!: () => void
    const soltarP = new Promise<void>(r => (soltar = r))
    const otra = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${ex.productId} FOR UPDATE`
        tomado()
        await soltarP
        await tx.product.update({ where: { id: ex.productId }, data: { inventoryMethod: 'RECIPE' } })
        await tx.inventory.deleteMany({ where: { productId: ex.productId } })
      },
      { timeout: 30_000 },
    )
    await tomadoP
    const ctx = await contexto(e)
    const upsert = upsertShopifyVariant(ctx, variante(12, { sku: 'CARRERA-1', barcode: null }))
    await new Promise(r => setTimeout(r, 300)) // el upsert ya leyó al candidato y espera su candado
    soltar()
    await otra
    expect(await upsert).toEqual({ kind: 'PROBLEMA', reason: 'METODO_RECETA' })
    expect(await prisma.inventory.count({ where: { productId: ex.productId } })).toBe(0)
    expect(await prisma.shopifyVariantLink.count({ where: { productId: ex.productId } })).toBe(0)
  })

  it('N05: la sucursal cambió de generación, de lease o perdió el reclamo del evento ⇒ OBSOLETO y nada se escribe', async () => {
    const e = await conectando()
    const ctx = await contexto(e)
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
    expect(await upsertShopifyVariant(ctx, variante(13))).toEqual({ kind: 'OBSOLETO' })

    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'otro' } })
    expect(await upsertShopifyVariant(await contexto(e, { workToken: 'mio' }), variante(13))).toEqual({ kind: 'OBSOLETO' })

    const ev = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: `ev-${e.venueId}`,
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: {},
        status: 'PROCESSING',
        claimToken: 'nuevo',
      },
    })
    expect(await upsertShopifyVariant(await contexto(e, { reclamo: { eventId: ev.id, claimToken: 'viejo' } }), variante(13))).toEqual({
      kind: 'OBSOLETO',
    })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('una pareja existente se edita (nombre, SKU, código, SKU original, imagen quitada); un SKU ocupado se conserva y se avisa', async () => {
    const e = await conectando()
    await upsertShopifyVariant(await contexto(e), variante(14))
    const editada = variante(14, {
      titulo: 'Camisa lino premium',
      sku: 'CAM AZ 14 B',
      barcode: '7500000099999',
      imagenVariante: null,
      imagenProducto: null,
    })
    expect(await upsertShopifyVariant(await contexto(e), editada)).toMatchObject({ kind: 'ACTUALIZADO' })
    const p = await porSku(e, 'CAM-AZ-14-B')
    expect(p).toMatchObject({ name: 'Camisa lino premium · M14', gtin: '7500000099999', imageUrl: null })
    expect(p.shopifyVariantLink!.originalSku).toBe('CAM AZ 14 B')

    await agregarProductoShopify(e, { sku: 'OCUPADO', pareja: false })
    await upsertShopifyVariant(await contexto(e), variante(14, { sku: 'OCUPADO', barcode: '7500000099999' }))
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).sku).toBe('CAM-AZ-14-B')
    expect(await problema(e, 14)).toMatchObject({ reason: 'SKU_CHOCA', productId: p.id })
  })
})

describe('importar por páginas (#18, #19, N05, N06, N20)', () => {
  it('avanza el cursor con el filtro de estado, guarda lo importado y en la última página pasa a REVIEWING', async () => {
    const e = await conectando()
    const graphql = graphqlFalso((_q, vars) =>
      vars.after ? paginaDeVariantes([variante(21)], null) : paginaDeVariantes([variante(22), variante(23)], 'c1', 3),
    )
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ done: false, procesadas: 2 })
    expect(graphql.mock.calls[0][3]).toMatchObject({
      first: 50,
      after: null,
      query: 'product_status:active,draft', // en minúsculas: en mayúsculas Shopify devuelve 0 (C10, en vivo)
      loc: 'gid://shopify/Location/1',
      conteo: true,
    })
    expect(await sucursal(e)).toMatchObject({ importCursor: 'c1', status: 'CONNECTING' })
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ done: true, procesadas: 1 })
    expect(graphql.mock.calls[1][3]).toMatchObject({ after: 'c1', conteo: false })
    const l = await sucursal(e)
    expect(l).toMatchObject({ importCursor: null, status: 'REVIEWING', importAttempts: 0, importError: null, lastReconciledAt: null })
    expect(l.importedAt).toBeInstanceOf(Date)
  })

  it('una variante que truena no avanza el cursor; al 5º intento queda ERROR_IMPORTACION y la página sigue', async () => {
    const e = await conectando()
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(31), variante(32), variante(33)], 'c2'))
    const upsert = jest.fn(async (c: Parameters<typeof upsertShopifyVariant>[0], v: VarianteShopify) => {
      if (v.id === variante(32).id) throw new Error('la base parpadeó')
      return upsertShopifyVariant(c, v)
    })
    for (let i = 1; i <= 4; i++) {
      expect(await importar(e.locationLinkId, { graphql, upsert })).toEqual({ error: 'VARIANTE_FALLO', retry: true })
      expect(await sucursal(e)).toMatchObject({ importCursor: null, importAttempts: i })
    }
    expect(await importar(e.locationLinkId, { graphql, upsert })).toEqual({ done: false, procesadas: 3 })
    expect(await sucursal(e)).toMatchObject({ importCursor: 'c2', importAttempts: 0 })
    expect(await problema(e, 32)).toMatchObject({ reason: 'ERROR_IMPORTACION' })
    expect(await prisma.shopifyVariantLink.count({ where: { shopifyVariantId: { in: [variante(31).id, variante(33).id] } } })).toBe(2)
  })

  it('catálogo de más de 20,000 variantes ⇒ importError CATALOGO_MUY_GRANDE; no importa nada ni vuelve a preguntar (12 bis.12)', async () => {
    const e = await conectando()
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(41)], 'c1', 20_001))
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'CATALOGO_MUY_GRANDE', retry: false })
    expect(graphql.mock.calls[0][3]).toMatchObject({ conteo: true, limite: 20_001 })
    expect(await sucursal(e)).toMatchObject({ status: 'CONNECTING', importCursor: null, importError: 'CATALOGO_MUY_GRANDE' })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'CATALOGO_MUY_GRANDE', retry: false })
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  const pagina = (nodes: unknown[], pageInfo: unknown, total: unknown = { count: nodes.length }) => ({
    ok: true as const,
    data: { total, productVariants: { pageInfo, nodes } },
  })
  const raras: Array<[string, ReturnType<typeof pagina>]> = [
    ['primera página sin conteo', pagina([variante(51)], { hasNextPage: false, endCursor: null }, null)],
    ['hay otra página pero el cursor no avanza', pagina([variante(52)], { hasNextPage: true, endCursor: null })],
    ['la misma variante dos veces', pagina([variante(53), variante(53)], { hasNextPage: false, endCursor: null })],
    [
      'una cantidad fuera de rango',
      pagina(
        [
          {
            ...variante(54),
            inventoryItem: {
              ...variante(54).inventoryItem,
              inventoryLevel: {
                isActive: true,
                quantities: [
                  { name: 'available', quantity: 3e9 },
                  { name: 'committed', quantity: 0 },
                ],
              },
            },
          },
        ],
        {
          hasNextPage: false,
          endCursor: null,
        },
      ),
    ],
    [
      'un nivel sin isActive',
      pagina([{ ...variante(55), inventoryItem: { ...variante(55).inventoryItem, inventoryLevel: { quantities: [] } } }], {
        hasNextPage: false,
        endCursor: null,
      }),
    ],
  ]
  it.each(raras)('N06: %s ⇒ BAD_RESPONSE: no importa nada ni avanza', async (_n, respuesta) => {
    const e = await conectando()
    expect(await importar(e.locationLinkId, { graphql: graphqlFalso(() => respuesta) })).toEqual({
      error: 'BAD_RESPONSE',
      retry: true,
    })
    expect(await sucursal(e)).toMatchObject({
      importCursor: null,
      status: 'CONNECTING',
      importError: expect.stringContaining('BAD_RESPONSE'),
    })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('si la página no llega, no avanza, suma el intento y deja el error a la vista', async () => {
    const e = await conectando()
    expect(await importar(e.locationLinkId, { graphql: graphqlFalso(() => falla('HTTP_5XX', true, true)) })).toEqual({
      error: 'HTTP_5XX',
      retry: true,
    })
    expect(await sucursal(e)).toMatchObject({ importCursor: null, importAttempts: 1, importError: expect.stringContaining('HTTP_5XX') })
  })

  it('N20: falta un permiso (403 o ACCESS_DENIED) ⇒ FALTA_PERMISO a la vista, aviso, y no vuelve a preguntar', async () => {
    const e = await conectando()
    const graphql = graphqlFalso(() => falla('FORBIDDEN', false, false))
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'FALTA_PERMISO', retry: false })
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO', importAttempts: 0, importCursor: null })
    expect(
      await prisma.notification.count({
        where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'FALTA_PERMISO:' } },
      }),
    ).toBe(1)
    // K18: la marca deja rastro en la bitácora del negocio.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: e.venueId,
        action: 'SHOPIFY_PERMISSION_MISSING',
        entity: 'ShopifyLocationLink',
        entityId: e.locationLinkId,
      }),
    )
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'FALTA_PERMISO', retry: false })
    expect(graphql).toHaveBeenCalledTimes(1)
  })

  it('N05: la conexión cambió mientras la página viajaba ⇒ nada se crea y el cursor no avanza', async () => {
    const e = await conectando()
    const graphql = graphqlConEfecto(
      () => prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } }).then(() => undefined),
      () => paginaDeVariantes([variante(61)], 'c1', 1),
    )
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'CONTEXTO_CAMBIO', retry: false })
    expect(await sucursal(e)).toMatchObject({ importCursor: null, generation: 2 })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('§10.1: el lease pasó a otro worker mientras la página viajaba ⇒ esta unidad no escribe ni avanza', async () => {
    const e = await conectando()
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { workToken: 'w1', workLeaseUntil: new Date(Date.now() + 90_000) },
    })
    const graphql = graphqlConEfecto(
      () => prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'w2' } }).then(() => undefined),
      () => paginaDeVariantes([variante(62)], 'c1', 1),
    )
    expect(await importar(e.locationLinkId, { graphql, workToken: 'w1' })).toEqual({ error: 'CONTEXTO_CAMBIO', retry: false })
    expect(await sucursal(e)).toMatchObject({ importCursor: null })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('N05 (§12.2): una falta de permiso marcada mientras la página viajaba no la borran ni el avance ni un error pasajero', async () => {
    const e = await conectando()
    const marcar = () =>
      prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'FALTA_PERMISO' } }).then(() => undefined)
    // Con variantes: el upsert ve el error terminal bajo candado (cerco de A) y no escribe.
    const conVariante = graphqlConEfecto(marcar, () => paginaDeVariantes([variante(63)], 'c1', 1))
    expect(await importar(e.locationLinkId, { graphql: conVariante })).toEqual({ error: 'CONTEXTO_CAMBIO', retry: false })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO', importCursor: null, status: 'CONNECTING' })
    // La última página, vacía: sólo el CAS del avance la detiene (antes la habría pasado a REVIEWING sin el error).
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
    const vacia = graphqlConEfecto(marcar, () => paginaDeVariantes([], null, 0))
    expect(await importar(e.locationLinkId, { graphql: vacia })).toEqual({ error: 'CONTEXTO_CAMBIO', retry: false })
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO', status: 'CONNECTING' })
    // Un error pasajero tampoco la pisa ni suma intentos.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
    const caida = graphqlConEfecto(marcar, () => falla('HTTP_5XX', true, true))
    expect(await importar(e.locationLinkId, { graphql: caida })).toEqual({ error: 'HTTP_5XX', retry: true })
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO', importAttempts: 0 })
  })
})

describe('sync de un producto en ACTIVE (#7, #20, N01, N11, N21)', () => {
  const PRODUCTO = 'gid://shopify/Product/500'
  const cincuentaYUno = Array.from({ length: 51 }, (_, i) => variante(100 + i, { producto: PRODUCTO }))
  const paginas = (variantes: VarianteShopify[], fallarSegunda = false) =>
    graphqlFalso((_q, vars) => {
      if (!vars.after) return paginaDeVariantes(variantes.slice(0, 50), variantes.length > 50 ? 'p2' : null)
      return fallarSegunda ? falla('HTTP_5XX', true, true) : paginaDeVariantes(variantes.slice(50), null)
    })

  it('RF2: con la segunda página caída no archiva nada; si la variante 51 desaparece, se archiva; si vuelve, se restaura el MISMO producto', async () => {
    const e = await escenario()
    expect(await syncShopifyProduct(e.storeId, PRODUCTO, { hasAccess: conPlan, graphql: paginas(cincuentaYUno) })).toEqual({ ok: true })
    const la51 = await porSku(e, 'CAM-AZ-150')
    expect(la51.shopifyVariantLink!.initializedAt).not.toBeNull() // producto nuevo en ACTIVE: TOMAR_SHOPIFY
    expect(la51.inventory!.currentStock.toString()).toBe('6')
    expect(la51.shopifyVariantLink!.mirrorAvailable).toBe(6)

    expect(await syncShopifyProduct(e.storeId, PRODUCTO, { hasAccess: conPlan, graphql: paginas(cincuentaYUno, true) })).toEqual({
      error: 'HTTP_5XX',
      retry: true,
    })
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId, shopifyProductId: PRODUCTO } })).toBe(51)

    expect(await syncShopifyProduct(e.storeId, PRODUCTO, { hasAccess: conPlan, graphql: paginas(cincuentaYUno.slice(0, 50)) })).toEqual({
      ok: true,
    })
    const archivada = await prisma.product.findUniqueOrThrow({ where: { id: la51.id }, include: { shopifyVariantLink: true } })
    expect(archivada).toMatchObject({ active: false, deletedBy: ARCHIVADO_POR_SHOPIFY, shopifyVariantLink: null })
    expect(archivada.deletedAt).toBeInstanceOf(Date)

    expect(await syncShopifyProduct(e.storeId, PRODUCTO, { hasAccess: conPlan, graphql: paginas(cincuentaYUno) })).toEqual({ ok: true })
    const restaurada = await porSku(e, 'CAM-AZ-150')
    expect(restaurada).toMatchObject({ id: la51.id, deletedAt: null, active: true })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: e.venueId, action: 'SHOPIFY_PRODUCT_RESTORED', entityId: la51.id }),
    ) // K18
    // Ya existía, con su historia (§9.6): createdProduct = false ⇒ se COMPARA, y cuadra (6 = 6).
    expect(restaurada.shopifyVariantLink).toMatchObject({ createdProduct: false })
    expect(restaurada.shopifyVariantLink!.initializedAt).not.toBeNull()
    expect(await prisma.shopifyReviewItem.count({ where: { productId: la51.id, status: 'OPEN' } })).toBe(0)
  })

  it('N05: una baja decidida con la conexión anterior no archiva la pareja de la conexión nueva', async () => {
    const e = await escenario()
    const vista = await prisma.shopifyVariantLink.findUniqueOrThrow({
      where: { id: e.variantLinkId },
      include: { locationLink: { include: { store: true } } },
    })
    const cerco = {
      generation: vista.locationLink.generation,
      storeId: e.storeId,
      shopifyLocationId: vista.locationLink.shopifyLocationId,
      tokenVersion: vista.locationLink.store.tokenVersion,
    }
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: { increment: 1 } } }) // se desconectó y reconectó
    expect(await archivarPareja(vista, cerco)).toBe('OBSOLETO')
    expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ deletedAt: null })
  })

  it('N17 (§12.8): una primera página lenta no detiene a la segunda: lo escrito queda, el avance se guarda y la siguiente vez sigue en la página 2; las bajas, sólo con el recorrido completo', async () => {
    const e = await escenario()
    const P = 'gid://shopify/Product/510'
    const huerfana = await agregarProductoShopify(e)
    await prisma.shopifyVariantLink.update({ where: { id: huerfana.variantLinkId! }, data: { shopifyProductId: P } })
    const responde = graphqlFalso((_q, vars) =>
      vars.after ? paginaDeVariantes([variante(212, { producto: P })], null) : paginaDeVariantes([variante(211, { producto: P })], 'q2'),
    )
    const graphql = jest.fn(async (...a: unknown[]) => {
      if (!(a[3] as { after?: string | null }).after) await dormir(1_000) // la primera página tarda
      return responde(...a)
    })
    const guardado: AvanceSync = {}
    const guardarAvance = jest.fn(async (a: AvanceSync) => {
      Object.assign(guardado, JSON.parse(JSON.stringify(a)))
      return true
    })
    // Tras la primera página quedan ~1.5 s: alcanza para escribirla (MIN_ESCRITURA_MS, 1 s), no para pedir otra (2 s).
    const vence = Date.now() + MIN_HTTP_MS + 600
    expect(
      await syncShopifyProduct(e.storeId, P, { hasAccess: conPlan, graphql: graphql as never, vence, avance: guardado, guardarAvance }),
    ).toEqual({
      error: 'SIN_TIEMPO',
      retry: true,
    })
    expect(graphql).toHaveBeenCalledTimes(1)
    expect(graphql.mock.calls[0][4]).toMatchObject({ timeoutMs: expect.any(Number) }) // el corte real va a la petición
    expect(await prisma.shopifyVariantLink.count({ where: { shopifyVariantId: variante(211).id } })).toBe(1) // la página 1 quedó
    expect(await prisma.shopifyVariantLink.count({ where: { id: huerfana.variantLinkId! } })).toBe(1) // sin recorrido completo, ninguna baja
    const l = await sucursal(e)
    expect(guardado[`${l.id}:${l.generation}`]).toEqual({ cursor: 'q2', vistas: [variante(211).id] })

    expect(
      await syncShopifyProduct(e.storeId, P, { hasAccess: conPlan, graphql: graphql as never, avance: guardado, guardarAvance }),
    ).toEqual({ ok: true })
    expect(graphql).toHaveBeenCalledTimes(2) // la página 1 no se repitió
    expect((graphql.mock.calls[1][3] as { after: string }).after).toBe('q2')
    expect(await prisma.shopifyVariantLink.count({ where: { shopifyVariantId: variante(212).id } })).toBe(1)
    expect(await prisma.shopifyVariantLink.count({ where: { id: huerfana.variantLinkId! } })).toBe(0) // ahora sí: no vino en ninguna
    expect(guardado[`${l.id}:${l.generation}`]).toMatchObject({ cursor: FIN_PAGINAS })
  })

  it('RF2 (N01): con un envío en camino, archivar SUSPENDE la pareja y conserva la barrera; al cerrar el envío, se borra', async () => {
    const e = await escenario()
    const fila = await filaDelBuzon(e, e.productId, 'IN_PROGRESS')
    expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')).toEqual({ archivadas: 0, suspendidas: 1 })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      suspendedReason: 'NIVEL_INEXISTENTE',
    })
    expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: fila.id } })).status).toBe('IN_PROGRESS')
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({
      deletedBy: ARCHIVADO_POR_SHOPIFY,
      active: false,
    })

    await prisma.shopifyStockOutbox.update({ where: { id: fila.id }, data: { status: 'SENT', processedAt: new Date(), claimToken: null } })
    expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')).toEqual({ archivadas: 1, suspendidas: 0 })
    expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(0)
  })

  it('un producto que ya estaba en Avoqado y se liga en ACTIVE se COMPARA: Inventory intacto y «Por revisar» REACTIVADA', async () => {
    const e = await escenario()
    const ex = await agregarProductoShopify(e, { sku: 'TARDE-1', stock: 4, pareja: false })
    const graphql = graphqlFalso(() =>
      paginaDeVariantes([variante(160, { sku: 'TARDE-1', barcode: null, producto: 'gid://shopify/Product/600', available: 9 })], null),
    )
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/600', { graphql, hasAccess: conPlan })).toEqual({ ok: true })
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: ex.inventoryId } })).currentStock.toString()).toBe('4')
    expect(await prisma.shopifyReviewItem.findFirst({ where: { productId: ex.productId, status: 'OPEN' } })).toMatchObject({
      reason: 'REACTIVADA',
      shopifyQty: 9,
      suggestion: 'SHOPIFY',
    })
  })

  it('N21: una pareja que no pudo iniciarse (envío en camino del producto) deja pedido el cuadre', async () => {
    const e = await escenario()
    const ex = await agregarProductoShopify(e, { sku: 'ESPERA-1', stock: 4, pareja: false })
    await filaDelBuzon(e, ex.productId, 'IN_PROGRESS')
    const graphql = graphqlFalso(() =>
      paginaDeVariantes([variante(170, { sku: 'ESPERA-1', barcode: null, producto: 'gid://shopify/Product/650' })], null),
    )
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/650', { graphql, hasAccess: conPlan })).toEqual({ ok: true })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId: ex.productId } })).initializedAt).toBeNull()
    expect(await sucursal(e)).toMatchObject({ needsReconcile: true })
  })

  it('N11: si el evento pierde su reclamo entre páginas, el sync se detiene sin escribir nada', async () => {
    const e = await escenario()
    const ev = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: `ev-${e.venueId}`,
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: { id: 500 },
        status: 'RECEIVED',
      },
    })
    const reclamo = { eventId: ev.id, claimToken: await procesando(ev.id) }
    const renovar = jest.fn(async () => false) // otro proceso ya lo reclamó
    expect(
      await syncShopifyProduct(e.storeId, PRODUCTO, { hasAccess: conPlan, graphql: paginas(cincuentaYUno), reclamo, renovar }),
    ).toEqual({
      error: 'RECLAMO_PERDIDO',
      retry: false,
    })
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId, shopifyProductId: PRODUCTO } })).toBe(0)
  })

  it('con la sucursal en pausa no toca nada (sus avisos esperan diferidos)', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(180, { producto: 'gid://shopify/Product/700' })], null))
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/700', { graphql, hasAccess: conPlan })).toEqual({ ok: true })
    expect(graphql).not.toHaveBeenCalled()
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('products/delete archiva todas las parejas del producto, por tandas', async () => {
    const e = await escenario()
    for (let i = 0; i < 55; i++) {
      const p = await agregarProductoShopify(e)
      await prisma.shopifyVariantLink.update({ where: { id: p.variantLinkId! }, data: { shopifyProductId: 'gid://shopify/Product/800' } })
    }
    expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/800')).toEqual({ archivadas: 55, suspendidas: 0 })
    expect(await prisma.shopifyVariantLink.count({ where: { shopifyProductId: 'gid://shopify/Product/800' } })).toBe(0)
    expect(await prisma.product.count({ where: { venueId: e.venueId, deletedBy: ARCHIVADO_POR_SHOPIFY } })).toBe(55)
  })

  it('N11 (§12.8): un archivo interrumpido lo dice; lo archivado no vuelve a salir y la siguiente pasada sigue con lo que falta', async () => {
    const e = await escenario()
    const P = 'gid://shopify/Product/810'
    for (let i = 0; i < 55; i++) {
      const p = await agregarProductoShopify(e)
      await prisma.shopifyVariantLink.update({ where: { id: p.variantLinkId! }, data: { shopifyProductId: P } })
    }
    expect(await archiveShopifyProduct(e.storeId, P, { vence: Date.now() - 1 })).toEqual({
      archivadas: 0,
      suspendidas: 0,
      interrumpido: 'SIN_TIEMPO',
    })
    const renovar = jest.fn(async () => false) // el reclamo se pierde después de la primera tanda
    expect(await archiveShopifyProduct(e.storeId, P, { renovar })).toEqual({
      archivadas: 50,
      suspendidas: 0,
      interrumpido: 'RECLAMO_PERDIDO',
    })
    expect(await prisma.shopifyVariantLink.count({ where: { shopifyProductId: P } })).toBe(5)
    expect(await archiveShopifyProduct(e.storeId, P)).toEqual({ archivadas: 5, suspendidas: 0 })
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } })
    expect(await archiveShopifyProduct(e.storeId, P)).toEqual({ archivadas: 0, suspendidas: 0, interrumpido: 'CONTEXTO_CAMBIO' })
  })
})

describe('decisiones del preflight de B (K11, K14, K18, B-7)', () => {
  it('K11 (B-3): el candado del producto es FOR NO KEY UPDATE: una venta que lo referencia no espera al traductor', async () => {
    const e = await conectando()
    const ex = await agregarProductoShopify(e, { sku: 'LLAVE-1', pareja: false })
    // Lo que toma una venta al insertar un renglón con llave foránea al producto (FOR KEY SHARE), sin esperar, mientras el
    // upsert tiene el producto bloqueado (el plan se mira con el producto y la sucursal ya bloqueados).
    let ventaPaso: boolean | null = null
    const hasAccess = async () => {
      ventaPaso = await prisma.$queryRaw`SELECT id FROM "Product" WHERE id = ${ex.productId} FOR KEY SHARE NOWAIT`.then(
        () => true,
        () => false,
      )
      return true
    }
    expect(
      await upsertShopifyVariant({ ...(await contexto(e)), hasAccess }, variante(16, { sku: 'LLAVE-1', barcode: null })),
    ).toMatchObject({
      kind: 'LIGADO',
      productId: ex.productId,
    })
    expect(ventaPaso).toBe(true)
  })

  it('K14 (BR-6): la variante cambió de artículo de inventario ⇒ la pareja se suspende, guarda el id nuevo y conserva la barrera', async () => {
    const e = await conectando()
    await upsertShopifyVariant(await contexto(e), variante(15))
    const p = await porSku(e, 'CAM-AZ-15')
    const enCamino = await filaDelBuzon(e, p.id, 'IN_PROGRESS')
    const nunca = await filaDelBuzon(e, p.id, 'PENDING')
    const otra = variante(15)
    otra.inventoryItem = { ...otra.inventoryItem, id: 'gid://shopify/InventoryItem/7015' }
    expect(await upsertShopifyVariant(await contexto(e), otra)).toMatchObject({ kind: 'ACTUALIZADO', iniciada: false })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId: p.id } })).toMatchObject({
      inventoryItemId: 'gid://shopify/InventoryItem/7015',
      suspendedReason: 'NIVEL_INEXISTENTE',
    })
    expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: enCamino.id } })).status).toBe('IN_PROGRESS')
    expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: nunca.id } })).status).toBe('DISCARDED')
  })

  it('B-7: un token que no se puede descifrar no truena: no sale nada, el error queda a la vista y se reintenta', async () => {
    const e = await conectando()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: Buffer.from('cifrado-dañado') } })
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(17)], null))
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: TOKEN_ILEGIBLE, retry: true })
    expect(graphql).not.toHaveBeenCalled()
    expect(await sucursal(e)).toMatchObject({ importError: TOKEN_ILEGIBLE, importCursor: null, status: 'CONNECTING' })
    // La lectura de niveles (fetchLevels de A lanza al descifrar) tampoco truena.
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    expect(
      await leerNiveles(fetchLevels, store, [{ inventoryItemId: 'gid://shopify/InventoryItem/1', shopifyLocationId: UBICACION_PRUEBA }]),
    ).toMatchObject({
      ok: false,
      retryable: true,
    })
  })

  it('K18: Shopify rechaza la app con el token vigente (401) ⇒ la tienda queda REVOCADA, avisa, deja rastro y no vuelve a preguntar', async () => {
    const e = await conectando()
    const graphql = graphqlFalso(() => falla('UNAUTHORIZED', false, false))
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'UNAUTHORIZED', retry: false })
    expect(await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).toMatchObject({ status: 'REVOKED' })
    expect(
      await prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'REVOCADA:' } } }),
    ).toBe(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: e.organizationId,
        action: 'SHOPIFY_STORE_REVOKED',
        entity: 'ShopifyStore',
        entityId: e.storeId,
      }),
    )
    expect(await importar(e.locationLinkId, { graphql })).toEqual({ error: 'TIENDA_REVOCADA', retry: false })
    expect(graphql).toHaveBeenCalledTimes(1)
  })
})

describe('ronda de arreglos 1 de B1', () => {
  /** La variante del escenario (`ProductVariant/1`, `InventoryItem/1`, `Product/1`) como la devolvería Shopify. */
  async function laDelEscenario(e: EscenarioShopify, available: number): Promise<VarianteShopify> {
    const { sku } = await prisma.product.findUniqueOrThrow({ where: { id: e.productId }, select: { sku: true } })
    const v = {
      ...variante(1, { sku, barcode: null, producto: 'gid://shopify/Product/1', available, committed: 0 }),
      id: 'gid://shopify/ProductVariant/1',
    }
    v.inventoryItem = { ...v.inventoryItem, id: 'gid://shopify/InventoryItem/1' }
    return v
  }

  it('products/delete con una sucursal en FALTA_PERMISO: la sana se archiva y el archivo NO se interrumpe', async () => {
    const e = await escenario()
    const otra = await otraSucursalDeLaTienda(e) // su pareja nace después: la detenida va primero en la tanda
    try {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'FALTA_PERMISO' } })
      expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')).toEqual({ archivadas: 1, suspendidas: 0 })
      expect(await prisma.shopifyVariantLink.count({ where: { id: otra.variantLinkId } })).toBe(0)
      expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(1)
      expect((await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).deletedAt).toBeNull()
    } finally {
      await limpiarOtraSucursal(otra)
    }
  })

  it.each(['DISCONNECTED', 'PAUSED'] as const)('products/delete no toca el producto de una sucursal %s', async status => {
    const e = await escenario({ linkStatus: status })
    expect(await archiveShopifyProduct(e.storeId, 'gid://shopify/Product/1')).toEqual({ archivadas: 0, suspendidas: 0 })
    expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ deletedAt: null, active: true })
  })

  it('Minor 2: el evento lo toma otro proceso mientras Shopify contesta 403 ⇒ RECLAMO_PERDIDO, sin tronar y sin marcar nada', async () => {
    const e = await escenario()
    const ev = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: `ev403-${e.venueId}`,
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: {},
        status: 'RECEIVED',
      },
    })
    const reclamo = { eventId: ev.id, claimToken: await procesando(ev.id) }
    const graphql = graphqlConEfecto(
      () => prisma.shopifyInboundEvent.update({ where: { id: ev.id }, data: { claimToken: 'otro-proceso' } }).then(() => undefined),
      () => falla('FORBIDDEN', false, false),
    )
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/900', { hasAccess: conPlan, graphql, reclamo })).toEqual({
      error: 'RECLAMO_PERDIDO',
      retry: false,
    })
    expect(await sucursal(e)).toMatchObject({ importError: null })
  })

  it('una pareja suspendida que vuelve en el sync se COMPARA: se reactiva y abre «Por revisar» con el invariante cuadrado', async () => {
    const e = await escenario() // Inventory 10, espejo 10
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    const v = await laDelEscenario(e, 7)
    expect(
      await syncShopifyProduct(e.storeId, 'gid://shopify/Product/1', {
        hasAccess: conPlan,
        graphql: graphqlFalso(() => paginaDeVariantes([v], null)),
      }),
    ).toEqual({ ok: true })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      suspendedReason: null,
      mirrorAvailable: 7,
    })
    expect(await prisma.shopifyReviewItem.findFirst({ where: { productId: e.productId, status: 'OPEN' } })).toMatchObject({
      reason: 'REACTIVADA',
      shopifyQty: 7,
    })
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('Minor 6: un producto que archivó el conector y ya no es elegible (pasó a receta) vuelve en el sync ⇒ se anota y NO se compara', async () => {
    const e = await escenario()
    await prisma.product.update({
      where: { id: e.productId },
      data: { originSystem: 'SHOPIFY', deletedAt: new Date(), deletedBy: ARCHIVADO_POR_SHOPIFY, active: false, inventoryMethod: 'RECIPE' },
    })
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    const v = await laDelEscenario(e, 7)
    expect(
      await syncShopifyProduct(e.storeId, 'gid://shopify/Product/1', {
        hasAccess: conPlan,
        graphql: graphqlFalso(() => paginaDeVariantes([v], null)),
      }),
    ).toEqual({
      ok: true,
    })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      suspendedReason: 'NIVEL_INEXISTENTE',
    })
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId, status: 'OPEN' } })).toBe(0)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
    expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId, shopifyVariantId: v.id } })).toMatchObject({
      reason: 'METODO_RECETA',
    })
  })

  it('B-7 en el sync: un token ilegible no truena ni sale a la red, y se reintenta', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: Buffer.from('cifrado-dañado') } })
    const graphql = graphqlFalso(() => paginaDeVariantes([], null))
    expect(await syncShopifyProduct(e.storeId, 'gid://shopify/Product/1', { hasAccess: conPlan, graphql })).toEqual({
      error: TOKEN_ILEGIBLE,
      retry: true,
    })
    expect(graphql).not.toHaveBeenCalled()
  })

  it('Minor 5: sin `hasAccess` inyectado se mira el plan real; un negocio sin plan no escribe nada', async () => {
    const e = await conectando()
    expect(await upsertShopifyVariant({ ...(await contexto(e)), hasAccess: undefined }, variante(18))).toEqual({ kind: 'OBSOLETO' })
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
  })

  it('Minor 3: la falta de permiso de toda la tienda deja una fila por sucursal con su venueId y su organizationId', async () => {
    const e = await conectando()
    expect(await atenderFalla({ id: e.storeId, tokenVersion: 1 }, falla('FORBIDDEN', false, false))).toBe('SIN_PERMISO')
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: e.venueId,
        organizationId: e.organizationId,
        action: 'SHOPIFY_PERMISSION_MISSING',
        entityId: e.locationLinkId,
      }),
    )
  })
})

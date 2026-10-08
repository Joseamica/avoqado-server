// tests/integration/shopify/espejo.integration.test.ts
import { randomUUID } from 'crypto'
import { Prisma, ShopifyOutboxStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  applyShopifyLevel,
  CercoShopify,
  fetchLevels,
  initializePair,
  levelKey,
  liveOutboxSum,
  NivelLeido,
  productBlocked,
  suspendPair,
} from '@/services/commerce-channels/shopify/shopify.mirror.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
  TOKEN_DE_PRUEBA,
  UBICACION_PRUEBA,
} from './fixtures'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const ITEM = 'gid://shopify/InventoryItem/1'
const OTRA_UBICACION = 'gid://shopify/Location/2'
const siAcceso = async () => true
const ok = (available: number, committed = 0): NivelLeido => ({ kind: 'OK', available, committed })
const nodo = (id: string, available: number, committed = 0) => ({
  id,
  tracked: true,
  inventoryLevel: {
    isActive: true,
    quantities: [
      { name: 'available', quantity: available },
      { name: 'committed', quantity: committed },
    ],
  },
})
const stock = async (inventoryId: string) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).currentStock.toString()
const pareja = (id: string) => prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id } })
const filas = (productId: string) =>
  prisma.shopifyStockOutbox.findMany({ where: { productId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 })
const venta = (inventoryId: string, cuantas = 1) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - ${cuantas} WHERE id = ${inventoryId}`
const aplicar = (e: EscenarioShopify, nivel: NivelLeido, fetchedAt = new Date()) =>
  applyShopifyLevel({ variantLinkId: e.variantLinkId, nivel, fetchedAt, cause: 'aviso de inventario' }, { hasAccess: siAcceso })
const iniciar = (variantLinkId: string, nivel: NivelLeido, mode: 'TOMAR_SHOPIFY' | 'COMPARAR', fetchedAt = new Date()) =>
  initializePair({ variantLinkId, nivel, fetchedAt, mode }, { hasAccess: siAcceso })
const hueco = (e: { productId: string }) => huecoDelInvariante(e.productId)
const avisosDe = (e: EscenarioShopify, aviso: string) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: `${aviso}:` } } })
const nuevaFila = (
  e: EscenarioShopify,
  delta: number,
  o: { status?: ShopifyOutboxStatus; ambiguous?: boolean; generation?: number } = {},
) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: o.generation ?? 1,
      productId: e.productId,
      delta: D(delta),
      status: o.status ?? 'PENDING',
      ambiguous: o.ambiguous ?? false,
    },
  })
/** Lo que deja una venta cuyo envío ya salió: la fila de la venta pasa al estado indicado. */
async function ventaEnEstado(e: EscenarioShopify, data: Prisma.ShopifyStockOutboxUpdateManyMutationInput) {
  await venta(e.inventoryId)
  await prisma.shopifyStockOutbox.updateMany({ where: { productId: e.productId }, data })
}
/** El contexto con el que un llamador (worker o evento de B) leyó Shopify: el de la fixture, salvo lo que se cambie. */
const cercoDe = (e: EscenarioShopify, o: Partial<CercoShopify> = {}): CercoShopify => ({
  generation: 1,
  storeId: e.storeId,
  shopifyLocationId: UBICACION_PRUEBA,
  tokenVersion: 1,
  ...o,
})
const eventoReclamado = (e: EscenarioShopify, claimToken: string) =>
  prisma.shopifyInboundEvent.create({
    data: {
      dedupKey: `ev-${randomUUID()}`,
      appKey: 'PILOTO',
      topic: 'inventory_levels/update',
      shopDomain: e.shopDomain,
      payload: {},
      status: 'PROCESSING',
      claimToken,
      leaseUntil: new Date(Date.now() + 60_000),
    },
  })
/** §11.2: cada caso cambia el contexto DESPUÉS de que el llamador leyó, y devuelve el cerco viejo que traía. */
const CONTEXTOS_VIEJOS: Array<[string, (e: EscenarioShopify) => Promise<CercoShopify>]> = [
  [
    'la sucursal cambió de generación (desconectar y volver a conectar)',
    async e => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
      return cercoDe(e)
    },
  ],
  [
    'la credencial cambió (reautorizar)',
    async e => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } })
      return cercoDe(e)
    },
  ],
  [
    'otro worker se quedó con la sucursal (workToken robado)',
    async e => {
      await prisma.shopifyLocationLink.update({
        where: { id: e.locationLinkId },
        data: { workToken: 'de-otro', workLeaseUntil: new Date(Date.now() + 90_000) },
      })
      return cercoDe(e, { workToken: 'mio' })
    },
  ],
  [
    'otro procesador reclamó el evento',
    async e => {
      const ev = await eventoReclamado(e, 'de-otro')
      return cercoDe(e, { evento: { id: ev.id, claimToken: 'mio' } })
    },
  ],
  [
    'la tienda se revocó (§12.2)',
    async e => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
      return cercoDe(e)
    },
  ],
  [
    'la sucursal quedó detenida por un error terminal (§12.2)',
    async e => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'CATALOGO_MAESTRO' } })
      return cercoDe(e)
    },
  ],
]

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

describe('fetchLevels', () => {
  it('🔴 dos ubicaciones con el mismo artículo y cantidades distintas: cada llave guarda la suya (#3)', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const graphql = graphqlFalso((_q, vars) => ({
      ok: true,
      data: { nodes: vars.ids.map((id: string) => nodo(id, vars.loc === UBICACION_PRUEBA ? 4 : 9, 1)) },
    }))
    const r = await fetchLevels(
      store,
      [
        { inventoryItemId: ITEM, shopifyLocationId: UBICACION_PRUEBA },
        { inventoryItemId: ITEM, shopifyLocationId: OTRA_UBICACION },
      ],
      { graphql },
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.data.get(levelKey(UBICACION_PRUEBA, ITEM))).toEqual(ok(4, 1))
    expect(r.data.get(levelKey(OTRA_UBICACION, ITEM))).toEqual(ok(9, 1))
    expect(graphql).toHaveBeenCalledTimes(2)
    expect(graphql.mock.calls[0][1]).toBe(TOKEN_DE_PRUEBA)
  })

  it('🔴 nulo explícito, nivel nulo o inactivo ⇒ SIN_NIVEL; tracked=false ⇒ NO_RASTREADO; toda llave pedida sale (#4)', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const ids = ['a', 'b', 'c', 'd', 'e'].map(x => `gid://shopify/InventoryItem/${x}`)
    const graphql = graphqlFalso(() => ({
      ok: true,
      data: {
        nodes: [
          nodo(ids[0], 3),
          null,
          { id: ids[2], tracked: true, inventoryLevel: null },
          { id: ids[3], tracked: true, inventoryLevel: { isActive: false, quantities: [] } },
          { id: ids[4], tracked: false, inventoryLevel: null },
        ],
      },
    }))
    const r = await fetchLevels(
      store,
      ids.map(inventoryItemId => ({ inventoryItemId, shopifyLocationId: UBICACION_PRUEBA })),
      { graphql },
    )
    if (!r.ok) throw new Error(r.message)
    expect(ids.map(id => r.data.get(levelKey(UBICACION_PRUEBA, id)))).toEqual([
      ok(3),
      { kind: 'SIN_NIVEL' },
      { kind: 'SIN_NIVEL' },
      { kind: 'SIN_NIVEL' },
      { kind: 'NO_RASTREADO' },
    ])
  })

  it('pide de LEVELS_PAGE_SIZE en LEVELS_PAGE_SIZE: 120 artículos ⇒ 3 consultas de 50, 50 y 20', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const graphql = graphqlFalso((_q, vars) => ({ ok: true, data: { nodes: vars.ids.map((id: string) => nodo(id, 1)) } }))
    const items = Array.from({ length: 120 }, (_, i) => ({
      inventoryItemId: `gid://shopify/InventoryItem/${i}`,
      shopifyLocationId: UBICACION_PRUEBA,
    }))
    const r = await fetchLevels(store, items, { graphql })
    expect(graphql.mock.calls.map(c => c[3].ids.length)).toEqual([50, 50, 20])
    expect(r.ok && r.data.size).toBe(120)
  })

  it('una página que falla devuelve la falla, sin mapa a medias', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const graphql = graphqlFalso(() => ({ ok: false, code: 'THROTTLED', retryable: true, ambiguous: false, message: 'x' }))
    expect(await fetchLevels(store, [{ inventoryItemId: ITEM, shopifyLocationId: UBICACION_PRUEBA }], { graphql })).toMatchObject({
      ok: false,
      code: 'THROTTLED',
    })
  })

  const SESENTA = Array.from({ length: 60 }, (_, i) => ({
    inventoryItemId: `gid://shopify/InventoryItem/${i}`,
    shopifyLocationId: UBICACION_PRUEBA,
  }))

  it('§11.6: el plazo es de toda la lectura: cada página recibe lo que le queda, nunca más', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const graphql = graphqlFalso((_q, vars) => ({ ok: true, data: { nodes: vars.ids.map((id: string) => nodo(id, 1)) } }))
    expect((await fetchLevels(store, SESENTA, { graphql, timeoutMs: 5_000 })).ok).toBe(true)
    const plazos: number[] = graphql.mock.calls.map(c => c[4].timeoutMs)
    expect(plazos).toHaveLength(2)
    expect(plazos[0]).toBeGreaterThan(0)
    expect(plazos[0]).toBeLessThanOrEqual(5_000)
    expect(plazos[1]).toBeLessThanOrEqual(plazos[0])
  })

  it('§11.6: sin tiempo para la siguiente página ⇒ TIMEOUT reintentable, sin llamar otra vez ni mapa a medias', async () => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const lenta: jest.Mock = jest.fn(async (_s: string, _t: string, _q: string, vars: any) => {
      await new Promise(r => setTimeout(r, 40))
      return { ok: true, data: { nodes: vars.ids.map((id: string) => nodo(id, 1)) } }
    })
    expect(await fetchLevels(store, SESENTA, { graphql: lenta, timeoutMs: 25 })).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
      retryable: true,
    })
    expect(lenta).toHaveBeenCalledTimes(1)
  })

  const ADVERSARIAS: Array<[string, (ids: string[]) => unknown[]]> = [
    ['omite un id (llegan menos nodos)', ids => ids.slice(1).map(id => nodo(id, 1))],
    ['repite un id', ids => ids.map(() => nodo(ids[0], 1))],
    ['trae un id ajeno', ids => ids.map((_id, i) => nodo(`gid://shopify/InventoryItem/ajeno-${i}`, 1))],
    ['manda un objeto vacío en vez del nodo', ids => ids.map(() => ({}))],
    [
      'trae un nivel activo sin «committed»',
      ids => ids.map(id => ({ id, tracked: true, inventoryLevel: { isActive: true, quantities: [{ name: 'available', quantity: 2 }] } })),
    ],
    ['trae una cantidad con decimales', ids => ids.map(id => nodo(id, 2.5))],
    ['trae una cantidad fuera de rango', ids => ids.map(id => nodo(id, 3_000_000_000))],
  ]
  it.each(ADVERSARIAS)('🔴 una respuesta que %s ⇒ BAD_RESPONSE ambiguo, sin mapa (N4)', async (_caso, nodos) => {
    const e = await escenario()
    const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    const ids = [ITEM, 'gid://shopify/InventoryItem/2']
    const graphql = graphqlFalso(() => ({ ok: true, data: { nodes: nodos(ids) } }))
    expect(
      await fetchLevels(
        store,
        ids.map(inventoryItemId => ({ inventoryItemId, shopifyLocationId: UBICACION_PRUEBA })),
        { graphql },
      ),
    ).toMatchObject({
      ok: false,
      code: 'BAD_RESPONSE',
      ambiguous: true,
    })
  })
})

describe('applyShopifyLevel', () => {
  it('pedido en línea: 9 contra espejo 10 ⇒ Avoqado 9, espejo 9, sin eco, con movimiento y bitácora', async () => {
    const e = await escenario()
    expect(await aplicar(e, ok(9, 1))).toBe('APLICADO')
    expect(await stock(e.inventoryId)).toBe('9')
    expect(await pareja(e.variantLinkId)).toMatchObject({ mirrorAvailable: 9, mirrorCommitted: 1 })
    expect(await filas(e.productId)).toHaveLength(0)
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { inventoryId: e.inventoryId } })
    expect(mov).toMatchObject({ type: 'ADJUSTMENT', reason: 'Shopify: aviso de inventario' })
    expect(mov.quantity.toString()).toBe('-1')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_STOCK_APPLIED', entityId: e.productId, venueId: e.venueId }),
    )
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 mismo disponible con apartadas nuevas ⇒ SIN_CAMBIO pero el espejo guarda committed (#10)', async () => {
    const e = await escenario()
    const antes = await pareja(e.variantLinkId)
    expect(await aplicar(e, ok(10, 3))).toBe('SIN_CAMBIO')
    const despues = await pareja(e.variantLinkId)
    expect(despues.mirrorCommitted).toBe(3)
    expect(despues.mirrorAt.getTime()).toBeGreaterThan(antes.mirrorAt.getTime())
    expect(despues.committedAt).not.toBeNull()
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 SIN_NIVEL ⇒ SUSPENDIDO, nunca cero: stock y espejo intactos, la fila NO ambigua se descarta, «sin pareja» (#4)', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    expect(await aplicar(e, { kind: 'SIN_NIVEL' })).toBe('SUSPENDIDO')
    expect(await stock(e.inventoryId)).toBe('9')
    expect(await pareja(e.variantLinkId)).toMatchObject({ mirrorAvailable: 10, suspendedReason: 'NIVEL_INEXISTENTE' })
    expect(await filas(e.productId)).toEqual([expect.objectContaining({ status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA' })])
    expect(await prisma.shopifyImportIssue.findFirstOrThrow({ where: { venueId: e.venueId } })).toMatchObject({
      reason: 'NIVEL_INEXISTENTE',
      productId: e.productId,
      shopifyVariantId: 'gid://shopify/ProductVariant/1',
    })
  })

  it('NO_RASTREADO ⇒ SUSPENDIDO con su motivo', async () => {
    const e = await escenario()
    expect(await aplicar(e, { kind: 'NO_RASTREADO' })).toBe('SUSPENDIDO')
    expect((await pareja(e.variantLinkId)).suspendedReason).toBe('NO_RASTREADO')
  })

  it('🔴 un nivel no OK con lectura vieja o con un envío en vuelo ⇒ REINTENTAR, no suspende (N1)', async () => {
    const e = await escenario()
    expect(await aplicar(e, { kind: 'SIN_NIVEL' }, new Date(Date.now() - 60_000))).toBe('REINTENTAR')
    await ventaEnEstado(e, { status: 'IN_PROGRESS', claimToken: 'en-vuelo', leaseUntil: new Date(Date.now() + 60_000) })
    expect(await aplicar(e, { kind: 'NO_RASTREADO' })).toBe('REINTENTAR')
    expect((await pareja(e.variantLinkId)).suspendedReason).toBeNull()
    expect((await filas(e.productId))[0].status).toBe('IN_PROGRESS')
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 sin fila Inventory ⇒ suspende SIN_INVENTARIO y NO mueve el espejo (#9)', async () => {
    const e = await escenario()
    await prisma.$executeRaw`DELETE FROM "Inventory" WHERE id = ${e.inventoryId}`
    expect(await aplicar(e, ok(7))).toBe('SUSPENDIDO')
    expect(await pareja(e.variantLinkId)).toMatchObject({ mirrorAvailable: 10, suspendedReason: 'SIN_INVENTARIO' })
    expect((await prisma.shopifyImportIssue.findFirstOrThrow({ where: { venueId: e.venueId } })).reason).toBe('SIN_INVENTARIO')
  })

  it('🔴 contraejemplo #2: venta, envío FAILED ambiguo y Shopify YA lo aplicó ⇒ INCIERTO, nada cambia', async () => {
    const e = await escenario()
    await ventaEnEstado(e, { status: 'FAILED', ambiguous: true, attempts: 1, firstAttemptAt: new Date() })
    expect(await aplicar(e, ok(9))).toBe('INCIERTO') // Shopify ya tiene 9: aplicar −1 contaría doble
    expect(await stock(e.inventoryId)).toBe('9')
    expect((await pareja(e.variantLinkId)).mirrorAvailable).toBe(10)
    expect(await hueco(e)).toBe('0')
  })

  it('un DEAD_LETTER ambiguo también bloquea ⇒ INCIERTO (y sigue en la cuenta del invariante)', async () => {
    const e = await escenario()
    await ventaEnEstado(e, { status: 'DEAD_LETTER', ambiguous: true })
    expect(await aplicar(e, ok(9))).toBe('INCIERTO')
    expect(await hueco(e)).toBe('0')
  })

  it('un envío en vuelo (IN_PROGRESS) ⇒ REINTENTAR', async () => {
    const e = await escenario()
    await ventaEnEstado(e, { status: 'IN_PROGRESS', claimToken: 'en-vuelo', leaseUntil: new Date(Date.now() + 60_000) })
    expect(await aplicar(e, ok(8))).toBe('REINTENTAR')
    expect(await stock(e.inventoryId)).toBe('9')
    expect(await hueco(e)).toBe('0')
  })

  it('una fila viva NO ambigua no bloquea: aplica contra el espejo y el invariante se sostiene', async () => {
    const e = await escenario()
    await venta(e.inventoryId) // A 9, espejo 10, −1 pendiente (aún no sale)
    expect(await aplicar(e, ok(9))).toBe('APLICADO') // un pedido en línea bajó Shopify de 10 a 9
    expect(await stock(e.inventoryId)).toBe('8')
    expect((await pareja(e.variantLinkId)).mirrorAvailable).toBe(9)
    expect(await hueco(e)).toBe('0') // 8 = 9 + (−1)
  })

  it('lectura vieja (el espejo se movió después de leer Shopify) ⇒ REINTENTAR sin tocar nada', async () => {
    const e = await escenario()
    expect(await aplicar(e, ok(3), new Date(Date.now() - 60_000))).toBe('REINTENTAR')
    expect(await stock(e.inventoryId)).toBe('10')
  })

  it('tienda REVOKED ⇒ PAUSADO', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
    expect(await aplicar(e, ok(8))).toBe('PAUSADO')
    expect(await stock(e.inventoryId)).toBe('10')
  })

  it('sucursal PAUSED o todavía CONNECTING ⇒ PAUSADO', async () => {
    const pausada = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    expect(await aplicar(pausada, ok(8))).toBe('PAUSADO')
    const conectando = await escenario({ linkStatus: 'CONNECTING' })
    expect(await aplicar(conectando, ok(8))).toBe('PAUSADO')
  })

  it('pareja sin iniciar ⇒ NO_INICIADA; suspendida ⇒ SUSPENDIDO; ninguna toca el stock', async () => {
    const e = await escenario({ initialized: false })
    expect(await aplicar(e, ok(8))).toBe('NO_INICIADA')
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { initializedAt: new Date(), suspendedReason: 'NO_RASTREADO' },
    })
    expect(await aplicar(e, ok(8))).toBe('SUSPENDIDO')
    expect(await stock(e.inventoryId)).toBe('10')
  })

  it('stock negativo después de aplicar ⇒ aviso SOBREVENTA', async () => {
    const e = await escenario({ stock: 1 })
    expect(await aplicar(e, ok(-1))).toBe('APLICADO')
    expect(await stock(e.inventoryId)).toBe('-1')
    expect(await avisosDe(e, 'SOBREVENTA')).toBe(1)
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 SIN_CAMBIO con el stock local en negativo también avisa SOBREVENTA (#23)', async () => {
    const e = await escenario({ stock: 0 })
    await venta(e.inventoryId) // vendida en caja la pieza que Shopify todavía cuenta: A −1, espejo 0, −1 pendiente
    expect(await aplicar(e, ok(0))).toBe('SIN_CAMBIO')
    expect(await avisosDe(e, 'SOBREVENTA')).toBe(1)
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 N7: si falla buscar el nombre del producto, el cambio igual queda APLICADO y el aviso sale genérico', async () => {
    const e = await escenario({ stock: 1 })
    const espia = jest.spyOn(prisma.product, 'findUnique').mockRejectedValueOnce(new Error('base caída'))
    try {
      expect(await aplicar(e, ok(-1))).toBe('APLICADO')
    } finally {
      espia.mockRestore()
    }
    expect(await stock(e.inventoryId)).toBe('-1')
    const aviso = await prisma.notification.findFirstOrThrow({ where: { venueId: e.venueId, entityId: { startsWith: 'SOBREVENTA:' } } })
    expect(aviso.message).toContain('Un producto')
  })

  it('🔴 acceso real (#14): sin plan ⇒ PAUSADO sin tocar nada; el mismo negocio exento ⇒ APLICADO', async () => {
    const e = await escenario()
    const sinInyectar = () => applyShopifyLevel({ variantLinkId: e.variantLinkId, nivel: ok(9), fetchedAt: new Date(), cause: 'aviso' })
    expect(await sinInyectar()).toBe('PAUSADO')
    expect(await stock(e.inventoryId)).toBe('10')
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } })
    expect(await sinInyectar()).toBe('APLICADO')
    expect(await stock(e.inventoryId)).toBe('9')
  })

  it('🔴 acceso real (#14): la función con el periodo vencido ⇒ PAUSADO; vigente ⇒ APLICADO', async () => {
    const e = await escenario()
    const feature = await prisma.feature.upsert({
      where: { code: 'SHOPIFY_INTEGRATION' },
      create: { code: 'SHOPIFY_INTEGRATION', name: 'Conector Shopify', category: 'INTEGRATIONS', monthlyPrice: D(299) },
      update: {},
    })
    const vf = await prisma.venueFeature.create({
      data: { venueId: e.venueId, featureId: feature.id, active: true, monthlyPrice: D(299), endDate: new Date(Date.now() - 86_400_000) },
    })
    const sinInyectar = () => applyShopifyLevel({ variantLinkId: e.variantLinkId, nivel: ok(9), fetchedAt: new Date(), cause: 'aviso' })
    expect(await sinInyectar()).toBe('PAUSADO')
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { endDate: new Date(Date.now() + 86_400_000) } })
    expect(await sinInyectar()).toBe('APLICADO')
  })

  it.each(CONTEXTOS_VIEJOS)('🔴 §11.2 cerco: si %s ⇒ CONTEXTO_CAMBIO y nada cambia', async (_caso, envejecer) => {
    const e = await escenario()
    await venta(e.inventoryId) // A 9, espejo 10, −1 pendiente
    const antes = await pareja(e.variantLinkId)
    const cerco = await envejecer(e)
    expect(
      await applyShopifyLevel(
        { variantLinkId: e.variantLinkId, nivel: ok(4), fetchedAt: new Date(), cause: 'aviso' },
        { hasAccess: siAcceso, cerco },
      ),
    ).toBe('CONTEXTO_CAMBIO')
    expect(await stock(e.inventoryId)).toBe('9')
    expect(await pareja(e.variantLinkId)).toMatchObject({
      mirrorAvailable: 10,
      mirrorCommitted: 0,
      mirrorAt: antes.mirrorAt,
      suspendedReason: null,
    })
    expect((await filas(e.productId)).map(f => f.status)).toEqual(['PENDING'])
    expect(await prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId } })).toBe(0)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 §11.2 cerco: un nivel inexistente con el contexto viejo tampoco suspende', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } })
    expect(
      await applyShopifyLevel(
        { variantLinkId: e.variantLinkId, nivel: { kind: 'SIN_NIVEL' }, fetchedAt: new Date(), cause: 'aviso' },
        { hasAccess: siAcceso, cerco: cercoDe(e) },
      ),
    ).toBe('CONTEXTO_CAMBIO')
    expect((await pareja(e.variantLinkId)).suspendedReason).toBeNull()
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
  })

  it('§11.2 cerco vigente, con el workToken y el evento propios ⇒ aplica como siempre', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { workToken: 'mio', workLeaseUntil: new Date(Date.now() + 90_000) },
    })
    const ev = await eventoReclamado(e, 'mio')
    const cerco = cercoDe(e, { workToken: 'mio', evento: { id: ev.id, claimToken: 'mio' } })
    expect(
      await applyShopifyLevel(
        { variantLinkId: e.variantLinkId, nivel: ok(9), fetchedAt: new Date(), cause: 'aviso' },
        { hasAccess: siAcceso, cerco },
      ),
    ).toBe('APLICADO')
    expect(await stock(e.inventoryId)).toBe('9')
    expect(await hueco(e)).toBe('0')
  })
})

describe('initializePair', () => {
  it('🔴 TOMAR_SHOPIFY en REVIEWING con «Aplicar» pedido: Inventory = S + pendientes, espejo = S, sin eco', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    await venta(e.inventoryId, 2) // vendido mientras se revisaba: queda −2 en el buzón
    expect(await iniciar(e.variantLinkId, ok(15), 'TOMAR_SHOPIFY')).toBe('INICIADA')
    expect(await stock(e.inventoryId)).toBe('13') // 15 + (−2)
    const p = await pareja(e.variantLinkId)
    expect(p).toMatchObject({ mirrorAvailable: 15, suspendedReason: null })
    expect(p.initializedAt).not.toBeNull()
    expect((await filas(e.productId)).map(f => f.delta.toString())).toEqual(['-2'])
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { inventoryId: e.inventoryId } })
    expect(mov).toMatchObject({ reason: 'Shopify: inicio de sincronización' })
    expect(mov.quantity.toString()).toBe('5')
    expect(await hueco(e)).toBe('0')
  })

  it('TOMAR_SHOPIFY sin «Aplicar» pedido, o COMPARAR en REVIEWING ⇒ NO_APLICA', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    expect(await iniciar(e.variantLinkId, ok(15), 'TOMAR_SHOPIFY')).toBe('NO_APLICA')
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    expect(await iniciar(e.variantLinkId, ok(15), 'COMPARAR')).toBe('NO_APLICA')
    expect(await stock(e.inventoryId)).toBe('10')
  })

  it('una pareja viva (iniciada y no suspendida) no se re-arranca con ningún modo', async () => {
    const e = await escenario()
    for (const mode of ['TOMAR_SHOPIFY', 'COMPARAR'] as const) expect(await iniciar(e.variantLinkId, ok(4), mode)).toBe('NO_APLICA')
    expect(await stock(e.inventoryId)).toBe('10')
  })

  it('🔴 N6: un producto que ya existía (stock 10) rechaza TOMAR_SHOPIFY en ACTIVE; COMPARAR conserva el 10 y abre la revisión', async () => {
    const e = await escenario({ initialized: false }) // el producto de la fixture es local: createdProduct = false
    expect(await iniciar(e.variantLinkId, ok(2), 'TOMAR_SHOPIFY')).toBe('NO_APLICA')
    expect(await stock(e.inventoryId)).toBe('10')
    expect(await iniciar(e.variantLinkId, ok(2), 'COMPARAR')).toBe('EN_REVISION')
    expect(await stock(e.inventoryId)).toBe('10')
    expect((await pareja(e.variantLinkId)).mirrorAvailable).toBe(2)
    const rev = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId } })
    expect(rev).toMatchObject({ reason: 'REACTIVADA', status: 'OPEN', shopifyQty: 2, suggestion: 'SHOPIFY' })
    expect(rev.offset.toString()).toBe('8')
    expect(await hueco(e)).toBe('0')
  })

  it('un producto que el catálogo CREÓ (createdProduct) sí toma el número de Shopify en ACTIVE', async () => {
    const e = await escenario()
    const nuevo = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
    expect(await iniciar(nuevo.variantLinkId!, ok(5), 'TOMAR_SHOPIFY')).toBe('INICIADA')
    expect(await stock(nuevo.inventoryId)).toBe('5')
    expect(await hueco(nuevo)).toBe('0')
  })

  it('🔴 COMPARAR sobre una pareja suspendida: descarta lo pendiente y lo atorado, offset = Inventory − S, «sin pareja» se va', async () => {
    const e = await escenario()
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    await prisma.shopifyImportIssue.create({
      data: {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/1',
        shopifyProductId: 'gid://shopify/Product/1',
        title: 'Camisa · M',
        reason: 'NIVEL_INEXISTENTE',
        productId: e.productId,
      },
    })
    await nuevaFila(e, -1)
    await nuevaFila(e, -2, { status: 'DEAD_LETTER' })
    expect(await iniciar(e.variantLinkId, ok(7), 'COMPARAR')).toBe('EN_REVISION')
    expect(await stock(e.inventoryId)).toBe('10')
    expect(await pareja(e.variantLinkId)).toMatchObject({ mirrorAvailable: 7, suspendedReason: null })
    expect((await filas(e.productId)).map(f => [f.status, f.lastError])).toEqual([
      ['DISCARDED', 'PAREJA_REACTIVADA'],
      ['DISCARDED', 'PAREJA_REACTIVADA'],
    ])
    const rev = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId } })
    expect(rev).toMatchObject({ reason: 'REACTIVADA', status: 'OPEN', shopifyQty: 7, suggestion: 'SHOPIFY' })
    expect(rev.avoqadoQty.toString()).toBe('10')
    expect(rev.offset.toString()).toBe('3')
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
    expect(await avisosDe(e, 'POR_REVISAR')).toBe(1)
    expect(await hueco(e)).toBe('0')
  })

  it('COMPARAR con Inventory = S ⇒ INICIADA sin revisión', async () => {
    const e = await escenario({ initialized: false })
    expect(await iniciar(e.variantLinkId, ok(10), 'COMPARAR')).toBe('INICIADA')
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 N1: reactivar espera mientras haya un envío incierto o en vuelo: REINTENTAR y nada cambia', async () => {
    const e = await escenario()
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'SIN_INVENTARIO', suspendedAt: new Date() },
    })
    const fila = await nuevaFila(e, -1, { status: 'FAILED', ambiguous: true })
    expect(await iniciar(e.variantLinkId, ok(9), 'COMPARAR')).toBe('REINTENTAR')
    await prisma.shopifyStockOutbox.update({ where: { id: fila.id }, data: { status: 'IN_PROGRESS', ambiguous: false } })
    expect(await iniciar(e.variantLinkId, ok(9), 'COMPARAR')).toBe('REINTENTAR')
    expect((await pareja(e.variantLinkId)).suspendedReason).toBe('SIN_INVENTARIO')
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId } })).toBe(0)
    expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: fila.id } })).status).toBe('IN_PROGRESS')
  })

  it('nivel SIN_NIVEL ⇒ SUSPENDIDA; lectura vieja ⇒ REINTENTAR', async () => {
    const e = await escenario({ initialized: false })
    expect(await iniciar(e.variantLinkId, ok(4), 'COMPARAR', new Date(Date.now() - 60_000))).toBe('REINTENTAR')
    expect(await iniciar(e.variantLinkId, { kind: 'SIN_NIVEL' }, 'COMPARAR')).toBe('SUSPENDIDA')
    expect((await pareja(e.variantLinkId)).suspendedReason).toBe('NIVEL_INEXISTENTE')
  })

  it('🔴 TOMAR_SHOPIFY que deja el stock en negativo avisa SOBREVENTA aunque el número no cambie (#23)', async () => {
    const e = await escenario({ stock: 0, linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    await venta(e.inventoryId) // A −1, −1 pendiente; Shopify tiene 0
    expect(await iniciar(e.variantLinkId, ok(0), 'TOMAR_SHOPIFY')).toBe('INICIADA')
    expect(await stock(e.inventoryId)).toBe('-1')
    expect(await avisosDe(e, 'SOBREVENTA')).toBe(1)
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 sin acceso al plan (acceso real) ⇒ NO_APLICA sin tocar nada (#14)', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    expect(await initializePair({ variantLinkId: e.variantLinkId, nivel: ok(15), fetchedAt: new Date(), mode: 'TOMAR_SHOPIFY' })).toBe(
      'NO_APLICA',
    )
    expect(await stock(e.inventoryId)).toBe('10')
    expect((await pareja(e.variantLinkId)).initializedAt).toBeNull()
  })

  it('🔴 acceso real (#14, §9.7): el mismo negocio sin plan ⇒ NO_APLICA; exento ⇒ INICIADA', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const sinInyectar = () =>
      initializePair({ variantLinkId: e.variantLinkId, nivel: ok(15), fetchedAt: new Date(), mode: 'TOMAR_SHOPIFY' })
    expect(await sinInyectar()).toBe('NO_APLICA')
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } })
    expect(await sinInyectar()).toBe('INICIADA')
    expect(await stock(e.inventoryId)).toBe('15')
    expect((await pareja(e.variantLinkId)).initializedAt).not.toBeNull()
    expect(await hueco(e)).toBe('0')
  })

  it.each(CONTEXTOS_VIEJOS)('🔴 §11.2 cerco: si %s ⇒ CONTEXTO_CAMBIO; ni stock, ni espejo, ni inicio', async (_caso, envejecer) => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const cerco = await envejecer(e)
    expect(
      await initializePair(
        { variantLinkId: e.variantLinkId, nivel: ok(15), fetchedAt: new Date(), mode: 'TOMAR_SHOPIFY' },
        { hasAccess: siAcceso, cerco },
      ),
    ).toBe('CONTEXTO_CAMBIO')
    expect(await stock(e.inventoryId)).toBe('10')
    expect(await pareja(e.variantLinkId)).toMatchObject({ mirrorAvailable: 10, initializedAt: null, suspendedReason: null })
    expect(await prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId } })).toBe(0)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 C1 (§11.8): diferencia → suspensión → Shopify igual otra vez ⇒ COMPARAR cierra la revisión y el hueco queda en 0', async () => {
    const e = await escenario({ initialized: false })
    expect(await iniciar(e.variantLinkId, ok(7), 'COMPARAR')).toBe('EN_REVISION') // A 10, Shopify 7 ⇒ offset 3
    expect(await hueco(e)).toBe('0')
    expect(await aplicar(e, { kind: 'SIN_NIVEL' })).toBe('SUSPENDIDO')
    expect(await iniciar(e.variantLinkId, ok(10), 'COMPARAR')).toBe('INICIADA') // Shopify volvió a 10
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId, status: 'OPEN' } })).toBe(0)
    const rev = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId } })
    expect(rev.status).toBe('RESOLVED')
    expect(rev.offset.toString()).toBe('0')
    expect(rev.resolvedAt).not.toBeNull()
    expect(await hueco(e)).toBe('0') // con la revisión abierta sería 10 − 10 − 3 = −3
  })
})

describe('liveOutboxSum, productBlocked y suspendPair', () => {
  it('liveOutboxSum suma sólo PENDING, IN_PROGRESS y FAILED de la generación vigente', async () => {
    const e = await escenario()
    await nuevaFila(e, -1)
    await nuevaFila(e, -2, { status: 'FAILED' })
    await nuevaFila(e, -4, { status: 'IN_PROGRESS' })
    for (const status of ['SENT', 'DEAD_LETTER', 'DISCARDED'] as const) await nuevaFila(e, 50, { status })
    await nuevaFila(e, 100, { generation: 0 })
    expect((await prisma.$transaction(tx => liveOutboxSum(tx, e.productId, e.locationLinkId, 1))).toString()).toBe('-7')
  })

  it('productBlocked: LIBRE, EN_VUELO (IN_PROGRESS) e INCIERTO (viva o DEAD_LETTER ambigua)', async () => {
    const e = await escenario()
    const consulta = () => prisma.$transaction(tx => productBlocked(tx, e.productId, e.locationLinkId, 1))
    await nuevaFila(e, -1, { status: 'DEAD_LETTER' })
    await nuevaFila(e, -1, { status: 'SENT', ambiguous: true })
    expect(await consulta()).toBe('LIBRE')
    const incierta = await nuevaFila(e, -1, { status: 'FAILED', ambiguous: true })
    expect(await consulta()).toBe('INCIERTO')
    await prisma.shopifyStockOutbox.update({ where: { id: incierta.id }, data: { status: 'DISCARDED' } })
    await nuevaFila(e, -1, { status: 'IN_PROGRESS' })
    expect(await consulta()).toBe('EN_VUELO')
  })

  it('🔴 suspendPair sólo descarta lo que nunca llegó: PENDING/FAILED no ambiguas; IN_PROGRESS y ambiguas siguen vivas (N1)', async () => {
    const e = await escenario()
    const pendiente = await nuevaFila(e, -1)
    const fallida = await nuevaFila(e, -1, { status: 'FAILED' })
    const incierta = await nuevaFila(e, -1, { status: 'FAILED', ambiguous: true })
    const enVuelo = await nuevaFila(e, -1, { status: 'IN_PROGRESS' })
    await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'SIN_INVENTARIO'))
    const estado = async (id: string) => (await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id } })).status
    expect([await estado(pendiente.id), await estado(fallida.id), await estado(incierta.id), await estado(enVuelo.id)]).toEqual([
      'DISCARDED',
      'DISCARDED',
      'FAILED',
      'IN_PROGRESS',
    ])
  })
})

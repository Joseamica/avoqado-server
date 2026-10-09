// tests/integration/shopify/receptor.integration.test.ts
/**
 * El receptor (B2): firma, dedup, reclamo tri-estado con lease, avisos diferidos sin gastar intentos y reabiertos por el
 * drenado durable, efectos que respetan el reclamo vigente, desinstalación tardía y relectura de Shopify con el espejo
 * de A. Postgres real; Shopify por deps.
 */
import crypto from 'crypto'
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import {
  claimShopifyEvent,
  handleShopifyWebhook,
  MAX_EVENT_ATTEMPTS,
  persistShopifyWebhook,
  processShopifyEvent,
  requeueDeferredEvents,
} from '@/services/commerce-channels/shopify/shopify.inbound.service'
import { assertTestDatabase, crearEscenarioShopify, EscenarioShopify, graphqlFalso, limpiarEscenarioShopify } from './fixtures'
import { ContextoObsoleto, MIN_HTTP_MS } from '@/services/commerce-channels/shopify/shopify.store.service'
import { getContext, runWithContext } from '@/observability/executionContext'
import {
  dormir,
  falla,
  graphqlConEfecto,
  limpiarOtraSucursal,
  nivel,
  nivelesFalsos,
  otraSucursalDeLaTienda,
  paginaDeVariantes,
  procesando,
  variante,
} from './fixturesB'

jest.setTimeout(120_000)
const SECRETO = 'secreto-app-piloto'
const firmar = (b: Buffer) => crypto.createHmac('sha256', SECRETO).update(b).digest('base64')
const NIVEL_1 = { inventory_item_id: 1, location_id: 1, available: 7 }
const conAcceso = { hasAccess: async () => true }

let escenarios: EscenarioShopify[] = []
let otras: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
beforeAll(() => {
  assertTestDatabase()
  process.env.SHOPIFY_PILOTO_CLIENT_ID = 'cliente'
  process.env.SHOPIFY_PILOTO_CLIENT_SECRET = SECRETO
})
afterEach(async () => {
  for (const s of otras) await limpiarOtraSucursal(s) // antes que el dueño de la tienda
  otras = []
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

function guardar(
  e: EscenarioShopify,
  topic: string,
  payload: unknown,
  o: { webhookId?: string; firma?: string; dominio?: string; triggeredAt?: string } = {},
) {
  const rawBody = Buffer.from(JSON.stringify(payload))
  return persistShopifyWebhook({
    rawBody,
    appKey: 'PILOTO',
    hmac: o.firma ?? firmar(rawBody),
    topic,
    shopDomain: o.dominio ?? e.shopDomain,
    webhookId: o.webhookId ?? crypto.randomUUID(),
    triggeredAt: o.triggeredAt,
  })
}
async function evento(e: EscenarioShopify, topic: string, payload: unknown, triggeredAt?: string): Promise<string> {
  const r = await guardar(e, topic, payload, { triggeredAt })
  if (r.outcome !== 'PERSISTED') throw new Error(`no se guardó: ${r.outcome}`)
  return r.eventId
}
const ev = (id: string) => prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { id } })
const stock = async (e: EscenarioShopify) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const avisos = (e: EscenarioShopify, aviso: string) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: `${aviso}:` } } })

describe('guardar (#28, N04, N09)', () => {
  it('firma mala ⇒ INVALID_SIGNATURE y no guarda nada', async () => {
    const e = await escenario()
    expect(await guardar(e, 'inventory_levels/update', NIVEL_1, { webhookId: 'w-mala', firma: 'AAAA' })).toEqual({
      outcome: 'INVALID_SIGNATURE',
    })
    expect(await prisma.shopifyInboundEvent.count({ where: { dedupKey: 'w-mala' } })).toBe(0)
  })

  it('el mismo X-Shopify-Webhook-Id dos veces ⇒ DUPLICATE y una sola fila', async () => {
    const e = await escenario()
    expect((await guardar(e, 'orders/create', { line_items: [] }, { webhookId: 'w-dup' })).outcome).toBe('PERSISTED')
    expect(await guardar(e, 'orders/create', { line_items: [] }, { webhookId: 'w-dup' })).toEqual({ outcome: 'DUPLICATE' })
    expect(await prisma.shopifyInboundEvent.count({ where: { dedupKey: 'w-dup' } })).toBe(1)
  })

  it('dominio ajeno, cuerpo que no es objeto o sin topic ⇒ MALFORMED; más de 1 MB ⇒ TOO_LARGE', async () => {
    const e = await escenario()
    expect(await guardar(e, 'orders/create', {}, { dominio: 'evil.com' })).toEqual({ outcome: 'MALFORMED' })
    expect(await guardar(e, 'orders/create', 42)).toEqual({ outcome: 'MALFORMED' })
    expect(await guardar(e, '', {})).toEqual({ outcome: 'MALFORMED' })
    const grande = Buffer.alloc(1_048_577, 'a')
    expect(
      await persistShopifyWebhook({
        rawBody: grande,
        appKey: 'PILOTO',
        hmac: firmar(grande),
        topic: 'x',
        shopDomain: e.shopDomain,
        webhookId: 'w-big',
      }),
    ).toEqual({
      outcome: 'TOO_LARGE',
    })
  })

  it('el controlador sólo guarda y contesta (con la hora de origen de Shopify): 200, 401, 404 y 400', async () => {
    const e = await escenario()
    const respuesta = () => {
      const res = { status: jest.fn(), end: jest.fn() }
      res.status.mockReturnValue(res)
      return res
    }
    const peticion = (appKey: string, body: unknown, headers: Record<string, string>) =>
      ({ params: { appKey }, body, get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request
    const cuerpo = Buffer.from(JSON.stringify(NIVEL_1))
    const cabeceras = {
      'x-shopify-hmac-sha256': firmar(cuerpo),
      'x-shopify-topic': 'inventory_levels/update',
      'x-shopify-shop-domain': e.shopDomain,
      'x-shopify-webhook-id': 'w-ctrl',
      'x-shopify-triggered-at': '2026-10-07T18:00:27.877041743Z',
    }
    const ok = respuesta()
    await handleShopifyWebhook(peticion('piloto', cuerpo, cabeceras), ok as unknown as Response)
    expect(ok.status).toHaveBeenCalledWith(200)
    const fila = await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { dedupKey: 'w-ctrl' } })
    expect(fila).toMatchObject({ status: 'RECEIVED', attemptCount: 0 })
    expect(fila.triggeredAt!.toISOString()).toBe('2026-10-07T18:00:27.877Z')
    expect(await stock(e)).toBe('10') // contestar no procesa

    const mala = respuesta()
    await handleShopifyWebhook(
      peticion('piloto', cuerpo, { ...cabeceras, 'x-shopify-hmac-sha256': 'AAAA', 'x-shopify-webhook-id': 'w-ctrl-2' }),
      mala as unknown as Response,
    )
    expect(mala.status).toHaveBeenCalledWith(401)
    const app = respuesta()
    await handleShopifyWebhook(peticion('otra', cuerpo, cabeceras), app as unknown as Response)
    expect(app.status).toHaveBeenCalledWith(404)
    const crudo = respuesta()
    await handleShopifyWebhook(peticion('piloto', { ya: 'parseado' }, cabeceras), crudo as unknown as Response)
    expect(crudo.status).toHaveBeenCalledWith(400)
  })
})

describe('reclamar (N12)', () => {
  it('uno por reclamo con lease; un lease vencido se retoma contando el intento; al tope queda en CUARENTENA', async () => {
    const e = await escenario()
    const a = await evento(e, 'orders/create', { line_items: [] })
    const b = await evento(e, 'orders/create', { line_items: [] })
    const ahora = new Date()
    const r1 = await claimShopifyEvent(ahora)
    const r2 = await claimShopifyEvent(ahora)
    if (r1.kind !== 'FILA' || r2.kind !== 'FILA') throw new Error('se esperaban dos FILA')
    expect(new Set([r1.id, r2.id])).toEqual(new Set([a, b]))
    expect(await claimShopifyEvent(ahora)).toEqual({ kind: 'VACIO' })
    expect(await ev(a)).toMatchObject({ status: 'PROCESSING', attemptCount: 0 })

    await prisma.shopifyInboundEvent.update({ where: { id: a }, data: { leaseUntil: new Date(Date.now() - 1_000) } })
    expect(await claimShopifyEvent(new Date())).toMatchObject({ kind: 'FILA', id: a })
    expect((await ev(a)).attemptCount).toBe(1)

    await prisma.shopifyInboundEvent.update({
      where: { id: a },
      data: { attemptCount: MAX_EVENT_ATTEMPTS - 1, leaseUntil: new Date(Date.now() - 1_000) },
    })
    expect(await claimShopifyEvent(new Date())).toEqual({ kind: 'CUARENTENA', id: a })
    expect(await ev(a)).toMatchObject({ status: 'FAILED', claimToken: null, error: expect.stringContaining('LEASE_EXPIRED') })
  })

  it('N12: tres vencidas al tope delante de una sana ⇒ CUARENTENA ×3 y después la sana, no VACIO', async () => {
    const e = await escenario()
    const viejas = [await evento(e, 'orders/create', {}), await evento(e, 'orders/create', {}), await evento(e, 'orders/create', {})]
    await prisma.shopifyInboundEvent.updateMany({
      where: { id: { in: viejas } },
      data: {
        status: 'PROCESSING',
        claimToken: 'x',
        attemptCount: MAX_EVENT_ATTEMPTS - 1,
        leaseUntil: new Date(Date.now() - 1_000),
        receivedAt: new Date(Date.now() - 60_000),
      },
    })
    const sana = await evento(e, 'orders/create', {})
    const kinds = []
    for (let i = 0; i < 4; i++) kinds.push((await claimShopifyEvent(new Date())).kind)
    expect(kinds).toEqual(['CUARENTENA', 'CUARENTENA', 'CUARENTENA', 'FILA'])
    expect((await ev(sana)).status).toBe('PROCESSING')
  })
})

describe('procesar (#14, #16, N09, N10, N11, N20)', () => {
  it('tienda desconocida o de otra app ⇒ SKIPPED sin tocar nada', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    await prisma.shopifyInboundEvent.update({ where: { id }, data: { shopDomain: 'nadie.myshopify.com' } })
    expect(await processShopifyEvent(id, await procesando(id), conAcceso)).toBe('SKIPPED')
    const id2 = await evento(e, 'inventory_levels/update', NIVEL_1)
    await prisma.shopifyInboundEvent.update({ where: { id: id2 }, data: { appKey: 'PUBLICA' } })
    expect(await processShopifyEvent(id2, await procesando(id2), conAcceso)).toBe('SKIPPED')
    expect(await ev(id2)).toMatchObject({ status: 'SKIPPED', error: 'APP_DISTINTA', claimToken: null })
    expect(await stock(e)).toBe('10')
    await prisma.shopifyInboundEvent.deleteMany({ where: { id } }) // su dominio ya no es el del escenario
  })

  it('inventory_levels/update en ACTIVE ⇒ relee el nivel y aplica disponible − espejo, sin eco', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const fetchLevels = nivelesFalsos(() => nivel(7, 3))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels })).toBe('PROCESSED')
    expect(fetchLevels.mock.calls[0][1]).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/1', shopifyLocationId: 'gid://shopify/Location/1' },
    ])
    expect(await stock(e)).toBe('7')
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      mirrorAvailable: 7,
      mirrorCommitted: 3,
    })
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId } })).toBe(0)
    expect(await ev(id)).toMatchObject({ status: 'PROCESSED', claimToken: null })
  })

  it('RF4: en pausa ⇒ DEFERRED sin intentos; la reanudación deja requeuePending y, aunque el proceso muera antes de drenar, el drenado lo reabre después', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    const inv = await evento(e, 'inventory_levels/update', NIVEL_1)
    const cat = await evento(e, 'products/update', { id: 42 })
    const fetchLevels = nivelesFalsos(() => nivel(7))
    expect(await processShopifyEvent(inv, await procesando(inv), { ...conAcceso, fetchLevels })).toBe('DEFERRED')
    expect(await processShopifyEvent(cat, await procesando(cat), conAcceso)).toBe('DEFERRED')
    expect(await ev(inv)).toMatchObject({ status: 'DEFERRED', attemptCount: 0, claimToken: null })
    expect(fetchLevels).not.toHaveBeenCalled()
    expect(await claimShopifyEvent(new Date())).toEqual({ kind: 'VACIO' }) // un diferido no se reclama

    // Lo que hace la reanudación (B3) en UNA tx; el proceso «muere» antes de drenar.
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { status: 'ACTIVE', pausedFrom: null, requeuePending: true },
    })
    expect((await ev(cat)).status).toBe('DEFERRED')
    expect(await requeueDeferredEvents(e.locationLinkId)).toEqual({ reabiertos: 1, superados: 1, terminado: true })
    expect(await ev(cat)).toMatchObject({ status: 'RECEIVED', attemptCount: 0 })
    expect(await ev(inv)).toMatchObject({ status: 'PROCESSED', error: 'SUPERADO_POR_CUADRE' })
    expect(await sucursal(e)).toMatchObject({ requeuePending: false, needsReconcile: true })
    const syncProduct = jest.fn(async () => ({ ok: true as const }))
    expect(await processShopifyEvent(cat, await procesando(cat), { ...conAcceso, syncProduct })).toBe('PROCESSED')
  })

  it('N10: si la reanudación hace commit mientras el aviso decidía diferirse, el aviso vuelve a la fila en vez de quedar varado', async () => {
    const e = await escenario()
    const venue2 = await prisma.venue.create({
      data: {
        organizationId: e.organizationId,
        name: `v2-${e.venueId}`,
        slug: `v2-${e.venueId}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    const l2 = await prisma.shopifyLocationLink.create({
      data: {
        storeId: e.storeId,
        venueId: venue2.id,
        shopifyLocationId: 'gid://shopify/Location/2',
        locationName: 'Otra',
        status: 'PAUSED',
        pausedFrom: 'ACTIVE',
      },
    })
    const id = await evento(e, 'products/update', { id: 42 })
    // Mientras se revisan las sucursales, la segunda se reanuda (commit) antes de que el aviso se cierre.
    const hasAccess = jest.fn(async () => {
      await prisma.shopifyLocationLink.update({ where: { id: l2.id }, data: { status: 'ACTIVE', pausedFrom: null, requeuePending: true } })
      return true
    })
    expect(await processShopifyEvent(id, await procesando(id), { hasAccess })).toBe('FAILED')
    expect(await ev(id)).toMatchObject({ status: 'RECEIVED', attemptCount: 0, claimToken: null })
    await prisma.shopifyInboundEvent.deleteMany({ where: { id } })
    await prisma.shopifyLocationLink.delete({ where: { id: l2.id } })
    await prisma.venue.delete({ where: { id: venue2.id } })
  })

  it('sin plan con la sucursal ACTIVE ⇒ vuelve a la fila en 60 s sin gastar intentos (nada queda diferido sin dueño)', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    expect(await processShopifyEvent(id, await procesando(id), { hasAccess: async () => false })).toBe('DEFERRED')
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'RECEIVED', error: 'SIN_PLAN', attemptCount: 0, claimToken: null })
    expect(f.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000)
  })

  it('un envío en vuelo del producto ⇒ FAILED con espera y un intento; al último intento, FAILED terminal', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'IN_PROGRESS', claimToken: 'm', leaseUntil: new Date(Date.now() + 60_000) },
    })
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const deps = { ...conAcceso, fetchLevels: nivelesFalsos(() => nivel(8)) }
    expect(await processShopifyEvent(id, await procesando(id), deps)).toBe('FAILED')
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'FAILED', attemptCount: 1, error: 'ENVIO_EN_VUELO_O_LECTURA_VIEJA' })
    expect(f.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    expect(await stock(e)).toBe('9')

    await prisma.shopifyInboundEvent.update({ where: { id }, data: { attemptCount: MAX_EVENT_ATTEMPTS - 1 } })
    expect(await processShopifyEvent(id, await procesando(id), deps)).toBe('FAILED')
    expect(await ev(id)).toMatchObject({ status: 'FAILED', attemptCount: MAX_EVENT_ATTEMPTS, nextAttemptAt: null })
    expect((await ev(id)).processedAt).toBeInstanceOf(Date)
  })

  it('orders/create ⇒ relee las variantes del pedido', async () => {
    const e = await escenario()
    const id = await evento(e, 'orders/create', { line_items: [{ variant_id: 1, quantity: 2 }, { variant_id: null }] })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels: nivelesFalsos(() => nivel(8, 2)) })).toBe(
      'PROCESSED',
    )
    expect(await stock(e)).toBe('8')
  })

  it('products/update ⇒ sync del producto; products/delete ⇒ archivo, los dos con el reclamo del evento', async () => {
    const e = await escenario()
    const syncProduct = jest.fn(async () => ({ ok: true as const }))
    const archiveProduct = jest.fn(async () => ({ archivadas: 1, suspendidas: 0 }))
    const a = await evento(e, 'products/update', { id: 42 })
    const ta = await procesando(a, 'tok-a')
    expect(await processShopifyEvent(a, ta, { ...conAcceso, syncProduct, archiveProduct })).toBe('PROCESSED')
    expect(syncProduct).toHaveBeenCalledWith(
      e.storeId,
      'gid://shopify/Product/42',
      expect.objectContaining({ reclamo: { eventId: a, claimToken: 'tok-a' } }),
    )
    const b = await evento(e, 'products/delete', { id: 42 })
    expect(await processShopifyEvent(b, await procesando(b, 'tok-b'), { ...conAcceso, syncProduct, archiveProduct })).toBe('PROCESSED')
    expect(archiveProduct).toHaveBeenCalledWith(
      e.storeId,
      'gid://shopify/Product/42',
      expect.objectContaining({ reclamo: { eventId: b, claimToken: 'tok-b' } }),
    )
  })

  it('R07 (§12.6): un evento de catálogo válido se procesa aunque otro worker tenga el lease de la sucursal; los dos reclamos siguen', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { workToken: 'w-otro', workLeaseUntil: new Date(Date.now() + 90_000) },
    })
    const id = await evento(e, 'products/update', { id: 950 })
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(950, { producto: 'gid://shopify/Product/950' })], null))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, graphql })).toBe('PROCESSED')
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId, shopifyVariantId: variante(950).id } })).toBe(
      1,
    )
    expect(await sucursal(e)).toMatchObject({ workToken: 'w-otro' }) // el worker conserva su lease
    expect(await ev(id)).toMatchObject({ status: 'PROCESSED', claimToken: null })
  })

  it('N11 (§12.8): un archivo interrumpido no se da por procesado: vuelve a la fila sin gastar intento; sin el reclamo, ni se toca', async () => {
    const e = await escenario()
    const archiveProduct = jest
      .fn()
      .mockResolvedValueOnce({ archivadas: 50, suspendidas: 0, interrumpido: 'SIN_TIEMPO' })
      .mockResolvedValue({ archivadas: 5, suspendidas: 0 })
    const id = await evento(e, 'products/delete', { id: 812 })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, archiveProduct })).toBe('FAILED')
    expect(await ev(id)).toMatchObject({ status: 'RECEIVED', attemptCount: 0, claimToken: null })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, archiveProduct })).toBe('PROCESSED')
    // El reclamo pasó a otro proceso mientras archivaba: se detuvo y el evento ajeno no se toca.
    const otro = await evento(e, 'products/delete', { id: 813 })
    const viejo = await procesando(otro, 'tok-viejo')
    const quitado = jest.fn(async () => {
      await prisma.shopifyInboundEvent.update({ where: { id: otro }, data: { claimToken: 'tok-nuevo' } })
      return { archivadas: 0, suspendidas: 0, interrumpido: 'CONTEXTO_CAMBIO' as const }
    })
    expect(await processShopifyEvent(otro, viejo, { ...conAcceso, archiveProduct: quitado })).toBe('SKIPPED')
    expect(await ev(otro)).toMatchObject({ status: 'PROCESSING', claimToken: 'tok-nuevo' })
  })

  it('N17 (§12.8): el avance del sync queda en el evento: la siguiente pasada sigue en la página que faltaba', async () => {
    const e = await escenario()
    const P = 'gid://shopify/Product/520'
    const responde = graphqlFalso((_q, vars) =>
      vars.after ? paginaDeVariantes([variante(222, { producto: P })], null) : paginaDeVariantes([variante(221, { producto: P })], 'r2'),
    )
    const graphql = jest.fn(async (...a: unknown[]) => {
      if (!(a[3] as { after?: string | null }).after) await dormir(1_000) // la primera página tarda
      return responde(...a)
    })
    const id = await evento(e, 'products/update', { id: 520 })
    const vence = Date.now() + MIN_HTTP_MS + 600
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, graphql: graphql as never, vence })).toBe('FAILED')
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'RECEIVED', attemptCount: 0 })
    const l = await sucursal(e)
    const avance = (f.payload as { _avoqadoAvance: Record<string, unknown> })._avoqadoAvance
    expect(avance[`${l.id}:${l.generation}`]).toEqual({ cursor: 'r2', vistas: [variante(221).id] })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, graphql: graphql as never })).toBe('PROCESSED')
    expect(graphql).toHaveBeenCalledTimes(2) // la página 1 no se repitió
    expect((graphql.mock.calls[1][3] as { after: string }).after).toBe('r2')
  })

  it('§12.2 (B-5, R2): la tienda se revoca mientras se relee ⇒ A no aplica: nada se escribe y, releído el contexto, el evento se difiere sin gastar intento', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const fetchLevels = jest.fn(async (_s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } })
      return nivelesFalsos(() => nivel(7))(_s as never, items)
    })
    // B-5: CONTEXTO_CAMBIO ⇒ se relee el contexto y, con la tienda no ACTIVE, toma la ruta pausada en la MISMA pasada.
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels: fetchLevels as never })).toBe('DEFERRED')
    expect(await stock(e)).toBe('10')
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(10)
    expect(await ev(id)).toMatchObject({ status: 'DEFERRED', error: 'TIENDA_REVOCADA', attemptCount: 0, claimToken: null })
  })

  it('N11: otro proceso tomó el evento mientras éste leía Shopify ⇒ éste no escribe catálogo ni cierra el evento ajeno', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/update', { id: 900 })
    const viejo = await procesando(id, 'tok-viejo')
    const graphql = graphqlConEfecto(
      () => prisma.shopifyInboundEvent.update({ where: { id }, data: { claimToken: 'tok-nuevo' } }).then(() => undefined),
      () => paginaDeVariantes([variante(900, { producto: 'gid://shopify/Product/900' })], null),
    )
    expect(await processShopifyEvent(id, viejo, { ...conAcceso, graphql })).toBe('SKIPPED')
    expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(0)
    expect(await ev(id)).toMatchObject({ status: 'PROCESSING', claimToken: 'tok-nuevo' })
  })

  it('app/uninstalled originado después de la autorización ⇒ revoca y avisa; N09: uno originado ANTES (llegó tarde) no revoca', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { authorizedAt: new Date('2026-10-07T12:00:00Z') } })
    const tarde = await evento(e, 'app/uninstalled', { id: 1 }, '2026-10-07T11:00:00Z') // desinstalación vieja, reinstalada a las 12
    expect(await processShopifyEvent(tarde, await procesando(tarde))).toBe('SKIPPED')
    expect(await ev(tarde)).toMatchObject({ status: 'SKIPPED', error: 'REINSTALADA_DESPUES' })
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')

    const real = await evento(e, 'app/uninstalled', { id: 1 }, '2026-10-07T13:00:00Z')
    expect(await processShopifyEvent(real, await procesando(real))).toBe('PROCESSED')
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('REVOKED')
    expect(await avisos(e, 'REVOCADA')).toBe(1)
  })

  it('N09: sin hora de origen, se prueba el token vigente: si contesta no revoca; si da 401, revoca', async () => {
    const e = await escenario()
    const a = await evento(e, 'app/uninstalled', { id: 1 })
    const vivo = graphqlFalso(() => ({ ok: true, data: { shop: { id: 'gid://shopify/Shop/1' } } }))
    expect(await processShopifyEvent(a, await procesando(a), { graphql: vivo })).toBe('SKIPPED')
    expect(await ev(a)).toMatchObject({ error: 'TOKEN_VIGENTE' })
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')

    const b = await evento(e, 'app/uninstalled', { id: 1 })
    expect(await processShopifyEvent(b, await procesando(b), { graphql: graphqlFalso(() => falla('UNAUTHORIZED', false, false)) })).toBe(
      'PROCESSED',
    )
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('REVOKED')
  })

  it('tienda revocada ⇒ DEFERRED; un 401 al releer revoca (token vigente) y difiere', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const no = jest.fn(async () => falla('UNAUTHORIZED', false, false))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels: no as never })).toBe('DEFERRED')
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('REVOKED')
    const id2 = await evento(e, 'inventory_levels/update', NIVEL_1)
    expect(await processShopifyEvent(id2, await procesando(id2), conAcceso)).toBe('DEFERRED')
    expect(await ev(id2)).toMatchObject({ status: 'DEFERRED', error: 'TIENDA_REVOCADA', attemptCount: 0 })
  })

  it('N11 (§11.2): una lectura vieja que vuelve DESPUÉS de que otro proceso reclamó el evento no mueve el stock ni cierra el evento', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const viejo = await procesando(id, 'tok-viejo')
    const fetchLevels = jest.fn(async (_store: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      // Mientras la lectura viaja, el lease vence y otro proceso reclama el MISMO evento.
      await prisma.shopifyInboundEvent.update({ where: { id }, data: { claimToken: 'tok-nuevo' } })
      return nivelesFalsos(() => nivel(7))(_store as never, items)
    })
    await processShopifyEvent(id, viejo, { ...conAcceso, fetchLevels: fetchLevels as never })
    expect(await stock(e)).toBe('10')
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(10)
    expect(await ev(id)).toMatchObject({ status: 'PROCESSING', claimToken: 'tok-nuevo', attemptCount: 0 })
  })

  it('N11: una desinstalación sin hora cuyo evento reclamó otro proceso a media prueba del token no revoca', async () => {
    const e = await escenario()
    const id = await evento(e, 'app/uninstalled', { id: 1 })
    const viejo = await procesando(id, 'tok-viejo')
    const graphql = graphqlConEfecto(
      () => prisma.shopifyInboundEvent.update({ where: { id }, data: { claimToken: 'tok-nuevo' } }).then(() => undefined),
      () => falla('UNAUTHORIZED', false, false),
    )
    expect(await processShopifyEvent(id, viejo, { graphql })).toBe('SKIPPED')
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')
    expect(await ev(id)).toMatchObject({ status: 'PROCESSING', claimToken: 'tok-nuevo' })
  })

  it('N25 (§11.6): sin tiempo, un aviso de inventario no sale a la red y vuelve a la fila sin gastar intento', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const fetchLevels = nivelesFalsos(() => nivel(7))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels, vence: Date.now() + 100 })).toBe('FAILED')
    expect(fetchLevels).not.toHaveBeenCalled()
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'RECEIVED', attemptCount: 0, claimToken: null })
    expect(await stock(e)).toBe('10')
  })

  it('N20: falta un permiso al releer ⇒ la sucursal queda FALTA_PERMISO, aviso, y el evento espera DEFERRED sin intentos', async () => {
    const e = await escenario()
    const id = await evento(e, 'inventory_levels/update', NIVEL_1)
    const sinPermiso = jest.fn(async () => falla('FORBIDDEN', false, false))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, fetchLevels: sinPermiso as never })).toBe('DEFERRED')
    expect(await ev(id)).toMatchObject({ status: 'DEFERRED', error: 'FALTA_PERMISO', attemptCount: 0 })
    expect((await sucursal(e)).importError).toBe('FALTA_PERMISO')
    expect(await avisos(e, 'FALTA_PERMISO')).toBe(1)
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')
  })
})

describe('drenar requeuePending (§10.5)', () => {
  it('por tandas de 500: baja la bandera sólo cuando ya no queda nada', async () => {
    const e = await escenario()
    await prisma.shopifyInboundEvent.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        dedupKey: `d-${e.venueId}-${i}`,
        appKey: 'PILOTO' as const,
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: { id: i },
        status: 'DEFERRED' as const,
      })),
    })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { requeuePending: true } })
    expect(await requeueDeferredEvents(e.locationLinkId)).toEqual({ reabiertos: 500, superados: 0, terminado: false })
    expect((await sucursal(e)).requeuePending).toBe(true)
    expect(await requeueDeferredEvents(e.locationLinkId)).toEqual({ reabiertos: 1, superados: 0, terminado: true })
    expect((await sucursal(e)).requeuePending).toBe(false)
  })

  it('R03 (§11.5): un pedido diferido por la sucursal X que se cierra SUPERADO pide cuadre también a Y, que tiene pareja de ese artículo', async () => {
    const x = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    const y = await otraSucursalDeLaTienda(x)
    otras.push(y)
    const sinPareja = await otraSucursalDeLaTienda(x, { shopifyLocationId: 'gid://shopify/Location/3' }) // R08: otra ubicación
    otras.push(sinPareja)
    await prisma.shopifyVariantLink.update({
      where: { id: sinPareja.variantLinkId },
      data: { shopifyVariantId: 'gid://shopify/ProductVariant/77', inventoryItemId: 'gid://shopify/InventoryItem/77' },
    })
    const id = await evento(x, 'orders/create', { line_items: [{ variant_id: 1, quantity: 1 }] })
    expect(await processShopifyEvent(id, await procesando(id), conAcceso)).toBe('DEFERRED') // X todavía no está ACTIVE
    const antes = await prisma.shopifyLocationLink.findMany({
      where: { id: { in: [y.locationLinkId, sinPareja.locationLinkId] } },
      select: { id: true, reconcileVersion: true },
      take: 2,
    })
    // X se activa (B3 deja requeuePending en esa misma tx) y el worker drena.
    await prisma.shopifyLocationLink.update({ where: { id: x.locationLinkId }, data: { status: 'ACTIVE', requeuePending: true } })
    expect(await requeueDeferredEvents(x.locationLinkId)).toEqual({ reabiertos: 0, superados: 1, terminado: true })
    expect(await ev(id)).toMatchObject({ status: 'PROCESSED', error: 'SUPERADO_POR_CUADRE' })
    const despues = await prisma.shopifyLocationLink.findMany({
      where: { id: { in: [x.locationLinkId, y.locationLinkId, sinPareja.locationLinkId] } },
      take: 3,
    })
    const version = (id: string) => despues.find(l => l.id === id)!.reconcileVersion
    const vieja = (id: string) => antes.find(l => l.id === id)!.reconcileVersion
    expect(version(y.locationLinkId)).toBe(vieja(y.locationLinkId) + 1) // Y: tiene pareja de la variante 1
    expect(despues.find(l => l.id === y.locationLinkId)!.reconcileDoneVersion).toBeLessThan(version(y.locationLinkId))
    expect(version(sinPareja.locationLinkId)).toBe(vieja(sinPareja.locationLinkId)) // sin pareja de ese artículo: no se toca
    expect(version(x.locationLinkId)).toBeGreaterThan(0)
  })

  it('R03: un aviso diferido sin artículos legibles pide cuadre a TODAS las ACTIVE de la tienda', async () => {
    const x = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    const y = await otraSucursalDeLaTienda(x)
    otras.push(y)
    await prisma.shopifyVariantLink.update({
      where: { id: y.variantLinkId },
      data: { shopifyVariantId: 'gid://shopify/ProductVariant/77', inventoryItemId: 'gid://shopify/InventoryItem/77' },
    })
    await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: `raro-${x.venueId}`,
        appKey: 'PILOTO',
        topic: 'orders/cancelled',
        shopDomain: x.shopDomain,
        payload: { line_items: [] },
        status: 'DEFERRED',
      },
    })
    const antes = (await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: y.locationLinkId } })).reconcileVersion
    await prisma.shopifyLocationLink.update({ where: { id: x.locationLinkId }, data: { status: 'ACTIVE', requeuePending: true } })
    expect(await requeueDeferredEvents(x.locationLinkId)).toEqual({ reabiertos: 0, superados: 1, terminado: true })
    expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: y.locationLinkId } })).reconcileVersion).toBe(antes + 1)
  })

  it('con la sucursal en pausa, la tienda revocada o el lease de otro worker, no drena', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: `p-${e.venueId}`,
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: {},
        status: 'DEFERRED',
      },
    })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { requeuePending: true } })
    expect(await requeueDeferredEvents(e.locationLinkId)).toEqual({ reabiertos: 0, superados: 0, terminado: true })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'ACTIVE', workToken: 'otro' } })
    expect(await requeueDeferredEvents(e.locationLinkId, { workToken: 'mio' })).toEqual({ reabiertos: 0, superados: 0, terminado: false })
    expect((await sucursal(e)).requeuePending).toBe(true)
  })
})

describe('lo que exige la revisión de B1 (R1, R2, R3) y el contexto', () => {
  it('R1: un error pasajero de la base (P2028, 40P01) vuelve a la fila sin gastar intento; uno cualquiera es FAILED con espera', async () => {
    const e = await escenario()
    const a = await evento(e, 'products/update', { id: 970 })
    const pasajero = jest.fn(async () => {
      throw Object.assign(new Error('Unable to start a transaction in the given time'), { code: 'P2028' })
    })
    expect(await processShopifyEvent(a, await procesando(a), { ...conAcceso, syncProduct: pasajero })).toBe('FAILED')
    const fa = await ev(a)
    expect(fa).toMatchObject({ status: 'RECEIVED', attemptCount: 0, claimToken: null, error: 'DB_PASAJERO: P2028' })
    expect(fa.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now())
    const interbloqueo = jest.fn(async () => {
      throw Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '40P01', message: 'deadlock detected' } })
    })
    expect(await processShopifyEvent(a, await procesando(a), { ...conAcceso, syncProduct: interbloqueo })).toBe('FAILED')
    expect(await ev(a)).toMatchObject({ status: 'RECEIVED', attemptCount: 0, error: 'DB_PASAJERO: 40P01' })

    const roto = jest.fn(async () => {
      throw new Error('algo se rompió')
    })
    expect(await processShopifyEvent(a, await procesando(a), { ...conAcceso, syncProduct: roto })).toBe('FAILED')
    expect(await ev(a)).toMatchObject({ status: 'FAILED', attemptCount: 1, error: 'algo se rompió', processedAt: null })
  })

  it('R1: un products/delete que lanza NO queda PROCESSED y se retoma; uno que lanza ContextoObsoleto no toca el evento', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/delete', { id: 971 })
    const truena = jest.fn(async () => {
      throw new Error('falló a media tanda')
    })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, archiveProduct: truena })).toBe('FAILED')
    expect(await ev(id)).toMatchObject({ status: 'FAILED', attemptCount: 1, processedAt: null })
    const sigue = jest.fn(async () => ({ archivadas: 1, suspendidas: 0 }))
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, archiveProduct: sigue })).toBe('PROCESSED')

    const otro = await evento(e, 'products/delete', { id: 972 })
    const ajeno = jest.fn(async () => {
      throw new ContextoObsoleto()
    })
    expect(await processShopifyEvent(otro, await procesando(otro, 'tok-mio'), { ...conAcceso, archiveProduct: ajeno })).toBe('SKIPPED')
    expect(await ev(otro)).toMatchObject({ status: 'PROCESSING', claimToken: 'tok-mio', attemptCount: 0 })
  })

  it('R2: CONTEXTO_CAMBIO porque la sucursal salió de ACTIVE ⇒ se relee y se difiere en la misma pasada, sin intento', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/update', { id: 973 })
    const pausa = jest.fn(async () => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } })
      return { error: 'CONTEXTO_CAMBIO', retry: true }
    })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, syncProduct: pausa })).toBe('DEFERRED')
    expect(await ev(id)).toMatchObject({ status: 'DEFERRED', error: 'SUCURSAL_PAUSED', attemptCount: 0, claimToken: null })
  })

  it('R2: CONTEXTO_CAMBIO porque se perdió el plan ⇒ el plan se vuelve a preguntar (no la respuesta guardada) y espera 60 s', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/update', { id: 974 })
    const hasAccess = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const sinPlan = jest.fn(async () => ({ error: 'CONTEXTO_CAMBIO', retry: true }))
    expect(await processShopifyEvent(id, await procesando(id), { hasAccess, syncProduct: sinPlan })).toBe('DEFERRED')
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'RECEIVED', error: 'SIN_PLAN', attemptCount: 0, claimToken: null })
    expect(f.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000)
    expect(hasAccess).toHaveBeenCalledTimes(2) // la compuerta y la relectura
  })

  it('R2: CONTEXTO_CAMBIO con todo vigente (otra generación) ⇒ vuelve a la fila en 15 s sin gastar intento', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/update', { id: 975 })
    const reconecto = jest.fn(async () => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: { increment: 1 } } })
      return { error: 'CONTEXTO_CAMBIO', retry: true }
    })
    expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, syncProduct: reconecto })).toBe('FAILED')
    const f = await ev(id)
    expect(f).toMatchObject({ status: 'RECEIVED', error: 'CONTEXTO_CAMBIO', attemptCount: 0, claimToken: null })
    expect(f.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 10_000)
    expect(f.nextAttemptAt!.getTime()).toBeLessThan(Date.now() + 20_000)
  })

  it('R3: el plan se pregunta UNA vez por negocio en la pasada, aunque el sync escriba varias variantes', async () => {
    const e = await escenario()
    const P = 'gid://shopify/Product/976'
    const id = await evento(e, 'products/update', { id: 976 })
    const hasAccess = jest.fn(async () => true)
    const graphql = graphqlFalso(() => paginaDeVariantes([variante(9761, { producto: P }), variante(9762, { producto: P })], null))
    expect(await processShopifyEvent(id, await procesando(id), { hasAccess, graphql })).toBe('PROCESSED')
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId, shopifyProductId: P } })).toBe(2)
    expect(hasAccess).toHaveBeenCalledTimes(1)
  })

  it('contexto: el negocio se estampa en una COPIA del contexto de quien llama; el del worker no se ensucia', async () => {
    const e = await escenario()
    const id = await evento(e, 'products/update', { id: 977 })
    const visto: Array<string | undefined> = []
    const syncProduct = jest.fn(async () => {
      visto.push(getContext()?.venueId)
      return { ok: true as const }
    })
    const tick = { correlationId: 'tick-1', source: 'job' as const, entrypoint: 'shopify-worker' }
    await runWithContext(tick, async () => {
      expect(await processShopifyEvent(id, await procesando(id), { ...conAcceso, syncProduct })).toBe('PROCESSED')
      expect(getContext()?.venueId).toBeUndefined()
      expect(getContext()?.correlationId).toBe('tick-1')
    })
    expect(visto).toEqual([e.venueId])
  })
})

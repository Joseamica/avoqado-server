/**
 * El worker con Postgres real (B8): lease por sucursal (N19), equidad entre ticks con una sucursal lenta (RF5, N18), la
 * unidad real de acceso y drenado (#15, §10.5), la limpieza por tandas con tope y el cuadre de la mañana. Más lo que el
 * ledger le pidió a B8: el cerco del mensajero (T5), esperar un envío en camino (T5), FALTA_PERMISO terminal (T5), la
 * espera creciente de la importación (R9), el plan una vez por unidad (R3), releer el plan tras CONTEXTO_CAMBIO (R2), el
 * drenado que no gira (S7), el aviso «Por revisar» sólo al cerrar y un solo correo al día (U4, B4 Minor 1) y la purga de
 * lo que ya no puede salir (T5, S7).
 */
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import { importCatalogPage } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { claimShopifyOutbox } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import { notifyShopifyReview } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import { MIN_HTTP_MS, pedirCuadre } from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  enviarFila,
  limpiarShopify,
  ShopifyWorkerJob,
  soltarSucursal,
  tomarSucursal,
  unidadDeSucursal,
  type DepsUnidad,
  type ResultadoUnidad,
  type SucursalTomada,
} from '@/jobs/shopify-worker.job'
import { pedirCuadreDeLaManana } from '@/jobs/shopify-reconcile.job'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  limpiarEscenarioShopify,
  UBICACION_PRUEBA,
} from './fixtures'
import {
  conPlan,
  falla,
  graphqlConEfecto,
  graphqlDelCatalogo,
  nivel,
  nivelesFalsos,
  paginaDeVariantes,
  variante,
  variantesDeLaSucursal,
} from './fixturesB'

jest.setTimeout(180_000)
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
  jest.restoreAllMocks()
})
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
/** Toma hasta encontrar la sucursal del escenario (en la base de pruebas puede haber otras) y suelta las ajenas. */
async function tomarLaMia(e: EscenarioShopify, now: Date): Promise<SucursalTomada | null> {
  for (let i = 0; i < 50; i++) {
    const s = await tomarSucursal(now)
    if (!s) return null
    if (s.id === e.locationLinkId) return s
    await soltarSucursal(s.id, s.workToken, now, null)
  }
  return null
}

it('N19: dos workers nunca tienen la misma sucursal; con el lease vencido otro la toma y el primero ya no puede avanzar', async () => {
  const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
  const t0 = new Date()
  const primero = await tomarLaMia(e, t0)
  expect(primero).not.toBeNull()
  expect(await tomarLaMia(e, new Date(t0.getTime() + 30_000))).toBeNull() // lease vigente: nadie más
  const segundo = await tomarLaMia(e, new Date(t0.getTime() + 100_000)) // venció a los 90 s
  expect(segundo).not.toBeNull()
  expect(segundo!.workToken).not.toBe(primero!.workToken)
  const pagina = graphqlFalso(() => paginaDeVariantes([], null, 0))
  expect(await importCatalogPage(e.locationLinkId, { graphql: pagina, workToken: primero!.workToken })).toEqual({
    error: 'SIN_LEASE',
    retry: false,
  })
  expect((await sucursal(e)).status).toBe('CONNECTING')
  expect(await importCatalogPage(e.locationLinkId, { graphql: pagina, workToken: segundo!.workToken })).toEqual({
    done: true,
    procesadas: 0,
  })
})

it('RF5 (N18, N25): 21 sucursales, la primera lenta y fallando, y el buzón y los eventos gastando su presupuesto ⇒ en tres vueltas TODAS reciben turno', async () => {
  const mias: EscenarioShopify[] = []
  for (let i = 0; i < 21; i++) mias.push(await escenario())
  let t = Date.now()
  const lenta = mias[0].locationLinkId
  await prisma.shopifyLocationLink.updateMany({ where: { id: { in: mias.map(m => m.locationLinkId) } }, data: { needsReconcile: true } })
  // La lenta va primero (nunca ha tenido turno); las demás llevan 6 min sin turno.
  await prisma.shopifyLocationLink.updateMany({
    where: { id: { in: mias.slice(1).map(m => m.locationLinkId) } },
    data: { lastWorkedAt: new Date(t - 6 * 60_000) },
  })
  const atendidas = new Set<string>()
  let enviadas = 0
  let procesados = 0
  const job = new ShopifyWorkerJob({
    now: () => new Date(t),
    cron: { start: jest.fn(), stop: jest.fn() },
    claimOutbox: async () => ({ kind: 'FILA', id: 'o', claimToken: 't' }),
    runOutboxRow: async () => {
      t += 2_500 // el buzón siempre tiene trabajo y gasta sus 7 s
      enviadas++
      return 'SENT'
    },
    claimEvent: async () => ({ kind: 'FILA', id: 'e', claimToken: 'k' }),
    processEvent: async () => {
      t += 1_000 // los eventos también gastan sus 5 s
      procesados++
      return 'PROCESSED'
    },
    limpiar: async () => undefined,
    unidad: async (s: SucursalTomada) => {
      atendidas.add(s.id)
      t += s.id === lenta ? 6_000 : 300
      return s.id === lenta ? { ok: false } : { ok: true, esperaMs: 3_600_000 } // las demás: ya no vuelven en esta prueba
    },
  })
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    await job.runOnce()
    t += 30_000
  }
  expect(enviadas).toBe(9) // 3 por vuelta (7 s de buzón): no se comió el tiempo de las sucursales
  expect(procesados).toBe(12) // 4 por vuelta (5 s de eventos)
  for (const m of mias) expect(atendidas.has(m.locationLinkId)).toBe(true)
  const l = await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: lenta } })
  expect(l.workToken).toBeNull()
  expect(l.nextWorkAt).not.toBeNull() // la lenta espera su turno; no acapara
})

it('N18: con dos sucursales ocupadas, la que no alcanzó a empezar al final de la fase conserva su lugar y abre la siguiente vuelta', async () => {
  const a = await escenario()
  const b = await escenario()
  let t = Date.now()
  await prisma.shopifyLocationLink.update({ where: { id: a.locationLinkId }, data: { lastWorkedAt: new Date(t - 9 * 60_000) } })
  await prisma.shopifyLocationLink.update({ where: { id: b.locationLinkId }, data: { lastWorkedAt: new Date(t - 8 * 60_000) } })
  const conTiempo: string[] = []
  const job = new ShopifyWorkerJob({
    now: () => new Date(t),
    cron: { start: jest.fn(), stop: jest.fn() },
    claimOutbox: async () => ({ kind: 'VACIO' }),
    claimEvent: async () => ({ kind: 'VACIO' }),
    limpiar: async () => undefined,
    seguirAvisos: async () => undefined,
    // Una unidad de página pide 5 s; con menos no empieza (así contesta `unidadDeSucursal`). Ésta tarda 5.5 s.
    unidad: async (s: SucursalTomada, vence: number) => {
      if (vence - t < 5_000) return { ok: true, sinAvance: true, sinTurno: true }
      conTiempo.push(s.id === a.locationLinkId ? 'a' : 'b')
      t += 5_500
      return { ok: true }
    },
  })
  await job.runOnce() // a trabaja; b llega con 2.5 s y no empieza
  expect(conTiempo).toEqual(['a'])
  t += 30_000
  await job.runOnce()
  expect(conTiempo).toEqual(['a', 'b']) // b abre la vuelta: no se quedó al final de la fila
  expect((await sucursal(b)).workToken).toBeNull()
})

it('tomar respeta la espera, el lease, FALTA_PERMISO, la tienda revocada y la lista de excluidas; una pausada se revisa cada 5 min', async () => {
  const e = await escenario()
  const ahora = new Date()
  await prisma.shopifyLocationLink.update({
    where: { id: e.locationLinkId },
    data: { needsReconcile: true, nextWorkAt: new Date(ahora.getTime() + 60_000) },
  })
  expect(await tomarLaMia(e, ahora)).toBeNull()
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { nextWorkAt: null, importError: 'FALTA_PERMISO' } })
  expect(await tomarLaMia(e, ahora)).toBeNull()
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: ahora } })
  expect(await tomarLaMia(e, ahora)).toBeNull()
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE', revokedAt: null } })
  expect(await tomarSucursal(ahora, [e.locationLinkId])).toBeNull() // U4: la que ya se trabajó sin avance en esta vuelta
  const s = await tomarLaMia(e, ahora)
  expect(s).toMatchObject({ id: e.locationLinkId, generation: 1, importAttempts: 0, pendienteCuadre: true })
  await soltarSucursal(s!.id, s!.workToken, ahora, null)
  await prisma.shopifyLocationLink.update({
    where: { id: e.locationLinkId },
    data: { status: 'PAUSED', pausedFrom: 'ACTIVE', needsReconcile: false, lastWorkedAt: ahora },
  })
  expect(await tomarLaMia(e, new Date(ahora.getTime() + 60_000))).toBeNull()
  expect(await tomarLaMia(e, new Date(ahora.getTime() + 6 * 60_000))).toMatchObject({ status: 'PAUSED' })
})

it('#15: la unidad real pausa a quien perdió el plan (guarda la fase) y reanuda a quien lo recuperó, dejando el drenado pedido', async () => {
  const e = await escenario()
  const s = await tomarLaMia(e, new Date())
  expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: async () => false })).toMatchObject({ ok: true })
  expect(await sucursal(e)).toMatchObject({ status: 'PAUSED', pausedFrom: 'ACTIVE', needsReconcile: true })
  await soltarSucursal(s!.id, s!.workToken, new Date(), null)
  const p = await tomarLaMia(e, new Date(Date.now() + 6 * 60_000))
  expect(await unidadDeSucursal(p!, Date.now() + 20_000, { hasAccess: conPlan })).toMatchObject({ ok: true })
  expect(await sucursal(e)).toMatchObject({ status: 'ACTIVE', pausedFrom: null, requeuePending: true })
})

it('N19 (§12.7): el worker pierde la sucursal mientras pregunta por el plan ⇒ no pausa a la que ya es de otro', async () => {
  const e = await escenario()
  const s = await tomarLaMia(e, new Date())
  const hasAccess = jest.fn(async () => {
    // Mientras pregunta, su lease vence y otro worker la toma con otro workToken.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'w-nuevo' } })
    return false
  })
  expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess })).toMatchObject({ ok: true })
  expect(await sucursal(e)).toMatchObject({ status: 'ACTIVE', workToken: 'w-nuevo' })
  expect(hasAccess).toHaveBeenCalledTimes(1) // con otro dueño, la pausa ni vuelve a preguntar
})

it('R06: la fase de avisos tiene tiempo de verdad: runOnce sigue el correo que una vuelta dejó pendiente', async () => {
  const e = await escenario()
  await prisma.shopifyReviewItem.create({
    data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 13, shopifyQty: 10, suggestion: 'SHOPIFY' },
  })
  const correo = jest
    .spyOn(emailService, 'sendShopifyPorRevisarEmail')
    .mockImplementationOnce(() => new Promise<boolean>(() => undefined)) // el proveedor no contestó a tiempo
    .mockResolvedValue(true)
  expect(await notifyShopifyReview(e.venueId, 1, { vence: Date.now() + MIN_HTTP_MS + 300 })).toBe(false)
  expect(correo).toHaveBeenCalledTimes(1)
  // Un worker real salvo las colas vacías: la fase de avisos es `seguirAvisosPendientes` de verdad.
  const job = new ShopifyWorkerJob({
    cron: { start: jest.fn(), stop: jest.fn() },
    claimOutbox: async () => ({ kind: 'VACIO' }),
    claimEvent: async () => ({ kind: 'VACIO' }),
    tomarSucursal: async () => null,
    limpiar: async () => undefined,
  })
  await job.runOnce()
  expect(correo).toHaveBeenCalledTimes(2)
  expect(correo.mock.calls[1][1].idempotencyKey).toBe(correo.mock.calls[0][1].idempotencyKey)
})

it('§10.5: con requeuePending la unidad drena una tanda y baja la bandera', async () => {
  const e = await escenario()
  const ev = await prisma.shopifyInboundEvent.create({
    data: {
      dedupKey: crypto.randomUUID(),
      appKey: 'PILOTO',
      topic: 'products/update',
      shopDomain: e.shopDomain,
      payload: { id: 1 },
      status: 'DEFERRED',
    },
  })
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { requeuePending: true, webhooksAt: new Date() } })
  const s = await tomarLaMia(e, new Date())
  const r = await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: conPlan })
  expect(r).toMatchObject({ ok: true })
  expect(r.sinAvance).toBeUndefined() // movió algo: puede volver en esta misma vuelta
  expect((await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('RECEIVED')
  expect((await sucursal(e)).requeuePending).toBe(false)
})

it('limpieza: borra por tandas lo cerrado hace más de 30 días (filas, eventos e intents vencidos) y deja lo reciente', async () => {
  const e = await escenario()
  const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600_000)
  const vieja = await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: 1,
      status: 'SENT',
      processedAt: hace(31),
    },
  })
  const reciente = await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: 1,
      status: 'DISCARDED',
      processedAt: hace(29),
    },
  })
  const evento = await prisma.shopifyInboundEvent.create({
    data: {
      dedupKey: crypto.randomUUID(),
      appKey: 'PILOTO',
      topic: 'orders/create',
      shopDomain: e.shopDomain,
      payload: {},
      status: 'PROCESSED',
      processedAt: hace(31),
    },
  })
  const intent = await prisma.shopifyConnectIntent.create({
    data: { venueId: e.venueId, authUserId: e.staffId, shopDomain: e.shopDomain, appKey: 'PILOTO', expiresAt: hace(31) },
  })
  await limpiarShopify(new Date(), Date.now() + 10_000)
  expect(await prisma.shopifyStockOutbox.findUnique({ where: { id: vieja.id } })).toBeNull()
  expect(await prisma.shopifyStockOutbox.findUnique({ where: { id: reciente.id } })).not.toBeNull()
  expect(await prisma.shopifyInboundEvent.findUnique({ where: { id: evento.id } })).toBeNull()
  expect(await prisma.shopifyConnectIntent.findUnique({ where: { id: intent.id } })).toBeNull()
})

it('cuadre de la mañana: pide una vuelta a cada sucursal ACTIVE sin tocar la que va a media vuelta; la pausada no se toca', async () => {
  const a = await escenario()
  await prisma.shopifyLocationLink.update({ where: { id: a.locationLinkId }, data: { reconcileCursor: 'x' } })
  const p = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
  expect(await pedirCuadreDeLaManana()).toBeGreaterThanOrEqual(1)
  expect(await sucursal(a)).toMatchObject({ needsReconcile: true, reconcileCursor: 'x' })
  expect((await sucursal(p)).needsReconcile).toBe(false)
})

// ─── Requisitos del ledger para B8 ──────────────────────────────────────────────────────────────────────────

describe('requisitos del ledger para B8', () => {
  const AJUSTE_OK = {
    ok: true as const,
    data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/1' }, userErrors: [] } },
  }
  /** Una venta que el guardia habría anotado (la fila del buzón) para la pareja iniciada del escenario. */
  const filaDeVenta = (e: EscenarioShopify) =>
    prisma.shopifyStockOutbox.create({
      data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation: 1, productId: e.productId, delta: -1 },
    })
  /** El reclamo real del buzón (A7); la prueba exige que tome ESA fila. */
  async function reclamar(id: string): Promise<string> {
    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA' || c.id !== id) throw new Error(`se esperaba reclamar ${id} y llegó ${JSON.stringify(c)}`)
    return c.claimToken
  }

  it('T5: el cerco del mensajero se arma justo tras el reclamo: con el contexto igual sale y confirma; si la credencial cambia antes del envío, CONTEXTO_CAMBIO sin salir', async () => {
    const e = await escenario()
    const fila = await filaDeVenta(e)
    const ok = graphqlFalso(() => AJUSTE_OK)
    expect(await enviarFila(fila.id, await reclamar(fila.id), new Date(), 7_000, { graphql: ok, hasAccess: conPlan })).toBe('SENT')
    expect(ok).toHaveBeenCalledTimes(1)
    expect(ok.mock.calls[0][3]).toMatchObject({ key: fila.id })
    expect(ok.mock.calls[0][4].timeoutMs).toBeLessThanOrEqual(7_000)
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(9)

    // Otra fila; la tienda se reautoriza DESPUÉS de armar el cerco y antes de que el mensajero congele el envío.
    const otra = await filaDeVenta(e)
    const claim2 = await reclamar(otra.id)
    const nunca = graphqlFalso(() => AJUSTE_OK)
    const reautoriza = async () => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } })
      return true
    }
    expect(await enviarFila(otra.id, claim2, new Date(), 7_000, { graphql: nunca, hasAccess: reautoriza })).toBe('CONTEXTO_CAMBIO')
    expect(nunca).not.toHaveBeenCalled() // nunca salió con la credencial vieja
    expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: otra.id } })).toMatchObject({
      status: 'IN_PROGRESS',
      claimToken: claim2, // se queda reclamada: la retoma su lease vencido, con el contexto vigente
      sentInventoryItemId: null,
    })
  })

  it('T5: aplicar con algo de la conexión anterior en camino ESPERA (no es una falla) y no inicia nada', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { webhooksAt: new Date(), applyRequestedAt: new Date(), generation: 2 },
    })
    await prisma.shopifyStockOutbox.create({
      data: {
        venueId: e.venueId,
        locationLinkId: e.locationLinkId,
        generation: 1,
        productId: e.productId,
        delta: -1,
        status: 'IN_PROGRESS',
        claimToken: 'otro',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    })
    const s = await tomarLaMia(e, new Date())
    const niveles = nivelesFalsos()
    expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: conPlan, fetchLevels: niveles })).toEqual({
      ok: true,
      esperaMs: 60_000,
    })
    expect(niveles).not.toHaveBeenCalled()
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).initializedAt).toBeNull()
  })

  it('T5: un webhook rechazado deja FALTA_PERMISO terminal: la unidad espera largo y la sucursal ya no se toma', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const rechazo = graphqlFalso(q =>
      q.includes('webhookSubscriptionCreate')
        ? {
            ok: true,
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [{ field: ['topic'], message: 'You do not have permission to create webhooks' }],
              },
            },
          }
        : { ok: true, data: { webhookSubscriptions: { nodes: [] } } },
    )
    const ahora = new Date()
    const s = await tomarLaMia(e, ahora)
    const r = await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: conPlan, graphql: rechazo })
    expect(r).toEqual({ ok: false, esperaMs: 30 * 60_000, sinAvance: true, motivo: 'FALTA_PERMISO' })
    await soltarSucursal(s!.id, s!.workToken, ahora, r.esperaMs ?? null)
    expect((await sucursal(e)).importError).toBe('FALTA_PERMISO')
    expect(await tomarLaMia(e, new Date(ahora.getTime() + 31 * 60_000))).toBeNull() // pasada la espera, sigue fuera
  })

  it('R9: una página que falla espera más cada vez (1, 2, 4… hasta 30 min); la petición deja margen para escribir la página', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    const caida = graphqlFalso(() => falla('HTTP_5XX'))
    const s = await tomarLaMia(e, new Date())
    expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: conPlan, graphql: caida })).toMatchObject({
      ok: false,
      esperaMs: 60_000,
    })
    // R9: el corte de la petición deja RESERVA_PAGINA_MS (3 s) para las escrituras de la página.
    expect(caida.mock.calls[0][4].timeoutMs).toBeLessThanOrEqual(17_000)
    expect((await sucursal(e)).importAttempts).toBe(1)
    expect(await unidadDeSucursal({ ...s!, importAttempts: 1 }, Date.now() + 20_000, { hasAccess: conPlan, graphql: caida })).toMatchObject(
      {
        esperaMs: 120_000,
      },
    )
    expect(await unidadDeSucursal({ ...s!, importAttempts: 9 }, Date.now() + 20_000, { hasAccess: conPlan, graphql: caida })).toMatchObject(
      {
        esperaMs: 30 * 60_000,
      },
    )
    // Sin tiempo para la página (5 s = 2 de la petición + 3 de las escrituras): no sale nada ni cuenta como falla.
    const nada = graphqlFalso(() => paginaDeVariantes([], null, 0))
    expect(await unidadDeSucursal(s!, Date.now() + 4_000, { hasAccess: conPlan, graphql: nada })).toEqual({
      ok: true,
      sinAvance: true,
      sinTurno: true, // ni empezó: conserva su lugar en la fila
    })
    expect(nada).not.toHaveBeenCalled()
    expect((await sucursal(e)).importAttempts).toBe(3)
  })

  it('R3: una página de importación pregunta el plan UNA vez, no una por variante', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    const pagina = graphqlFalso(() => paginaDeVariantes([variante(901), variante(902), variante(903)], 'c1', 3))
    const hasAccess = jest.fn(conPlan)
    const s = await tomarLaMia(e, new Date())
    expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess, graphql: pagina })).toEqual({ ok: true })
    expect(hasAccess).toHaveBeenCalledTimes(1)
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId } })).toBe(4) // + la del escenario
    expect((await sucursal(e)).importCursor).toBe('c1')
  })

  it('R2/U4: un CONTEXTO_CAMBIO del cuadre vuelve a preguntar el plan: sin plan se pausa; con plan sólo se detiene', async () => {
    for (const conPlanAlFinal of [false, true]) {
      const e = await escenario()
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date(), needsReconcile: true } })
      // La credencial cambia mientras viaja la página del barrido: el avance cercado ya no coincide.
      const barrido = graphqlConEfecto(
        () => prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } }).then(() => undefined),
        () => paginaDeVariantes([], null, 0),
      )
      const respuestas = [true, conPlanAlFinal, conPlanAlFinal]
      const hasAccess = jest.fn(async () => respuestas.shift() ?? conPlanAlFinal)
      const s = await tomarLaMia(e, new Date())
      expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess, graphql: barrido })).toEqual({ ok: true, sinAvance: true })
      expect((await sucursal(e)).status).toBe(conPlanAlFinal ? 'ACTIVE' : 'PAUSED')
      await soltarSucursal(s!.id, s!.workToken, new Date(), null)
    }
  })

  it('S7: un drenado que no mueve nada no se repite en la vuelta (la bandera se quedó, pero la sucursal ya no está ACTIVE)', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date(), requeuePending: true } })
    const s = await tomarLaMia(e, new Date())
    // Entre el reclamo y la unidad, la sucursal se pausó: el drenado contesta «terminado» y la bandera se queda.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } })
    expect(await unidadDeSucursal(s!, Date.now() + 20_000, { hasAccess: conPlan })).toEqual({ ok: true, sinAvance: true })
    expect((await sucursal(e)).requeuePending).toBe(true)
  })

  /** Pide una vuelta y la corre con unidades del worker (tomar → unidad → soltar) hasta cerrarla; devuelve cada resultado. */
  async function vueltaConElWorker(e: EscenarioShopify, deps: DepsUnidad): Promise<ResultadoUnidad[]> {
    await pedirCuadre(e.locationLinkId)
    const rs: ResultadoUnidad[] = []
    for (let i = 0; i < 20; i++) {
      const s = await tomarLaMia(e, new Date())
      if (!s) break
      const r = await unidadDeSucursal(s, Date.now() + 20_000, deps)
      rs.push(r)
      await soltarSucursal(s.id, s.workToken, new Date(), r.esperaMs ?? null)
    }
    expect(await sucursal(e)).toMatchObject({ needsReconcile: false, reconcileCursor: null, catalogSweepCursor: null })
    return rs
  }
  const campanitas = (e: EscenarioShopify) =>
    prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'POR_REVISAR:' } } })
  const marcasDelCorreo = (e: EscenarioShopify) =>
    prisma.activityLog.count({ where: { venueId: e.venueId, action: 'SHOPIFY_POR_REVISAR_EMAILED' } })
  async function conAlgoPorRevisar(e: EscenarioShopify) {
    const suelto = await agregarProductoShopify(e, { pareja: false })
    await prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: suelto.productId,
        reason: 'DIFERENCIA',
        avoqadoQty: 13,
        shopifyQty: 10,
        suggestion: 'SHOPIFY',
      },
    })
  }
  const depsDeVuelta = async (e: EscenarioShopify, disponible = 10): Promise<DepsUnidad> => ({
    hasAccess: conPlan,
    graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
    fetchLevels: nivelesFalsos(() => nivel(disponible)),
  })

  it('U4 y B4 Minor 1: el aviso «Por revisar» sale sólo al CERRAR una vuelta con algo por revisar, y el correo una vez al día', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    const deps = await depsDeVuelta(e)
    await vueltaConElWorker(e, deps) // nada por revisar: ni campanita ni correo
    expect(await campanitas(e)).toBe(0)
    expect(correo).not.toHaveBeenCalled()

    await conAlgoPorRevisar(e)
    await vueltaConElWorker(e, deps) // cierra con 1 por revisar: campanita y correo, y la marca del día
    expect(await campanitas(e)).toBe(1)
    expect(correo).toHaveBeenCalledTimes(1)
    expect(await marcasDelCorreo(e)).toBe(1)
    await vueltaConElWorker(e, deps) // otra vuelta el mismo día: el correo no se repite (otro contenido, misma llave)
    expect(await campanitas(e)).toBe(1)
    expect(correo).toHaveBeenCalledTimes(1)
    expect(await marcasDelCorreo(e)).toBe(1)
  })

  it('I1: la campanita del día que crea COMPARAR a media vuelta no se come el correo: sale una vez al cerrar', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    // La pareja estaba suspendida y Shopify tiene 12 contra 10 de Avoqado: el cuadre la reactiva COMPARANDO (EN_REVISION),
    // y `initializePair` manda la campanita POR_REVISAR del día ANTES de que la vuelta cierre.
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    const deps = await depsDeVuelta(e, 12)
    await vueltaConElWorker(e, deps)
    expect(await prisma.shopifyReviewItem.count({ where: { venueId: e.venueId, status: 'OPEN', reason: 'REACTIVADA' } })).toBe(1)
    expect(await campanitas(e)).toBe(1)
    expect(correo).toHaveBeenCalledTimes(1)
    await vueltaConElWorker(e, deps)
    expect(correo).toHaveBeenCalledTimes(1) // la misma revisión otra vuelta: hoy ya no
  })

  it('I1: con las alertas apagadas no hay campanita, y aun así el correo sale UNA vez al día, no en cada vuelta', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    await prisma.notificationPreference.create({ data: { staffId: e.staffId, venueId: e.venueId, type: 'ALERT', enabled: false } })
    await conAlgoPorRevisar(e)
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    const deps = await depsDeVuelta(e)
    await vueltaConElWorker(e, deps)
    await vueltaConElWorker(e, deps)
    await vueltaConElWorker(e, deps)
    expect(await campanitas(e)).toBe(0)
    expect(correo).toHaveBeenCalledTimes(1)
  })

  it('I1: la marca del día se busca por el índice (entity, entityId), nunca recorriendo ActivityLog', async () => {
    const e = await escenario()
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    await conAlgoPorRevisar(e)
    // Un negocio con historia: miles de filas de bitácora suyas (la de venueId no distingue nada).
    await prisma.activityLog.createMany({
      data: Array.from({ length: 5_000 }, (_, i) => ({ venueId: e.venueId, action: 'PRUEBA', entity: 'Order', entityId: `o-${i}` })),
    })
    expect(await notifyShopifyReview(e.venueId, 1)).toBe(true)
    expect(correo).toHaveBeenCalledTimes(1)
    await prisma.$executeRawUnsafe('ANALYZE "ActivityLog"')
    const marca = await prisma.activityLog.findFirstOrThrow({ where: { venueId: e.venueId, action: 'SHOPIFY_POR_REVISAR_EMAILED' } })
    // Literales (EXPLAIN no acepta parámetros): son ids propios, sin comillas.
    const lit = (x: string | null) => {
      if (!x || !/^[\w:-]+$/.test(x)) throw new Error(`literal inesperado: ${x}`)
      return `'${x}'`
    }
    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id FROM "ActivityLog" WHERE entity = ${lit(marca.entity)} AND "entityId" = ${lit(marca.entityId)} AND "venueId" = ${lit(e.venueId)} LIMIT 1`,
    )
    const texto = plan.map(r => r['QUERY PLAN']).join('\n')
    expect(texto).toContain('ActivityLog_entity_entityId_idx')
    expect(texto).not.toContain('Seq Scan')
    expect(await notifyShopifyReview(e.venueId, 1)).toBe(true) // ya salió hoy
    expect(correo).toHaveBeenCalledTimes(1)
  })

  it('I2: un negocio con catálogo maestro omite el barrido y termina el stock en la misma vuelta, sin esperar ni registrar una falla', async () => {
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    const gobierno = jest.fn(async () => {
      throw Object.assign(new Error('El catálogo lo administra el catálogo maestro'), { code: 'CATALOG_GOVERNANCE_REQUIRED' })
    })
    const deps: DepsUnidad = { ...(await depsDeVuelta(e)), upsert: gobierno as never }
    const avisos = jest.spyOn(logger, 'warn')
    avisos.mockClear() // el logger de la integración es compartido entre pruebas
    const rs = await vueltaConElWorker(e, deps)
    expect(gobierno).toHaveBeenCalled() // el barrido sí se intentó
    expect(deps.fetchLevels).toHaveBeenCalled() // y el stock corrió en la misma vuelta
    for (const r of rs) expect(r.ok && !r.esperaMs).toBe(true)
    expect((await sucursal(e)).importError).toBeNull()
    expect((await sucursal(e)).lastReconciledAt).not.toBeNull()
    const fallas = avisos.mock.calls.filter(
      c => String(c[0]).includes(`sucursal ${e.locationLinkId}`) && String(c[0]).includes('vuelve en'),
    )
    expect(fallas).toEqual([]) // ninguna «falló»
  })

  it('M2: la limpieza borra el token cifrado de los intents consumidos, fallidos o vencidos; el de uno vigente se queda', async () => {
    const e = await escenario()
    const intent = (status: 'EXCHANGED' | 'CONSUMED' | 'FAILED', expiresAt: Date) =>
      prisma.shopifyConnectIntent.create({
        data: {
          venueId: e.venueId,
          authUserId: e.staffId,
          shopDomain: e.shopDomain,
          appKey: 'PILOTO',
          status,
          expiresAt,
          tokenCiphertext: Buffer.from('cifrado-de-prueba'),
        },
      })
    const futuro = new Date(Date.now() + 10 * 60_000)
    const vigente = await intent('EXCHANGED', futuro)
    const consumido = await intent('CONSUMED', futuro)
    const fallido = await intent('FAILED', futuro)
    const vencido = await intent('EXCHANGED', new Date(Date.now() - 60_000))
    await limpiarShopify(new Date(), Date.now() + 10_000)
    const token = async (id: string) => (await prisma.shopifyConnectIntent.findUniqueOrThrow({ where: { id } })).tokenCiphertext
    expect(await token(vigente.id)).not.toBeNull()
    expect(await token(consumido.id)).toBeNull()
    expect(await token(fallido.id)).toBeNull()
    expect(await token(vencido.id)).toBeNull()
  })

  it('T5 y S7: la limpieza descarta lo que nunca podrá salir (generación vieja, sin sucursal) y purga los eventos terminales; lo que va en camino no se toca', async () => {
    const e = await escenario({ generation: 2 })
    const hace = (dias: number) => new Date(Date.now() - dias * 24 * 3600_000)
    const fila = (o: { generation: number; status?: 'PENDING' | 'FAILED' | 'IN_PROGRESS'; ambiguous?: boolean; locationLinkId?: string }) =>
      prisma.shopifyStockOutbox.create({
        data: {
          venueId: e.venueId,
          locationLinkId: o.locationLinkId ?? e.locationLinkId,
          generation: o.generation,
          productId: e.productId,
          delta: -1,
          status: o.status ?? 'PENDING',
          ambiguous: o.ambiguous ?? false,
          ...(o.ambiguous ? { sentInventoryItemId: 'gid://shopify/InventoryItem/1', sentLocationId: UBICACION_PRUEBA } : {}),
        },
      })
    const vieja = await fila({ generation: 1 })
    const viejaFallida = await fila({ generation: 1, status: 'FAILED' })
    const huerfana = await fila({ generation: 1, locationLinkId: 'sucursal-que-ya-no-existe' })
    const enDuda = await fila({ generation: 1, status: 'FAILED', ambiguous: true })
    const enVuelo = await fila({ generation: 1, status: 'IN_PROGRESS' })
    const vigente = await fila({ generation: 2 })
    const evento = (o: { status: 'FAILED' | 'SKIPPED'; attemptCount: number; processedAt: Date | null }) =>
      prisma.shopifyInboundEvent.create({
        data: {
          dedupKey: crypto.randomUUID(),
          appKey: 'PILOTO',
          topic: 'orders/create',
          shopDomain: e.shopDomain,
          payload: {},
          receivedAt: hace(40),
          ...o,
        },
      })
    const terminal = await evento({ status: 'FAILED', attemptCount: 10, processedAt: hace(31) })
    const saltado = await evento({ status: 'SKIPPED', attemptCount: 0, processedAt: hace(31) })
    const reintentable = await evento({ status: 'FAILED', attemptCount: 3, processedAt: null })

    await limpiarShopify(new Date(), Date.now() + 10_000)
    const estado = async (id: string) => prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id } })
    expect(await estado(vieja.id)).toMatchObject({ status: 'DISCARDED', lastError: 'GENERACION_VIEJA' })
    expect(await estado(viejaFallida.id)).toMatchObject({ status: 'DISCARDED', lastError: 'GENERACION_VIEJA' })
    expect(await estado(huerfana.id)).toMatchObject({ status: 'DISCARDED', lastError: 'SIN_ENLACE' })
    expect((await estado(vieja.id)).processedAt).not.toBeNull() // a los 30 días lo borra la misma limpieza
    expect(await estado(enDuda.id)).toMatchObject({ status: 'FAILED' })
    expect(await estado(enVuelo.id)).toMatchObject({ status: 'IN_PROGRESS' })
    expect(await estado(vigente.id)).toMatchObject({ status: 'PENDING' })
    expect(await prisma.shopifyInboundEvent.findUnique({ where: { id: terminal.id } })).toBeNull()
    expect(await prisma.shopifyInboundEvent.findUnique({ where: { id: saltado.id } })).toBeNull()
    expect(await prisma.shopifyInboundEvent.findUnique({ where: { id: reintentable.id } })).not.toBeNull()
  })
})

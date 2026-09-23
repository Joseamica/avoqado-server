/**
 * Integration (REAL DB) — Tarea 18 del KDS de Uber (spec §4.2/§4.3): la tienda se RECLAMA en la
 * base antes de llamar a `pos_data`, se finaliza por CAS sobre la versión de revocación, y una
 * revocación (`store.deprovisioned`) siempre gana. Dos negocios nunca terminan con la misma tienda
 * y un consentimiento revocado nunca se vuelve a otorgar en silencio.
 *
 * La red de Uber se sustituye (`pos_data`): nada sale. Las carreras se intercalan de verdad con
 * promesas diferidas, no en secuencia.
 */
import { DeliveryProvider, StaffRole } from '@prisma/client'
import { env } from '@/config/env'
import prisma from '@/utils/prismaClient'
import * as uberHttp from '@/services/delivery-channels/providers/uber-eats/uber.http'
import * as intents from '@/services/delivery-channels/core/deliveryConnectIntent.service'
import * as claims from '@/services/delivery-channels/core/deliveryStoreClaim.service'
import * as adapterRegistry from '@/services/delivery-channels/core/adapterRegistry'
import { pauseChannelLink, updateChannelLink } from '@/services/delivery-channels/core/deliveryChannelLink.service'
import { processUberEvent } from '@/services/delivery-channels/providers/uber-eats/uber.eventProcessor'
import { activarTiendaUber } from '@/controllers/delivery-channels/uber.oauth.controller'

jest.setTimeout(30_000)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OK = { status: 200, json: {}, text: '{}' }

describe('Activación por tienda: reclamar antes del HTTP, finalizar por CAS (Tarea 18)', () => {
  const sufijo = Date.now()
  const tiendas = Array.from({ length: 20 }, (_, i) => `t18-${i}-${sufijo}`)
  let n = 0
  const nuevaTienda = () => tiendas[n++]
  let orgId: string, venueA: string, venueB: string, staffId: string
  const envOriginal: Record<string, unknown> = {}
  let posData: jest.Mock

  const ENV_PRUEBA = {
    UBER_WEBHOOK_SIGNING_KEY: 'llave-de-prueba-t18',
    UBER_ENVIRONMENT: 'SANDBOX',
    UBER_CLIENT_ID_SANDBOX: 'cid-sandbox-t18',
    UBER_CLIENT_SECRET_SANDBOX: 'secreto-sandbox-t18',
    UBER_CLIENT_ID_PRODUCTION: 'cid-prod-t18',
    UBER_CLIENT_SECRET_PRODUCTION: 'secreto-prod-t18',
    UBER_WRITABLE_STORE_IDS_SANDBOX: tiendas.join(','),
    UBER_WRITABLE_STORE_IDS_PRODUCTION: '',
  }

  /** Un intent en ACTIVATING con su selección, como lo deja el POST de la selección. */
  async function activando(venueId: string, seleccion: string[]) {
    const { intent } = await intents.crearIntent({ venueId, staffId })
    expect(
      await intents.casEstado(intent.id, 'CREATED', 'EXCHANGED', {
        storesJson: seleccion.map(id => ({ id, name: `Tienda ${id}` })),
        merchantTokenEnvelope: intents.cifrarTokenComerciante(intent, 'token-del-comerciante'),
      }),
    ).toBe(true)
    expect(await intents.casEstado(intent.id, 'EXCHANGED', 'ACTIVATING', { selectionJson: seleccion })).toBe(true)
    return intent.id
  }
  const activar = (id: string) => intents.activar(id, activarTiendaUber)
  const outcome = (r: intents.ResultadoActivacion, store: string) => ('resultados' in r ? r.resultados[store]?.outcome : r.estado)
  const fila = (id: string) => prisma.deliveryConnectIntent.findUniqueOrThrow({ where: { id } })
  const link = (store: string) =>
    prisma.deliveryChannelLink.findUniqueOrThrow({
      where: { provider_externalLocationId: { provider: DeliveryProvider.UBER_EATS, externalLocationId: store } },
    })
  const resultados = async (id: string) => (await fila(id)).resultsJson as Record<string, Record<string, unknown>>

  /** `store.deprovisioned` por el procesador REAL, como llega el webhook de Uber. */
  async function deprovisionar(store: string) {
    const l = await link(store)
    const eventId = `t18-deprov-${store}-${Date.now()}-${Math.random()}`
    const ev = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: eventId,
        eventType: 'store.deprovisioned',
        payload: { event_id: eventId, event_type: 'store.deprovisioned', meta: { user_id: store, resource_id: store } },
        channelLinkId: l.id,
        venueId: l.venueId,
        dedupKey: `UBER_EATS:${eventId}`,
      },
    })
    expect((await processUberEvent(ev.id)).outcome).toBe('STORE_STATE')
  }

  beforeAll(async () => {
    for (const k of Object.keys(ENV_PRUEBA)) envOriginal[k] = (env as Record<string, unknown>)[k]
    Object.assign(env, ENV_PRUEBA)
    const feature = await prisma.feature.upsert({
      where: { code: 'DELIVERY_CHANNELS' },
      update: {},
      create: { code: 'DELIVERY_CHANNELS', name: 'Delivery', category: 'INTEGRATIONS', monthlyPrice: 0 },
    })
    orgId = (await prisma.organization.create({ data: { name: `Org t18 ${sufijo}`, email: `t18${sufijo}@t.mx`, phone: '5555555555' } })).id
    venueA = (await prisma.venue.create({ data: { organizationId: orgId, name: `V t18 A ${sufijo}`, slug: `v-t18-a-${sufijo}` } })).id
    venueB = (await prisma.venue.create({ data: { organizationId: orgId, name: `V t18 B ${sufijo}`, slug: `v-t18-b-${sufijo}` } })).id
    await prisma.venueFeature.createMany({
      data: [venueA, venueB].map(venueId => ({ venueId, featureId: feature.id, monthlyPrice: 0 })),
    })
    staffId = (await prisma.staff.create({ data: { email: `t18-staff-${sufijo}@t.mx`, firstName: 'Dueño', lastName: 'T18' } })).id
    await prisma.staffVenue.createMany({
      data: [venueA, venueB].map(venueId => ({ staffId, venueId, role: StaffRole.OWNER, active: true })),
    })
  })

  beforeEach(() => {
    posData = jest.fn(async (_store: string) => OK)
    jest
      .spyOn(uberHttp, 'uberRequest')
      .mockImplementation(async (_deps, o) => (o.method === 'GET' ? { status: 200, json: {}, text: '' } : posData(o.storeId as string)))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Object.assign(env, ENV_PRUEBA)
  })

  afterAll(async () => {
    try {
      await prisma.deliveryOrderEvent.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
      await prisma.deliveryConnectIntent.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
      await prisma.activityLog.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
      await prisma.venueFeature.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
    Object.assign(env, envOriginal)
  })

  it('dos intents de venues distintos por la misma tienda ⇒ uno sin HTTP', async () => {
    const store = nuevaTienda()
    const idA = await activando(venueA, [store])
    const idB = await activando(venueB, [store])
    let soltar!: () => void
    const bloqueo = new Promise<void>(r => (soltar = r))
    posData.mockImplementation(async () => {
      await bloqueo
      return OK
    })

    const pA = activar(idA)
    const pB = activar(idB)
    while (posData.mock.calls.length === 0) await sleep(20)
    // El ganador está DENTRO de pos_data con la tienda reclamada; el otro tiene que terminar sin HTTP.
    await Promise.race([pA, pB, sleep(3_000)])
    soltar()
    const [rA, rB] = await Promise.all([pA, pB])

    expect(posData).toHaveBeenCalledTimes(1)
    expect([outcome(rA, store), outcome(rB, store)].sort()).toEqual(['ACTIVATED', 'OTHER_VENUE'])
    const l = await link(store)
    expect(l).toMatchObject({ status: 'ACTIVE', activatingIntentId: null, activationOwner: null })
    expect(l.ownerAuthorizedByIntentId).toBe(outcome(rA, store) === 'ACTIVATED' ? idA : idB)
  })

  it('deprovisioned entre pos_data OK y la finalizacion ⇒ REVOKED_MEANWHILE sin consentimiento', async () => {
    const store = nuevaTienda()
    const id = await activando(venueA, [store])
    posData.mockImplementation(async () => {
      await deprovisionar(store) // Uber revoca mientras nuestro 2xx viene de regreso
      return OK
    })

    const r = await activar(id)

    expect(r.estado).toBe('CONSUMED')
    expect(outcome(r, store)).toBe('REVOKED_MEANWHILE')
    expect(await link(store)).toMatchObject({
      status: 'DISABLED',
      revocationVersion: 1,
      ownerAuthorizedAt: null,
      ownerAuthorizedStoreId: null,
      ownerAuthorizedClientId: null,
      ownerAuthorizedByIntentId: null,
      activatingIntentId: null,
      activationOwner: null,
    })
  })

  it('recuperar el mismo intent tras deprovisioned ⇒ REVOKED_MEANWHILE SIN HTTP (version persistida)', async () => {
    const store = nuevaTienda()
    const id = await activando(venueA, [store])
    // pos_data OK y la escritura local truena: la tienda queda reclamada y sin resultado final.
    jest.spyOn(claims, 'finalizarTienda').mockRejectedValueOnce(new Error('la base se cayó'))
    expect((await activar(id)).estado).toBe('INCOMPLETO')
    expect((await resultados(id))[store]).toMatchObject({ outcome: 'LOCAL_WRITE_FAILED', claimedRevocationVersion: 0 })

    await deprovisionar(store) // Uber revoca ANTES del «Reintentar»

    const r = await activar(id)
    expect(outcome(r, store)).toBe('REVOKED_MEANWHILE')
    expect(posData).toHaveBeenCalledTimes(1) // sólo el primer intento
    expect(await link(store)).toMatchObject({ status: 'DISABLED', ownerAuthorizedAt: null, activatingIntentId: null })
    expect((await fila(id)).state).toBe('CONSUMED')
  })

  it('caida entre pos_data OK y la escritura local ⇒ intent sigue ACTIVATING y el reintento finaliza', async () => {
    const store = nuevaTienda()
    const id = await activando(venueA, [store])
    jest.spyOn(claims, 'finalizarTienda').mockRejectedValueOnce(new Error('la base se cayó'))

    const r1 = await activar(id)
    expect(r1.estado).toBe('INCOMPLETO')
    const f1 = await fila(id)
    expect(f1.state).toBe('ACTIVATING')
    expect(f1.merchantTokenEnvelope).not.toBeNull()
    expect((await link(store)).activatingIntentId).toBe(id)

    const r2 = await activar(id)
    expect(r2.estado).toBe('CONSUMED')
    expect(outcome(r2, store)).toBe('ACTIVATED')
    expect(posData).toHaveBeenCalledTimes(2) // «Reintentar» repite pos_data (idempotente) y finaliza
    expect(await link(store)).toMatchObject({
      venueId: venueA,
      status: 'ACTIVE',
      ownerAuthorizedEnvironment: 'SANDBOX',
      ownerAuthorizedStoreId: store,
      ownerAuthorizedClientId: 'cid-sandbox-t18',
      ownerAuthorizedByIntentId: id,
      activatingIntentId: null,
      activationOwner: null,
    })
    expect((await link(store)).ownerAuthorizedAt).toBeInstanceOf(Date)
    expect((await resultados(id))[store]).toMatchObject({ outcome: 'ACTIVATED', claimedRevocationVersion: 0 })
  })

  it('pos_data fallido ⇒ la reclamacion se libera y un intent NUEVO puede activar', async () => {
    const store = nuevaTienda()
    posData.mockResolvedValueOnce({ status: 500, json: {}, text: 'boom' })
    const id1 = await activando(venueA, [store])
    const r1 = await activar(id1)
    expect(outcome(r1, store)).toBe('POS_DATA_FAILED')
    expect(await link(store)).toMatchObject({ activatingIntentId: null, activationOwner: null, ownerAuthorizedAt: null })

    const id2 = await activando(venueA, [store])
    const r2 = await activar(id2)
    expect(outcome(r2, store)).toBe('ACTIVATED')
    expect((await link(store)).ownerAuthorizedByIntentId).toBe(id2)
  })

  it('intent vencido ⇒ el job libera la reclamacion', async () => {
    const store = nuevaTienda()
    const id1 = await activando(venueA, [store])
    jest.spyOn(claims, 'finalizarTienda').mockRejectedValueOnce(new Error('la base se cayó'))
    expect((await activar(id1)).estado).toBe('INCOMPLETO')
    // Nadie le dio «Reintentar»: la reclamación sigue viva y bloquea a un enlace nuevo.
    const bloqueado = await activando(venueA, [store])
    expect(outcome(await activar(bloqueado), store)).toBe('CLAIMED_BY_OTHER')

    await prisma.deliveryConnectIntent.update({ where: { id: id1 }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const viejo = await activando(venueA, [nuevaTienda()])
    await prisma.deliveryConnectIntent.update({
      where: { id: viejo },
      data: { state: 'FAILED', merchantTokenEnvelope: null, expiresAt: new Date(Date.now() - 8 * 24 * 3_600_000) },
    })

    const r = await claims.limpiarIntents()

    expect(r.vencidos).toBeGreaterThanOrEqual(1)
    expect(r.liberadas).toBeGreaterThanOrEqual(1)
    expect(await fila(id1)).toMatchObject({ state: 'EXPIRED', merchantTokenEnvelope: null, activationOwner: null })
    expect(await link(store)).toMatchObject({ activatingIntentId: null, activationOwner: null })
    expect(await prisma.deliveryConnectIntent.findUnique({ where: { id: viejo } })).toBeNull() // purgado a los 7 días

    const id3 = await activando(venueA, [store])
    expect(outcome(await activar(id3), store)).toBe('ACTIVATED')
  })

  it('la variable de entorno excluyente ⇒ EXCLUDED_BY_ENV sin pos_data', async () => {
    Object.assign(env, { UBER_ENVIRONMENT: 'PRODUCTION', UBER_WRITABLE_STORE_IDS_PRODUCTION: 'otra-tienda-autorizada' })
    const excluida = nuevaTienda()
    const r = await activar(await activando(venueA, [excluida]))
    expect(outcome(r, excluida)).toBe('EXCLUDED_BY_ENV')
    expect(posData).not.toHaveBeenCalled()
    expect(await prisma.deliveryChannelLink.count({ where: { externalLocationId: excluida } })).toBe(0)

    // Vacía en PRODUCTION no restringe: la palomita del dueño es el permiso (intersección, nunca amplía).
    Object.assign(env, { UBER_WRITABLE_STORE_IDS_PRODUCTION: '' })
    const libre = nuevaTienda()
    const id = await activando(venueA, [libre])
    expect(outcome(await activar(id), libre)).toBe('ACTIVATED')
    expect(await link(libre)).toMatchObject({ ownerAuthorizedEnvironment: 'PRODUCTION', ownerAuthorizedClientId: 'cid-prod-t18' })
  })

  it('dueño vencido: B recupera y re-reclama; el 2xx tardío de A no activa, no libera ni escribe', async () => {
    const store = nuevaTienda()
    const id = await activando(venueA, [store])
    let rB: intents.ResultadoActivacion | undefined
    posData.mockImplementationOnce(async () => {
      // A se congela dentro de pos_data más de 2 min: su lease vence y B toma el intent.
      await prisma.deliveryConnectIntent.update({ where: { id }, data: { activationLeaseUntil: new Date(Date.now() - 1_000) } })
      rB = await activar(id)
      return OK // el 2xx de A llega tarde
    })

    const rA = await activar(id)

    expect(rA.estado).toBe('INTERRUMPIDO')
    expect(rB?.estado).toBe('CONSUMED')
    expect(outcome(rB!, store)).toBe('ACTIVATED') // sin REVOKED_MEANWHILE falso
    expect(posData).toHaveBeenCalledTimes(2)
    expect(await link(store)).toMatchObject({ status: 'ACTIVE', ownerAuthorizedByIntentId: id, activatingIntentId: null })
    expect((await resultados(id))[store]).toMatchObject({ outcome: 'ACTIVATED' })
  })

  describe('el vínculo ya conectado', () => {
    async function conectada(conConsentimiento: boolean) {
      const store = nuevaTienda()
      return prisma.deliveryChannelLink.create({
        data: {
          venueId: venueA,
          provider: DeliveryProvider.UBER_EATS,
          externalLocationId: store,
          externalAccountId: 'Cuenta',
          webhookSecret: 'x'.repeat(64),
          status: 'ACTIVE',
          ...(conConsentimiento && {
            ownerAuthorizedAt: new Date(),
            ownerAuthorizedEnvironment: 'SANDBOX',
            ownerAuthorizedStoreId: store,
            ownerAuthorizedClientId: 'cid-sandbox-t18',
          }),
        },
      })
    }

    it('pausa rechazada por Uber revierte a ACTIVE y NO pisa un DISABLED concurrente', async () => {
      const setStoreStatus = jest.fn(async () => ({ ok: false, status: 500, raw: 'no' }))
      jest.spyOn(adapterRegistry, 'adapterFor').mockReturnValue({ setStoreStatus } as never)

      const l1 = await conectada(true)
      await expect(pauseChannelLink(venueA, l1.id, true)).rejects.toMatchObject({ statusCode: 409 })
      expect((await prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id: l1.id } })).status).toBe('ACTIVE')

      const l2 = await conectada(true)
      setStoreStatus.mockImplementationOnce(async () => {
        await deprovisionar(l2.externalLocationId) // Uber revoca mientras la pausa va y viene
        return { ok: false, status: 500, raw: 'no' }
      })
      await expect(pauseChannelLink(venueA, l2.id, true)).rejects.toMatchObject({ statusCode: 409 })
      expect((await prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id: l2.id } })).status).toBe('DISABLED')

      // Y un DISABLED no se pausa: pausarlo y reanudarlo lo resucitaría a ACTIVE.
      const antes = setStoreStatus.mock.calls.length
      await expect(pauseChannelLink(venueA, l2.id, true)).rejects.toMatchObject({ statusCode: 409 })
      expect(setStoreStatus.mock.calls.length).toBe(antes)
      expect((await prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id: l2.id } })).status).toBe('DISABLED')
    })

    it('updateChannelLink con consentimiento ⇒ 409 IDENTITY_LOCKED', async () => {
      const l = await conectada(true)
      await expect(updateChannelLink(venueA, l.id, { externalLocationId: 'otra-tienda' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IDENTITY_LOCKED',
      })
      await expect(updateChannelLink(venueA, l.id, { externalAccountId: 'Otra cuenta' })).rejects.toMatchObject({ code: 'IDENTITY_LOCKED' })
      expect(await prisma.deliveryChannelLink.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({
        externalLocationId: l.externalLocationId,
        externalAccountId: 'Cuenta',
      })
      // Mandar los MISMOS valores (el formulario completo) y cambiar lo demás sí pasa.
      await expect(
        updateChannelLink(venueA, l.id, { externalLocationId: l.externalLocationId, externalAccountId: 'Cuenta', autoSyncMenu: false }),
      ).resolves.toMatchObject({ autoSyncMenu: false })

      // Sin consentimiento (vínculo legacy) sigue editable; de otro venue, 404.
      const legacy = await conectada(false)
      await expect(updateChannelLink(venueA, legacy.id, { externalAccountId: 'Nueva' })).resolves.toMatchObject({
        externalAccountId: 'Nueva',
      })
      await expect(updateChannelLink(venueB, l.id, { externalLocationId: 'x' })).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})

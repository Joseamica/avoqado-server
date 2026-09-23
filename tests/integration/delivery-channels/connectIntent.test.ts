/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 17 del KDS de Uber: la intención de
 * conexión (spec §4.1). Conectar una tienda de Uber al negocio equivocado le desvía pedidos
 * REALES, así que cada paso se revalida y cada transición es un CAS.
 *
 * La red de Uber se sustituye (canje del código, lista de tiendas y `pos_data`): nada sale.
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { env } from '@/config/env'
import prisma from '@/utils/prismaClient'
import * as uberHttp from '@/services/delivery-channels/providers/uber-eats/uber.http'
import * as intents from '@/services/delivery-channels/core/deliveryConnectIntent.service'

jest.setTimeout(30_000)

const OAUTH = '/api/v1/delivery/uber/oauth'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('Intención de conexión de Uber (Tarea 17)', () => {
  const sufijo = Date.now()
  const tiendaA = `t17-a-${sufijo}`
  const tiendaB = `t17-b-${sufijo}`
  const tiendasDeUber = [
    { id: tiendaA, name: 'Sucursal A' },
    { id: tiendaB, name: 'Sucursal B' },
  ]
  let server: Server
  let orgId: string, venueId: string, venueSinPlanId: string, staffId: string, token: string
  let venueFeatureId: string
  const envOriginal: Record<string, unknown> = {}
  let posData: jest.Mock
  let canje: jest.SpyInstance
  let listaDeTiendas = tiendasDeUber

  const ENV_PRUEBA = {
    UBER_WEBHOOK_SIGNING_KEY: 'llave-de-prueba-t17',
    UBER_ENVIRONMENT: 'SANDBOX',
    UBER_CLIENT_ID_SANDBOX: 'cid-sandbox-t17',
    UBER_CLIENT_SECRET_SANDBOX: 'secreto-sandbox-t17',
    UBER_CLIENT_ID_PRODUCTION: 'cid-prod-t17',
    UBER_CLIENT_SECRET_PRODUCTION: 'secreto-prod-t17',
    UBER_WRITABLE_STORE_IDS_SANDBOX: `${tiendaA},${tiendaB}`,
  }

  /** Un intent ya canjeado (EXCHANGED), con sus tiendas y el token cifrado, como lo deja el callback. */
  async function canjeado(tiendas = tiendasDeUber) {
    const { intent } = await intents.crearIntent({ venueId, staffId })
    const ok = await intents.casEstado(intent.id, 'CREATED', 'EXCHANGED', {
      storesJson: tiendas,
      merchantTokenEnvelope: intents.cifrarTokenComerciante(intent, 'token-del-comerciante'),
    })
    expect(ok).toBe(true)
    return intent.id
  }
  async function activando(seleccion: string[]) {
    const id = await canjeado()
    expect(await intents.casEstado(id, 'EXCHANGED', 'ACTIVATING', { selectionJson: seleccion })).toBe(true)
    return id
  }
  const fila = (id: string) => prisma.deliveryConnectIntent.findUniqueOrThrow({ where: { id } })
  const postActivar = (id: string, tiendas: string[]) =>
    request(server)
      .post(`${OAUTH}/activate`)
      .type('form')
      .send({ state2: intents.firmarIntent(id, 'activate'), stores: tiendas })

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))
    for (const k of Object.keys(ENV_PRUEBA)) envOriginal[k] = (env as Record<string, unknown>)[k]
    Object.assign(env, ENV_PRUEBA)

    const feature = await prisma.feature.upsert({
      where: { code: 'DELIVERY_CHANNELS' },
      update: {},
      create: { code: 'DELIVERY_CHANNELS', name: 'Delivery', category: 'INTEGRATIONS', monthlyPrice: 0 },
    })
    orgId = (await prisma.organization.create({ data: { name: `Org t17 ${sufijo}`, email: `t17${sufijo}@t.mx`, phone: '5555555555' } })).id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V t17 ${sufijo}`, slug: `v-t17-${sufijo}` } })).id
    venueSinPlanId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: `V t17 sp ${sufijo}`, slug: `v-t17-sp-${sufijo}` } })
    ).id
    venueFeatureId = (await prisma.venueFeature.create({ data: { venueId, featureId: feature.id, monthlyPrice: 0 } })).id
    staffId = (await prisma.staff.create({ data: { email: `t17-staff-${sufijo}@t.mx`, firstName: 'Dueño', lastName: 'T17' } })).id
    await prisma.staffVenue.createMany({
      data: [
        { staffId, venueId, role: StaffRole.OWNER, active: true },
        { staffId, venueId: venueSinPlanId, role: StaffRole.OWNER, active: true },
      ],
    })
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  beforeEach(() => {
    listaDeTiendas = tiendasDeUber
    posData = jest.fn(async (_storeId: string) => ({ status: 200, json: {}, text: '{}' }))
    canje = jest.spyOn(uberHttp, 'exchangeUberAuthCode').mockResolvedValue({ access_token: 'token-del-comerciante', expires_in: 3600 })
    jest
      .spyOn(uberHttp, 'uberRequest')
      .mockImplementation(async (_deps, o) =>
        o.method === 'GET' ? { status: 200, json: { stores: listaDeTiendas }, text: '' } : posData(o.storeId as string),
      )
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    Object.assign(env, ENV_PRUEBA)
    await prisma.staffVenue.updateMany({ where: { staffId }, data: { active: true } })
    await prisma.venueFeature.update({ where: { id: venueFeatureId }, data: { endDate: null } })
  })

  afterAll(async () => {
    try {
      await prisma.deliveryConnectIntent.deleteMany({ where: { venueId: { in: [venueId, venueSinPlanId] } } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.deliveryChannelLink.deleteMany({ where: { venueId } })
      await prisma.venueFeature.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: { in: [venueId, venueSinPlanId] } } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
    Object.assign(env, envOriginal)
    await new Promise<void>(listo => server.close(() => listo()))
  })

  it('/oauth/start RECHAZA un venueId crudo', async () => {
    const res = await request(server).get(`${OAUTH}/start?venueId=${venueId}`)
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })

  it('/oauth/start exige la firma de SU propósito: alterada o de otro propósito ⇒ 400', async () => {
    const { intent, firmado } = await intents.crearIntent({ venueId, staffId })
    const alterado = firmado.slice(0, -1) + (firmado.endsWith('A') ? 'B' : 'A')
    expect((await request(server).get(`${OAUTH}/start?intent=${alterado}`)).status).toBe(400)
    expect((await request(server).get(`${OAUTH}/start?intent=${intents.firmarIntent(intent.id, 'activate')}`)).status).toBe(400)

    const ok = await request(server).get(`${OAUTH}/start?intent=${firmado}`)
    expect(ok.status).toBe(302)
    const state = new URL(ok.headers.location).searchParams.get('state')
    expect(intents.leerFirma(state, 'callback')).toBe(intent.id)
  })

  it('connect-url exige checkFeatureAccess(DELIVERY_CHANNELS)', async () => {
    const sinPlan = await request(server)
      .get(`/api/v1/delivery-channels/venues/${venueSinPlanId}/channels/uber/connect-url`)
      .set('Authorization', `Bearer ${token}`)
    expect({ status: sinPlan.status, code: sinPlan.body.code }).toEqual({ status: 403, code: 'PLAN_REQUIRED' })
    expect(await prisma.deliveryConnectIntent.count({ where: { venueId: venueSinPlanId } })).toBe(0)

    const conPlan = await request(server)
      .get(`/api/v1/delivery-channels/venues/${venueId}/channels/uber/connect-url`)
      .set('Authorization', `Bearer ${token}`)
    expect(conPlan.status).toBe(200)
    const url = new URL(conPlan.body.url)
    expect(url.searchParams.get('venueId')).toBeNull()
    const id = intents.leerFirma(url.searchParams.get('intent'), 'start')
    expect(await fila(id as string)).toMatchObject({ venueId, staffId, state: 'CREATED', clientId: 'cid-sandbox-t17' })
  })

  it('replay del callback ⇒ "ya se usó o venció", sin canjear el código', async () => {
    listaDeTiendas = [tiendasDeUber[0]]
    const { intent, firmado } = await intents.crearIntent({ venueId, staffId })
    const inicio = await request(server).get(`${OAUTH}/start?intent=${firmado}`)
    const state = new URL(inicio.headers.location).searchParams.get('state') as string

    const primero = await request(server).get(`${OAUTH}/callback`).query({ code: 'codigo-1', state })
    expect(primero.status).toBe(200)
    expect(posData).toHaveBeenCalledTimes(1)
    expect(await fila(intent.id)).toMatchObject({ state: 'CONSUMED', merchantTokenEnvelope: null })

    const replay = await request(server).get(`${OAUTH}/callback`).query({ code: 'codigo-1', state })
    expect(replay.status).toBe(400)
    expect(replay.text).toContain('ya se usó o venció')
    expect(canje).toHaveBeenCalledTimes(1)
    expect(posData).toHaveBeenCalledTimes(1)
  })

  it('empleado dado de baja entre emitir y activar ⇒ FAILED, cero activaciones', async () => {
    const id = await canjeado()
    await prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: false } })
    const res = await postActivar(id, [tiendaA])
    expect(res.status).toBe(403)
    expect(await fila(id)).toMatchObject({ state: 'FAILED', failureReason: 'STAFF_NOT_AUTHORIZED', merchantTokenEnvelope: null })
    expect(posData).not.toHaveBeenCalled()
  })

  it('plan vencido entre emitir y activar ⇒ FAILED, cero activaciones', async () => {
    const id = await canjeado()
    await prisma.venueFeature.update({ where: { id: venueFeatureId }, data: { endDate: new Date(Date.now() - 60_000) } })
    const res = await postActivar(id, [tiendaA])
    expect(res.status).toBe(403)
    expect(await fila(id)).toMatchObject({ state: 'FAILED', failureReason: 'PLAN_REQUIRED', merchantTokenEnvelope: null })
    expect(posData).not.toHaveBeenCalled()
  })

  it('UBER_CLIENT_ID_PRODUCTION distinto al del intent ⇒ FAILED', async () => {
    Object.assign(env, { UBER_ENVIRONMENT: 'PRODUCTION' })
    const id = await canjeado()
    expect((await fila(id)).clientId).toBe('cid-prod-t17')
    Object.assign(env, { UBER_CLIENT_ID_PRODUCTION: 'otra-app-de-uber' })
    const res = await postActivar(id, [tiendaA])
    expect(res.status).toBe(403)
    expect(await fila(id)).toMatchObject({ state: 'FAILED', failureReason: 'CLIENT_ID_CHANGED', merchantTokenEnvelope: null })
    expect(posData).not.toHaveBeenCalled()
  })

  it('dos POST de activate en vuelo ⇒ el segundo recibe "en curso" (lease)', async () => {
    const id = await canjeado()
    let soltar!: () => void
    const bloqueo = new Promise<void>(r => (soltar = r))
    posData.mockImplementation(async () => {
      await bloqueo
      return { status: 200, json: {}, text: '{}' }
    })

    const primero = postActivar(id, [tiendaA]).then(r => r)
    while (posData.mock.calls.length === 0) await sleep(20)

    const segundo = await postActivar(id, [tiendaA])
    expect(segundo.status).toBe(409)
    expect(segundo.text).toContain('en curso')

    soltar()
    expect((await primero).status).toBe(200)
    expect(await fila(id)).toMatchObject({ state: 'CONSUMED', activationAttempt: 1 })
    expect(posData).toHaveBeenCalledTimes(1)
  })

  it('una selección fuera de storesJson se rechaza sin tocar el intent', async () => {
    const id = await canjeado()
    const res = await postActivar(id, [tiendaA, 'tienda-ajena'])
    expect(res.status).toBe(400)
    expect(await fila(id)).toMatchObject({ state: 'EXCHANGED', selectionJson: null })
    expect(posData).not.toHaveBeenCalled()
  })

  it.each([
    ['otra ejecución lo recuperó', true],
    ['nadie lo recuperó, sólo venció', false],
  ])('un dueño VENCIDO no escribe resultsJson ni CONSUMED (%s)', async (_caso, recuperado) => {
    const id = await activando([tiendaA])
    let ownerB: string | null = null
    const r = await intents.activar(id, async () => {
      // A trabaja más de 2 min: su lease vence y (a veces) B toma el intent.
      await prisma.deliveryConnectIntent.update({ where: { id }, data: { activationLeaseUntil: new Date(Date.now() - 1_000) } })
      if (recuperado) ownerB = await intents.tomarLeaseDeActivacion(id)
      return { outcome: 'ACTIVATED' } // el 2xx tardío de A
    })
    expect(r.estado).toBe('INTERRUMPIDO')
    const f = await fila(id)
    expect(f).toMatchObject({ state: 'ACTIVATING', resultsJson: null })
    expect(f.merchantTokenEnvelope).not.toBeNull()
    if (recuperado) expect(f.activationOwner).toBe(ownerB)
  })

  it('el sobre del token se descifra con IV y AAD correctos; llave rotada ⇒ FAILED sin activar', async () => {
    const id = await activando([tiendaA])
    const f = await fila(id)
    const [v, iv, tag, ct] = (f.merchantTokenEnvelope as string).split(':')
    expect(v).toBe('v1')
    expect(Buffer.from(iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(tag, 'base64')).toHaveLength(16)
    expect(ct.length).toBeGreaterThan(0)
    expect(f.merchantTokenEnvelope).not.toContain('token-del-comerciante')
    expect(intents.descifrarTokenComerciante(f)).toBe('token-del-comerciante')
    expect(intents.descifrarTokenComerciante({ ...f, venueId: venueSinPlanId })).toBeNull() // AAD

    Object.assign(env, { UBER_WEBHOOK_SIGNING_KEY: 'llave-rotada' })
    const tienda = jest.fn()
    const r = await intents.activar(id, tienda)
    expect(r).toEqual({ estado: 'FAILED', motivo: 'TOKEN_UNREADABLE' })
    expect(tienda).not.toHaveBeenCalled()
    expect(await fila(id)).toMatchObject({ state: 'FAILED', merchantTokenEnvelope: null, activationOwner: null })
  })

  it('tras CONSUMED el token queda en null', async () => {
    const id = await canjeado()
    const res = await postActivar(id, [tiendaB])
    expect(res.status).toBe(200)
    const f = await fila(id)
    expect(f).toMatchObject({
      state: 'CONSUMED',
      merchantTokenEnvelope: null,
      activationOwner: null,
      activationLeaseUntil: null,
      selectionJson: [tiendaB],
    })
    expect(Object.keys(f.resultsJson as object)).toEqual([tiendaB])
    expect(posData.mock.calls).toEqual([[tiendaB]])
  })
})

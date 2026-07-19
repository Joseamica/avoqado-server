import nock from 'nock'

/**
 * `deliverect.client.ts` es una frontera HTTP credential-gated (sin credenciales reales
 * de staging todavía) — por eso el resto de la suite (`statusDispatcher.test.ts`) lo
 * mockea completo. Este archivo SÍ ejercita el client real contra `nock` para fijar el
 * contrato exacto (path + body) que la auditoría (Codex, doc pública) documentó — son
 * el checklist de "esto debe pegarle a esta URL con este body" a revalidar en staging.
 *
 * `DELIVERECT_API_URL` ya viene seteado por tests/__helpers__/setup.ts
 * (https://api.staging.deliverect.com) ANTES de este import — el módulo arma su
 * instancia de axios (`http = axios.create({ baseURL: ... })`) en el top-level.
 */
import { deliverectClient, DeliverectApiError } from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.client'

const BASE = 'https://api.staging.deliverect.com'

beforeAll(() => {
  // Una suite previa de nock en este worker de Jest puede haber llamado nock.restore().
  if (!nock.isActive()) nock.activate()
  nock.disableNetConnect()
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
  nock.restore()
})
afterEach(() => nock.cleanAll())

/** Todas las llamadas del client pasan primero por getToken() → POST /oauth/token. */
function mockToken() {
  nock(BASE).post('/oauth/token').reply(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 })
}

describe('deliverectClient.postOrderStatus (Fix C2, spec §10.1.6)', () => {
  it('pega a POST /orderStatus/{externalId} (endpoint documentado, NO /orders/{id}/status)', async () => {
    mockToken()
    const scope = nock(BASE).post('/orderStatus/EXT-123', { status: 50 }).reply(200, {})

    await deliverectClient.postOrderStatus('EXT-123', 50)

    expect(scope.isDone()).toBe(true)
  })

  it('NO pega al path viejo /orders/{id}/status', async () => {
    mockToken()
    // Solo interceptamos el path nuevo — si el código todavía pegara al viejo, nock
    // dejaría la petición sin match y axios lanzaría ECONNREFUSED/"disallowed net connect".
    nock(BASE).post('/orderStatus/EXT-123').reply(200, {})

    await expect(deliverectClient.postOrderStatus('EXT-123', 50)).resolves.toBeUndefined()
  })

  it('propaga DeliverectApiError con status+body si el provider responde error', async () => {
    mockToken()
    nock(BASE).post('/orderStatus/EXT-123').reply(422, { message: 'unknown order' })

    let caught: unknown
    try {
      await deliverectClient.postOrderStatus('EXT-123', 50)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(DeliverectApiError)
    expect((caught as InstanceType<typeof DeliverectApiError>).status).toBe(422)
  })
})

describe('deliverectClient.setBusyMode (Fix C3, spec §10.1.7)', () => {
  it('paused:true → POST /updateStoreStatus/{locationId} con { isActive: false } (inverso, NO /locations/{id}/busy)', async () => {
    mockToken()
    const scope = nock(BASE).post('/updateStoreStatus/loc-1', { isActive: false }).reply(200, {})

    await deliverectClient.setBusyMode('loc-1', true)

    expect(scope.isDone()).toBe(true)
  })

  it('paused:false → { isActive: true } (sigue siendo el inverso)', async () => {
    mockToken()
    const scope = nock(BASE).post('/updateStoreStatus/loc-1', { isActive: true }).reply(200, {})

    await deliverectClient.setBusyMode('loc-1', false)

    expect(scope.isDone()).toBe(true)
  })

  it('error del provider → SIEMPRE propaga (nunca se traga en el client — la capa de arriba decide)', async () => {
    mockToken()
    nock(BASE).post('/updateStoreStatus/loc-1').reply(503, { message: 'provider down' })

    let caught: unknown
    try {
      await deliverectClient.setBusyMode('loc-1', true)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(DeliverectApiError)
    expect((caught as InstanceType<typeof DeliverectApiError>).status).toBe(503)
  })
})

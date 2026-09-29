/**
 * El CABLEADO del self-onboarding en `rappi.client.ts`: que el cuerpo con `cancellation_events`, los dos
 * headers, el host alterno y el candado POR TIENDA lleguen de verdad a la petición.
 *
 * Las piezas puras (`cuerpoAprovisionamiento`, `leerRespuestaAprovisionamiento`, `llamarRappi`) ya tienen sus
 * pruebas; esto cubre lo único que ellas no ven: que el cliente las use. El cliente importa `@/config/env`
 * (que hace `process.exit` bajo Jest), así que aquí el env se sustituye por un objeto.
 */
const mockEnv: Record<string, string | undefined> = {
  RAPPI_ENVIRONMENT: 'SANDBOX',
  RAPPI_COUNTRY: 'MX',
  RAPPI_CLIENT_ID_SANDBOX: 'cid',
  RAPPI_CLIENT_SECRET_SANDBOX: 'csecret',
  RAPPI_WRITABLE_STORE_IDS_SANDBOX: '10,11',
  RAPPI_WEBHOOK_BASE_URL: 'https://api.ejemplo.test',
}
jest.mock('@/config/env', () => ({ env: mockEnv }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import {
  apiBaseSelfOnboarding,
  aprovisionarTiendasRappi,
  suscribirTiendaAEventos,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'
import { RappiEscrituraBloqueadaError } from '../../../../src/services/delivery-channels/providers/rappi/rappi.http'
import { _resetRappiTokenCacheForTests } from '../../../../src/services/delivery-channels/providers/rappi/rappi.token'

type Llamada = { url: string; init: RequestInit }

function json(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response
}

/** El login de Rappi contesta el token; todo lo demás se guarda en `llamadas` y se contesta con `responder`. */
function simularRed(responder: (llamada: Llamada) => Response = () => json(202)) {
  const llamadas: Llamada[] = []
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/auth/v1/token/login/')) return json(200, { access_token: 'tok-integ', expires_in: 3600 })
    const llamada = { url: String(url), init: init ?? {} }
    llamadas.push(llamada)
    return responder(llamada)
  }) as unknown as typeof fetch
  return llamadas
}

const tiendas = [
  { storeId: '10', name: 'Sucursal Centro' },
  { storeId: '11', name: 'Sucursal Norte' },
]

describe('rappi.client — self-onboarding', () => {
  beforeEach(() => {
    _resetRappiTokenCacheForTests()
    mockEnv.RAPPI_ENVIRONMENT = 'SANDBOX'
    mockEnv.RAPPI_SELF_ONBOARDING_API_BASE = undefined
    mockEnv.RAPPI_WRITABLE_STORE_IDS_SANDBOX = '10,11'
  })

  it('aprovisionar: host del self-onboarding, dos headers y el cuerpo con cancellation_events (R1, R2)', async () => {
    const llamadas = simularRed(() => json(202, { batch_id: 'b1', accepted: [{ store_id: '10', integration_id: 'i10' }], rejected: [] }))

    const r = await aprovisionarTiendasRappi('idt', tiendas)

    expect(llamadas).toHaveLength(1)
    expect(llamadas[0].url).toBe('https://api.dev.rappi.com/api/v2/restaurants-integrations-public-api/stores/provisioning')
    expect(llamadas[0].init.headers).toMatchObject({ 'x-authorization': 'Bearer tok-integ', 'Authorization-Partners': 'Bearer idt' })
    expect(JSON.parse(llamadas[0].init.body as string).stores).toEqual([
      { store_id: '10', name: 'Sucursal Centro', status: 'ACTIVE', store_integration_id: '10', cancellation_events: true },
      { store_id: '11', name: 'Sucursal Norte', status: 'ACTIVE', store_integration_id: '11', cancellation_events: true },
    ])
    // R6: la que Rappi no nombró queda incierta, no rechazada.
    expect(r).toEqual({ batchId: 'b1', aceptadas: [{ storeId: '10', integrationId: 'i10' }], rechazadas: [], inciertas: ['11'] })
  })

  it('🔴 aprovisionar: una tienda fuera de la lista y NO sale ninguna petición al host de Rappi', async () => {
    mockEnv.RAPPI_WRITABLE_STORE_IDS_SANDBOX = '10'
    const llamadas = simularRed()

    await expect(aprovisionarTiendasRappi('idt', tiendas)).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(llamadas).toHaveLength(0)
  })

  it('el host de México no se inventa: en PRODUCTION sin RAPPI_SELF_ONBOARDING_API_BASE se niega', () => {
    mockEnv.RAPPI_ENVIRONMENT = 'PRODUCTION'
    expect(() => apiBaseSelfOnboarding()).toThrow(/RAPPI_SELF_ONBOARDING_API_BASE/)
    mockEnv.RAPPI_SELF_ONBOARDING_API_BASE = 'https://host.ejemplo.test'
    expect(apiBaseSelfOnboarding()).toBe('https://host.ejemplo.test')
  })

  it('suscribir: un PUT por evento de tienda (nunca el de aprovisionamiento) y reporta cuáles fallaron', async () => {
    const llamadas = simularRed(l => (l.url.includes('/webhook/NEW_ORDER/') ? json(500) : json(200)))

    const r = await suscribirTiendaAEventos('10')

    expect(llamadas.every(l => l.init.method === 'PUT')).toBe(true)
    expect(llamadas.map(l => l.url).join('\n')).not.toContain('STORE_PROVISIONING_STATUS')
    const nueva = llamadas.find(l => l.url.includes('/webhook/NEW_ORDER/add-stores'))
    expect(JSON.parse(nueva?.init.body as string)).toEqual([
      { url: 'https://api.ejemplo.test/api/v1/webhooks/delivery/rappi/new-order', stores: ['10'] },
    ])
    expect(r).toEqual({ ok: false, fallidos: ['NEW_ORDER'] })
  })

  it('🔴 suscribir: también pasa por el candado — tienda fuera de la lista, ninguna petición', async () => {
    const llamadas = simularRed()
    await expect(suscribirTiendaAEventos('99')).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(llamadas).toHaveLength(0)
  })
})

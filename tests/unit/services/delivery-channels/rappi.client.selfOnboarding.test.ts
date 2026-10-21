/**
 * El CABLEADO del self-onboarding en `rappi.client.ts`: que el cuerpo con `cancellation_events`, los dos
 * headers, el host alterno y el candado POR TIENDA lleguen de verdad a la petición.
 *
 * Las piezas puras (`cuerpoAprovisionamiento`, `leerRespuestaAprovisionamiento`, `llamarRappi`) ya tienen sus
 * pruebas; esto cubre lo único que ellas no ven: que el cliente las use. El cliente importa `@/config/env`
 * (que hace `process.exit` bajo Jest), así que aquí el env se sustituye por un objeto.
 */
/** Los ONCE webhooks, escritos a mano: cada uno necesita su secreto o nuestro endpoint le contesta 401. */
const TODOS_LOS_EVENTOS = [
  'NEW_ORDER',
  'NEW_ORDER_SCHEDULED',
  'NEW_ORDER_SCHEDULED_CANCELLED',
  'ORDER_EVENT_CANCEL',
  'ORDER_OTHER_EVENT',
  'MENU_APPROVED',
  'MENU_REJECTED',
  'PING',
  'STORE_CONNECTIVITY',
  'ORDER_RT_TRACKING',
  'STORE_PROVISIONING_STATUS',
]
const secretos = (sin: string[] = []) =>
  JSON.stringify(Object.fromEntries(TODOS_LOS_EVENTOS.filter(e => !sin.includes(e)).map(e => [e, `secreto-${e}`])))
const mockEnv: Record<string, string | undefined> = {
  RAPPI_ENVIRONMENT: 'SANDBOX',
  RAPPI_COUNTRY: 'MX',
  RAPPI_CLIENT_ID_SANDBOX: 'cid',
  RAPPI_CLIENT_SECRET_SANDBOX: 'csecret',
  RAPPI_WRITABLE_STORE_IDS_SANDBOX: '10,11',
  RAPPI_WEBHOOK_BASE_URL: 'https://api.ejemplo.test',
  RAPPI_OAUTH_REDIRECT_BASE: 'https://api.ejemplo.test',
}
const envBase = { ...mockEnv }
jest.mock('@/config/env', () => ({ env: mockEnv }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import {
  apiBaseSelfOnboarding,
  aprovisionarTiendasRappi,
  canjearCodigoRappi,
  clientIdRappi,
  preflightSelfOnboardingRappi,
  rappiApi,
  redirectUriRappi,
  suscribirTiendaAEventos,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.client'
import { urlDeInicio } from '../../../../src/services/delivery-channels/providers/rappi/rappi.selfOnboarding'
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
    mockEnv.RAPPI_WEBHOOK_BASE_URL = 'https://api.ejemplo.test'
    mockEnv.RAPPI_OAUTH_REDIRECT_BASE = 'https://api.ejemplo.test'
    mockEnv.RAPPI_WEBHOOK_SECRETS = secretos()
    mockEnv.RAPPI_SELF_ONBOARDING_CLIENT_ID_SANDBOX = 'so-cid'
  })

  // Ninguna prueba hereda llaves de otra (las de PRODUCTION de abajo no deben quedarse en el objeto compartido).
  afterEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k]
    Object.assign(mockEnv, envBase)
  })

  // 14-oct: al activar Self Onboarding, Rappi crea OTRA aplicación (la del login del dueño) con su propio Client ID,
  // distinto al de la integración. Con el de la integración, su login rechaza al dueño.
  describe('client id del login del dueño', () => {
    it('🔴 el canje del código usa el Client ID del Self Onboarding, no el de la integración', async () => {
      const idToken = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.e30.firma`
      const llamadas = simularRed(() => json(200, { id_token: idToken }))

      expect(clientIdRappi()).toBe('so-cid')
      await canjearCodigoRappi('code', 'verifier')

      expect(new URLSearchParams(llamadas[0].init.body as string).get('client_id')).toBe('so-cid')
    })

    it('sin la variable ⇒ Error claro (nunca cae al Client ID de la integración)', () => {
      mockEnv.RAPPI_SELF_ONBOARDING_CLIENT_ID_SANDBOX = undefined
      expect(() => clientIdRappi()).toThrow(/RAPPI_SELF_ONBOARDING_CLIENT_ID_SANDBOX/)
    })

    it('en PRODUCTION el canje usa RAPPI_SELF_ONBOARDING_CLIENT_ID_PRODUCTION', () => {
      Object.assign(mockEnv, {
        RAPPI_ENVIRONMENT: 'PRODUCTION',
        RAPPI_SELF_ONBOARDING_CLIENT_ID_PRODUCTION: 'so-prod',
        RAPPI_CLIENT_ID_PRODUCTION: 'int-prod',
      })
      expect(clientIdRappi()).toBe('so-prod')
    })
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

  // H3: el login del integrador, el canje OAuth y la API — ninguna llamada a Rappi espera para siempre.
  it('🔴 toda llamada a Rappi lleva timeout: login, canje del código y la API', async () => {
    const idToken = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.e30.firma`
    const senales: Array<[string, unknown]> = []
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      senales.push([String(url), init?.signal])
      if (String(url).includes('/auth/v1/token/login/')) return json(200, { access_token: 'tok-integ', expires_in: 3600 })
      if (String(url).endsWith('/oauth/token')) return json(200, { id_token: idToken })
      return json(202, {})
    }) as unknown as typeof fetch

    await aprovisionarTiendasRappi('idt', tiendas)
    expect(await canjearCodigoRappi('code', 'verifier')).toBe(idToken)

    expect(senales.map(([u]) => u)).toEqual([
      expect.stringContaining('/auth/v1/token/login/'),
      expect.stringContaining('/stores/provisioning'),
      expect.stringContaining('/oauth/token'),
    ])
    for (const [, senal] of senales) expect(senal).toBeInstanceOf(AbortSignal)
  })

  it('🔴 aprovisionar: una tienda fuera de la lista y NO sale ninguna petición al host de Rappi', async () => {
    mockEnv.RAPPI_WRITABLE_STORE_IDS_SANDBOX = '10'
    const llamadas = simularRed()

    await expect(aprovisionarTiendasRappi('idt', tiendas)).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(llamadas).toHaveLength(0)
  })

  // T5 (20-oct): Rappi ya publicó el host de México para el self-onboarding; la variable sólo lo sustituye.
  it('el host del self-onboarding en PRODUCTION es el publicado (https://api.rappi.com.mx) si no hay variable', () => {
    mockEnv.RAPPI_ENVIRONMENT = 'PRODUCTION'
    expect(apiBaseSelfOnboarding()).toBe('https://api.rappi.com.mx')
    mockEnv.RAPPI_SELF_ONBOARDING_API_BASE = 'https://host.ejemplo.test'
    expect(apiBaseSelfOnboarding()).toBe('https://host.ejemplo.test')
  })

  it('el host del self-onboarding en SANDBOX sigue siendo api.dev.rappi.com', () => {
    expect(apiBaseSelfOnboarding()).toBe('https://api.dev.rappi.com')
  })

  it('🔴 PRODUCTION con un país que no es México y sin variable: se niega (no cae al host de México)', () => {
    mockEnv.RAPPI_ENVIRONMENT = 'PRODUCTION'
    mockEnv.RAPPI_COUNTRY = 'CO'
    expect(() => apiBaseSelfOnboarding()).toThrow(/país/i)
  })

  // T5 (20-oct): el login se mudó al dominio nuevo y exige la barra final (sin ella: 307 a la ruta con `/`, medido el 20-oct).
  // La API NO se mudó: sigue en el host clásico.
  describe('hosts de Rappi: login en el dominio nuevo, API en el clásico', () => {
    /** TODAS las URLs que salen (login incluido), en orden. El login contesta el token; lo demás, 200. */
    function capturarFetch(): string[] {
      const urls: string[] = []
      global.fetch = jest.fn(async (url: string | URL | Request) => {
        urls.push(String(url))
        return String(url).includes('/auth/v1/token/login/') ? json(200, { access_token: 'tok', expires_in: 3600 }) : json(200, {})
      }) as unknown as typeof fetch
      return urls
    }

    it('🔴 el login va al dominio nuevo y CON barra final', async () => {
      const urls = capturarFetch()
      await rappiApi({ metodo: 'GET', ruta: '/api/v2/restaurants-integrations-public-api/stores-pa' })
      expect(urls[0]).toBe('https://api.dev.rappi.com/restaurants/auth/v1/token/login/integrations/')
      expect(urls[1]).toMatch(/^https:\/\/microservices\.dev\.rappi\.com\/api\/v2\//)
      expect(urls).toHaveLength(2)
    })

    it('la API de Utils pide su propio login (…/token/login/utils/) y llama en el host clásico', async () => {
      const urls = capturarFetch()
      await rappiApi({ superficie: 'utils', metodo: 'GET', ruta: '/api/rest-ops-utils/schedules' })
      expect(urls).toEqual([
        'https://api.dev.rappi.com/restaurants/auth/v1/token/login/utils/',
        'https://microservices.dev.rappi.com/api/rest-ops-utils/schedules',
      ])
    })

    it('PRODUCTION México: login en api.rappi.com.mx (con barra) y la API en el host clásico de México', async () => {
      Object.assign(mockEnv, {
        RAPPI_ENVIRONMENT: 'PRODUCTION',
        RAPPI_CLIENT_ID_PRODUCTION: 'int-prod',
        RAPPI_CLIENT_SECRET_PRODUCTION: 'int-prod-secret',
      })
      const urls = capturarFetch()
      await rappiApi({ metodo: 'GET', ruta: '/api/v2/restaurants-integrations-public-api/orders' })
      expect(urls).toEqual([
        'https://api.rappi.com.mx/restaurants/auth/v1/token/login/integrations/',
        'https://services.mxgrability.rappi.com/api/v2/restaurants-integrations-public-api/orders',
      ])
    })

    it('🔴 PRODUCTION con otro país: el login se niega y NO sale ninguna petición', async () => {
      Object.assign(mockEnv, {
        RAPPI_ENVIRONMENT: 'PRODUCTION',
        RAPPI_COUNTRY: 'CO',
        RAPPI_CLIENT_ID_PRODUCTION: 'int-prod',
        RAPPI_CLIENT_SECRET_PRODUCTION: 'int-prod-secret',
      })
      const urls = capturarFetch()
      await expect(rappiApi({ metodo: 'GET', ruta: '/api/v2/restaurants-integrations-public-api/orders' })).rejects.toThrow(/país/i)
      expect(urls).toHaveLength(0)
    })
  })

  // H11: la lista esperada va escrita a MANO, no derivada del código: si alguien quita un webhook del filtro de
  // suscripción, esta prueba tiene que caer (derivándola de la implementación, seguía verde).
  const SUSCRIPCIONES = [
    ['NEW_ORDER', 'new-order'],
    ['NEW_ORDER_SCHEDULED', 'new-order-scheduled'],
    ['NEW_ORDER_SCHEDULED_CANCELLED', 'new-order-scheduled-cancelled'],
    ['ORDER_EVENT_CANCEL', 'order-cancel'],
    ['ORDER_OTHER_EVENT', 'order-other'],
    ['MENU_APPROVED', 'menu-approved'],
    ['MENU_REJECTED', 'menu-rejected'],
    ['PING', 'ping'],
    ['STORE_CONNECTIVITY', 'store-connectivity'],
    ['ORDER_RT_TRACKING', 'order-tracking'],
  ].map(([evento, segmento]) => ({
    metodo: 'PUT',
    url: `https://microservices.dev.rappi.com/api/v2/restaurants-integrations-public-api/webhook/${evento}/add-stores`,
    cuerpo: [{ url: `https://api.ejemplo.test/api/v1/webhooks/delivery/rappi/${segmento}`, stores: ['10'] }],
  }))
  const porUrl = <T extends { url: string }>(xs: T[]) => [...xs].sort((a, b) => a.url.localeCompare(b.url))

  it('suscribir: EXACTAMENTE los diez webhooks de tienda (nunca el de aprovisionamiento), y reporta cuáles fallaron', async () => {
    const llamadas = simularRed(l => (l.url.includes('/webhook/NEW_ORDER/') ? json(500) : json(200)))

    const r = await suscribirTiendaAEventos('10')

    const hechas = llamadas.map(l => ({ metodo: l.init.method, url: l.url, cuerpo: JSON.parse(l.init.body as string) }))
    expect(porUrl(hechas)).toEqual(porUrl(SUSCRIPCIONES))
    expect(r).toEqual({ ok: false, fallidos: ['NEW_ORDER'] })
  })

  it('🔴 suscribir: también pasa por el candado — tienda fuera de la lista, ninguna petición', async () => {
    const llamadas = simularRed()
    await expect(suscribirTiendaAEventos('99')).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(llamadas).toHaveLength(0)
  })

  // ── Las variables de una función OPCIONAL no tumban el proceso: se validan al usarse ─────────────────
  describe('bases configurables (se validan en el punto de uso, con la barra final quitada)', () => {
    it('redirect_uri: las barras finales NO producen `//` (no coincidiría con la registrada en Rappi)', () => {
      mockEnv.RAPPI_OAUTH_REDIRECT_BASE = 'https://api.ejemplo.test///'
      expect(redirectUriRappi()).toBe('https://api.ejemplo.test/api/v1/delivery/rappi/oauth/callback')
    })

    it.each([['no-es-una-url'], ['ftp://api.ejemplo.test'], ['   '], ['https://']])(
      'redirect_uri: %j no es una URL http(s) válida ⇒ Error claro, no un `undefined/api/...`',
      malo => {
        mockEnv.RAPPI_OAUTH_REDIRECT_BASE = malo
        expect(() => redirectUriRappi()).toThrow(/RAPPI_OAUTH_REDIRECT_BASE.*http\(s\)/)
      },
    )

    it('redirect_uri: sin la variable ⇒ Error claro', () => {
      mockEnv.RAPPI_OAUTH_REDIRECT_BASE = undefined
      expect(() => redirectUriRappi()).toThrow(/Falta RAPPI_OAUTH_REDIRECT_BASE/)
    })

    it('host del self-onboarding: la barra final se quita y el provisioning no sale con `//`', async () => {
      mockEnv.RAPPI_SELF_ONBOARDING_API_BASE = 'https://host.ejemplo.test/'
      expect(apiBaseSelfOnboarding()).toBe('https://host.ejemplo.test')
      const llamadas = simularRed()
      await aprovisionarTiendasRappi('idt', tiendas)
      expect(llamadas[0].url).toBe('https://host.ejemplo.test/api/v2/restaurants-integrations-public-api/stores/provisioning')
    })

    it('host del self-onboarding: uno MAL escrito se niega también en SANDBOX (no cae en silencio al de pruebas)', () => {
      mockEnv.RAPPI_SELF_ONBOARDING_API_BASE = 'host.ejemplo.test'
      expect(() => apiBaseSelfOnboarding()).toThrow(/RAPPI_SELF_ONBOARDING_API_BASE.*http\(s\)/)
    })

    it('suscribir: la barra final de la base pública no produce `//` en la URL que recibe Rappi', async () => {
      mockEnv.RAPPI_WEBHOOK_BASE_URL = 'https://api.ejemplo.test//'
      const llamadas = simularRed(() => json(200))
      await suscribirTiendaAEventos('10')
      const nueva = llamadas.find(l => l.url.includes('/webhook/NEW_ORDER/add-stores'))
      expect(JSON.parse(nueva?.init.body as string)[0].url).toBe('https://api.ejemplo.test/api/v1/webhooks/delivery/rappi/new-order')
    })

    it('suscribir: con la base pública inválida o ausente se niega ANTES de mandar nada', async () => {
      const llamadas = simularRed(() => json(200))
      mockEnv.RAPPI_WEBHOOK_BASE_URL = 'api.ejemplo.test'
      await expect(suscribirTiendaAEventos('10')).rejects.toThrow(/RAPPI_WEBHOOK_BASE_URL.*http\(s\)/)
      mockEnv.RAPPI_WEBHOOK_BASE_URL = undefined
      await expect(suscribirTiendaAEventos('10')).rejects.toThrow(/Falta RAPPI_WEBHOOK_BASE_URL/)
      expect(llamadas).toHaveLength(0)
    })
  })

  // F2: la base de webhooks se descubría faltante hasta SUSCRIBIR, con la tienda ya aprovisionada en Rappi.
  describe('preflight: todo el self-onboarding se valida ANTES de crear el intent', () => {
    it('devuelve la base del enlace de inicio, y el enlace sale idéntico al de antes', () => {
      mockEnv.RAPPI_OAUTH_REDIRECT_BASE = 'https://api.ejemplo.test/'
      expect(preflightSelfOnboardingRappi()).toBe('https://api.ejemplo.test')
      expect(urlDeInicio(preflightSelfOnboardingRappi(), 'a+b/c=')).toBe(
        'https://api.ejemplo.test/api/v1/delivery/rappi/oauth/start?intent=a%2Bb%2Fc%3D',
      )
    })

    // Sin esto el dueño autorizaba en Rappi y el fallo salía DESPUÉS, con el intent ya creado.
    it('🔴 el preflight falla ANTES de mandar al dueño a autorizar si faltan las credenciales de la integración', () => {
      mockEnv.RAPPI_CLIENT_ID_SANDBOX = undefined
      expect(() => preflightSelfOnboardingRappi()).toThrow(/Faltan credenciales de Rappi/)
    })

    it('PRODUCTION México sin RAPPI_SELF_ONBOARDING_API_BASE: el preflight pasa (el host ya está publicado)', () => {
      Object.assign(mockEnv, {
        RAPPI_ENVIRONMENT: 'PRODUCTION',
        RAPPI_CLIENT_ID_PRODUCTION: 'int-prod',
        RAPPI_CLIENT_SECRET_PRODUCTION: 'int-prod-secret',
        RAPPI_SELF_ONBOARDING_CLIENT_ID_PRODUCTION: 'so-prod',
      })
      expect(preflightSelfOnboardingRappi()).toBe('https://api.ejemplo.test')
    })

    it.each([
      ['sin RAPPI_WEBHOOK_BASE_URL', { RAPPI_WEBHOOK_BASE_URL: undefined }, /Falta RAPPI_WEBHOOK_BASE_URL/],
      ['RAPPI_WEBHOOK_BASE_URL inválida', { RAPPI_WEBHOOK_BASE_URL: 'api.ejemplo.test' }, /RAPPI_WEBHOOK_BASE_URL.*http\(s\)/],
      ['sin RAPPI_OAUTH_REDIRECT_BASE', { RAPPI_OAUTH_REDIRECT_BASE: undefined }, /Falta RAPPI_OAUTH_REDIRECT_BASE/],
      ['host del self-onboarding inválido', { RAPPI_SELF_ONBOARDING_API_BASE: 'host' }, /RAPPI_SELF_ONBOARDING_API_BASE/],
      [
        // T5: ya no hay host que inventar en México, pero otro país sigue sin tener uno verificado.
        'PRODUCTION de otro país sin host del self-onboarding',
        // Con las tres llaves de PRODUCTION puestas: el preflight las pide primero y aquí se prueba el host.
        {
          RAPPI_ENVIRONMENT: 'PRODUCTION',
          RAPPI_COUNTRY: 'CO',
          RAPPI_CLIENT_ID_PRODUCTION: 'int-prod',
          RAPPI_CLIENT_SECRET_PRODUCTION: 'int-prod-secret',
          RAPPI_SELF_ONBOARDING_CLIENT_ID_PRODUCTION: 'so-prod',
        },
        /país/i,
      ],
      // H7: Rappi acepta la suscripción aunque nos falte el secreto, y luego nuestro endpoint le contesta 401 a cada
      // pedido — la tienda queda «conectada» y sorda. Se niega ANTES de crear la intención.
      ['sin el secreto de NEW_ORDER', { RAPPI_WEBHOOK_SECRETS: secretos(['NEW_ORDER']) }, /RAPPI_WEBHOOK_SECRETS.*NEW_ORDER/],
      ['sin el secreto de PING', { RAPPI_WEBHOOK_SECRETS: secretos(['PING']) }, /RAPPI_WEBHOOK_SECRETS.*PING/],
      [
        'sin el secreto del aviso de aprovisionamiento',
        { RAPPI_WEBHOOK_SECRETS: secretos(['STORE_PROVISIONING_STATUS']) },
        /RAPPI_WEBHOOK_SECRETS.*STORE_PROVISIONING_STATUS/,
      ],
      ['RAPPI_WEBHOOK_SECRETS ilegible', { RAPPI_WEBHOOK_SECRETS: '{no es json' }, /RAPPI_WEBHOOK_SECRETS/],
      ['sin RAPPI_WEBHOOK_SECRETS', { RAPPI_WEBHOOK_SECRETS: undefined }, /RAPPI_WEBHOOK_SECRETS/],
    ])('%s ⇒ se niega', (_n, cambio, error) => {
      Object.assign(mockEnv, cambio)
      expect(() => preflightSelfOnboardingRappi()).toThrow(error)
    })
  })

  describe('suscribir: un fallo de red en un evento no corta a los demás', () => {
    it('un PUT que LANZA cae en `fallidos` y el resto se sigue intentando', async () => {
      const llamadas = simularRed(l => {
        if (l.url.includes('/webhook/NEW_ORDER/')) throw new Error('ECONNRESET')
        return json(200)
      })
      const r = await suscribirTiendaAEventos('10')

      expect(porUrl(llamadas).map(l => l.url)).toEqual(porUrl(SUSCRIPCIONES).map(l => l.url)) // no se cortó en el que lanzó
      expect(r).toEqual({ ok: false, fallidos: ['NEW_ORDER'] })
    })

    it('🔴 pero un rechazo del CANDADO no es un fallo por evento: se relanza y no se sigue', async () => {
      const llamadas = simularRed(() => json(200))
      await expect(suscribirTiendaAEventos('99')).rejects.toThrow(RappiEscrituraBloqueadaError)
      expect(llamadas).toHaveLength(0)
    })
  })
})

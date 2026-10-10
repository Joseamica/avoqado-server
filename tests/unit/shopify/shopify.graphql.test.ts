import { exchangeOAuthCode, shopifyGraphql, shopifyThrottleOk } from '@/services/commerce-channels/shopify/shopify.graphql'

type Resp = { status: number; text: () => Promise<string> }
const respuesta = (status: number, body: unknown): Resp => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
const conNombre = (name: string) => Object.assign(new Error(`falla ${name}`), { name })
/** Lo que Shopify contesta (HTTP 200) cuando a la app le falta un scope (shopify.dev/docs/api/usage/response-codes). */
const CUERPO_ACCESS_DENIED = {
  errors: [
    {
      message: 'Access denied for inventoryAdjustQuantities field. Required access: `write_inventory` access scope.',
      locations: [{ line: 2, column: 3 }],
      path: ['inventoryAdjustQuantities'],
      extensions: {
        code: 'ACCESS_DENIED',
        documentation: 'https://shopify.dev/api/usage/access-scopes',
        requiredAccess: '`write_inventory` access scope.',
      },
    },
  ],
  data: { inventoryAdjustQuantities: null },
  extensions: {
    cost: {
      requestedQueryCost: 10,
      actualQueryCost: 10,
      throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 },
    },
  },
}

const fetchOriginal = global.fetch
const fetchMock = jest.fn()
beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockReset()
})
afterAll(() => {
  global.fetch = fetchOriginal
})

describe('shopifyGraphql', () => {
  const llamar = (opts?: { validate?: (d: unknown) => d is unknown }) =>
    shopifyGraphql('t.myshopify.com', 'tok-secreto', '{ shop { name } }', { a: 1 }, opts)

  it('ok: devuelve data y manda token, versión y cuerpo', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { data: { shop: { name: 'X' } } }))
    expect(await llamar()).toEqual({ ok: true, data: { shop: { name: 'X' } } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://t.myshopify.com/admin/api/2026-10/graphql.json')
    expect(init.headers['X-Shopify-Access-Token']).toBe('tok-secreto')
    expect(JSON.parse(init.body)).toEqual({ query: '{ shop { name } }', variables: { a: 1 } })
    expect(init.signal).toBeDefined()
  })

  it.each([
    [401, 'UNAUTHORIZED', false, false],
    [403, 'FORBIDDEN', false, false],
    [429, 'THROTTLED', true, false],
    [503, 'HTTP_5XX', true, true],
    [422, 'HTTP_4XX', false, false],
  ] as const)('HTTP %i ⇒ %s', async (status, code, retryable, ambiguous) => {
    fetchMock.mockResolvedValue(respuesta(status, 'x'))
    expect(await llamar()).toMatchObject({ ok: false, code, retryable, ambiguous, status })
  })

  it('🔴 ACCESS_DENIED dentro de un 200 (falta un scope) ⇒ FORBIDDEN: no se reintenta ni es ambiguo (N5)', async () => {
    fetchMock.mockResolvedValue(respuesta(200, CUERPO_ACCESS_DENIED))
    const r = await llamar()
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN', retryable: false, ambiguous: false })
    expect(JSON.stringify(r)).toContain('write_inventory')
  })

  it('THROTTLED dentro de un 200 se reintenta y no es ambiguo', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }))
    expect(await llamar()).toMatchObject({ ok: false, code: 'THROTTLED', retryable: true, ambiguous: false })
  })

  it('otro errors[] ⇒ GRAPHQL_ERROR, reintentable y ambiguo', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { errors: [{ message: 'Internal error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }))
    expect(await llamar()).toMatchObject({ ok: false, code: 'GRAPHQL_ERROR', retryable: true, ambiguous: true })
  })

  it('JSON inválido ⇒ BAD_RESPONSE ambiguo', async () => {
    fetchMock.mockResolvedValue(respuesta(200, '{no es json'))
    expect(await llamar()).toMatchObject({ ok: false, code: 'BAD_RESPONSE', retryable: true, ambiguous: true })
  })

  it('el cuerpo truena al leerse ⇒ BAD_RESPONSE (la lectura va dentro del try)', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => Promise.reject(new Error('socket hang up')) })
    expect(await llamar()).toMatchObject({ ok: false, code: 'BAD_RESPONSE', ambiguous: true })
  })

  it('el tiempo se acaba LEYENDO el cuerpo ⇒ TIMEOUT', async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => Promise.reject(conNombre('TimeoutError')) })
    expect(await llamar()).toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true, ambiguous: true })
  })

  it('validate falso ⇒ BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { data: { otra: 'forma' } }))
    const validate = (d: unknown): d is unknown => typeof (d as { shop?: unknown }).shop === 'object'
    expect(await llamar({ validate })).toMatchObject({ ok: false, code: 'BAD_RESPONSE', ambiguous: true })
  })

  it('data nula sin errors ⇒ BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { data: null }))
    expect(await llamar()).toMatchObject({ ok: false, code: 'BAD_RESPONSE' })
  })

  it('fetch rechaza por tiempo ⇒ TIMEOUT; por red ⇒ NETWORK; los dos ambiguos', async () => {
    fetchMock.mockRejectedValueOnce(conNombre('TimeoutError'))
    expect(await llamar()).toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true, ambiguous: true })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await llamar()).toMatchObject({ ok: false, code: 'NETWORK', retryable: true, ambiguous: true })
  })

  it('nunca pone el token en el mensaje de error', async () => {
    fetchMock.mockResolvedValue(respuesta(500, 'falló con tok-secreto adentro'))
    expect(JSON.stringify(await llamar())).not.toContain('tok-secreto')
  })

  it('anota el cupo de extensions.cost: avisa cuando una tienda va justa y se recupera con el tiempo', async () => {
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    fetchMock.mockResolvedValue(
      respuesta(200, {
        data: { x: 1 },
        extensions: {
          cost: {
            requestedQueryCost: 10,
            actualQueryCost: 10,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 50, restoreRate: 100 },
          },
        },
      }),
    )
    await shopifyGraphql('justa.myshopify.com', 'tok', '{ x }')
    expect(shopifyThrottleOk('justa.myshopify.com', 200)).toBe(false)
    reloj.mockReturnValue(1_002_000) // +2 s ⇒ 50 + 200 = 250
    expect(shopifyThrottleOk('justa.myshopify.com', 200)).toBe(true)
    reloj.mockRestore()
  })

  it('un timeoutMs menor corta antes: sale TIMEOUT, reintentable y ambiguo', async () => {
    // fetch que sólo termina cuando su señal aborta, como una petición que se quedó colgada.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_ok, falla) => init.signal.addEventListener('abort', () => falla(init.signal.reason))),
    )
    const inicio = Date.now()
    const r = await shopifyGraphql('t.myshopify.com', 'tok', '{ x }', {}, { timeoutMs: 50 })
    expect(r).toMatchObject({ ok: false, code: 'TIMEOUT', retryable: true, ambiguous: true })
    expect(Date.now() - inicio).toBeLessThan(5_000) // el default es 20 s
  })

  it('🔴 M1: nunca sigue una redirección con el token puesto (redirect: error); si llega una, es una falla de red ambigua', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { data: { shop: { name: 'X' } } }))
    await llamar()
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    // Así contesta fetch (undici) cuando el servidor redirige y `redirect` es 'error'.
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))
    const r = await llamar()
    expect(r).toMatchObject({ ok: false, code: 'NETWORK', retryable: true, ambiguous: true })
    expect(JSON.stringify(r)).not.toContain('tok-secreto')
  })

  it('sin datos de cupo, la tienda se da por libre', () => {
    expect(shopifyThrottleOk('nunca-vista.myshopify.com')).toBe(true)
  })
})

describe('exchangeOAuthCode', () => {
  afterEach(() => {
    delete process.env.SHOPIFY_PILOTO_CLIENT_ID
    delete process.env.SHOPIFY_PILOTO_CLIENT_SECRET
  })
  const conLlaves = () => {
    process.env.SHOPIFY_PILOTO_CLIENT_ID = 'cliente'
    process.env.SHOPIFY_PILOTO_CLIENT_SECRET = 'secreto-app'
  }

  it('sin llaves de la app no llama a Shopify', async () => {
    expect(await exchangeOAuthCode('t.myshopify.com', 'PILOTO', 'c')).toMatchObject({ ok: false, code: 'UNAUTHORIZED', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('canjea el code por el token offline', async () => {
    conLlaves()
    fetchMock.mockResolvedValue(respuesta(200, { access_token: 'shpat_x', scope: 'read_products' }))
    expect(await exchangeOAuthCode('t.myshopify.com', 'PILOTO', 'codigo')).toEqual({
      ok: true,
      data: { accessToken: 'shpat_x', scope: 'read_products' },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://t.myshopify.com/admin/oauth/access_token')
    expect(JSON.parse(init.body)).toEqual({ client_id: 'cliente', client_secret: 'secreto-app', code: 'codigo' })
    expect(init.redirect).toBe('error') // M1: el client_secret nunca viaja a otro host por una redirección
  })

  it('un 400 no se reintenta y no filtra el secreto', async () => {
    conLlaves()
    fetchMock.mockResolvedValue(respuesta(400, 'invalid code for secreto-app'))
    const r = await exchangeOAuthCode('t.myshopify.com', 'PILOTO', 'codigo')
    expect(r).toMatchObject({ ok: false, code: 'HTTP_4XX', retryable: false })
    expect(JSON.stringify(r)).not.toContain('secreto-app')
  })
})

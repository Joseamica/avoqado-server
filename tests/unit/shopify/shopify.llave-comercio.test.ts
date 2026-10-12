/**
 * 5a (spec 2026-10-11 §2, riesgo 8): la llave de 24 h de la app del comercio con las respuestas que Shopify dio en vivo el 11-oct.
 * El módulo es puro: `fetch` inyectado y sin base de datos. Sólo escribe en el log lo que NO reconoce (con el status y el código de
 * Shopify, nunca el cuerpo, el secret ni la llave): ruling P1 de la auditoría, un 4xx sin `error` reconocible no es definitivo.
 */
import logger from '@/config/logger'
import { pedirLlaveDelComercio } from '@/services/commerce-channels/shopify/shopify.llave-comercio'

const respuesta = (status: number, body: unknown) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
const ID = '0123456789abcdef0123456789abcdef'
const SECRETO = 'shpss_0123456789abcdef0123456789abcd'
const MEDIDO = 'write_products,write_inventory,read_locations,read_orders,read_fulfillments'
const pedir = (f: jest.Mock, shop = 'mi-tienda.myshopify.com') =>
  pedirLlaveDelComercio({ shop, clientId: ID, clientSecret: SECRETO }, { fetch: f as unknown as typeof fetch })

beforeEach(() => jest.clearAllMocks())

describe('pedirLlaveDelComercio (5a)', () => {
  it('🔴 OK: POST form-urlencoded a /admin/oauth/access_token, sin seguir redirecciones y con plazo; devuelve la llave, los permisos y el vencimiento', async () => {
    const f = jest.fn().mockResolvedValue(respuesta(200, { access_token: 'shpat_24h', scope: MEDIDO, expires_in: 86399 }))
    expect(await pedir(f)).toEqual({ ok: true, token: 'shpat_24h', scope: MEDIDO, expiresIn: 86399 })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://mi-tienda.myshopify.com/admin/oauth/access_token')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: 'client_credentials',
      client_id: ID,
      client_secret: SECRETO,
    })
    expect(init.signal).toBeDefined()
  })

  it.each([
    [
      'secret malo (medido)',
      400,
      { error: 'invalid_request', error_description: 'Missing or invalid client secret' },
      { ok: false, motivo: 'SECRET_INVALIDO' },
    ],
    [
      'Client ID malo (medido)',
      400,
      {
        error: 'application_cannot_be_found',
        error_description: 'Could not find Shopify API application with api_key 00000000000000000000000000000000',
      },
      { ok: false, motivo: 'CLIENT_ID_INVALIDO' },
    ],
    ['tienda inexistente (medido)', 404, { errors: 'Not Found' }, { ok: false, motivo: 'TIENDA_NO_EXISTE' }],
    [
      'app de otra organización (documentado)',
      400,
      'Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.',
      { ok: false, motivo: 'APP_DE_OTRA_ORGANIZACION' },
    ],
    [
      'otro 4xx con error',
      400,
      { error: 'invalid_scope', error_description: 'x' },
      { ok: false, motivo: 'RECHAZADA', codigoShopify: 'invalid_scope' },
    ],
    [
      'invalid_request que no es del secret',
      400,
      { error: 'invalid_request', error_description: 'Missing grant_type' },
      { ok: false, motivo: 'RECHAZADA', codigoShopify: 'invalid_request' },
    ],
    // Auditoría Codex C1: un `error` que no es un código (texto libre, o una palabra con mayúsculas de un proxy) no prueba que las
    // llaves estén mal: se reintenta, como un 4xx sin `error`. Antes era RECHAZADA:SIN_CODIGO y la tienda quedaba revocada.
    ['4xx con un error que no tiene forma de código', 400, { error: 'Something went wrong here' }, { ok: false, motivo: 'TRANSITORIO' }],
    ['403 con texto libre en `error` (Codex C1)', 403, { error: 'Temporary upstream failure' }, { ok: false, motivo: 'TRANSITORIO' }],
    ['403 con una palabra que no es código', 403, { error: 'Forbidden' }, { ok: false, motivo: 'TRANSITORIO' }],
    // Ruling P1: un 4xx SIN un `error` reconocible (un proxy, una página de error) no es un rechazo de las llaves: se reintenta.
    ['4xx sin error (HTML de un proxy)', 403, '<html>Forbidden</html>', { ok: false, motivo: 'TRANSITORIO' }],
    ['404 que no es el de Shopify (HTML de un proxy)', 404, '<html>Not Found</html>', { ok: false, motivo: 'TRANSITORIO' }],
    ['401 sin error', 401, { errors: '[API] Invalid API key or access token' }, { ok: false, motivo: 'TRANSITORIO' }],
    ['429', 429, '', { ok: false, motivo: 'TRANSITORIO' }],
    ['408', 408, '', { ok: false, motivo: 'TRANSITORIO' }],
    ['5xx', 503, '<html>', { ok: false, motivo: 'TRANSITORIO' }],
    ['200 sin llave', 200, { scope: MEDIDO }, { ok: false, motivo: 'TRANSITORIO' }],
    ['200 sin vencimiento', 200, { access_token: 'shpat_x', scope: MEDIDO }, { ok: false, motivo: 'TRANSITORIO' }],
    ['200 que no es JSON', 200, '<html>', { ok: false, motivo: 'TRANSITORIO' }],
  ] as const)('🔴 %s', async (_caso, status, body, esperado) => {
    expect(await pedir(jest.fn().mockResolvedValue(respuesta(status, body)))).toEqual(esperado)
  })

  it.each([
    ['tiempo', Object.assign(new Error('timeout'), { name: 'TimeoutError' })],
    ['red', new TypeError('fetch failed')],
    ['redirección (redirect: error)', new TypeError('unexpected redirect')],
  ])('%s ⇒ TRANSITORIO', async (_caso, err) => {
    expect(await pedir(jest.fn().mockRejectedValue(err))).toEqual({ ok: false, motivo: 'TRANSITORIO' })
  })

  it('🔴 un dominio que no es de Shopify nunca recibe el secret', async () => {
    const f = jest.fn()
    expect(await pedir(f, 'evil.com')).toEqual({ ok: false, motivo: 'TIENDA_NO_EXISTE' })
    expect(await pedir(f, 'mi-tienda.myshopify.com.evil.com')).toEqual({ ok: false, motivo: 'TIENDA_NO_EXISTE' })
    expect(f).not.toHaveBeenCalled()
  })

  it('🔴 riesgo 6: lo que se reconoce (bien, rechazo conocido, red) no escribe en el log', async () => {
    await pedir(jest.fn().mockResolvedValue(respuesta(200, { access_token: 'shpat_24h', scope: MEDIDO, expires_in: 86399 })))
    await pedir(
      jest.fn().mockResolvedValue(respuesta(400, { error: 'invalid_request', error_description: 'Missing or invalid client secret' })),
    )
    await pedir(jest.fn().mockRejectedValue(new TypeError('fetch failed')))
    for (const f of [logger.info, logger.warn, logger.error, logger.debug]) expect(f).not.toHaveBeenCalled()
  })

  it.each([408, 429, 500, 503])('🔴 riesgo 6: un %s es rutina (Shopify ocupado): se reintenta sin escribir en el log', async status => {
    expect(await pedir(jest.fn().mockResolvedValue(respuesta(status, '<html>')))).toEqual({ ok: false, motivo: 'TRANSITORIO' })
    for (const f of [logger.info, logger.warn, logger.error, logger.debug]) expect(f).not.toHaveBeenCalled()
  })

  it('🔴 Codex C1: un `error` de texto libre se reintenta y queda en el log de errores sólo con el status: el texto no se escribe', async () => {
    const cuerpo = { error: `Temporary upstream failure ${SECRETO}`, error_description: 'shpat_24h' }
    expect(await pedir(jest.fn().mockResolvedValue(respuesta(403, cuerpo)))).toEqual({ ok: false, motivo: 'TRANSITORIO' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    const linea = String((logger.error as jest.Mock).mock.calls[0][0])
    expect(linea).toContain('HTTP 403')
    expect(linea).toContain('código ninguno')
    const todo = JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map(f => (f as jest.Mock).mock.calls))
    expect(todo).not.toMatch(/Temporary upstream|shpss_|shpat_/)
  })

  it('🔴 ruling P1 · riesgo 6: un 4xx que no se reconoce queda en el log de errores sólo con el status y el código: ni el cuerpo, ni el secret, ni la llave', async () => {
    const cuerpo = `<html>cuerpo-del-proxy ${SECRETO} shpat_24h</html>`
    expect(await pedir(jest.fn().mockResolvedValue(respuesta(403, cuerpo)))).toEqual({ ok: false, motivo: 'TRANSITORIO' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    const linea = String((logger.error as jest.Mock).mock.calls[0][0])
    expect(linea).toContain('HTTP 403')
    expect(linea).toContain('código ninguno')
    const todo = JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map(f => (f as jest.Mock).mock.calls))
    expect(todo).not.toMatch(/cuerpo-del-proxy|shpss_|shpat_/)
  })
})

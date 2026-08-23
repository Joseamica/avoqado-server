/**
 * Cliente HTTP de Rappi.
 *
 * El test que más importa es el del candado de escritura: existe por un incidente real —un
 * token de sandbox escribió el menú EN VIVO de un restaurante— y Rappi tiene la misma
 * exposición, peor, porque las tiendas se provisionan por lote.
 */
import {
  assertTiendaEscribible,
  crearEspaciadorDeSondeo,
  hostRappi,
  INTERVALO_SONDEO_MS,
  llamarRappi,
  RappiEscrituraBloqueadaError,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.http'
import { _resetRappiTokenCacheForTests } from '../../../../src/services/delivery-channels/providers/rappi/rappi.token'

function respuesta(status: number, body = '{}') {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response
}

function deps(over: Record<string, unknown> = {}) {
  return {
    ambiente: 'SANDBOX' as const,
    fetchImpl: jest.fn(async () => respuesta(200)) as unknown as typeof fetch,
    getToken: jest.fn(async () => 'tok'),
    tiendasEscribibles: [] as readonly string[],
    ...over,
  }
}

describe('hostRappi', () => {
  it('el host de México se escribe raro y hay que respetarlo tal cual', () => {
    expect(hostRappi('PRODUCTION', 'MX')).toBe('https://services.mxgrability.rappi.com')
  })

  it('sandbox es uno solo, sin importar el país', () => {
    expect(hostRappi('SANDBOX', 'MX')).toBe('https://microservices.dev.rappi.com')
    expect(hostRappi('SANDBOX', 'CO')).toBe('https://microservices.dev.rappi.com')
  })

  // 🔴 Un default silencioso mandaría los pedidos de un país al host de otro, y el síntoma
  // sería "no encuentra la tienda" sin ninguna pista.
  it('🔴 un país desconocido LANZA en vez de caer a México', () => {
    expect(() => hostRappi('PRODUCTION', 'XX')).toThrow(/país/i)
  })
})

describe('assertTiendaEscribible', () => {
  // ── El candado que evita repetir el incidente ─────────────────────────────────────
  it('🔴 lista VACÍA = NADA se puede escribir (la falla segura)', () => {
    expect(() => assertTiendaEscribible('900105814', [])).toThrow(RappiEscrituraBloqueadaError)
  })

  it('deja pasar sólo la tienda autorizada explícitamente', () => {
    expect(() => assertTiendaEscribible('900105814', ['900105814'])).not.toThrow()
    expect(() => assertTiendaEscribible('900105815', ['900105814'])).toThrow(RappiEscrituraBloqueadaError)
  })

  it('sin id de tienda tampoco pasa: no se escribe "a ciegas"', () => {
    expect(() => assertTiendaEscribible(undefined, ['900105814'])).toThrow(RappiEscrituraBloqueadaError)
  })

  it('el mensaje dice QUÉ pasó y qué hacer, no sólo que falló', () => {
    try {
      assertTiendaEscribible('999', [])
    } catch (e) {
      expect((e as Error).message).toMatch(/999/)
      expect((e as Error).message).toMatch(/autorizadas/i)
    }
  })
})

describe('llamarRappi', () => {
  beforeEach(() => _resetRappiTokenCacheForTests())

  it('🔴 una ESCRITURA a una tienda no autorizada NO sale a la red', () => {
    const d = deps()
    return expect(llamarRappi(d, { superficie: 'integrations', metodo: 'PUT', ruta: '/x', storeId: '1' }))
      .rejects.toThrow(RappiEscrituraBloqueadaError)
      .then(() => expect(d.fetchImpl).not.toHaveBeenCalled())
  })

  it('una LECTURA no necesita autorización de tienda', async () => {
    const d = deps()
    await llamarRappi(d, { superficie: 'integrations', metodo: 'GET', ruta: '/orders' })
    expect(d.fetchImpl).toHaveBeenCalled()
  })

  it('manda el header `x-authorization`, no el estándar', async () => {
    const d = deps()
    await llamarRappi(d, { superficie: 'integrations', metodo: 'GET', ruta: '/orders' })
    const headers = (d.fetchImpl as jest.Mock).mock.calls[0][1].headers
    expect(headers['x-authorization']).toBe('Bearer tok')
    expect(headers.Authorization).toBeUndefined()
  })

  it('usa el token de LA superficie que se le pide', async () => {
    const d = deps()
    await llamarRappi(d, { superficie: 'utils', metodo: 'GET', ruta: '/store/schedule/1' })
    expect(d.getToken).toHaveBeenCalledWith('utils')
  })

  // 🔴 Rappi puede revocar un token antes de que venza. Sin esto reintentaríamos con el
  // mismo para siempre.
  it('🔴 ante 401 invalida el token y reintenta UNA vez', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(respuesta(401)).mockResolvedValueOnce(respuesta(200))
    const d = deps({ fetchImpl })

    const r = await llamarRappi(d, { superficie: 'integrations', metodo: 'GET', ruta: '/orders' })

    expect(r.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('no reintenta en bucle: dos 401 devuelven el 401', async () => {
    // Machacar sólo empeora la tasa de éxito del 98% que Rappi exige.
    const fetchImpl = jest.fn().mockResolvedValue(respuesta(401))
    const r = await llamarRappi(deps({ fetchImpl }), { superficie: 'integrations', metodo: 'GET', ruta: '/orders' })
    expect(r.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('un 400 NO se reintenta — el problema es la petición, no el token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(respuesta(400, 'invalid transition'))
    const r = await llamarRappi(deps({ fetchImpl }), { superficie: 'integrations', metodo: 'GET', ruta: '/orders' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ ok: false, status: 400, raw: 'invalid transition' })
  })

  it('una escritura AUTORIZADA sí sale, con cuerpo JSON', async () => {
    const d = deps({ tiendasEscribibles: ['900'] })
    await llamarRappi(d, { superficie: 'integrations', metodo: 'PUT', ruta: '/x', storeId: '900', cuerpo: { a: 1 } })
    const opts = (d.fetchImpl as jest.Mock).mock.calls[0][1]
    expect(opts.body).toBe('{"a":1}')
    expect(opts.headers['content-type']).toBe('application/json')
  })
})

describe('crearEspaciadorDeSondeo', () => {
  it('el intervalo es el que Rappi pide: 45 segundos', () => {
    expect(INTERVALO_SONDEO_MS).toBe(45_000)
  })

  it('la primera vuelta no espera', async () => {
    const sleep = jest.fn(async () => {})
    const e = crearEspaciadorDeSondeo({ now: () => 1000, sleep })
    await e.esperarTurno('v1')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('la segunda vuelta espera lo que falte para los 45 s', async () => {
    const sleep = jest.fn(async () => {})
    let t = 1000
    const e = crearEspaciadorDeSondeo({ now: () => t, sleep })

    await e.esperarTurno('v1')
    t += 10_000
    await e.esperarTurno('v1')

    expect(sleep).toHaveBeenCalledWith(35_000)
  })

  it('si ya pasaron los 45 s no espera nada', async () => {
    const sleep = jest.fn(async () => {})
    let t = 1000
    const e = crearEspaciadorDeSondeo({ now: () => t, sleep })

    await e.esperarTurno('v1')
    t += 60_000
    await e.esperarTurno('v1')

    expect(sleep).not.toHaveBeenCalled()
  })

  // El límite es sobre cuánto sondeamos UNA tienda, no sobre cuántas atendemos: hacer fila
  // entre venues distintos escalaría pésimo con 50 clientes.
  it('🔴 dos venues NO se hacen fila entre ellos', async () => {
    const sleep = jest.fn(async () => {})
    const e = crearEspaciadorDeSondeo({ now: () => 1000, sleep })

    await e.esperarTurno('v1')
    await e.esperarTurno('v2')

    expect(sleep).not.toHaveBeenCalled()
  })

  // 🔴 Espera, NO rechaza: perder una vuelta de sondeo es perder pedidos cuando el webhook
  // falló — y Rappi no documenta reintentos de webhook, así que el sondeo ES la red.
  it('🔴 espaciador, no limitador: nunca rechaza una vuelta', async () => {
    const sleep = jest.fn(async () => {})
    let t = 1000
    const e = crearEspaciadorDeSondeo({ now: () => t, sleep })
    await e.esperarTurno('v1')
    t += 1
    await expect(e.esperarTurno('v1')).resolves.toBeUndefined()
  })
})

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
  hostDeLoginRappi,
  hostRappi,
  INTERVALO_SONDEO_MS,
  llamarRappi,
  RappiEscrituraBloqueadaError,
  TIMEOUT_RAPPI_MS,
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

// T5 (20-oct): el login de Rappi se mudó al dominio nuevo; la API sigue en el clásico (`hostRappi`).
describe('hostDeLoginRappi', () => {
  it('🔴 sandbox: el dominio nuevo, sin importar el país', () => {
    expect(hostDeLoginRappi('SANDBOX')).toBe('https://api.dev.rappi.com')
    expect(hostDeLoginRappi('SANDBOX', 'MX')).toBe('https://api.dev.rappi.com')
    expect(hostDeLoginRappi('SANDBOX', 'CO')).toBe('https://api.dev.rappi.com')
  })

  it('producción México: el publicado (api.rappi.com.mx), con o sin país explícito y sin importar mayúsculas', () => {
    expect(hostDeLoginRappi('PRODUCTION')).toBe('https://api.rappi.com.mx')
    expect(hostDeLoginRappi('PRODUCTION', 'MX')).toBe('https://api.rappi.com.mx')
    expect(hostDeLoginRappi('PRODUCTION', ' mx ')).toBe('https://api.rappi.com.mx')
  })

  // Sólo México tiene el dominio nuevo verificado: caer a México mandaría el login de otro país al host equivocado.
  it('🔴 producción con otro país LANZA (sólo México está soportado)', () => {
    expect(() => hostDeLoginRappi('PRODUCTION', 'CO')).toThrow(/país.*"CO"/i)
    expect(() => hostDeLoginRappi('PRODUCTION', 'XX')).toThrow(/país/i)
  })

  it('el dominio nuevo es sólo del login: la API sigue en el host clásico', () => {
    expect(hostRappi('SANDBOX', 'MX')).toBe('https://microservices.dev.rappi.com')
    expect(hostRappi('PRODUCTION', 'MX')).toBe('https://services.mxgrability.rappi.com')
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

  // H3: sin techo, una llamada colgada sostenía la pasada de la reconciliación (y detrás de ella, los pedidos).
  it('🔴 cada petición lleva AbortSignal.timeout(10 s), y al vencer sale como un fallo de red (lanza), no como una respuesta', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal)
    const espia = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(5)) // vence ya: la prueba no espera 10 s
    try {
      // El fetch falla SÓLO si su señal se aborta: con una señal que nunca vence, esta prueba se queda colgada.
      const fetchImpl = jest.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_ok, rechazar) => init.signal?.addEventListener('abort', () => rechazar(init.signal?.reason))),
      )
      await expect(
        llamarRappi(deps({ fetchImpl: fetchImpl as unknown as typeof fetch }), {
          superficie: 'integrations',
          metodo: 'GET',
          ruta: '/orders',
        }),
      ).rejects.toThrow(/timeout/i)
      expect(espia).toHaveBeenCalledWith(10_000)
      expect(TIMEOUT_RAPPI_MS).toBe(10_000)
      expect(fetchImpl.mock.calls[0][1].signal).toBe(espia.mock.results[0].value)
    } finally {
      espia.mockRestore()
    }
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

describe('llamarRappi — self-onboarding', () => {
  const base = { ambiente: 'SANDBOX' as const, getToken: async () => 'tok-integ' }

  it('manda el header del comercio además del del integrador, al host indicado', async () => {
    const fetchImpl = jest.fn(async () => respuesta(200))
    await llamarRappi(
      { ...base, fetchImpl: fetchImpl as never },
      {
        superficie: 'integrations',
        metodo: 'GET',
        ruta: '/api/v2/restaurants-integrations-public-api/stores/integration-status',
        host: 'https://api.dev.rappi.com',
        cabecerasExtra: { 'Authorization-Partners': 'Bearer idt' },
      },
    )
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.dev.rappi.com/api/v2/restaurants-integrations-public-api/stores/integration-status')
    expect(init.headers).toMatchObject({ 'x-authorization': 'Bearer tok-integ', 'Authorization-Partners': 'Bearer idt' })
  })

  it('el candado revisa CADA tienda del lote: una fuera de la lista y no sale nada', async () => {
    const fetchImpl = jest.fn()
    await expect(
      llamarRappi(
        { ...base, fetchImpl: fetchImpl as never, tiendasEscribibles: ['10'] },
        { superficie: 'integrations', metodo: 'POST', ruta: '/x', storeIds: ['10', '11'], cuerpo: {} },
      ),
    ).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('un lote donde TODAS están autorizadas sí sale', async () => {
    const fetchImpl = jest.fn(async () => respuesta(202))
    await llamarRappi(
      { ...base, fetchImpl: fetchImpl as never, tiendasEscribibles: ['10', '11'] },
      { superficie: 'integrations', metodo: 'POST', ruta: '/x', storeIds: ['10', '11'], cuerpo: {} },
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // 🔴 Un lote vacío no puede ser un pase libre: `[].every(...)` es true, y por eso se exige al menos una.
  it('🔴 un lote VACÍO de tiendas no se salta el candado', async () => {
    const fetchImpl = jest.fn()
    await expect(
      llamarRappi(
        { ...base, fetchImpl: fetchImpl as never, tiendasEscribibles: ['10'] },
        { superficie: 'integrations', metodo: 'POST', ruta: '/x', storeIds: [], cuerpo: {} },
      ),
    ).rejects.toThrow(RappiEscrituraBloqueadaError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sin host ni cabeceras extra todo sigue igual que antes (regresión)', async () => {
    const fetchImpl = jest.fn(async () => respuesta(200))
    await llamarRappi({ ...base, fetchImpl: fetchImpl as never }, { superficie: 'integrations', metodo: 'GET', ruta: '/x' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://microservices.dev.rappi.com/x')
    expect(Object.keys(init.headers as object)).not.toContain('Authorization-Partners')
  })
})

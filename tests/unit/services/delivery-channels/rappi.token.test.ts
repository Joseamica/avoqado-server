/**
 * Caché del token de Rappi.
 *
 * Lo que importa aquí: son TRES superficies con tokens distintos, el header no es el
 * estándar, y una vigencia de una semana da tiempo de sobra a quedarse con uno vencido.
 */
import {
  _resetRappiTokenCacheForTests,
  anotarLoginExitoso,
  anotarLoginFallido,
  cabeceraRappi,
  getRappiToken,
  invalidarToken,
} from '../../../../src/services/delivery-channels/providers/rappi/rappi.token'

describe('getRappiToken', () => {
  beforeEach(() => _resetRappiTokenCacheForTests())

  it('pide el token una vez y lo reusa', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 604800 })

    expect(await getRappiToken('integrations', { fetchToken })).toBe('t1')
    expect(await getRappiToken('integrations', { fetchToken })).toBe('t1')
    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  // ── El bug clásico que esto evita ─────────────────────────────────────────────────
  // El token de pedidos NO sirve para horarios. Cachearlos juntos daría 401 con un token
  // "fresco", y nadie entendería por qué.
  it('🔴 cada superficie tiene su PROPIO token — el de una no sirve en otra', async () => {
    const fetchToken = jest.fn(async (s: string) => ({ access_token: `token-${s}`, expires_in: 604800 }))

    expect(await getRappiToken('integrations', { fetchToken })).toBe('token-integrations')
    expect(await getRappiToken('utils', { fetchToken })).toBe('token-utils')
    expect(await getRappiToken('finance', { fetchToken })).toBe('token-finance')
    expect(fetchToken).toHaveBeenCalledTimes(3)
  })

  it('single-flight: tres llamadas simultáneas piden UN solo token', async () => {
    let resolver: (v: unknown) => void = () => {}
    const fetchToken = jest.fn(
      () =>
        new Promise(r => {
          resolver = r
        }),
    )

    const p = Promise.all([
      getRappiToken('integrations', { fetchToken: fetchToken as never }),
      getRappiToken('integrations', { fetchToken: fetchToken as never }),
      getRappiToken('integrations', { fetchToken: fetchToken as never }),
    ])
    resolver({ access_token: 't1', expires_in: 604800 })

    expect(await p).toEqual(['t1', 't1', 't1'])
    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  it('el single-flight es POR superficie: pedir horarios no espera a pedidos', async () => {
    const fetchToken = jest.fn(async (s: string) => ({ access_token: `t-${s}`, expires_in: 604800 }))
    await Promise.all([getRappiToken('integrations', { fetchToken }), getRappiToken('utils', { fetchToken })])
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  // ── La renovación anticipada ──────────────────────────────────────────────────────
  // Una semana es tiempo de sobra para que un reinicio o un reloj desfasado lo dejen viejo.
  it('🔴 renueva un DÍA antes de vencer, no en el último minuto', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 604800 })
    let ahora = 1_000_000
    const now = () => ahora

    await getRappiToken('integrations', { fetchToken, now })

    // A 2 días de vencer todavía sirve.
    ahora += 5 * 24 * 3600 * 1000
    await getRappiToken('integrations', { fetchToken, now })
    expect(fetchToken).toHaveBeenCalledTimes(1)

    // A menos de 1 día, se renueva.
    ahora += 1.5 * 24 * 3600 * 1000
    await getRappiToken('integrations', { fetchToken, now })
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  // ── D6 (26-oct) ────────────────────────────────────────────────────────────────────
  // Rappi entrega el MISMO token hasta que vence (medido en DEV el 25-oct: pedirlo de nuevo devolvió el de siempre con 23 h
  // de vida). Con el margen fijo de un día, en su último día ese token nunca quedaba en caché: cada llamada volvía a pedir
  // login, y el script de avisos no encontraba el token para sacar el `azp`.
  describe('🔴 D6: el último día del token', () => {
    const HORA = 3600 * 1000

    it('un token con menos de un día de vida se guarda y se reusa', async () => {
      const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 23 * 3600 })
      let ahora = 1_000_000
      const now = () => ahora
      expect(await getRappiToken('integrations', { fetchToken, now })).toBe('t1')
      ahora += HORA
      expect(await getRappiToken('integrations', { fetchToken, now })).toBe('t1')
      expect(fetchToken).toHaveBeenCalledTimes(1)
    })

    it('se renueva a la mitad de lo que le queda: unas pocas veces en el día, nunca en cada llamada', async () => {
      const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 23 * 3600 })
      let ahora = 1_000_000
      const now = () => ahora
      await getRappiToken('integrations', { fetchToken, now })
      ahora += 11 * HORA // le quedan 12 h: más que la mitad (11.5 h), todavía sirve
      await getRappiToken('integrations', { fetchToken, now })
      expect(fetchToken).toHaveBeenCalledTimes(1)
      ahora += 1 * HORA // le quedan 11 h: ahora sí se pide (y Rappi devuelve el mismo, con 11 h)
      fetchToken.mockResolvedValue({ access_token: 't1', expires_in: 11 * 3600 })
      await getRappiToken('integrations', { fetchToken, now })
      await getRappiToken('integrations', { fetchToken, now })
      await getRappiToken('integrations', { fetchToken, now })
      expect(fetchToken).toHaveBeenCalledTimes(2)
    })

    it('el script de avisos encuentra en caché el token aunque le quede menos de un día', async () => {
      await getRappiToken('integrations', { fetchToken: async () => ({ access_token: 't1', expires_in: 20 * 3600 }) })
      const sinLogin = { fetchToken: () => Promise.reject(new Error('el token no quedó en caché')) }
      await expect(getRappiToken('integrations', sinLogin)).resolves.toBe('t1')
    })

    it('regresión: un token de una semana se sigue renovando con un día de anticipación', async () => {
      const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 604800 })
      let ahora = 1_000_000
      const now = () => ahora
      await getRappiToken('integrations', { fetchToken, now })
      ahora += (7 * 24 - 25) * HORA // le quedan 25 h
      await getRappiToken('integrations', { fetchToken, now })
      expect(fetchToken).toHaveBeenCalledTimes(1)
      ahora += 2 * HORA // le quedan 23 h: dentro del día de anticipación
      await getRappiToken('integrations', { fetchToken, now })
      expect(fetchToken).toHaveBeenCalledTimes(2)
    })

    it('con menos de un minuto de vida no se guarda: la siguiente llamada vuelve a pedir', async () => {
      const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 30 })
      expect(await getRappiToken('integrations', { fetchToken })).toBe('t1')
      expect(await getRappiToken('integrations', { fetchToken })).toBe('t1')
      expect(fetchToken).toHaveBeenCalledTimes(2)
    })
  })

  it('sin `expires_in` asume la semana que Rappi documenta, no cero', async () => {
    // Asumir cero pediría un token en CADA llamada y agotaría cualquier límite.
    const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1' })
    let ahora = 1_000_000
    const now = () => ahora

    await getRappiToken('integrations', { fetchToken, now })
    ahora += 3600 * 1000
    await getRappiToken('integrations', { fetchToken, now })
    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  it('una respuesta sin access_token LANZA en vez de cachear basura', async () => {
    const fetchToken = jest.fn().mockResolvedValue({})
    await expect(getRappiToken('integrations', { fetchToken })).rejects.toThrow(/access_token/)
  })

  it.each(['   ', 7, {}, true])('un access_token inválido (%j) no se guarda y permite pedir uno válido después', async access_token => {
    const fetchToken = jest.fn().mockResolvedValueOnce({ access_token }).mockResolvedValueOnce({ access_token: 'valido' })
    await expect(getRappiToken('integrations', { fetchToken })).rejects.toThrow(/access_token/)
    expect(await getRappiToken('integrations', { fetchToken })).toBe('valido')
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it.each(['LEAK42\nBAD', 'LEAK42\rBAD', 'LEAK42\0BAD', 'LEAK42\tBAD', 'LEAK42 BAD', 'LEAK42😀'])(
    'un token no utilizable como Bearer no se cachea (%j)',
    async access_token => {
      const fetchToken = jest
        .fn()
        .mockResolvedValueOnce({ access_token, expires_in: 604800 })
        .mockResolvedValueOnce({ access_token: 'recuperado' })
      await expect(getRappiToken('integrations', { fetchToken })).rejects.toThrow(/access_token/)
      expect(await getRappiToken('integrations', { fetchToken })).toBe('recuperado')
      expect(fetchToken).toHaveBeenCalledTimes(2)
    },
  )

  it('un fallo no deja la petición atorada: el siguiente intento vuelve a pedir', async () => {
    const fetchToken = jest.fn().mockRejectedValueOnce(new Error('red caída')).mockResolvedValue({ access_token: 't1', expires_in: 604800 })

    await expect(getRappiToken('integrations', { fetchToken })).rejects.toThrow('red caída')
    expect(await getRappiToken('integrations', { fetchToken })).toBe('t1')
  })

  // 🔴 Un 401 puede significar que lo revocaron ANTES de vencer. Sin invalidar, se
  // reintentaría con el mismo token para siempre.
  it('invalidarToken fuerza a pedir uno nuevo aunque no haya vencido', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ access_token: 't1', expires_in: 604800 })

    await getRappiToken('integrations', { fetchToken })
    invalidarToken('integrations')
    await getRappiToken('integrations', { fetchToken })

    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it('invalidar una superficie no tira las otras', async () => {
    const fetchToken = jest.fn(async (s: string) => ({ access_token: `t-${s}`, expires_in: 604800 }))
    await getRappiToken('integrations', { fetchToken })
    await getRappiToken('utils', { fetchToken })

    invalidarToken('integrations')
    await getRappiToken('utils', { fetchToken })

    expect(fetchToken).toHaveBeenCalledTimes(2)
  })
})

describe('cabeceraRappi', () => {
  // 🔴 Rappi NO usa `Authorization`. Un cliente HTTP normal manda el estándar y recibe 401
  // sin explicación, con el token correcto.
  it('🔴 usa `x-authorization`, NO el header estándar', () => {
    const h = cabeceraRappi('abc')
    expect(h['x-authorization']).toBe('Bearer abc')
    expect(h.Authorization).toBeUndefined()
  })
})

// Tarea 20, ronda 1 (I-1): un login rechazado gritaba 🚨 en CADA intento (con el sondeo prendido, ~3,800 al día). Ahora el 🚨
// sale sólo al EMPEZAR una racha de fallos por superficie; el primer login bueno la cierra y rearma el aviso.
describe('racha de logins fallidos', () => {
  beforeEach(() => _resetRappiTokenCacheForTests())

  it('🔴 sólo el PRIMER fallo de la racha la empieza; los siguientes no', () => {
    expect(anotarLoginFallido('integrations')).toBe(true)
    expect(anotarLoginFallido('integrations')).toBe(false)
    expect(anotarLoginFallido('integrations')).toBe(false)
  })

  it('el primer login bueno cierra la racha y rearma el aviso', () => {
    anotarLoginFallido('integrations')
    expect(anotarLoginExitoso('integrations')).toBe(true)
    expect(anotarLoginExitoso('integrations')).toBe(false) // sin racha, un éxito no dice nada
    expect(anotarLoginFallido('integrations')).toBe(true) // racha nueva: avisa otra vez
  })

  it('cada superficie lleva su racha', () => {
    expect(anotarLoginFallido('integrations')).toBe(true)
    expect(anotarLoginFallido('utils')).toBe(true)
    expect(anotarLoginExitoso('utils')).toBe(true)
    expect(anotarLoginFallido('integrations')).toBe(false)
  })

  // Menores del bloque 2 (T20 re-revisión): un 🚨 por racha SIN límite de tiempo callaba una caída de login de días.
  describe('🔴 una racha que sigue vuelve a gritar cada hora (en memoria)', () => {
    const HORA = 60 * 60 * 1000
    const T0 = 1_761_130_000_000
    let reloj: jest.SpyInstance
    beforeEach(() => {
      reloj = jest.spyOn(Date, 'now').mockReturnValue(T0)
    })
    afterEach(() => reloj.mockRestore())
    const a = (ms: number) => reloj.mockReturnValue(T0 + ms)

    it('dentro de la hora no repite; al cumplirse la hora desde el último 🚨, sí; y la hora se cuenta desde ese 🚨', () => {
      expect(anotarLoginFallido('integrations')).toBe(true) // empieza la racha
      a(HORA - 1)
      expect(anotarLoginFallido('integrations')).toBe(false)
      a(HORA)
      expect(anotarLoginFallido('integrations')).toBe(true) // la caída sigue: otro 🚨
      a(HORA + 5 * 60_000)
      expect(anotarLoginFallido('integrations')).toBe(false) // la hora cuenta desde el 🚨 repetido, no desde el inicio
      a(2 * HORA - 1)
      expect(anotarLoginFallido('integrations')).toBe(false)
      a(2 * HORA)
      expect(anotarLoginFallido('integrations')).toBe(true)
    })

    it('cada superficie lleva su propio reloj', () => {
      anotarLoginFallido('integrations')
      a(HORA / 2)
      expect(anotarLoginFallido('utils')).toBe(true) // su racha empieza ahora
      a(HORA)
      expect(anotarLoginFallido('integrations')).toBe(true)
      expect(anotarLoginFallido('utils')).toBe(false)
    })

    it('un login bueno cierra la racha: el siguiente fallo vuelve a ser inicio de racha, sin esperar la hora', () => {
      anotarLoginFallido('integrations')
      a(60_000)
      expect(anotarLoginExitoso('integrations')).toBe(true)
      expect(anotarLoginFallido('integrations')).toBe(true)
    })
  })

  it('el reset de pruebas también borra las rachas', () => {
    anotarLoginFallido('integrations')
    _resetRappiTokenCacheForTests()
    expect(anotarLoginFallido('integrations')).toBe(true)
  })
})

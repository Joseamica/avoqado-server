/**
 * Caché del token de Rappi.
 *
 * Lo que importa aquí: son TRES superficies con tokens distintos, el header no es el
 * estándar, y una vigencia de una semana da tiempo de sobra a quedarse con uno vencido.
 */
import {
  _resetRappiTokenCacheForTests,
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

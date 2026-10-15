// tests/unit/services/customer-display/pollWork.test.ts
import {
  POLL_WORK_MAX_IN_FLIGHT,
  PollWorkLimiter,
  PollWorkSaturated,
  SingleFlightCache,
  dentroDelPlazo,
  esperarTodas,
  pollWorkLimiter,
} from '@/services/customer-display/pollWork'

function diferida<T>() {
  let resolver!: (v: T) => void
  let rechazar!: (e: unknown) => void
  const promesa = new Promise<T>((r, f) => ((resolver = r), (rechazar = f)))
  return { promesa, resolver, rechazar }
}
const vaciarMicrotareas = () => new Promise(r => setImmediate(r))

describe('PollWorkLimiter', () => {
  it('no arranca el trabajo número max+1: devuelve null SIN llamarlo', () => {
    const limiter = new PollWorkLimiter(2)
    const a = diferida<string>()
    const b = diferida<string>()
    expect(limiter.intentar(() => a.promesa)).not.toBeNull()
    expect(limiter.intentar(() => b.promesa)).not.toBeNull()
    const tercero = jest.fn(async () => 'x')
    expect(limiter.intentar(tercero)).toBeNull()
    expect(tercero).not.toHaveBeenCalled()
    expect(limiter.enVuelo).toBe(2)
  })

  it('libera su lugar al terminar, bien o mal', async () => {
    const limiter = new PollWorkLimiter(1)
    await limiter.intentar(async () => 'ok')
    await expect(limiter.intentar(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(limiter.enVuelo).toBe(0)
  })

  it('un trabajo que lanza SINCRÓNICAMENTE también libera su lugar', async () => {
    const limiter = new PollWorkLimiter(1)
    const p = limiter.intentar(() => {
      throw new Error('sync')
    })
    await expect(p).rejects.toThrow('sync')
    expect(limiter.enVuelo).toBe(0)
  })
})

describe('esperarTodas — lo que corre dentro de UN lugar (Codex r1 #2)', () => {
  it('🔴 no se asienta hasta que TODAS se asientan, aunque una falle primero', async () => {
    const lenta = diferida<string>()
    let asentada = false
    const todas = esperarTodas([Promise.reject(new Error('primera')), lenta.promesa]).catch(e => {
      asentada = true
      return e
    })
    await vaciarMicrotareas()
    expect(asentada).toBe(false) // Promise.all ya se habría rendido aquí, con `lenta` todavía viva
    lenta.resolver('tarde')
    expect(await todas).toEqual(new Error('primera')) // y se rechaza con el PRIMER error
  })

  it('🔴 dentro de un lugar: el lugar sigue ocupado mientras quede una lectura viva', async () => {
    const limiter = new PollWorkLimiter(1)
    const lenta = diferida<string>()
    const trabajo = limiter.intentar(() => esperarTodas([Promise.reject(new Error('x')), lenta.promesa]))!
    trabajo.catch(() => undefined)
    await vaciarMicrotareas()
    expect(limiter.enVuelo).toBe(1)
    lenta.resolver('ya')
    await expect(trabajo).rejects.toThrow('x')
    expect(limiter.enVuelo).toBe(0)
  })

  it('todas bien: los valores en su orden, con sus tipos', async () => {
    const [n, s] = await esperarTodas([Promise.resolve(1), Promise.resolve('a')])
    expect([n + 1, s.toUpperCase()]).toEqual([2, 'A'])
  })
})

describe('SingleFlightCache', () => {
  let reloj = 1_000_000
  const nueva = (maxEntradas = 3) => new SingleFlightCache<string>({ ttlMs: 60_000, maxEntradas, ahora: () => reloj })
  beforeEach(() => (reloj = 1_000_000))

  it('dos lecturas A LA VEZ de la misma llave: UN cálculo, el mismo resultado', async () => {
    const cache = nueva()
    const d = diferida<string>()
    const calcular = jest.fn(() => d.promesa)
    const [a, b] = [cache.get('k', calcular), cache.get('k', calcular)]
    d.resolver('v')
    await expect(Promise.all([a, b])).resolves.toEqual(['v', 'v'])
    expect(calcular).toHaveBeenCalledTimes(1)
  })

  it('lo guardado se entrega sin calcular hasta que vence', async () => {
    const cache = nueva()
    const calcular = jest.fn(async () => 'v')
    await cache.get('k', calcular)
    reloj += 59_999
    await cache.get('k', calcular)
    expect(calcular).toHaveBeenCalledTimes(1)
    reloj += 2
    await cache.get('k', calcular)
    expect(calcular).toHaveBeenCalledTimes(2)
  })

  it('un error NO se guarda: la siguiente lectura vuelve a calcular', async () => {
    const cache = nueva()
    await expect(cache.get('k', async () => Promise.reject(new Error('base caída')))).rejects.toThrow('base caída')
    expect(cache.peek('k')).toBeUndefined()
    await expect(cache.get('k', async () => 'ya')).resolves.toBe('ya')
  })

  it('saturado: rechaza con PollWorkSaturated y NO calcula', async () => {
    const cache = nueva()
    const limiter = new PollWorkLimiter(0)
    const calcular = jest.fn(async () => 'v')
    await expect(cache.get('k', calcular, { limiter })).rejects.toBeInstanceOf(PollWorkSaturated)
    expect(calcular).not.toHaveBeenCalled()
    expect(cache.sizeForTests().enVuelo).toBe(0)
  })

  // 🔴 El orden que importa: lo fresco nunca queda debajo de lo viejo.
  it('refresh no se une al cálculo en vuelo, y el cálculo VIEJO no pisa lo nuevo al terminar', async () => {
    const cache = nueva()
    const viejo = diferida<string>()
    const lectura = cache.get('k', () => viejo.promesa)
    await expect(cache.refresh('k', async () => 'nuevo')).resolves.toBe('nuevo')
    viejo.resolver('viejo')
    await expect(lectura).resolves.toBe('viejo') // quien lo pidió recibe lo suyo…
    await vaciarMicrotareas()
    expect(cache.peek('k')).toBe('nuevo') // …pero no se guarda encima de lo nuevo
  })

  it('después de un refresh, una lectura nueva se une a lo NUEVO, nunca al cálculo viejo', async () => {
    const cache = nueva()
    const viejo = diferida<string>()
    const nuevo = diferida<string>()
    void cache.get('k', () => viejo.promesa)
    const fresco = cache.refresh('k', () => nuevo.promesa)
    const otra = jest.fn(async () => 'no-debe-calcular')
    const lectura = cache.get('k', otra)
    nuevo.resolver('nuevo')
    viejo.resolver('viejo')
    await expect(Promise.all([fresco, lectura])).resolves.toEqual(['nuevo', 'nuevo'])
    expect(otra).not.toHaveBeenCalled()
  })

  it('tiene tope: por muchas llaves que se lean, no pasa de maxEntradas', async () => {
    const cache = nueva(3)
    for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => `v${i}`)
    expect(cache.sizeForTests().entradas).toBeLessThanOrEqual(3)
    expect(cache.peek('k9')).toBe('v9') // se van las más viejas, no la recién guardada
  })
})

describe('dentroDelPlazo', () => {
  it('entrega lo que llegó antes del plazo y omite lo demás', async () => {
    const a = diferida<string>()
    const b = diferida<string>()
    const plazo = diferida<void>()
    const resultado = dentroDelPlazo({ a: a.promesa, b: b.promesa }, 150, { esperar: () => plazo.promesa })
    a.resolver('A')
    await vaciarMicrotareas()
    plazo.resolver()
    const r = await resultado
    b.resolver('B')
    await vaciarMicrotareas()
    expect(r).toEqual({ a: 'A' }) // y lo que llegó tarde no muta la respuesta ya armada
  })

  it('si todo llega antes, no espera el plazo', async () => {
    const r = await dentroDelPlazo({ a: Promise.resolve('A') }, 150, { esperar: () => new Promise(() => {}) })
    expect(r).toEqual({ a: 'A' })
  })

  it('una tarea que falla se omite y se reporta — también la que falla DESPUÉS del plazo', async () => {
    const tarde = diferida<string>()
    const alFallar = jest.fn()
    const r = await dentroDelPlazo({ mala: Promise.reject(new Error('x')), tarde: tarde.promesa }, 150, {
      esperar: () => Promise.resolve(),
      alFallar,
    })
    expect(r).toEqual({})
    tarde.rechazar(new Error('tarde'))
    await vaciarMicrotareas()
    expect(alFallar).toHaveBeenCalledWith('mala', expect.any(Error))
    expect(alFallar).toHaveBeenCalledWith('tarde', expect.any(Error)) // ningún rechazo queda sin manejar
  })

  it('con el reloj real, una tarea que nunca termina no retiene la respuesta más allá del plazo', async () => {
    const inicio = Date.now()
    const r = await dentroDelPlazo({ nunca: new Promise<string>(() => {}) }, 20)
    expect(r).toEqual({})
    expect(Date.now() - inicio).toBeLessThan(1_000)
  })
})

it('🔴 el tope del proceso es 8 (decisión 2: el pool de Prisma es de 18 conexiones para TODO el proceso)', () => {
  expect(POLL_WORK_MAX_IN_FLIGHT).toBe(8)
  expect(pollWorkLimiter.enVuelo).toBe(0) // nadie lo deja ocupado al cargar el módulo
})

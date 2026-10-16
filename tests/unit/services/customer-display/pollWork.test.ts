// tests/unit/services/customer-display/pollWork.test.ts
import {
  POLL_WORK_MAX_IN_FLIGHT,
  PollWorkLimiter,
  PollWorkSaturated,
  REFRESH_COALESCE_MS,
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

  // Fix round 1 (#2): `activos >= NaN` nunca es cierto, así que un tope inválido dejaba pasar trabajo sin límite.
  it.each([NaN, -1, 1.5, Infinity])('un tope que no es entero ≥ 0 (%p) se rechaza al construir', maximo => {
    expect(() => new PollWorkLimiter(maximo)).toThrow(RangeError)
  })

  it('el tope 0 es válido: no deja arrancar nada', () => {
    expect(new PollWorkLimiter(0).intentar(async () => 'x')).toBeNull()
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

  // Fix round 1 (#3a, Review Focus #6): unirse a un cálculo en vuelo no pide lugar; sólo arrancar uno.
  it('🔴 con el tope lleno, una lectura de la MISMA llave se une al cálculo en vuelo (no se rechaza)', async () => {
    const cache = nueva()
    const limiter = new PollWorkLimiter(1)
    const d = diferida<string>()
    const calcular = jest.fn(() => d.promesa)
    const primera = cache.get('k', calcular, { limiter })
    expect(limiter.enVuelo).toBe(1) // el único lugar ya está tomado…
    const segunda = cache.get('k', calcular, { limiter }) // …y aun así ésta no se rechaza
    d.resolver('v')
    await expect(Promise.all([primera, segunda])).resolves.toEqual(['v', 'v'])
    expect(calcular).toHaveBeenCalledTimes(1)
    expect(limiter.enVuelo).toBe(0)
  })

  // Fix round 1 (#3b, Review Focus #6): anular un vuelo no detiene su lectura en la base; su lugar sigue contado.
  it('🔴 refresh no le quita el lugar al cálculo que reemplaza: sigue ocupado hasta que ése termina', async () => {
    const cache = nueva()
    const limiter = new PollWorkLimiter(1)
    const viejo = diferida<string>()
    const lectura = cache.get('k', () => viejo.promesa, { limiter })
    const calcular = jest.fn(async () => 'nuevo')
    const fresco = cache.refresh('k', calcular)
    expect(calcular).toHaveBeenCalledTimes(1) // en sincronía: si se uniera al vuelo viejo, cae aquí y no por tiempo
    await expect(fresco).resolves.toBe('nuevo')
    expect(limiter.enVuelo).toBe(1) // la lectura vieja sigue tocando la base
    await expect(cache.get('otra', async () => 'x', { limiter })).rejects.toBeInstanceOf(PollWorkSaturated)
    viejo.resolver('viejo')
    await expect(lectura).resolves.toBe('viejo')
    expect(limiter.enVuelo).toBe(0)
  })

  // 🔴 El orden que importa: lo fresco nunca queda debajo de lo viejo.
  it('refresh no se une al cálculo en vuelo, y el cálculo VIEJO no pisa lo nuevo al terminar', async () => {
    const cache = nueva()
    const viejo = diferida<string>()
    const lectura = cache.get('k', () => viejo.promesa)
    const calcular = jest.fn(async () => 'nuevo')
    const fresco = cache.refresh('k', calcular)
    expect(calcular).toHaveBeenCalledTimes(1) // en sincronía: si se uniera al vuelo viejo, cae aquí y no por tiempo
    await expect(fresco).resolves.toBe('nuevo')
    viejo.resolver('viejo')
    await expect(lectura).resolves.toBe('viejo') // quien lo pidió recibe lo suyo…
    await vaciarMicrotareas()
    expect(cache.peek('k')).toBe('nuevo') // …pero no se guarda encima de lo nuevo
  })

  it('sin nada guardado todavía: después de un refresh, una lectura nueva se une a lo NUEVO, nunca al cálculo viejo', async () => {
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

  // Fix round 1 (#4): lo que dice el JSDoc de `refresh`, con prueba.
  it('con algo guardado: mientras corre un refresh, get sigue entregando lo guardado antes', async () => {
    const cache = nueva()
    await cache.get('k', async () => 'guardado')
    const nuevo = diferida<string>()
    const fresco = cache.refresh('k', () => nuevo.promesa)
    const otra = jest.fn(async () => 'no-debe-calcular')
    const lectura = cache.get('k', otra)
    nuevo.resolver('nuevo')
    await expect(lectura).resolves.toBe('guardado')
    expect(otra).not.toHaveBeenCalled()
    await expect(fresco).resolves.toBe('nuevo')
    await vaciarMicrotareas()
    expect(cache.peek('k')).toBe('nuevo') // y al terminar, lo nuevo reemplaza a lo guardado
  })

  // 🔴 Ruling de la Task 6: tras una edición, las N tablets del venue piden refresh casi a la vez. Sin unirse, eran N
  // construcciones idénticas fuera del pool. Con la ventana: a lo más una nueva por llave cada REFRESH_COALESCE_MS.
  describe('refresh se une a un refresh RECIENTE de la misma llave (ventana REFRESH_COALESCE_MS)', () => {
    it.each([0, REFRESH_COALESCE_MS])('iniciado hace %p ms: UN cálculo, el mismo resultado para los dos', async transcurrido => {
      const cache = nueva()
      const d = diferida<string>()
      const calcular = jest.fn(() => d.promesa)
      const otra = jest.fn(async () => 'no-debe-calcular')
      const primero = cache.refresh('k', calcular)
      reloj += transcurrido
      const segundo = cache.refresh('k', otra)
      d.resolver('v')
      await expect(Promise.all([primero, segundo])).resolves.toEqual(['v', 'v'])
      expect(calcular).toHaveBeenCalledTimes(1)
      expect(otra).not.toHaveBeenCalled()
    })

    it('iniciado hace MÁS de la ventana: lo anula y arranca otro; el viejo no pisa lo nuevo, y uno anulado nunca se comparte', async () => {
      const cache = nueva()
      const viejo = diferida<string>()
      const nuevo = diferida<string>()
      const primero = cache.refresh('k', () => viejo.promesa)
      reloj += REFRESH_COALESCE_MS + 1
      const calcularNuevo = jest.fn(() => nuevo.promesa)
      const segundo = cache.refresh('k', calcularNuevo)
      expect(calcularNuevo).toHaveBeenCalledTimes(1)
      reloj += 1
      const tercera = jest.fn(async () => 'no-debe-calcular')
      const tercero = cache.refresh('k', tercera) // dentro de la ventana del SEGUNDO: se une a él, nunca al anulado
      nuevo.resolver('nuevo')
      viejo.resolver('viejo')
      await expect(Promise.all([primero, segundo, tercero])).resolves.toEqual(['viejo', 'nuevo', 'nuevo'])
      expect(tercera).not.toHaveBeenCalled()
      await vaciarMicrotareas()
      expect(cache.peek('k')).toBe('nuevo')
    })

    it('🔴 NO se une a un get (con tope) en vuelo, aunque haya empezado en el mismo instante: lo anula y arranca otro', async () => {
      const cache = nueva()
      const limiter = new PollWorkLimiter(2)
      const viejo = diferida<string>()
      const lectura = cache.get('k', () => viejo.promesa, { limiter })
      const calcular = jest.fn(async () => 'nuevo')
      const fresco = cache.refresh('k', calcular)
      expect(calcular).toHaveBeenCalledTimes(1) // en sincronía: si se uniera al get, cae aquí y no por tiempo
      viejo.resolver('viejo')
      await expect(fresco).resolves.toBe('nuevo')
      await expect(lectura).resolves.toBe('viejo')
      await vaciarMicrotareas()
      expect(cache.peek('k')).toBe('nuevo')
    })

    it('el error del refresh al que se unieron llega a los DOS y no se guarda', async () => {
      const cache = nueva()
      const d = diferida<string>()
      const otra = jest.fn(async () => 'no-debe-calcular')
      const primero = cache.refresh('k', () => d.promesa)
      reloj += 1
      const segundo = cache.refresh('k', otra)
      d.rechazar(new Error('base caída'))
      await expect(primero).rejects.toThrow('base caída')
      await expect(segundo).rejects.toThrow('base caída')
      expect(otra).not.toHaveBeenCalled()
      await vaciarMicrotareas()
      expect(cache.peek('k')).toBeUndefined()
      expect(cache.sizeForTests().enVuelo).toBe(0)
      await expect(cache.refresh('k', async () => 'ya')).resolves.toBe('ya') // y el siguiente vuelve a calcular
    })
  })

  it('tiene tope: por muchas llaves que se lean, no pasa de maxEntradas', async () => {
    const cache = nueva(3)
    for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => `v${i}`)
    expect(cache.sizeForTests().entradas).toBeLessThanOrEqual(3)
    expect(cache.peek('k9')).toBe('v9') // se van las más viejas, no la recién guardada
  })

  // Fix round 1 (#2): con 0 la purga borraría de un mapa vacío para siempre y congelaría el proceso.
  it.each([0, -1, 1.5, NaN])('un maxEntradas que no es entero ≥ 1 (%p) se rechaza al construir', maxEntradas => {
    expect(() => new SingleFlightCache<string>({ ttlMs: 60_000, maxEntradas })).toThrow(RangeError)
  })

  it('maxEntradas 1 es válido: guarda sólo la última', async () => {
    const cache = nueva(1)
    await cache.get('a', async () => 'A')
    await cache.get('b', async () => 'B')
    expect(cache.sizeForTests().entradas).toBe(1)
    expect(cache.peek('b')).toBe('B')
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

  // Fix round 1 (#1): `alFallar` sólo reporta; si él mismo truena, la huella sigue siendo «omitida», no un error.
  it('🔴 un alFallar que truena ANTES del plazo no convierte la huella omitida en un error', async () => {
    const alFallar = jest.fn(() => {
      throw new Error('el reporte falló')
    })
    const r = await dentroDelPlazo({ mala: Promise.reject(new Error('x')), buena: Promise.resolve('B') }, 150, {
      esperar: () => new Promise(() => {}),
      alFallar,
    })
    expect(r).toEqual({ buena: 'B' })
    expect(alFallar).toHaveBeenCalledWith('mala', expect.any(Error))
  })

  // Fix round 1 (#3c, Review Focus #6): en el camino rápido no queda un temporizador vivo por cada poll.
  it('🔴 si todo llega antes, el reloj del plazo se apaga (no queda ningún temporizador)', async () => {
    jest.useFakeTimers()
    try {
      const r = await dentroDelPlazo({ a: Promise.resolve('A') }, 150)
      expect(r).toEqual({ a: 'A' })
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})

it('🔴 el tope del proceso es 8 (decisión 2: el pool de Prisma es de 18 conexiones para TODO el proceso)', () => {
  expect(POLL_WORK_MAX_IN_FLIGHT).toBe(8)
  expect(pollWorkLimiter.enVuelo).toBe(0) // nadie lo deja ocupado al cargar el módulo
})

it('la ventana de refresh es de 2 s (ruling de la Task 6: ≤ 1 construcción nueva por llave cada 2 s; la Task 13 la mide)', () => {
  expect(REFRESH_COALESCE_MS).toBe(2_000)
})

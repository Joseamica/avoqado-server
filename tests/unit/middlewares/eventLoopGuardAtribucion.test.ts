/**
 * Qué puede AFIRMAR el guardia sobre una retención del hilo.
 *
 * El guardia ya decía cuánto se retuvo el hilo y qué peticiones esperaban. Eso no basta:
 * `topInFlight` fotografía a quien ESPERABA, no a quien EJECUTABA. Medido en producción el
 * 2026-09-21 — 1,849 retenciones en 10 h, ~500 ms cada una, repartidas entre rutas sin nada
 * en común y 41 de ellas sin una sola petición en vuelo — leer ese log llevaba a culpar a la
 * víctima.
 *
 * 🔴 Y la trampa que casi se despliega: las pausas del recolector se entregan de forma
 * ASÍNCRONA, así que durante una retención el hilo no puede entregarlas y llegan DESPUÉS.
 * Medido el 2026-09-22: de 72 entradas producidas dentro de un bloqueo de 616 ms, las 72 se
 * entregaron al terminar, una con 602 ms de retraso. Un acumulador por momento de entrega
 * habría dicho `gcMs≈0` justo en el tramo que fue GC — y habría cargado ese GC al tramo
 * siguiente, que estuvo limpio. De ahí que las pausas se guarden con SUS tiempos y que el
 * aviso se emita un tick después.
 */
import logger from '@/config/logger'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import {
  evaluarSenal,
  gcEnVentana,
  startEventLoopMonitor,
  eventLoopGuardMiddleware,
  __resetInFlightForTests,
  type ObservadorDeGc,
} from '@/middlewares/eventLoopGuard.middleware'
import { crearRegistroDeJobs } from '@/observability/registroDeJobs'

const avisos = () => (logger.warn as jest.Mock).mock.calls.map(c => c[1])

function fakeReqRes(method: string, url: string) {
  const res = { on: (_e: string, _cb: () => void) => {} }
  return { req: { method, originalUrl: url } as never, res: res as never }
}

/** Reloj y observador controlados: la atribución no puede depender de una corrida afortunada. */
function bancoDePruebas() {
  let t = 1000
  let cpuUs = 0
  const pausas: Array<{ inicioMs: number; finMs: number }> = []
  let descartadas = 0
  const observador: ObservadorDeGc = {
    pausas: () => pausas,
    descartadas: () => descartadas,
    purgar: limite => {
      for (let i = pausas.length - 1; i >= 0; i -= 1) if (pausas[i].finMs < limite) pausas.splice(i, 1)
    },
    detener: () => {},
  }
  return {
    observador,
    ahoraMs: () => t,
    cpuAcumulada: () => ({ user: cpuUs, system: 0 }),
    /** Avanza el reloj y, opcionalmente, la CPU consumida en ese tramo (en ms). */
    avanzar: (ms: number, cpuMs = 0) => {
      t += ms
      cpuUs += cpuMs * 1000
    },
    /** Simula la ENTREGA tardía: la pausa ocurrió antes, pero sólo ahora es visible. */
    entregarPausa: (inicioMs: number, finMs: number) => pausas.push({ inicioMs, finMs }),
    pausasVivas: () => pausas.length,
    /** Simula que el buffer se truncó y tiró pausas: el aviso ya no puede decirse completo. */
    truncarBuffer: (cuantas: number) => (descartadas += cuantas),
  }
}

describe('evaluarSenal (pura: sin reloj, sin estado)', () => {
  it('llama gc-dominante cuando el recolector ocupó la mayor parte del tramo', () => {
    expect(evaluarSenal({ elapsedMs: 500, cpuMs: 480, gcMs: 460, gcConfiable: true })).toBe('gc-dominante')
  })

  it('llama cpu-alta cuando hubo CPU y el GC no domina', () => {
    expect(evaluarSenal({ elapsedMs: 520, cpuMs: 505, gcMs: 4, gcConfiable: true })).toBe('cpu-alta')
  })

  it('llama cpu-baja cuando el proceso no consumió CPU', () => {
    expect(evaluarSenal({ elapsedMs: 500, cpuMs: 12, gcMs: 0, gcConfiable: true })).toBe('cpu-baja')
  })

  it('SIN GC confiable, la CPU alta es INDETERMINADA: no se puede separar del recolector', () => {
    // Éste es el punto que costó un rechazo: afirmar «cpu-propia» sin haber medido el GC es
    // exactamente el error que la instrumentación venía a corregir.
    expect(evaluarSenal({ elapsedMs: 500, cpuMs: 490, gcMs: 0, gcConfiable: false })).toBe('indeterminada')
  })

  it('SIN GC confiable y sin CPU, la señal cpu-baja sólo reporta el hecho medido', () => {
    expect(evaluarSenal({ elapsedMs: 500, cpuMs: 5, gcMs: 0, gcConfiable: false })).toBe('cpu-baja')
  })

  it('no divide entre cero', () => {
    expect(evaluarSenal({ elapsedMs: 0, cpuMs: 0, gcMs: 0, gcConfiable: true })).toBe('indeterminada')
  })

  it('tolera cpuMs MAYOR que el tramo: process.cpuUsage() suma todos los hilos', () => {
    // Medido con GC real: elapsed=1535, cpu=6562 (4.3 núcleos en una Mac de 10). El cociente
    // pasa de 1 y no es un error — por eso la señal se llama `cpu-alta` y no «culpable».
    expect(evaluarSenal({ elapsedMs: 1535, cpuMs: 6562, gcMs: 200, gcConfiable: true })).toBe('cpu-alta')
    expect(evaluarSenal({ elapsedMs: 1535, cpuMs: 6562, gcMs: 925, gcConfiable: true })).toBe('gc-dominante')
  })
})

describe('gcEnVentana (pura)', () => {
  it('cuenta sólo la parte de la pausa que cae dentro de la ventana', () => {
    expect(gcEnVentana([{ inicioMs: 90, finMs: 130 }], 100, 200)).toBe(30) // entra a caballo
    expect(gcEnVentana([{ inicioMs: 180, finMs: 260 }], 100, 200)).toBe(20) // sale a caballo
    expect(gcEnVentana([{ inicioMs: 120, finMs: 160 }], 100, 200)).toBe(40) // dentro
  })

  it('ignora las pausas de OTROS tramos', () => {
    expect(gcEnVentana([{ inicioMs: 10, finMs: 90 }], 100, 200)).toBe(0)
    expect(gcEnVentana([{ inicioMs: 210, finMs: 300 }], 100, 200)).toBe(0)
  })

  it('suma varias pausas del mismo tramo', () => {
    expect(gcEnVentana([{ inicioMs: 110, finMs: 130 }, { inicioMs: 150, finMs: 190 }], 100, 200)).toBe(60)
  })

  it('NO cuenta dos veces dos pausas que se solapen entre sí', () => {
    // Medido: V8 no solapa sus pausas (0 de 97 pares). Pero sumar a ciegas dejaría `gcMs`
    // a merced de esa suposición, y pasarse del tramo fabricaría un `gc-dominante` falso.
    expect(gcEnVentana([{ inicioMs: 110, finMs: 160 }, { inicioMs: 140, finMs: 180 }], 100, 200)).toBe(70)
    // Contenida dentro de otra: aporta cero extra.
    expect(gcEnVentana([{ inicioMs: 110, finMs: 190 }, { inicioMs: 130, finMs: 150 }], 100, 200)).toBe(80)
    // Pegadas: un solo intervalo, sin huecos inventados.
    expect(gcEnVentana([{ inicioMs: 110, finMs: 150 }, { inicioMs: 150, finMs: 170 }], 100, 200)).toBe(60)
  })

  it('nunca devuelve más GC que el tamaño de la ventana', () => {
    const muchas = Array.from({ length: 50 }, () => ({ inicioMs: 100, finMs: 200 }))
    expect(gcEnVentana(muchas, 100, 200)).toBe(100)
  })
})

describe('el aviso se emite un tick DESPUÉS, con las pausas ya entregadas', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it('atribuye al GC un tramo cuyas pausas llegaron tarde (y no lo llama cpu-alta)', () => {
    const b = bancoDePruebas()
    const { req, res } = fakeReqRes('GET', '/api/v1/tpv/sales-goals')
    eventLoopGuardMiddleware(req, res, jest.fn())

    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })

    // Tick 1 — el hilo estuvo retenido 500 ms (1000 → 1520). Aún no llegó ninguna pausa.
    b.avanzar(520)
    jest.advanceTimersByTime(20)
    expect(avisos()).toHaveLength(0) // todavía no: se espera a las pausas

    // Ahora el hilo se liberó y el observador entrega las pausas DEL TRAMO ANTERIOR.
    b.entregarPausa(1100, 1500) // 400 ms de GC dentro de [1000, 1520]
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a).toHaveLength(1)
    expect(a[0].gcMs).toBe(400)
    expect(a[0].senal).toBe('gc-dominante') // 400/520 ≥ 0.5
    expect(a[0].blockedMs).toBe(500)
    expect(a[0].gcVentanaCompleta).toBe(true)
  })

  it('NO carga al tramo siguiente el GC de un tramo anterior', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })

    // Tramo 1: retención con GC de verdad.
    b.avanzar(520)
    jest.advanceTimersByTime(20)
    b.entregarPausa(1100, 1500)

    // Tramo 2: otra retención, esta vez SIN GC. Se emite el tramo 1 y se guarda el 2.
    b.avanzar(520)
    jest.advanceTimersByTime(20)
    // Tramo 3 (corto) para que se emita el tramo 2.
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a).toHaveLength(2)
    expect(a[0].gcMs).toBe(400) // el primero sí fue GC
    expect(a[1].gcMs).toBe(0) // 🔴 el segundo NO hereda el GC del primero
    expect(a[1].senal).not.toBe('gc-dominante')
    stop()
  })

  it('al detener el monitor, un tramo sin emitir sale marcado como ventana INCOMPLETA', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })
    b.avanzar(520, 500) // 500 ms de CPU en un tramo de 520: CPU alta
    jest.advanceTimersByTime(20)
    expect(avisos()).toHaveLength(0)

    stop() // se cierra con un tramo pendiente: no se pierde, pero se dice que está incompleto

    const a = avisos()
    expect(a).toHaveLength(1)
    expect(a[0].gcVentanaCompleta).toBe(false)
    // CPU alta pero sin poder descartar el GC ⇒ se dice INDETERMINADA en vez de culpar al código.
    expect(a[0].senal).toBe('indeterminada')
  })

  it('si el buffer se trunca MIENTRAS el tramo espera, el aviso deja de decirse completo', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })

    b.avanzar(520, 500) // tramo retenido CON cpu alta: queda pendiente de emitir
    jest.advanceTimersByTime(20)

    // Antes de que se emita, el buffer se llena y tira pausas — puede haber tirado las SUYAS.
    b.truncarBuffer(7)
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a).toHaveLength(1)
    expect(a[0].gcVentanaCompleta).toBe(false) // 🔴 gcMs es un piso, no el total
    expect(a[0].gcPausasDescartadas).toBe(7)
    expect(a[0].senal).toBe('indeterminada') // y no se afirma una causa con datos incompletos
    stop()
  })

  it('purga las pausas ya usadas para que el buffer no crezca sin fin (con el FALSO)', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })
    b.avanzar(520)
    jest.advanceTimersByTime(20)
    b.entregarPausa(1100, 1500)
    expect(b.pausasVivas()).toBe(1)

    b.avanzar(20)
    jest.advanceTimersByTime(20) // emite el tramo y purga lo anterior a su fin

    expect(b.pausasVivas()).toBe(0)
    stop()
  })
})

describe('el buffer PRODUCTIVO de pausas (determinista, sin depender de que ocurra GC)', () => {
  it('acumula pausas con sus tiempos y las purga por límite', async () => {
    const { crearBufferDePausas } = await import('@/middlewares/eventLoopGuard.middleware')
    const b = crearBufferDePausas(10)

    b.agregar({ inicioMs: 100, finMs: 120 })
    b.agregar({ inicioMs: 130, finMs: 180 })
    expect(b.pausas()).toEqual([
      { inicioMs: 100, finMs: 120 },
      { inicioMs: 130, finMs: 180 },
    ])
    expect(b.descartadas()).toBe(0)

    b.purgar(125) // sólo sobrevive lo que termina en o después del corte
    expect(b.pausas()).toEqual([{ inicioMs: 130, finMs: 180 }])
  })

  it('al pasar del tope tira las MÁS VIEJAS y CUENTA cuántas tiró', () => {
    // Es el hallazgo que costó un rechazo: truncar en silencio deja un `gcMs` incompleto que
    // el aviso presentaba como completo. El contador es lo que permite invalidar la ventana.
    const { crearBufferDePausas } = jest.requireActual<typeof import('@/middlewares/eventLoopGuard.middleware')>(
      '@/middlewares/eventLoopGuard.middleware',
    )
    const b = crearBufferDePausas(3)
    for (let i = 0; i < 5; i += 1) b.agregar({ inicioMs: i * 10, finMs: i * 10 + 5 })

    expect(b.pausas()).toHaveLength(3)
    expect(b.descartadas()).toBe(2)
    expect(b.pausas()[0]).toEqual({ inicioMs: 20, finMs: 25 }) // se fueron las dos primeras
  })

  it('el observador real se instala y expone la misma forma', async () => {
    const { observarPausasDeGc } = await import('@/middlewares/eventLoopGuard.middleware')
    const obs = observarPausasDeGc()
    expect(obs).not.toBeNull()
    if (!obs) return
    // Sin aserciones sobre CUÁNTO GC ocurra: eso depende de la carga de la máquina y volvería
    // la prueba intermitente. Lo determinista se cubre arriba, sobre el mismo buffer.
    expect(Array.isArray(obs.pausas())).toBe(true)
    expect(typeof obs.descartadas()).toBe('number')
    obs.detener()
  })
})

describe('el guardia nunca tumba el proceso', () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock('node:perf_hooks')
  })

  it('arranca aunque INSTALAR el observador lance', async () => {
    jest.resetModules()
    const intentos: string[][] = []
    jest.doMock('node:perf_hooks', () => {
      const real = jest.requireActual('node:perf_hooks')
      return {
        ...real,
        PerformanceObserver: class {
          observe(opciones: { entryTypes: string[] }) {
            intentos.push(opciones.entryTypes)
            throw new Error('este runtime no admite entryTypes: gc')
          }
          disconnect() {}
        },
      }
    })
    const guardia = await import('@/middlewares/eventLoopGuard.middleware')

    // `observarGc: true` explícito: si el entorno trajera EVENT_LOOP_GC_OBSERVER=off, la
    // prueba pasaría sin haber intentado instalar nada y no probaría el try/catch.
    const stop = guardia.startEventLoopMonitor({ thresholdMs: 50, sampleIntervalMs: 5, observarGc: true })
    expect(typeof stop).toBe('function')
    expect(intentos).toEqual([['gc']]) // se INTENTÓ instalar, y el fallo quedó contenido
    stop()
  })

  it('EVENT_LOOP_GC_OBSERVER=off lo apaga y el aviso lo DICE', async () => {
    const previo = process.env.EVENT_LOOP_GC_OBSERVER
    process.env.EVENT_LOOP_GC_OBSERVER = 'off'
    jest.resetModules()
    const guardia = await import('@/middlewares/eventLoopGuard.middleware')
    const registro = (await import('@/config/logger')).default as unknown as { warn: jest.Mock }
    registro.warn.mockClear()

    jest.useFakeTimers()
    let t = 0
    let cpuUs = 0
    let usado = false
    const stop = guardia.startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      ahoraMs: () => t,
      cpuAcumulada: () => ({ user: cpuUs, system: 0 }),
      observadorDeGc: {
        pausas: () => ((usado = true), []),
        descartadas: () => 0,
        purgar: () => {},
        detener: () => {},
      },
    })
    t += 520
    cpuUs += 500_000 // CPU alta: sin observador de GC no se puede saber si fue el recolector
    jest.advanceTimersByTime(20)
    t += 20
    jest.advanceTimersByTime(20)
    stop()
    jest.useRealTimers()

    const meta = registro.warn.mock.calls[0]?.[1]
    expect(usado).toBe(false) // el interruptor gana sobre la costura
    expect(meta.gcObservado).toBe(false)
    expect(meta.senal).toBe('indeterminada') // lo dice, no inventa una causa
    process.env.EVENT_LOOP_GC_OBSERVER = previo
  })
})

/**
 * 🔴 Tercera pasada de Codex (2026-09-22): la protección contra el truncamiento tenía un hueco
 * por el LADO CONTRARIO al que se cerró en la segunda.
 *
 * La referencia de descartes se tomaba en el tick que DETECTA el tramo, o sea al final. Pero el
 * observador puede entregar —y con ello truncar— ANTES de que el temporizador consiga correr:
 * el callback del `PerformanceObserver` no hace fila detrás de los `setInterval`. Codex lo
 * reprodujo con el buffer productivo y su tope real: un tramo de 520 ms con 450 ms de GC, con
 * una pausa de 400 ms descartada antes de la detección, salía diciendo `gcMs:50` ·
 * `gcVentanaCompleta:true` · `gcPausasDescartadas:0`. O sea, el aviso mentía con confianza justo
 * en el caso que la defensa existía para cubrir.
 *
 * La ventana de vigilancia correcta va desde que ABRE el tramo hasta que se emite, no desde que
 * se detecta.
 */
describe('los descartes se vigilan desde que ABRE el tramo, no desde que se detecta', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it('un descarte ocurrido ANTES del tick detector invalida igual la ventana', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })

    // El hilo estuvo retenido 500 ms (1000 → 1520) con mucho GC. Al liberarse, el observador
    // entrega sus pausas y el buffer TRUNCA — todo eso ANTES de que el temporizador corra.
    b.avanzar(520, 300)
    b.entregarPausa(1450, 1500) // sólo sobreviven 50 ms de los 450 que hubo
    b.truncarBuffer(1) // la pausa grande del tramo se fue a la basura

    jest.advanceTimersByTime(20) // ahora sí: el tick que DETECTA el tramo
    b.avanzar(20)
    jest.advanceTimersByTime(20) // el tick que lo EMITE

    const a = avisos()
    expect(a).toHaveLength(1)
    expect(a[0].gcVentanaCompleta).toBe(false) // hubo pérdida: no puede decirse completa
    expect(a[0].gcPausasDescartadas).toBeGreaterThan(0) // y el aviso dice cuánta
    expect(a[0].senal).toBe('indeterminada') // con CPU alta y GC no confiable, no se atribuye
    stop()
  })

  it('sin ningún descarte, la ventana SIGUE declarándose completa (la defensa no es un apagón)', () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })

    b.avanzar(520, 300)
    b.entregarPausa(1100, 1500)
    jest.advanceTimersByTime(20)
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a[0].gcVentanaCompleta).toBe(true)
    expect(a[0].gcPausasDescartadas).toBe(0)
    expect(a[0].senal).toBe('gc-dominante')
    stop()
  })
})

/**
 * 🔴 Codex, 3ª pasada: probar `stop()` NO acredita que el servidor lo llame.
 *
 * El monitor arranca INCONDICIONALMENTE en `app.ts`, pero su cierre vivía dentro del bloque
 * `DEMO_MODE !== 'true'` y DESPUÉS de la salida rápida de desarrollo. Codex ejecutó la función
 * real de apagado con las dependencias simuladas y contó las llamadas: producción normal 1,
 * `DEMO_MODE=true` 0, desarrollo 0. En esos dos caminos un aviso pendiente —el tramo detectado
 * que espera un tick a sus pausas de GC— se pierde sin decir nada.
 *
 * Esta prueba mira el CABLEADO, no la función. Es el mismo patrón de guardia estático que el
 * repo ya usa para el contexto de ejecución (`jobContextGuard`, `multipartContext`).
 */
describe('el cableado del apagado llama al cierre del monitor en TODOS los caminos', () => {
  const fuente = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../src/server.ts'), 'utf8')

  it('se llama dentro de gracefulShutdown', () => {
    expect(fuente).toContain('detenerMonitorDeEventLoop()')
  })

  it('se llama ANTES de la salida rápida de desarrollo (que hace process.exit)', () => {
    const cierre = fuente.indexOf('detenerMonitorDeEventLoop()')
    const salidaDev = fuente.indexOf('Dev fast-exit on')
    expect(cierre).toBeGreaterThan(-1)
    expect(salidaDev).toBeGreaterThan(-1)
    expect(cierre).toBeLessThan(salidaDev)
  })

  it('NO vive dentro del bloque que se salta en modo demo', () => {
    const cierre = fuente.indexOf('detenerMonitorDeEventLoop()')
    const bloqueDemo = fuente.indexOf("process.env.DEMO_MODE !== 'true'")
    expect(bloqueDemo).toBeGreaterThan(-1)
    expect(cierre).toBeLessThan(bloqueDemo)
  })
})

/**
 * 🔴 Codex, 4ª pasada — y el hallazgo lo ABRIÓ mi propio arreglo del anterior.
 *
 * Al mover el cierre del monitor al principio de `gracefulShutdown` (para que los caminos de
 * demo y desarrollo dejaran de saltárselo), quedó ANTES del cierre del HTTP y de armar el plazo
 * máximo de 30 s. Si escribir el último aviso lanza —un transporte del logger caído, que es
 * justo lo que pasa mientras el proceso se apaga— la excepción se propagaba y frenaba el apagado
 * ENTERO. Codex lo ejecutó: observador desconectado sí, HTTP cerrado **no**, plazo máximo armado
 * **no**, proceso terminado **no**; y un segundo intento volvía a tropezar con el mismo tramo.
 *
 * El canje correcto es obvio dicho así: se pierde un aviso de diagnóstico, no el apagado.
 */
describe('detener el monitor nunca frena el apagado', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    // 🔴 `clearAllMocks` borra las LLAMADAS, no la implementación: sin esto, el logger que
    // lanza se filtra a los describes siguientes y los tumba por un motivo que no es el suyo.
    ;(logger.warn as jest.Mock).mockImplementation(() => {})
  })

  /** Deja un tramo detectado esperando su tick, que es el que `stop()` tiene que emitir. */
  const conTramoPendiente = () => {
    const b = bancoDePruebas()
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })
    b.avanzar(520, 300)
    jest.advanceTimersByTime(20) // detecta y guarda: queda pendiente de emitir
    return { b, stop }
  }

  it('si escribir el último aviso LANZA, stop() no propaga', () => {
    const { stop } = conTramoPendiente()
    ;(logger.warn as jest.Mock).mockImplementation(() => {
      throw new Error('transporte del logger caído')
    })

    expect(() => stop()).not.toThrow() // el apagado sigue: HTTP, plazo de 30 s y salida
  })

  it('…y aun así desconecta el observador', () => {
    const b = bancoDePruebas()
    let desconectado = false
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: { ...b.observador, detener: () => (desconectado = true) },
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
    })
    b.avanzar(520, 300)
    jest.advanceTimersByTime(20)
    ;(logger.warn as jest.Mock).mockImplementation(() => {
      throw new Error('transporte del logger caído')
    })

    stop()
    expect(desconectado).toBe(true) // si no, quedaría vivo sobre un monitor ya muerto
  })

  it('un SEGUNDO apagado no vuelve a tropezar con el mismo tramo', () => {
    const { stop } = conTramoPendiente()
    ;(logger.warn as jest.Mock).mockImplementation(() => {
      throw new Error('transporte del logger caído')
    })
    stop()

    const intentosDelPrimero = (logger.warn as jest.Mock).mock.calls.length
    stop()
    // El pendiente se retira ANTES de emitir: el segundo apagado no tiene nada que reintentar.
    expect((logger.warn as jest.Mock).mock.calls.length).toBe(intentosDelPrimero)
  })
})

/**
 * Y QUIÉN tenía el hilo: el aviso nombra los jobs del tramo.
 *
 * `topInFlight` sólo ve peticiones HTTP. Una retención de medio segundo que no corresponde a
 * ninguna ruta —el caso medido en producción: 41 de 1,849 retenciones sin una sola petición en
 * vuelo— apunta a un cron, y hasta ahora el aviso no tenía forma de decir cuál.
 *
 * 🔴 La cobertura es PARCIAL y el aviso lo DICE. Medido el 22-sep: 5 registros de scheduler no
 * pasan por el envoltorio (`server.ts` ×2, los dos de catálogo, `reviewSync`), `node-cron` queda
 * fuera a propósito, y varios jobs descartan su promesa con `=> void`, así que su tick «termina»
 * al instante aunque siga trabajando. Sin esa bandera, leer «ningún job» como «no fue un job»
 * sería la siguiente conclusión equivocada — exactamente el error que esta instrumentación vino
 * a corregir con `topInFlight`.
 */
describe('el aviso nombra los jobs que corrían en el tramo', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it('nombra al job que tenía el hilo, aunque haya TERMINADO antes del tick', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs })
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
      registroDeJobs: registro,
    })

    // Un barrido arranca, se come 450 ms de hilo y termina ANTES de que el tick pueda correr.
    const id = registro.iniciar('cash-drawer-reconciler')
    b.avanzar(450, 440)
    registro.terminar(id)
    b.avanzar(70)

    jest.advanceTimersByTime(20) // detecta
    b.avanzar(20)
    jest.advanceTimersByTime(20) // emite

    const a = avisos()
    expect(a).toHaveLength(1)
    expect(a[0].jobsEnVuelo).toEqual([{ nombre: 'cash-drawer-reconciler', ms: 450, vivo: false }])
    expect(a[0].jobsCoberturaParcial).toBe(true) // nunca se afirma que la lista sea completa
    stop()
  })

  it('sin ningún job, la lista va vacía y la bandera SIGUE puesta', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs })
    const stop = startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
      registroDeJobs: registro,
    })

    b.avanzar(520, 500)
    jest.advanceTimersByTime(20)
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a[0].jobsEnVuelo).toEqual([])
    // 🔴 Lo que impide la conclusión equivocada: «ningún job» ≠ «no fue un job».
    expect(a[0].jobsCoberturaParcial).toBe(true)
    stop()
  })
})

/**
 * 🔴 Codex: el historial podía BORRAR la evidencia de un tramo ya detectado.
 *
 * Los jobs se consultaban al EMITIR, un tick después de detectar. Codex lo reprodujo sobre el
 * guardia real: un job se come 450 ms, se detecta la retención, terminan otros 200 ticks antes
 * de emitir, y el aviso sale con `jobsEnVuelo: []` — el culpable, borrado por el recorte.
 *
 * La causa de diferir la emisión eran las pausas de GC, que llegan TARDE. Los jobs no: un tick
 * terminado ya está en el historial en el momento de detectar. Así que se fotografían ahí, y el
 * recorte posterior ya no puede llevárselos.
 */
describe('los jobs se fotografían al DETECTAR el tramo, no al emitirlo', () => {
  beforeEach(() => {
    __resetInFlightForTests()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  const montar = (b: ReturnType<typeof bancoDePruebas>, registro: ReturnType<typeof crearRegistroDeJobs>) =>
    startEventLoopMonitor({
      thresholdMs: 100,
      sampleIntervalMs: 20,
      observadorDeGc: b.observador,
      ahoraMs: b.ahoraMs,
      cpuAcumulada: b.cpuAcumulada,
      registroDeJobs: registro,
    })

  it('un aluvión de ticks entre detectar y emitir NO borra al job del tramo', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs, maxHistorial: 5 })
    const stop = montar(b, registro)

    const culpable = registro.iniciar('barrido-culpable')
    b.avanzar(450, 440)
    registro.terminar(culpable)
    b.avanzar(70)
    jest.advanceTimersByTime(20) // DETECTA el tramo

    // Entre la detección y el aviso pasan muchos ticks cortos que desbordan el historial.
    for (let i = 0; i < 20; i += 1) {
      const id = registro.iniciar(`ruido-${i}`)
      b.avanzar(1)
      registro.terminar(id)
    }

    b.avanzar(20)
    jest.advanceTimersByTime(20) // EMITE

    const a = avisos()
    expect(a[0].jobsEnVuelo.map((j: { nombre: string }) => j.nombre)).toContain('barrido-culpable')
    stop()
  })

  it('dice cuántos candidatos quedaron FUERA del tope de cinco', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs })
    const stop = montar(b, registro)

    for (let i = 0; i < 9; i += 1) registro.iniciar(`job-${i}`)
    b.avanzar(520, 500)
    jest.advanceTimersByTime(20)
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a[0].jobsEnVuelo).toHaveLength(5)
    // Sin esto, «cinco jobs» se leería como «sólo había cinco».
    expect(a[0].jobsOmitidos).toBe(4)
    stop()
  })

  it('🔴 el ruido POSTERIOR a la foto no infla el contador de evidencia perdida', () => {
    // Codex: la lista se congela al detectar, pero el contador se leía al emitir. Ruido de por
    // medio recortaba el historial y el aviso declaraba una pérdida que su foto no tenía.
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs, maxHistorial: 2 })
    const stop = montar(b, registro)

    const culpable = registro.iniciar('culpable')
    b.avanzar(450, 440)
    registro.terminar(culpable)
    b.avanzar(70)
    jest.advanceTimersByTime(20) // DETECTA y fotografía: la evidencia está completa

    for (let i = 0; i < 10; i += 1) {
      const id = registro.iniciar(`ruido-${i}`)
      b.avanzar(1)
      registro.terminar(id)
    }
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a[0].jobsEnVuelo.map((j: { nombre: string }) => j.nombre)).toContain('culpable')
    expect(a[0].jobsRastrosPerdidos).toBe(0) // su foto no perdió nada
    stop()
  })

  it('🔴 una expulsión ANTERIOR sigue declarándose: seguimos ciegos respecto de ese trabajo', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs, maxActivos: 1 })
    const stop = montar(b, registro)

    registro.iniciar('colgado-que-nadie-ve') // se expulsa al entrar el siguiente
    registro.iniciar('el-que-queda')
    b.avanzar(30)
    jest.advanceTimersByTime(20) // un tramo NORMAL de por medio
    b.avanzar(520, 500)
    jest.advanceTimersByTime(20) // ahora sí, el tramo lento
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    // El delta por tramo diría 0 y afirmaría que se ve todo. El acumulado no deja mentir.
    expect(a[0].jobsActivosExpulsados).toBe(1)
    stop()
  })

  it('declara cuando se perdió el rastro de algún tick del tramo', () => {
    const b = bancoDePruebas()
    const registro = crearRegistroDeJobs({ ahoraMs: b.ahoraMs, maxHistorial: 2 })
    const stop = montar(b, registro)

    for (let i = 0; i < 6; i += 1) {
      const id = registro.iniciar(`t-${i}`)
      b.avanzar(80, 80)
      registro.terminar(id)
    }
    b.avanzar(60)
    jest.advanceTimersByTime(20)
    b.avanzar(20)
    jest.advanceTimersByTime(20)

    const a = avisos()
    expect(a[0].jobsRastrosPerdidos).toBeGreaterThan(0)
    stop()
  })
})

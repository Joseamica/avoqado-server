/**
 * Guardia de retención del event loop.
 *
 * Node atiende de uno en uno. Cuando un handler hace CPU síncrono, todas las demás
 * peticiones esperan formadas. El 2026-08-04 eso llevó a `/dashboard/auth/status` —que no
 * hace nada pesado— a tardar 33.7 s mientras la pantalla de Ventas de PlayTelecom hacía
 * cuentas fila por fila.
 *
 * El guardia NO previene y NO nombra culpables: detecta, mide y deja PISTAS. Anota qué
 * peticiones estaban en vuelo y cuánta CPU y cuánto GC hubo en el tramo. Lo que sale de ahí
 * son señales (`senal`), no causas demostradas — `topInFlight` lista a quien ESPERABA, que
 * no tiene por qué ser quien ejecutaba.
 *
 * 🔴 NO es duplicado del `eventLoopHistogram` de `app.ts:52`. Son dos cosas distintas y
 * ninguna sustituye a la otra:
 *
 *   - `eventLoopHistogram` (`monitorEventLoopDelay`) alimenta el tablero de superadmin con
 *     estadísticas agregadas (`lagMs`, `lagP99Ms`, `lagMaxMs` en `app.ts:277`). NUNCA se
 *     resetea, así que su `max` es el máximo histórico desde que arrancó el proceso — tras
 *     el incidente del 2026-08-04 marcaría 33,000 ms hasta el siguiente deploy. Sirve para
 *     mirar, no para alertar. Y resetearlo aquí rompería ese endpoint.
 *   - Este guardia responde otra pregunta: *¿QUIÉN* está reteniendo el hilo ahora mismo?
 *     Eso el histograma no lo sabe: es un número global, sin ruta.
 *
 * Si algún día se unifican, hay que resolver primero el conflicto de reset.
 *
 * 🔴 Nota de operación (2026-08-04): los 4 monitores de uptime de Better Stack están
 * PAUSADOS desde el 26-jun-2026, y ninguna de las 5 alertas configuradas vigila lentitud
 * (todas miran errores; un 200 OK de 33 s les es invisible). Mientras eso siga así, este
 * log es la ÚNICA vía de enterarse. Ver §6.2 del spec.
 */
import type { Request, Response, NextFunction } from 'express'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import logger from '../config/logger'
import { redactUrlSecrets } from './requestLogger'
import {
  registroDeJobs as registroGlobalDeJobs,
  type RegistroDeJobs,
  type JobEnVentana,
} from '../observability/registroDeJobs'

/**
 * Umbral de aviso en producción.
 *
 * Más flojo que el de CI (50 ms, ver `eventLoopBudget.ts`) a propósito: en CI un falso
 * positivo cuesta rehacer un test; en producción cuesta que la gente aprenda a ignorar las
 * alertas, y una alerta ignorada no sirve de nada. Se aprieta cuando el ruido de las
 * primeras semanas esté medido.
 */
const PROD_ALERT_THRESHOLD_MS = Number(process.env.EVENT_LOOP_ALERT_MS) || 200

const DEFAULT_SAMPLE_INTERVAL_MS = 20

/**
 * Interruptor de emergencia del observador de GC, sin deploy.
 *
 * 🔴 Su costo NO está cuantificado. Se intentó tres veces en una Mac cargada y el ruido se
 * comió la señal: una corrida inválida (0 eventos observados), una con +19.7 % que resultó
 * artefacto del orden, y una alternada con −44 % y crudos de 2,869 ms contra medianas de 110.
 * No hay medición en Node 20 ni con la cuota de CPU de Render. Por eso existe el interruptor:
 * `EVENT_LOOP_GC_OBSERVER=off` lo apaga sin deploy y el guardia sigue avisando igual (pierde
 * la separación GC/CPU, y el aviso lo dice con `gcObservado:false`). Se lee al importar, así
 * que cambiarlo exige reiniciar el proceso.
 */
const GC_OBSERVER_HABILITADO = (process.env.EVENT_LOOP_GC_OBSERVER ?? 'on').toLowerCase() !== 'off'

/** Tope duro del registro. Si algo dejara de emitir 'finish', esto evita una fuga de memoria. */
const MAX_TRACKED_REQUESTS = 500

interface InFlightRequest {
  method: string
  url: string
  startedAt: number
}

const inFlight = new Map<symbol, InFlightRequest>()

/**
 * Anota la petición mientras está en vuelo.
 *
 * Nunca estorba: pase lo que pase llama a `next()`. Un guardia de observabilidad jamás
 * puede ser la razón por la que una petición falla — menos aún en el camino de cobro.
 */
export function eventLoopGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = Symbol('req')

  if (inFlight.size >= MAX_TRACKED_REQUESTS) {
    const oldest = inFlight.keys().next()
    if (!oldest.done) inFlight.delete(oldest.value)
  }

  inFlight.set(key, {
    method: req.method,
    url: req.originalUrl ?? (req as unknown as { url?: string }).url ?? 'desconocida',
    startedAt: Date.now(),
  })

  const release = () => {
    inFlight.delete(key)
  }
  res.on('finish', release)
  res.on('close', release) // el cliente cortó: igual hay que soltarla

  next()
}

export function getInFlightRequests(): Array<{ method: string; url: string; ageMs: number }> {
  const now = Date.now()
  return Array.from(inFlight.values()).map(r => ({
    method: r.method,
    // 🔴 Redactada al LEER, no al anotar: esta lista sale al log del hilo retenido, y el query
    // puede traer `code`/`state`/`intent` de OAuth. Hacerlo aquí no cuesta nada por petición.
    url: redactUrlSecrets(r.url),
    ageMs: now - r.startedAt,
  }))
}

/**
 * Lo que el guardia puede AFIRMAR sobre una retención. Son señales, no causas demostradas.
 *
 * 🔴 La diferencia no es cosmética. `process.cpuUsage()` agrega TODOS los hilos del proceso,
 * así que un cociente alto no demuestra trabajo síncrono del hilo principal; y uno bajo NO
 * demuestra que el proceso estuviera fuera de la CPU: un `readFileSync`, un `execSync` o una
 * llamada nativa bloqueante son código NUESTRO que retiene el hilo sin consumir CPU. Decir
 * «fuera del proceso» ahí mandaría a mirar el contenedor en vez del handler.
 *
 *   - `gc-dominante`  → el recolector ocupó la mayor parte del tramo. Buscar quién genera basura.
 *   - `cpu-alta`      → el proceso estuvo consumiendo CPU. Compatible con trabajo síncrono
 *                       nuestro, pero también con otros hilos: confirmar con un perfil de V8.
 *   - `cpu-baja`      → el proceso consumió MENOS CPU que el umbral durante el tramo. No es
 *                       «no consumió», ni descarta el GC: una pausa de recolección puede
 *                       alargarse justamente por falta de CPU. Caben I/O síncrono de nuestro
 *                       código y falta de CPU del planificador, y no se distinguen aquí.
 *   - `indeterminada` → falta el dato para separar: sin observador de GC, o la ventana de GC
 *                       quedó incompleta. Mejor decirlo que inventar una causa.
 */
export type SenalDeRetencion = 'gc-dominante' | 'cpu-alta' | 'cpu-baja' | 'indeterminada'

/** Heurística declarada, no ley: medio tramo. Por debajo, lo medido explica menos de la mitad. */
const PROPORCION_PARA_ATRIBUIR = 0.5

/**
 * Traduce las mediciones del tramo a una señal. Pura: sin reloj, sin estado, sin I/O.
 *
 * El GC se evalúa ANTES que la CPU porque el recolector también consume CPU: al revés, una
 * pausa de recolección se vería como `cpu-alta` y mandaría a buscar un handler inexistente.
 */
export function evaluarSenal(m: {
  elapsedMs: number
  cpuMs: number
  gcMs: number
  /** false cuando no hubo observador, o cuando su ventana no cubre el tramo entero. */
  gcConfiable: boolean
}): SenalDeRetencion {
  if (!(m.elapsedMs > 0)) return 'indeterminada'
  const cpuAlta = m.cpuMs / m.elapsedMs >= PROPORCION_PARA_ATRIBUIR
  if (!m.gcConfiable) {
    // Sin GC medido, «cpu-alta» es indistinguible de una pausa de recolección, así que no se
    // afirma. Por debajo del umbral sólo se reporta el hecho medido —poca CPU—, que tampoco
    // descarta al recolector: una pausa puede alargarse por falta de CPU.
    return cpuAlta ? 'indeterminada' : 'cpu-baja'
  }
  if (m.gcMs / m.elapsedMs >= PROPORCION_PARA_ATRIBUIR) return 'gc-dominante'
  return cpuAlta ? 'cpu-alta' : 'cpu-baja'
}

/** Una pausa del recolector, en la escala de `performance.now()`. */
interface PausaGc {
  inicioMs: number
  finMs: number
}

export interface ObservadorDeGc {
  /** Pausas ya entregadas, con SUS tiempos — no un acumulador por momento de entrega. */
  pausas: () => readonly PausaGc[]
  /**
   * Cuántas pausas se tiraron por el tope del buffer, acumulado desde el arranque.
   *
   * 🔴 No es telemetría de adorno: si el buffer se trunca mientras un tramo espera su aviso,
   * el GC de ESE tramo puede haberse ido a la basura. Sin este contador el aviso saldría
   * diciendo `gcVentanaCompleta:true` con `gcMs` incompleto — es decir, mintiendo con
   * confianza, que es peor que no medir.
   */
  descartadas: () => number
  /** Olvida las pausas terminadas antes de `limiteMs`, para no crecer sin fin. */
  purgar: (limiteMs: number) => void
  detener: () => void
}

/** Tope del buffer de pausas: un pico de GC no puede convertirse en una fuga de memoria. */
const MAX_PAUSAS_GC = 2000

/**
 * Observa las pausas del recolector conservando CUÁNDO ocurrieron.
 *
 * 🔴 Guardar un acumulador por momento de ENTREGA es incorrecto, y de la peor manera: durante
 * una retención el hilo no puede entregar nada, así que TODAS las pausas del tramo llegan
 * después. Medido el 2026-09-22 en Node 24: de 72 entradas producidas durante un bloqueo de
 * 616 ms, **72 se entregaron después de terminar**, una de ellas con 602 ms de retraso. Un
 * acumulador habría reportado `gcMs≈0` justo en el tramo que fue GC, y habría cargado ese GC
 * al tramo siguiente, que estuvo limpio. Por eso se guarda `startTime`+`duration` y el aviso
 * se emite un tick después, cuando las entradas ya llegaron.
 *
 * Devuelve `null` si no se puede instalar: esta corrida no podrá separar GC de CPU, y la señal
 * lo dirá con `indeterminada`. Un guardia de observabilidad jamás tumba el proceso.
 */
/**
 * El almacén de pausas, separado del `PerformanceObserver` a propósito.
 *
 * Así el acumular / truncar / contar descartes / purgar se prueba de forma DETERMINISTA sobre
 * el código productivo. Probarlo a través del observador real exigiría provocar recolecciones
 * de verdad y esperar su entrega, que bajo Jest concurrente es una prueba intermitente — el
 * repo ya tiene historial de eso con las pruebas de presupuesto del event loop.
 */
export function crearBufferDePausas(max = MAX_PAUSAS_GC) {
  let buffer: PausaGc[] = []
  let descartadas = 0
  return {
    agregar(pausa: PausaGc): void {
      buffer.push(pausa)
      if (buffer.length > max) {
        descartadas += buffer.length - max
        buffer = buffer.slice(-max)
      }
    },
    pausas: (): readonly PausaGc[] => buffer,
    descartadas: () => descartadas,
    purgar(limiteMs: number): void {
      buffer = buffer.filter(p => p.finMs >= limiteMs)
    },
  }
}

export function observarPausasDeGc(): ObservadorDeGc | null {
  try {
    const almacen = crearBufferDePausas()
    const observador = new PerformanceObserver(lista => {
      for (const entrada of lista.getEntries()) {
        almacen.agregar({ inicioMs: entrada.startTime, finMs: entrada.startTime + entrada.duration })
      }
    })
    observador.observe({ entryTypes: ['gc'] })
    return {
      pausas: almacen.pausas,
      descartadas: almacen.descartadas,
      purgar: almacen.purgar,
      detener: () => {
        try {
          observador.disconnect()
        } catch {
          /* ya desconectado */
        }
      },
    }
  } catch {
    return null
  }
}

/**
 * Suma cuánto GC cae DENTRO de la ventana; una pausa a caballo cuenta sólo su parte.
 *
 * Los trozos se FUSIONAN antes de sumar. Medido el 2026-09-22 (97 pausas reales, 0 pares
 * solapados) las entradas de V8 no se pisan entre sí —son pausas del hilo principal, que es
 * uno—, pero sumar a ciegas dejaría el resultado a merced de esa suposición: dos pausas
 * solapadas inflarían `gcMs` por encima del tramo y podrían fabricar un `gc-dominante` falso.
 * Fusionar lo vuelve imposible por construcción y cuesta un `sort`.
 */
export function gcEnVentana(pausas: readonly PausaGc[], inicioMs: number, finMs: number): number {
  const trozos: Array<[number, number]> = []
  for (const p of pausas) {
    const desde = Math.max(p.inicioMs, inicioMs)
    const hasta = Math.min(p.finMs, finMs)
    if (hasta > desde) trozos.push([desde, hasta])
  }
  if (trozos.length === 0) return 0
  trozos.sort((a, b) => a[0] - b[0])

  let total = 0
  let [ini, fin] = trozos[0]
  for (let i = 1; i < trozos.length; i += 1) {
    const [d, h] = trozos[i]
    if (d <= fin) {
      fin = Math.max(fin, h) // se solapan o se tocan: un solo intervalo
    } else {
      total += fin - ini
      ;[ini, fin] = [d, h]
    }
  }
  return total + (fin - ini)
}

/** Un tramo que pasó el umbral y espera un tick para que lleguen sus pausas de GC. */
interface TramoPendiente {
  inicioMs: number
  finMs: number
  blockedMs: number
  elapsedMs: number
  cpuMs: number
  cpuUserMs: number
  cpuSystemMs: number
  eluRatio?: number
  topInFlight: Array<{ method: string; url: string; ageMs: number }>
  inFlightCount: number
  /**
   * Los jobs del tramo, fotografiados AL DETECTARLO.
   *
   * 🔴 No se consultan al emitir: entre detectar y emitir pasa un tick, y en ese tick el
   * historial puede recortarse y llevarse justo al job culpable (Codex lo reprodujo: un aviso
   * salía con la lista VACÍA tras 200 ticks de ruido). Las pausas de GC obligan a esperar
   * porque llegan tarde; los jobs terminados ya están aquí cuando el tramo se detecta.
   */
  jobsDelTramo: JobEnVentana[]
  /**
   * Evidencia que el historial de jobs tiró entre que el tramo ABRIÓ y su foto.
   *
   * 🔴 Se congela con la foto, no se lee al emitir: el ruido posterior recorta el historial y
   * declararía una pérdida que esta foto no tuvo.
   */
  jobsDescartadosDelTramo: number
  /**
   * Descartes del buffer en el momento en que ABRIÓ el tramo.
   *
   * 🔴 No es «al detectarlo»: el observador puede entregar —y truncar— ANTES de que el
   * temporizador consiga correr, porque su callback no hace fila detrás de los `setInterval`.
   * Tomando la referencia al final, ese descarte ya venía incluido y desaparecía de la resta:
   * el aviso salía diciendo `gcVentanaCompleta:true` con el GC del tramo en la basura.
   */
  descartesAlAbrirTramo: number
}

/**
 * Arranca el muestreo del lag. Devuelve la función para detenerlo.
 *
 * Si un tick del intervalo llega tarde, ese retraso ES el tiempo que el hilo estuvo
 * secuestrado. Cuando pasa del umbral, el tramo se guarda y **se emite en el tick siguiente**:
 * las pausas de GC del tramo sólo pueden entregarse una vez que el hilo se libera.
 *
 * 🔴 `topInFlight` fotografía a quien ESPERABA, no a quien EJECUTABA — leerlo como lista de
 * culpables fue el error de la investigación del 2026-09-21. Lo que el guardia puede afirmar
 * está en `senal`, y hasta esa es una señal, no una causa demostrada.
 */
export function startEventLoopMonitor(
  options: {
    thresholdMs?: number
    sampleIntervalMs?: number
    observarGc?: boolean
    /** Costura de prueba: el `PerformanceObserver` real no se puede provocar a voluntad. */
    observadorDeGc?: ObservadorDeGc
    /** Costura de prueba: reloj monótono en la MISMA escala que `entrada.startTime`. */
    ahoraMs?: () => number
    /** Costura de prueba: CPU acumulada del proceso, en microsegundos (como `process.cpuUsage`). */
    cpuAcumulada?: () => { user: number; system: number }
    /** Costura de prueba: el registro de jobs en vuelo, para no depender del reloj real. */
    registroDeJobs?: RegistroDeJobs
  } = {},
): () => void {
  const thresholdMs = options.thresholdMs ?? PROD_ALERT_THRESHOLD_MS
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
  const gcPedido = options.observarGc ?? GC_OBSERVER_HABILITADO
  const gc = gcPedido ? (options.observadorDeGc ?? observarPausasDeGc()) : null
  const ahora = options.ahoraMs ?? (() => performance.now())
  const leerCpu = options.cpuAcumulada ?? (() => process.cpuUsage())
  const jobs = options.registroDeJobs ?? registroGlobalDeJobs

  let ultimoMs = ahora()
  let lastCpu = leerCpu()
  let lastElu = performance.eventLoopUtilization?.()
  let pendiente: TramoPendiente | null = null
  /** Descartes leídos en el tick anterior = los que había cuando ABRIÓ el tramo en curso. */
  let descartesAlAbrirTramo = gc?.descartadas() ?? 0
  /** Lo mismo para el historial de jobs: su contador al abrir el tramo en curso. */
  let descartesDeHistorialAlAbrir = jobs.descartesDeHistorial()

  /** Emite un tramo ya guardado, cruzando sus pausas de GC por tiempo. `gcConfiable` dice si se pudo. */
  const emitir = (t: TramoPendiente, esperóSuTick: boolean) => {
    const gcMs = gc ? gcEnVentana(gc.pausas(), t.inicioMs, t.finMs) : 0
    // Si el buffer se truncó en cualquier momento entre que el tramo abrió y este aviso, parte
    // de SU GC pudo irse a la basura: el número que queda es un piso, no el total, y decir
    // «completa» sería mentir. Se vigila la ventana ENTERA, no sólo la espera del aviso.
    const descartesDeLaVentana = gc ? gc.descartadas() - t.descartesAlAbrirTramo : 0
    const seTruncó = descartesDeLaVentana > 0
    const gcConfiable = esperóSuTick && !seTruncó
    logger.warn('[event-loop] hilo retenido', {
      blockedMs: Math.round(t.blockedMs),
      elapsedMs: Math.round(t.elapsedMs), // el denominador, para que la cuenta sea auditable
      thresholdMs,
      senal: evaluarSenal({ elapsedMs: t.elapsedMs, cpuMs: t.cpuMs, gcMs, gcConfiable: gcConfiable && gc !== null }),
      cpuMs: Math.round(t.cpuMs),
      cpuUserMs: Math.round(t.cpuUserMs),
      cpuSystemMs: Math.round(t.cpuSystemMs),
      gcMs: Math.round(gcMs),
      gcObservado: gc !== null,
      // false ⇒ el tramo se emitió sin esperar sus pausas (cierre del monitor) o el buffer se
      // truncó mientras esperaba. En ambos casos `gcMs` es un piso, no el total.
      gcVentanaCompleta: gcConfiable && gc !== null,
      // Descartes ocurridos desde que abrió el tramo hasta este aviso. No todos tienen por qué
      // ser suyos —el contador es global—, pero con uno solo la ventana ya no puede declararse
      // completa: es una cota superior honesta, no una atribución.
      gcPausasDescartadas: descartesDeLaVentana,
      eluRatio: t.eluRatio,
      inFlightCount: t.inFlightCount,
      // La más vieja primero: la que lleva más tiempo ESPERANDO. Pista, no veredicto.
      topInFlight: t.topInFlight,
      // Los cron cuya vida asíncrona se SOLAPÓ con el tramo, el de mayor solape primero —
      // incluidos los que ya terminaron, que son el caso probable: mientras un job tiene el
      // hilo, este tick no puede correr.
      // 🔴 `ms` es SOLAPE, no CPU ni posesión del hilo: un job esperando a Postgres cuenta
      // igual que uno calculando. Medido por la auditoría: cinco jobs en espera de I/O llenan
      // la lista y dejan fuera al que sí bloqueó la CPU. Es una pista de dónde mirar.
      // `vivo` significa vivo AL DETECTAR el tramo: la foto se toma ahí, así que un tick que
      // termine entre la detección y este aviso sigue apareciendo como vivo.
      jobsEnVuelo: t.jobsDelTramo.slice(0, 5),
      // Sin esto, «cinco jobs» se leería como «sólo había cinco».
      jobsOmitidos: Math.max(0, t.jobsDelTramo.length - 5),
      // Ticks terminados que el historial tiró entre que el tramo abrió y su foto: con uno
      // solo, la lista de arriba puede estar incompleta.
      jobsRastrosPerdidos: t.jobsDescartadosDelTramo,
      // 🔴 Acumulado DESDE EL ARRANQUE, no del tramo: un trabajo expulsado por el tope sigue
      // sin verse mientras corra, así que un delta por tramo diría «0 perdidos» en los avisos
      // siguientes y afirmaría que se ve todo. Distinto \u00a1ojo!: que no sea cero significa
      // «hubo expulsiones alguna vez, así que podrían faltar trabajos», NO que el registro esté
      // saturado ahora — los expulsados pueden haber terminado hace rato.
      jobsActivosExpulsados: jobs.expulsionesDeActivos(),
      // 🔴 Nunca se afirma que la lista esté completa: 5 registros de scheduler no pasan por el
      // envoltorio, `node-cron` queda fuera a propósito, y los ticks que descartan su promesa
      // con `=> void` se dan de baja al instante aunque sigan trabajando. Una lista vacía NO
      // significa «no fue un job».
      jobsCoberturaParcial: true,
    })
  }

  const sampler = setInterval(() => {
    const ahoraTick = ahora()
    const elapsedMs = ahoraTick - ultimoMs
    const blockedMs = elapsedMs - sampleIntervalMs
    const inicioTramo = ultimoMs
    ultimoMs = ahoraTick

    const cpuAhora = leerCpu()
    const cpu = { user: cpuAhora.user - lastCpu.user, system: cpuAhora.system - lastCpu.system }
    lastCpu = cpuAhora

    const elu = lastElu && performance.eventLoopUtilization?.(lastElu)
    if (performance.eventLoopUtilization) lastElu = performance.eventLoopUtilization()

    // 1) El tramo del tick anterior ya tiene sus pausas de GC entregadas: emitirlo ahora.
    if (pendiente) {
      emitir(pendiente, true)
      pendiente = null
    }

    // Purgar SIEMPRE, no sólo tras un aviso: una pausa que terminó antes de que abriera el
    // tramo en curso no le sirve ya a nadie. Sin esto, en un proceso sano —que no emite
    // avisos— el buffer se llena y cada entrada nueva paga un `slice` de 2,000 referencias.
    gc?.purgar(inicioTramo)

    // 2) Guardar este tramo si pasó del umbral. Se emitirá en el próximo tick.
    if (blockedMs > thresholdMs) {
      const culprits = getInFlightRequests().sort((a, b) => b.ageMs - a.ageMs)
      pendiente = {
        inicioMs: inicioTramo,
        finMs: ahoraTick,
        blockedMs,
        elapsedMs,
        cpuMs: cpu.user / 1000 + cpu.system / 1000,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        eluRatio: elu ? Number(elu.utilization.toFixed(3)) : undefined,
        topInFlight: culprits.slice(0, 5),
        inFlightCount: culprits.length,
        jobsDelTramo: jobs.jobsEnVentana(inicioTramo, ahoraTick),
        jobsDescartadosDelTramo: jobs.descartesDeHistorial() - descartesDeHistorialAlAbrir,
        descartesAlAbrirTramo,
      }
    }

    // Referencia para el PRÓXIMO tramo, que empieza justo ahora.
    descartesAlAbrirTramo = gc?.descartadas() ?? 0
    descartesDeHistorialAlAbrir = jobs.descartesDeHistorial()
  }, sampleIntervalMs)

  if (typeof sampler.unref === 'function') sampler.unref()

  return () => {
    clearInterval(sampler)
    // Se retira ANTES de emitir: si escribir el aviso falla, un segundo intento de apagado no
    // vuelve a tropezar con el mismo tramo.
    const ultimo = pendiente
    pendiente = null
    try {
      // Un tramo sin emitir se pierde si se calla: se emite marcando su ventana como incompleta.
      if (ultimo) emitir(ultimo, false)
    } catch (error) {
      // 🔴 Un fallo al escribir el último aviso NO puede frenar el apagado. Este cierre corre al
      // principio de `gracefulShutdown` —antes de cerrar el HTTP y de armar el plazo máximo de
      // 30 s—, así que propagar aquí dejaría el puerto tomado y el proceso vivo. Medido por la
      // auditoría del 2026-09-22: con el logger lanzando, HTTP no se cerraba, el plazo no se
      // armaba y el proceso no salía. Se pierde un aviso de diagnóstico, no el apagado.
      try {
        logger.error('[event-loop] no se pudo emitir el último aviso al detener', { error })
      } catch {
        /* el logger es justo lo que falló: no hay a dónde escribirlo */
      }
    } finally {
      // El observador se desconecta pase lo que pase: si no, quedaría vivo sobre un monitor
      // ya detenido.
      gc?.detener()
    }
  }
}

/** Sólo para tests: limpia el registro entre casos. */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}

/**
 * Quién estaba corriendo cuando el hilo se retuvo — la mitad que `topInFlight` no ve.
 *
 * El guardia del event loop lista las peticiones HTTP en vuelo, y eso deja ciego justo al
 * sospechoso más natural de una retención que no corresponde a ninguna ruta: un cron. Este
 * repo registra ~78 schedulers, varios de ellos barridos que leen lotes de la base.
 *
 * 🔴 **El historial no es un lujo: es el caso PRINCIPAL.** Mientras un job tiene el hilo, el
 * muestreo del guardia no puede correr — llega después. Si sólo se mirara la lista de activos
 * en ese momento, el job que causó la retención y terminó justo antes sería invisible. Por eso
 * los ticks terminados se conservan con sus tiempos y se cruzan por VENTANA, igual que las
 * pausas del recolector.
 */

/** Un tick con su marca de inicio y, si ya acabó, la de fin. */
interface TickDeJob {
  nombre: string
  inicioMs: number
  finMs: number | null
}

/**
 * Lo que el aviso publica de cada job.
 *
 * 🔴 `ms` es cuánto SE SOLAPÓ su vida asíncrona con la ventana — no cuánta CPU gastó ni cuánto
 * tuvo el hilo. Un job que pasó ese rato esperando a Postgres cuenta igual que uno que estuvo
 * calculando. Codex lo reprodujo: cinco jobs esperando I/O 500 ms llenan la lista y dejan fuera
 * al que bloqueó la CPU 480 ms. Es una PISTA para saber dónde mirar, no una acusación.
 */
export interface JobEnVentana {
  nombre: string
  ms: number
  vivo: boolean
}

/**
 * Tope del historial de ticks terminados.
 *
 * Con ~78 schedulers y el guardia mirando ventanas de un tick, 200 sobra: es el número de
 * ticks que pueden haber terminado entre dos muestreos sin que la máquina esté en llamas.
 * El tope existe para que un pico no se convierta en una fuga, no para acotar el uso normal.
 */
const MAX_HISTORIAL = 200

/**
 * Tope de ticks ACTIVOS a la vez.
 *
 * 🔴 El del historial no basta: un tick que nunca resuelve se queda dentro para siempre, y con
 * una avería que los encadene el registro crece sin fin (Codex reprodujo 10,000 retenidos).
 * Expulsar aquí es perder el RASTRO, no terminar el trabajo: el job sigue corriendo allá fuera,
 * así que se cuenta aparte y jamás se publica como terminado.
 */
const MAX_ACTIVOS = 500

export interface RegistroDeJobs {
  /** Registra el arranque de un tick y devuelve el identificador para darlo de baja. */
  iniciar: (nombre: string) => number
  /** Marca el fin de ese tick. Llamarlo dos veces no mueve el reloj ni duplica la fila. */
  terminar: (id: number) => void
  /** Los ticks que se solapan con `[inicioMs, finMs]`, el de mayor solape primero. */
  jobsEnVentana: (inicioMs: number, finMs: number) => JobEnVentana[]
  /**
   * Ticks TERMINADOS que el historial tiró, acumulado.
   *
   * Es evidencia perdida de un tramo concreto: si crece entre que un tramo abre y se fotografía,
   * su lista puede estar incompleta — mismo razonamiento que las pausas de GC descartadas.
   */
  descartesDeHistorial: () => number
  /**
   * Ticks ACTIVOS expulsados por el tope, acumulado.
   *
   * 🔴 Se cuenta aparte del anterior a propósito: mientras ese trabajo siga corriendo seguimos
   * ciegos respecto de él, así que la señal no puede ser un delta por tramo — un aviso posterior
   * diría «0 perdidos» y afirmaría que lo ve todo. Es persistente hasta que el proceso reinicie.
   */
  expulsionesDeActivos: () => number
  /** Sólo para pruebas y apagado: olvida todo. */
  limpiar: () => void
}

export function crearRegistroDeJobs(opciones: { ahoraMs?: () => number; maxHistorial?: number; maxActivos?: number } = {}): RegistroDeJobs {
  const ahora = opciones.ahoraMs ?? (() => performance.now())
  const maxHistorial = opciones.maxHistorial ?? MAX_HISTORIAL

  const activos = new Map<number, TickDeJob>()
  let historial: TickDeJob[] = []
  let siguienteId = 1
  let descartesDeHistorial = 0
  let expulsionesDeActivos = 0
  const maxActivos = opciones.maxActivos ?? MAX_ACTIVOS

  return {
    iniciar(nombre: string): number {
      const id = siguienteId
      siguienteId += 1
      activos.set(id, { nombre, inicioMs: ahora(), finMs: null })
      // El Map conserva el orden de inserción: el primero es el más viejo. Se expulsa a él y
      // NO pasa al historial — no terminó, sólo dejamos de verlo.
      while (activos.size > maxActivos) {
        const masViejo = activos.keys().next()
        if (masViejo.done) break
        activos.delete(masViejo.value)
        expulsionesDeActivos += 1
      }
      return id
    },

    terminar(id: number): void {
      const tick = activos.get(id)
      // Un `finally` puede correr dos veces si alguien encadena mal; sin esta guarda, el
      // segundo cierre reabriría el tick con un reloj distinto y el aviso mentiría.
      if (!tick) return
      activos.delete(id)
      tick.finMs = ahora()
      historial.push(tick)
      if (historial.length > maxHistorial) {
        descartesDeHistorial += historial.length - maxHistorial
        historial = historial.slice(-maxHistorial)
      }
    },

    jobsEnVentana(inicioMs: number, finMs: number): JobEnVentana[] {
      const dentro: JobEnVentana[] = []
      for (const tick of [...historial, ...activos.values()]) {
        const desde = Math.max(tick.inicioMs, inicioMs)
        // Un tick vivo se cuenta hasta el final de la ventana: su trabajo asíncrono seguía en
        // curso ahí (que NO es lo mismo que tener el hilo: puede estar esperando a Postgres).
        const hasta = Math.min(tick.finMs ?? finMs, finMs)
        if (hasta > desde) dentro.push({ nombre: tick.nombre, ms: Math.round(hasta - desde), vivo: tick.finMs === null })
      }
      return dentro.sort((a, b) => b.ms - a.ms)
    },

    descartesDeHistorial: () => descartesDeHistorial,
    expulsionesDeActivos: () => expulsionesDeActivos,

    limpiar(): void {
      activos.clear()
      historial = []
      descartesDeHistorial = 0
      expulsionesDeActivos = 0
    },
  }
}

/** El registro que usa el servidor. Uno solo por proceso, como el de peticiones en vuelo. */
export const registroDeJobs = crearRegistroDeJobs()

// src/services/customer-display/pollWork.ts
/**
 * Lo que ACOTA el trabajo que dispara el poll de la tablet (spec §5.7.4). PURO: sin base, sin red, reloj inyectable.
 *
 * Cuatro herramientas, cada una con su prueba:
 * - `PollWorkLimiter`: un máximo de trabajos en vuelo por proceso. Pasado el máximo NO se encola: el trabajo no
 *   arranca y la huella se omite hasta el siguiente poll (una huella omitida es «desconocida», nunca un error).
 * - `esperarTodas`: lo que corre en paralelo DENTRO de un lugar. No se asienta hasta que todo lo arrancado se asentó.
 * - `SingleFlightCache`: un solo cálculo por llave; lo guardado vence; un error nunca se guarda; `refresh` anula lo que
 *   estaba en vuelo para que un cálculo VIEJO jamás quede encima de uno nuevo — salvo otro refresh que arrancó hace
 *   ≤ 2 s (`REFRESH_COALESCE_MS`): se une a él si sigue en vuelo, o entrega lo que ya guardó.
 * - `dentroDelPlazo`: espera a lo más `plazoMs` a un grupo de cálculos en paralelo; lo que no llegó se omite, sigue
 *   corriendo para llenar su caché, y su error (si lo hay) se reporta — nunca queda un rechazo sin manejar.
 *
 * 🔴 Un lugar = UN trabajo que toca la base, ocupado hasta que ese trabajo y todo lo que arrancó se asentaron (Codex r1 #2).
 * Nunca un lugar dentro de otro: quien necesita dos cosas las pide por separado, cada una con su lugar.
 */

/**
 * 🔴 Decisión 2 (controlador, 15-oct): 8 y no los 32 del spec. El pool de Prisma es de 18 conexiones para TODO el proceso
 * (`src/utils/prismaClient.ts:51`) y los cobros nunca esperan. Son 8 TRABAJOS, no 8 conexiones: el del plan abre hasta 7
 * consultas a la vez (`getVenuePlanInfo` son 5 ramas en paralelo, más los dos grants). La Task 13 mide si ese abanico, con
 * varios venues fríos, hace esperar a un cobro. Una sola constante.
 */
export const POLL_WORK_MAX_IN_FLIGHT = 8
/** Plazo CONJUNTO de las huellas que falten cuando el poll no trae solicitud de inversión (spec §5.7.4). */
export const POLL_BUDGET_MS = 150

export class PollWorkSaturated extends Error {
  readonly code = 'POLL_WORK_SATURATED' as const
  constructor() {
    super('Hay demasiados cálculos del poll en vuelo; esta huella se omite hasta el siguiente poll')
    this.name = 'PollWorkSaturated'
  }
}

function llamar<T>(trabajo: () => Promise<T>): Promise<T> {
  try {
    return trabajo()
  } catch (error) {
    return Promise.reject(error)
  }
}

export class PollWorkLimiter {
  private activos = 0
  constructor(private readonly maximo: number) {
    // Un tope que no es entero ≥ 0 dejaría pasar trabajo sin límite: `activos >= NaN` nunca es cierto.
    if (!Number.isInteger(maximo) || maximo < 0) {
      throw new RangeError(`El tope de trabajos del poll debe ser un entero ≥ 0; llegó ${maximo}`)
    }
  }

  get enVuelo(): number {
    return this.activos
  }

  /**
   * Arranca `trabajo` si hay lugar; si no, devuelve null SIN llamarlo. El lugar se libera cuando se asienta la promesa
   * que devuelve `trabajo`, bien o mal — por eso `trabajo` no puede asentarse antes que lo que arrancó: en paralelo,
   * `esperarTodas`, nunca `Promise.all`.
   */
  intentar<T>(trabajo: () => Promise<T>): Promise<T> | null {
    if (this.activos >= this.maximo) return null
    this.activos += 1
    return llamar(trabajo).finally(() => {
      this.activos -= 1
    })
  }
}

/** El tope del proceso. Lo comparten la ficha, el plan, el carrusel, las firmas y la fuente de ajustes (cuando consulta) del poll. */
export const pollWorkLimiter = new PollWorkLimiter(POLL_WORK_MAX_IN_FLIGHT)

/**
 * Como `Promise.all`, pero NO se asienta hasta que TODAS se asentaron; después se rechaza con el primer error (en orden
 * de la lista) o entrega los valores. `Promise.all` se rinde al primer fallo y deja vivas a las demás: dentro de un lugar,
 * eso soltaría el lugar con lecturas todavía corriendo (Codex r1 #2).
 */
export async function esperarTodas<T extends readonly unknown[] | []>(promesas: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const resultados = await Promise.allSettled(promesas)
  for (const r of resultados) if (r.status === 'rejected') throw r.reason
  return resultados.map(r => (r as PromiseFulfilledResult<unknown>).value) as unknown as {
    -readonly [K in keyof T]: Awaited<T[K]>
  }
}

/**
 * 🔴 Ruling de la Task 6, completado en la Task 13 (F2): la ventana en que un `refresh` reusa el cálculo de otro `refresh`
 * de la misma llave que ARRANCÓ hace ≤ 2 s, siga en vuelo o ya esté guardado. Tras una edición, las N tablets de un venue
 * piden `/promotions` casi a la vez; sin ventana eran N construcciones idénticas fuera del pool. Con ella, `refresh`
 * arranca a lo más una construcción por llave cada 2 s, salvo que la anterior haya fallado (un error no se guarda) o que su
 * entrada haya salido por el tope de entradas. Lo que calcula `get` (el poll, con tope) no cuenta: va aparte.
 */
export const REFRESH_COALESCE_MS = 2_000

interface Vuelo<V> {
  promesa: Promise<V>
  anulado: boolean
  /** Con el reloj de la caché (`ahora`), no `Date.now()`: las pruebas lo mueven. */
  iniciadoEn: number
  /** Sólo un vuelo de `refresh` se comparte con otro `refresh`; uno de `get` (con tope, quizá viejo) jamás. */
  esRefresh: boolean
}

export class SingleFlightCache<V> {
  /** `refrescoIniciadoEn`: cuándo ARRANCÓ el `refresh` que guardó esta entrada (nada si la guardó un `get`). */
  private readonly entradas = new Map<string, { hasta: number; valor: V; refrescoIniciadoEn?: number }>()
  private readonly vuelos = new Map<string, Vuelo<V>>()
  private readonly ahora: () => number

  constructor(private readonly opciones: { ttlMs: number; maxEntradas: number; ahora?: () => number }) {
    // 🔴 Con `maxEntradas` < 1 la purga borraría de un mapa vacío para siempre: el proceso entero se congela.
    if (!Number.isInteger(opciones.maxEntradas) || opciones.maxEntradas < 1) {
      throw new RangeError(`El tope de entradas de la caché debe ser un entero ≥ 1; llegó ${opciones.maxEntradas}`)
    }
    // 🔴 `() => Date.now()` y no `Date.now`: guardar la referencia congela la función original y un reloj simulado
    // en una prueba (jest.spyOn(Date, 'now')) dejaría de verse — la caché viviría en otro tiempo que el resto.
    this.ahora = opciones.ahora ?? (() => Date.now())
  }

  peek(llave: string): V | undefined {
    const entrada = this.entradas.get(llave)
    return entrada && entrada.hasta > this.ahora() ? entrada.valor : undefined
  }

  get(llave: string, calcular: () => Promise<V>, o: { limiter?: PollWorkLimiter } = {}): Promise<V> {
    const guardado = this.peek(llave)
    if (guardado !== undefined) return Promise.resolve(guardado)
    const vuelo = this.vuelos.get(llave)
    if (vuelo) return vuelo.promesa // un vuelo anulado ya salió del mapa: nunca se comparte
    return this.arrancar(llave, calcular, o.limiter)
  }

  /**
   * Calcula de nuevo: no lee lo guardado ni se une a un `get` en vuelo (lo anula). Sin tope: lo pide una persona (o su
   * aparato). Mientras corre, `get` sigue entregando lo guardado antes (si hay algo vigente); sólo sin nada guardado se une
   * a este cálculo. Al terminar, lo nuevo reemplaza a lo guardado.
   *
   * 🔴 Una excepción (ruling de la Task 6; F2 de la Task 13): reusa otro `refresh` de la misma llave que ARRANCÓ hace
   * ≤ `REFRESH_COALESCE_MS` — se une a él si sigue en vuelo, o entrega lo que ya guardó. Es seguro porque la tablet se
   * entera del cambio por un poll calculado DESPUÉS de la escritura, y el primer refresh arranca después de ese poll: ya ve
   * la escritura. Si cae OTRA escritura dentro de la ventana, el siguiente poll trae otra huella y la tablet vuelve a pedir:
   * se corrige sola en ≤ 60 s. Lo que guardó un `get` nunca se reusa aquí. Más viejo que la ventana, se calcula como
   * siempre. Un vuelo anulado sale del mapa al anularse: nunca se comparte.
   */
  refresh(llave: string, calcular: () => Promise<V>): Promise<V> {
    const ahora = this.ahora()
    const vuelo = this.vuelos.get(llave)
    if (vuelo && vuelo.esRefresh && ahora - vuelo.iniciadoEn <= REFRESH_COALESCE_MS) return vuelo.promesa
    const entrada = this.entradas.get(llave)
    if (entrada?.refrescoIniciadoEn !== undefined && ahora - entrada.refrescoIniciadoEn <= REFRESH_COALESCE_MS) {
      return Promise.resolve(entrada.valor)
    }
    this.anularVuelo(llave)
    return this.arrancar(llave, calcular, undefined, true)
  }

  sizeForTests(): { entradas: number; enVuelo: number } {
    return { entradas: this.entradas.size, enVuelo: this.vuelos.size }
  }

  clearForTests(): void {
    this.entradas.clear()
    for (const llave of [...this.vuelos.keys()]) this.anularVuelo(llave)
  }

  private anularVuelo(llave: string): void {
    const vuelo = this.vuelos.get(llave)
    if (!vuelo) return
    vuelo.anulado = true
    this.vuelos.delete(llave)
  }

  private arrancar(llave: string, calcular: () => Promise<V>, limiter?: PollWorkLimiter, esRefresh = false): Promise<V> {
    const iniciadoEn = this.ahora()
    const iniciado = limiter ? limiter.intentar(calcular) : llamar(calcular)
    if (iniciado === null) return Promise.reject(new PollWorkSaturated())
    const vuelo: Vuelo<V> = { promesa: iniciado, anulado: false, iniciadoEn, esRefresh }
    this.vuelos.set(llave, vuelo)
    iniciado.then(
      valor => {
        if (this.vuelos.get(llave) === vuelo) this.vuelos.delete(llave)
        if (vuelo.anulado) return
        const ahora = this.ahora()
        this.entradas.delete(llave) // que reemplazar no cuente como una entrada de más ni conserve su lugar viejo
        this.purgar(ahora)
        this.entradas.set(llave, { hasta: ahora + this.opciones.ttlMs, valor, ...(esRefresh ? { refrescoIniciadoEn: iniciadoEn } : {}) })
      },
      () => {
        // 🔴 Un error nunca se guarda: quien lo pidió lo recibe por su promesa; la caché sólo suelta el vuelo.
        if (this.vuelos.get(llave) === vuelo) this.vuelos.delete(llave)
      },
    )
    return iniciado
  }

  private purgar(ahora: number): void {
    for (const [llave, entrada] of this.entradas) if (entrada.hasta <= ahora) this.entradas.delete(llave)
    while (this.entradas.size >= this.opciones.maxEntradas) this.entradas.delete(this.entradas.keys().next().value as string)
  }
}

export async function dentroDelPlazo<K extends string>(
  tareas: Partial<Record<K, Promise<string>>>,
  plazoMs: number,
  opciones: { esperar?: (ms: number) => Promise<void>; alFallar?: (clave: K, error: unknown) => void } = {},
): Promise<Partial<Record<K, string>>> {
  const listos: Partial<Record<K, string>> = {}
  const entradas = Object.entries(tareas).filter(([, p]) => p !== undefined) as Array<[K, Promise<string>]>
  if (entradas.length === 0) return {}
  let reloj: ReturnType<typeof setTimeout> | undefined
  const esperar =
    opciones.esperar ??
    ((ms: number) =>
      new Promise<void>(resolver => {
        reloj = setTimeout(resolver, ms)
        reloj.unref?.()
      }))
  // Cada tarea maneja SU rechazo aquí: lo que falle después del plazo también llega a `alFallar`.
  const todas = Promise.all(
    entradas.map(([clave, promesa]) =>
      promesa.then(
        valor => {
          listos[clave] = valor
        },
        error => {
          // 🔴 `alFallar` sólo reporta: si él mismo truena, la huella sigue «omitida», nunca un error del poll. Este
          // módulo es PURO y no tiene logger (como `effective.ts` y `customerDisplayCache.ts`): quien pasa `alFallar`
          // registra ahí, y la falla de su propio reporte se descarta aquí a propósito.
          try {
            opciones.alFallar?.(clave, error)
          } catch {
            // descartado a propósito (ver arriba)
          }
        },
      ),
    ),
  )
  try {
    await Promise.race([todas, esperar(plazoMs)])
  } finally {
    if (reloj) clearTimeout(reloj)
  }
  return { ...listos } // copia: lo que llegue tarde no muta la respuesta ya armada
}

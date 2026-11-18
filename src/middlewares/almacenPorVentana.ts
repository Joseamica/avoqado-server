import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'

/**
 * Almacén de un tope de intentos que sabe a qué VENTANA pertenece cada intento (tarjeta `hz:nube0000:na526456`, 17-nov-2026).
 *
 * 🔴 Es una COPIA FIEL del `MemoryStore` de express-rate-limit 7.5.1 (`node_modules/express-rate-limit/dist/index.cjs`, ~410-565): los
 * mismos dos mapas (`actual`/`anterior`), la misma rotación por temporizador, las MISMAS lecturas del reloj en el mismo orden (una al crear
 * la llave, otra al contar) y el mismo `get`, `decrement`, `resetKey` y `resetAll`. Así, frente a cualquier brinco del reloj del servidor,
 * cuenta los intentos IGUAL que la librería, por construcción: lo comprueba una prueba diferencial contra el `MemoryStore` real con miles
 * de brincos al azar (`tests/unit/middlewares/almacenPorVentana.test.ts`). Codex r5-r7 encontraron, una y otra vez, casos del reloj en
 * cada regla de tiempo propia; por la regla de parada del método se dejó de inventarlas (rediseño tras r7).
 *
 * Sólo cambian dos cosas, y ninguna lee el reloj:
 * 1. Al vencer una ventana, la nueva es un registro NUEVO (la librería reescribe el mismo objeto y el mismo `Date`, así que una petición
 *    de la ventana vieja podía «ver» la nueva y, al salir bien, restar un fallo que no era suyo: Codex r2 #1 y r3 #1).
 * 2. Cada intento recibe su FICHA: un `Date` propio (`resetTime`) atado en un `WeakMap` al registro donde se contó. `devolverEnVentana`
 *    resta sólo si ese registro sigue siendo el de la llave (aunque el reloj haya brincado: Codex r5 #2), una sola vez por ficha (r6 #3),
 *    en un tramo síncrono y sin lanzar (r3 #3).
 *
 * Una sola instancia del servidor (sin Redis): la memoria del proceso es la fuente, como con el `MemoryStore`.
 */
interface Registro {
  intentos: number
  /** Milisegundos de pared en que vence la ventana (el `resetTime` de la librería). */
  vence: number
}

export class AlmacenPorVentana implements Store {
  /** Las llaves son de este proceso (express-rate-limit lo usa para sus validaciones). */
  localKeys = true
  private ventanaMs = 60_000
  /** Como `current`/`previous` del `MemoryStore`: una llave sin uso dura entre una y dos rotaciones. */
  private actual = new Map<string, Registro>()
  private anterior = new Map<string, Registro>()
  /** La ficha de cada intento → el registro en el que se contó. Débil: se va con la petición. */
  private fichas = new WeakMap<Date, Registro>()
  private rotacion?: ReturnType<typeof setInterval>

  init(options: Options): void {
    this.ventanaMs = options.windowMs
    if (this.rotacion) clearInterval(this.rotacion)
    this.rotacion = setInterval(() => this.rotar(), this.ventanaMs)
    this.rotacion.unref?.()
  }

  /** Como `MemoryStore.get`: lee los dos mapas sin mirar la hora. */
  get(llave: string): ClientRateLimitInfo | undefined {
    const r = this.actual.get(llave) ?? this.anterior.get(llave)
    return r ? { totalHits: r.intentos, resetTime: new Date(r.vence) } : undefined
  }

  /** Como `MemoryStore.increment` (mismas lecturas del reloj), salvo que la ventana nueva es un registro nuevo y devuelve una ficha. */
  increment(llave: string): ClientRateLimitInfo {
    let r = this.registroDe(llave)
    const ahora = Date.now()
    if (r.vence <= ahora) {
      r = { intentos: 0, vence: ahora + this.ventanaMs }
      this.actual.set(llave, r)
    }
    r.intentos++
    const ficha = new Date(r.vence)
    this.fichas.set(ficha, r)
    return { totalHits: r.intentos, resetTime: ficha }
  }

  /** Como `MemoryStore.decrement`. El tope de PIN no la usa (devuelve con `devolverEnVentana`). */
  decrement(llave: string): void {
    const r = this.registroDe(llave)
    if (r.intentos > 0) r.intentos--
  }

  /**
   * Resta uno sólo si el registro de esa ficha sigue siendo el de la llave (la misma ventana). Cada ficha devuelve UNA vez. No lee el
   * reloj ni mueve la llave entre mapas. Síncrono y sin lanzar.
   */
  devolverEnVentana(llave: string, ficha: Date | undefined): void {
    const suyo = ficha ? this.fichas.get(ficha) : undefined
    if (!suyo) return
    this.fichas.delete(ficha!)
    const r = this.actual.get(llave) ?? this.anterior.get(llave)
    if (r === suyo && r.intentos > 0) r.intentos--
  }

  resetKey(llave: string): void {
    this.actual.delete(llave)
    this.anterior.delete(llave)
  }

  resetAll(): void {
    this.actual.clear()
    this.anterior.clear()
  }

  shutdown(): void {
    if (this.rotacion) clearInterval(this.rotacion)
    this.resetAll()
  }

  /** Sólo para pruebas: una rotación como la del temporizador (la de la librería es `clearExpired`). */
  rotarAhora(): void {
    this.rotar()
  }

  /** Como `MemoryStore.clearExpired`: lo de la rotación pasada se olvida; lo de ésta pasa a «anterior». Nunca lee el reloj. */
  private rotar(): void {
    this.anterior = this.actual
    this.actual = new Map()
  }

  /** Como `MemoryStore.getClient`: lo trae a «actual» o lo crea con UNA lectura del reloj (la librería: `resetClient(client)`). */
  private registroDe(llave: string): Registro {
    const enActual = this.actual.get(llave)
    if (enActual) return enActual
    let r = this.anterior.get(llave)
    if (r) this.anterior.delete(llave)
    else r = { intentos: 0, vence: Date.now() + this.ventanaMs }
    this.actual.set(llave, r)
    return r
  }
}

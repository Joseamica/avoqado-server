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
 *    de la ventana vieja podía «ver» la nueva y, al salir bien, restar un fallo que no era suyo: Codex r2 #1 y r3 #1). Para DECIDIR,
 *    en cambio, el total se lee como en la librería: del contador vivo de su «linaje» (el objeto cliente de la librería, que sobrevive
 *    a los reinicios por vencimiento), así que dos intentos en vuelo reciben siempre la misma respuesta que antes (Codex r8 #1 y r9 #1).
 * 2. Cada intento recibe su FICHA: un `Date` propio (`resetTime`) atado en un `WeakMap` al registro donde se contó. `devolverEnVentana`
 *    resta sólo si ese registro sigue siendo el de la llave (aunque el reloj haya brincado: Codex r5 #2), una sola vez por ficha (r6 #3),
 *    en un tramo síncrono y sin lanzar (r3 #3). La HORA de la ficha sí es la vigente del linaje, como el `Date` de la librería, para que
 *    el Retry-After de un 429 leído tarde sea el mismo (auditoría de apps viejas #3, 18-nov).
 *
 * Una sola instancia del servidor (sin Redis): la memoria del proceso es la fuente, como con el `MemoryStore`.
 */
interface Registro {
  intentos: number
  /** Milisegundos de pared en que vence la ventana (el `resetTime` de la librería). */
  vence: number
  /** El «cliente» de la librería: el mismo a través de los reinicios por vencimiento; uno nuevo al crear la llave desde cero. */
  linaje: Linaje
}
interface Linaje {
  /** La ventana vigente de este cliente (la librería la reescribe en el mismo objeto; aquí apunta al registro nuevo). */
  registro: Registro
}

/**
 * La ficha de UN intento. Su IDENTIDAD es la del intento (la devolución la busca en `fichas`), pero su HORA es siempre la de la ventana
 * vigente de su linaje, como el único `Date` que la librería reescribe con `setTime` al reiniciar (`resetClient`). Así, un 429 leído
 * tarde, ya con la ventana nueva, dice la espera de la nueva y no «0 s» (auditoría de apps viejas #3, 18-nov-2026).
 *
 * La hora se pone al día al leerla. express-rate-limit sólo llama `getTime()` (Retry-After y los encabezados `RateLimit-*`); también
 * se ponen al día `valueOf` (la resta de fechas) y los textos (`toISOString`, `toJSON`, `toString` y `toUTCString`).
 */
class FichaDeIntento extends Date {
  constructor(private readonly suLinaje: Linaje) {
    super(suLinaje.registro.vence)
  }

  private alDia(): void {
    const vence = this.suLinaje.registro.vence
    if (super.getTime() !== vence) super.setTime(vence)
  }

  getTime(): number {
    this.alDia()
    return super.getTime()
  }

  valueOf(): number {
    this.alDia()
    return super.valueOf()
  }

  toISOString(): string {
    this.alDia()
    return super.toISOString()
  }

  toJSON(llave?: unknown): string {
    this.alDia()
    return super.toJSON(llave)
  }

  toString(): string {
    this.alDia()
    return super.toString()
  }

  toUTCString(): string {
    this.alDia()
    return super.toUTCString()
  }
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
      const nuevo: Registro = { intentos: 0, vence: ahora + this.ventanaMs, linaje: r.linaje }
      r.linaje.registro = nuevo
      this.actual.set(llave, nuevo)
      r = nuevo
    }
    r.intentos++
    const linaje = r.linaje
    const ficha = new FichaDeIntento(linaje)
    this.fichas.set(ficha, r)
    // `totalHits` y la hora de `resetTime` EN VIVO y por linaje, como el objeto de la librería que express lee después del `await`:
    // dos intentos en vuelo, también a ambos lados del vencimiento, ven el mismo total y la misma espera (Codex r8 #1, r9 #1 y
    // auditoría de apps viejas #3). La IDENTIDAD de la ficha sigue atada al registro donde se contó (la devolución).
    return {
      get totalHits() {
        return linaje.registro.intentos
      },
      resetTime: ficha,
    }
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
    else r = this.registroNuevo(Date.now() + this.ventanaMs)
    this.actual.set(llave, r)
    return r
  }

  /** Un cliente nuevo (la llave no existía o se olvidó): su propio linaje. */
  private registroNuevo(vence: number): Registro {
    const r = { intentos: 0, vence } as Registro
    r.linaje = { registro: r }
    return r
  }
}

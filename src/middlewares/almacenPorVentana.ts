import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'

/**
 * Almacén de un tope de intentos que sabe a qué VENTANA pertenece cada intento (tarjeta `hz:nube0000:na526456`, 17-nov-2026).
 *
 * Existe para devolver lo que salió bien SIN borrar nunca un fallo de otra ventana. El `MemoryStore` de express-rate-limit no sirve
 * para eso: reutiliza el mismo objeto `Date` y lo reescribe al reiniciar, así que una petición que entró en la ventana vieja podía
 * «ver» la nueva y, al salir bien, restar un fallo que no era suyo (Codex r2 #1 y r3 #1). Aquí:
 * - cada ventana es un registro NUEVO; un reinicio nunca toca el anterior. La identidad de la ventana es ESE registro, no su hora:
 *   cada intento recibe su propio `Date` (`resetTime`) atado al registro en el que se contó (`fichas`). Así la hora vence exacta, como
 *   en la librería (sin el «+1 ms» de antes, que alargaba ventanas y heredaba saltos del reloj: Codex r5 #1);
 * - `increment` es síncrono: suma y ata la ficha en el mismo tramo, sin `await` en medio;
 * - `devolverEnVentana` resta sólo si el registro de esa ficha sigue siendo el de la llave, aunque el reloj haya brincado (un acierto
 *   nunca se queda cobrado por un salto del reloj: Codex r5 #2), también en un tramo síncrono, y nunca lanza (Codex r3 #3).
 *
 * Una sola instancia del servidor (sin Redis): la memoria del proceso es la fuente, como con el `MemoryStore`.
 */
interface Registro {
  intentos: number
  vence: number
}

export class AlmacenPorVentana implements Store {
  /** Las llaves son de este proceso (express-rate-limit lo usa para sus validaciones). */
  localKeys = true
  private ventanaMs = 60_000
  private registros = new Map<string, Registro>()
  /**
   * La ficha de cada intento (el `Date` que se le devolvió) → el registro en el que se contó. Débil: se va con la petición. Aunque se
   * borre una llave (`resetKey`/`resetAll`) y se abra otra ventana en el mismo milisegundo, la ficha vieja apunta al registro viejo y
   * nunca resta en el nuevo (Codex r4 #4).
   */
  private fichas = new WeakMap<Date, Registro>()
  private limpieza?: ReturnType<typeof setInterval>

  init(options: Options): void {
    this.ventanaMs = options.windowMs
    if (this.limpieza) clearInterval(this.limpieza)
    // Sólo quita registros ya vencidos: un registro vigente nunca se borra (borrarlo regalaría intentos).
    this.limpieza = setInterval(() => this.quitarVencidos(Date.now()), this.ventanaMs)
    this.limpieza.unref?.()
  }

  private vigente(llave: string, ahora: number): Registro | undefined {
    const r = this.registros.get(llave)
    return r && r.vence > ahora ? r : undefined
  }

  get(llave: string): ClientRateLimitInfo | undefined {
    const r = this.vigente(llave, Date.now())
    return r ? { totalHits: r.intentos, resetTime: new Date(r.vence) } : undefined
  }

  increment(llave: string): ClientRateLimitInfo {
    const ahora = Date.now()
    let r = this.vigente(llave, ahora)
    if (!r) {
      r = { intentos: 0, vence: ahora + this.ventanaMs }
      this.registros.set(llave, r)
    }
    r.intentos++
    // La ficha de ESTE intento: un `Date` propio (una copia: cambiarlo no toca el almacén) atado a su registro.
    const ficha = new Date(r.vence)
    this.fichas.set(ficha, r)
    return { totalHits: r.intentos, resetTime: ficha }
  }

  decrement(llave: string): void {
    const r = this.vigente(llave, Date.now())
    if (r && r.intentos > 0) r.intentos--
  }

  /** Resta uno sólo si el registro de esa ficha sigue siendo el de la llave (la misma ventana). Síncrono y sin lanzar. */
  devolverEnVentana(llave: string, ficha: Date | undefined): void {
    const suyo = ficha ? this.fichas.get(ficha) : undefined
    const r = this.registros.get(llave)
    if (suyo && r === suyo && r.intentos > 0) r.intentos--
  }

  resetKey(llave: string): void {
    this.registros.delete(llave)
  }

  resetAll(): void {
    this.registros.clear()
  }

  shutdown(): void {
    if (this.limpieza) clearInterval(this.limpieza)
    this.registros.clear()
  }

  private quitarVencidos(ahora: number): void {
    for (const [llave, r] of this.registros) if (r.vence <= ahora) this.registros.delete(llave)
  }
}

import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'

/**
 * Almacén de un tope de intentos que sabe a qué VENTANA pertenece cada intento (tarjeta `hz:nube0000:na526456`, 17-nov-2026).
 *
 * Existe para devolver lo que salió bien SIN borrar nunca un fallo de otra ventana. El `MemoryStore` de express-rate-limit no sirve
 * para eso: reutiliza el mismo objeto `Date` y lo reescribe al reiniciar, así que una petición que entró en la ventana vieja podía
 * «ver» la nueva y, al salir bien, restar un fallo que no era suyo (Codex r2 #1 y r3 #1). Aquí:
 * - cada ventana es un registro NUEVO con su número (`vence`, milisegundos); un reinicio nunca toca el registro anterior;
 * - `increment` es síncrono: suma y copia la ventana en el mismo tramo, sin `await` en medio;
 * - `devolverEnVentana` resta sólo si la ventana vigente de esa llave es la misma con la que se contó, también en un tramo síncrono,
 *   y nunca lanza (no hay promesa que se quede sin manejar: Codex r3 #3).
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
    // Una COPIA de la ventana: lo que se guarda en la petición no cambia aunque la llave se reinicie después.
    return { totalHits: r.intentos, resetTime: new Date(r.vence) }
  }

  decrement(llave: string): void {
    const r = this.vigente(llave, Date.now())
    if (r && r.intentos > 0) r.intentos--
  }

  /** Resta uno sólo si la ventana vigente de la llave es `vence`. Síncrono y sin lanzar. */
  devolverEnVentana(llave: string, vence: number): void {
    const r = this.registros.get(llave)
    if (r && r.vence === vence && r.vence > Date.now() && r.intentos > 0) r.intentos--
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

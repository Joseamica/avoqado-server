import logger from '@/config/logger'

/**
 * Cronómetro por fases para endpoints lentos.
 *
 * Nació midiendo `recordFastPayment`: 4,471 ms de mediana en producción (p95
 * 4,971 ms) contra 130 ms de latencia de red real desde México a Render Oregon
 * — o sea que ~97% de esa espera es trabajo del servidor, no internet. Antes de
 * mover nada había que saber QUÉ operación se lleva el tiempo, en vez de
 * adivinar: mover a segundo plano lo que no pesa no gana nada, y el endpoint
 * registra DINERO, así que no se toca a ciegas.
 *
 * 🔴 SOLO OBSERVA. No cambia orden, no captura errores, no altera valores de
 * retorno. Si el cronómetro fallara, no puede tumbar un registro de pago:
 * `mark()` no lanza y `end()` corre en su propio try/catch.
 *
 * Uso:
 *   const t = new PhaseTimer('recordFastPayment', { venueId })
 *   const staff = await t.time('validateStaff', () => validateStaffVenue(...))
 *   ...
 *   t.end()   // emite una sola línea con el desglose completo
 */
export class PhaseTimer {
  private readonly startedAt: number
  private lastAt: number
  private readonly phases: Array<{ fase: string; ms: number }> = []

  constructor(
    private readonly label: string,
    private readonly context: Record<string, unknown> = {},
  ) {
    this.startedAt = Date.now()
    this.lastAt = this.startedAt
  }

  /** Cierra la fase abierta y la registra. Nunca lanza. */
  mark(fase: string): void {
    try {
      const now = Date.now()
      this.phases.push({ fase, ms: now - this.lastAt })
      this.lastAt = now
    } catch {
      /* medir jamás puede romper el flujo del pago */
    }
  }

  /** Envuelve una operación async y la cronometra. Propaga el error tal cual. */
  async time<T>(fase: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    try {
      return await fn()
    } finally {
      try {
        this.phases.push({ fase, ms: Date.now() - startedAt })
        this.lastAt = Date.now()
      } catch {
        /* idem */
      }
    }
  }

  /**
   * Emite UNA línea con el total y las fases ordenadas de mayor a menor, para
   * que el culpable salga primero al leer el log. Nunca lanza.
   */
  end(extra: Record<string, unknown> = {}): void {
    try {
      const totalMs = Date.now() - this.startedAt
      const ordenadas = [...this.phases].sort((a, b) => b.ms - a.ms)
      const medido = this.phases.reduce((sum, p) => sum + p.ms, 0)
      logger.info(`⏱️ [${this.label}] desglose`, {
        totalMs,
        // Lo que el total tiene de más sobre la suma de fases: código no
        // instrumentado. Si crece, faltan marcas.
        sinMedirMs: Math.max(0, totalMs - medido),
        fases: ordenadas,
        ...this.context,
        ...extra,
      })
    } catch {
      /* idem */
    }
  }
}

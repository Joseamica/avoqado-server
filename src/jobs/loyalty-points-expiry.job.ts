import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { vencerPuntosVencidos } from '../services/loyalty/vencimientoDePuntos'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

/**
 * D27 (25-nov-2026): vence los puntos de lealtad de los clientes que pasaron N días sin movimientos en sus puntos, en los negocios con la
 * expiración prendida. Cada HORA y no una vez al día: cada negocio vive en su zona y su día cambia a distinta hora. Cada vuelta revisa todo
 * desde la base, sin memoria entre vueltas; todo es idempotente (la regla y los candados viven en `services/loyalty/vencimientoDePuntos.ts`)
 * y la lectura de entrada reintenta errores de conexión (regla cron-jobs.md).
 */
export class LoyaltyPointsExpiryJob {
  private readonly cron: CronHandle
  private readonly correr: typeof vencerPuntosVencidos
  private running = false
  /** Llegó un disparo mientras corría una vuelta: al terminar, corre otra en seguida (Codex r6 #2). */
  private pendiente = false

  constructor(overrides: { cron?: CronHandle; correr?: typeof vencerPuntosVencidos } = {}) {
    this.correr = overrides.correr ?? vencerPuntosVencidos
    this.cron =
      overrides.cron ??
      scheduleJob(
        'loyalty-points-expiry',
        DATABASE_JOB_SCHEDULES.loyaltyPointsExpiry,
        () =>
          this.runNow().then(
            () => undefined,
            error => {
              logger.error('🔴 [LEALTAD] Falló la vuelta del vencimiento de puntos', { error })
            },
          ),
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Loyalty points expiry job started')
  }

  stop(): void {
    this.cron.stop()
  }

  /**
   * Una vuelta lenta nunca se encima con la siguiente; pero el disparo que llegó mientras corría no se pierde: al terminar corre UNA vuelta
   * más en seguida (aunque se hayan saltado varios).
   */
  async runNow(): Promise<Awaited<ReturnType<typeof vencerPuntosVencidos>> | null> {
    if (this.running) {
      this.pendiente = true
      return null
    }
    this.running = true
    try {
      const r = await this.correr()
      // Sólo cuando hubo algo que contar: si no, 24 líneas vacías al día.
      if (r.customersAffected > 0 || r.fallidos > 0) logger.info('[LEALTAD] Vencimiento de puntos', r)
      return r
    } finally {
      this.running = false
      if (this.pendiente) {
        this.pendiente = false
        setImmediate(() => this.runNow().catch(error => logger.error('🔴 [LEALTAD] Falló la vuelta del vencimiento de puntos', { error })))
      }
    }
  }
}

export const loyaltyPointsExpiryJob = new LoyaltyPointsExpiryJob()

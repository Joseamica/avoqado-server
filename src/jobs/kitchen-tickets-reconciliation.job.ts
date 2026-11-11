import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { authorKitchenTickets } from '../services/kds/kitchenTicketAuthoring.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

const BATCH_LIMIT = 50
/** El gancho post-commit suele armarla en milisegundos: el barrido espera para no pisarlo. */
const MIN_AGE_MS = 30_000
/**
 * Pasado este tiempo la marca recibe UN último intento y después se limpia. hz:ce654971:D5 (Codex r4 B11): antes se limpiaba sin
 * llamar al autor, y tras una caída de 16 min una pieza todavía elegible (el autor decide con su ventana de 12 h y con lo que la
 * cocina ya marcó en papel) se abandonaba sin un solo intento. Que la pieza sirva o no lo decide el autor, no este reloj.
 */
const GIVE_UP_MS = 15 * 60_000

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface KitchenTicketsReconciliationDependencies {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  author: typeof authorKitchenTickets
}

const defaults: KitchenTicketsReconciliationDependencies = {
  prisma,
  now: () => new Date(),
  author: authorKitchenTickets,
}

/**
 * Etapa 3 del KDS (spec 2026-09-27 §2): la venta o la ronda es la fila durable del «outbox». La escritura que la
 * salda o suma la ronda pone `Order.kitchenPendingAt`; el armado la limpia. Si el proceso murió entre el commit y el
 * armado, este barrido la encuentra y la arma. Mismo patrón que `loyalty-reconciliation.job.ts`.
 */
export class KitchenTicketsReconciliationJob {
  private readonly dependencies: KitchenTicketsReconciliationDependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<KitchenTicketsReconciliationDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'kitchen-tickets-reconciliation',
        DATABASE_JOB_SCHEDULES.kitchenTicketsReconciliation,
        // Devuelve su promesa (nueva en cada tick, nunca rechaza) para que el aviso de «hilo retenido» vea este
        // barrido en `jobsEnVuelo`; descartarla con `void` lo dejaba invisible (jobContextRegistro.test.ts).
        async () => {
          try {
            await this.runNow()
          } catch (error) {
            logger.error('Kitchen tickets reconciliation sweep failed', { error })
          }
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Kitchen tickets reconciliation job started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Kitchen tickets reconciliation job stopped')
  }

  async runNow(): Promise<{ scanned: number; armadas: number; fallidas: number; rendidas: number; skipped: number }> {
    if (this.running) return { scanned: 0, armadas: 0, fallidas: 0, rendidas: 0, skipped: 1 }
    this.running = true
    try {
      const now = this.dependencies.now()
      // Regla cron-jobs.md: la lectura de ENTRADA reintenta errores transitorios de conexión.
      const pendientes = await retry(
        () =>
          this.dependencies.prisma.order.findMany({
            where: { kitchenPendingAt: { not: null, lt: new Date(now.getTime() - MIN_AGE_MS) } },
            select: { id: true, venueId: true, kitchenPendingAt: true },
            orderBy: [{ kitchenPendingAt: 'asc' }, { id: 'asc' }],
            take: BATCH_LIMIT,
          }),
        { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'kitchen-tickets-reconciliation.find' },
      )

      let armadas = 0
      let fallidas = 0
      let rendidas = 0
      for (const orden of pendientes) {
        const marca = orden.kitchenPendingAt as Date
        const ultimoIntento = marca.getTime() < now.getTime() - GIVE_UP_MS
        let armada = false
        try {
          await this.dependencies.author({ venueId: orden.venueId, orderId: orden.id, trigger: 'SWEEP' })
          armadas += 1
          armada = true
        } catch (error) {
          const datos = { venueId: orden.venueId, orderId: orden.id, error: error instanceof Error ? error.message : String(error) }
          if (!ultimoIntento) {
            fallidas += 1
            logger.error('[KDS] el barrido no pudo armar la comanda; lo reintenta en el siguiente tick', datos)
            continue
          }
          logger.error('🚨 [KDS] comanda de pantalla sin armar tras 15 min y un último intento; se deja de intentar', {
            ...datos,
            desde: marca,
          })
        }
        if (!ultimoIntento) continue
        // Pase lo que pase en el último intento, ESA marca ya no se reintenta: así una marca que el autor no limpió no se repite cada
        // minuto para siempre. Condicionada a su valor (la de una ronda nueva se conserva) y acotada al venue (ruling de aislamiento
        // de tenant, igual que la Tarea 3): nunca limpiar la marca de una orden ajena.
        try {
          await this.dependencies.prisma.order.updateMany({
            where: { id: orden.id, venueId: orden.venueId, kitchenPendingAt: marca },
            data: { kitchenPendingAt: null },
          })
          if (!armada) rendidas += 1
        } catch (error) {
          if (!armada) fallidas += 1
          logger.error('[KDS] el barrido no pudo limpiar una marca de más de 15 min; lo reintenta en el siguiente tick', {
            venueId: orden.venueId,
            orderId: orden.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return { scanned: pendientes.length, armadas, fallidas, rendidas, skipped: 0 }
    } finally {
      this.running = false
    }
  }
}

export const kitchenTicketsReconciliationJob = new KitchenTicketsReconciliationJob()

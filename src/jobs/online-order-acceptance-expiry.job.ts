import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { announceCancelledElsewhere, cerrarCanceladasReleyendo } from '../services/online-ordering/cancelledOrderSync'
import { EXPIRY_BATCH_SIZE } from '../services/online-ordering/constants'
import {
  cerrarFoliosDelDiaTerminado,
  leerFoliosConAbonoDevuelto,
  leerPedidosVencidos,
  syncPaidClosedFolios,
  syncPaidFolios,
  type CandidatoAVencer,
  type CursorDeVencer,
} from '../services/online-ordering/folios.service'
import { announceCollectedAutomatically, syncOnlineOrdersOfPaidPickups } from '../services/online-ordering/paidPickupSync'
import { expireOnlineOrder } from '../services/online-ordering/transitions.service'
import type { ReadCandidates, Reloj } from '../services/online-ordering/types'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

type CronHandle = Pick<CronJob, 'start' | 'stop'>

/** H7/R50: tope de páginas por lectura y pasada (10 × 100 candidatos). Sin estado entre pasadas: la siguiente vuelve a empezar. */
const EXPIRY_MAX_PAGES = 10

/** R50: una lectura de candidatos a vencer, una página después del cursor (el SQL ya excluye lo que se rechazaría de forma durable). */
type LeerVencidos = (now: Date, despues: CursorDeVencer | null) => Promise<CandidatoAVencer[]>

interface OnlineOrderAcceptanceExpiryDependencies {
  cron?: CronHandle
  now: () => Date
  expireOrder: typeof expireOnlineOrder
  retryEntry: typeof retry
  /**
   * R2: cierra (y anuncia) los pedidos cuya cuenta se canceló por otra vía, en TODOS los negocios, antes de buscar vencidos.
   * A10: `readEntry` reintenta por conexión SÓLO su lectura de candidatos. R52: escribe bajo el candado de cada pedido, así que
   * recibe el reloj, no la hora de la pasada.
   */
  syncCancelled: (reloj: Reloj, readEntry: ReadCandidates) => Promise<number>
  /** Opción 1 del founder (17-oct): entrega (y anuncia) lo de pagar al recoger que ya quedó pagado, después de R2. */
  syncPaidPickups: (now: Date, readEntry: ReadCandidates) => Promise<number>
  /** Tienda híbrida (decisión 18): folios pagados a «Por entregar», después de `syncPaidPickups` y antes de vencer. */
  syncPaidFolios: (reloj: Reloj, readEntry: ReadCandidates) => Promise<number>
  /** Tabla 7b, regla 2: folios cerrados que otro cobro terminó de saldar, de vuelta en «Por entregar». */
  syncPaidClosedFolios: (reloj: Reloj, readEntry: ReadCandidates) => Promise<number>
  /** Decisión 18 (T9b): folios en «Por entregar» cuyo día del negocio terminó pasan a «Entregado», después de lo anterior y antes de vencer. */
  cerrarFoliosDelDia: (reloj: Reloj, readEntry: ReadCandidates) => Promise<number>
  /** R1/R49/R50: lo vencido sin un peso con la cuenta abierta (folios y «Mi equipo»). */
  leerVencidos: LeerVencidos
  /** R44/R49/R50: los folios cuyo abono se devolvió completo (neto 0 filtrado en SQL), para su pasada aparte. */
  leerAbonosDevueltos: LeerVencidos
}

interface ExpiryResult {
  scanned: number
  expired: number
  noop: number
  errors: number
  synced: number
  collected: number
  /** Folios que esta pasada dejó en «Por entregar» (pagados y cerrados ya saldados). */
  porEntregar: number
  skipped?: true
}

const defaults: OnlineOrderAcceptanceExpiryDependencies = {
  now: () => new Date(),
  expireOrder: expireOnlineOrder,
  retryEntry: retry,
  // I-1: el job ya corre fuera de una transacción, así que anuncia a sus ganadores justo después de la llamada.
  // R12: cada candidato se cierra en su transacción, releyendo la cuenta bajo el candado de la orden.
  syncCancelled: async (reloj, readEntry) => {
    const won = await cerrarCanceladasReleyendo({}, reloj, readEntry)
    announceCancelledElsewhere(won, reloj())
    return won.length
  },
  syncPaidPickups: async (now, readEntry) => {
    const won = await syncOnlineOrdersOfPaidPickups(prisma, {}, now, readEntry)
    announceCollectedAutomatically(won, now)
    return won.length
  },
  // Anuncian a sus ganadores ellas mismas (cada fila confirma en su propia transacción).
  syncPaidFolios: (reloj, readEntry) => syncPaidFolios({}, reloj, readEntry),
  syncPaidClosedFolios: (reloj, readEntry) => syncPaidClosedFolios({}, reloj, readEntry),
  cerrarFoliosDelDia: (reloj, readEntry) => cerrarFoliosDelDiaTerminado({}, reloj, readEntry),
  leerVencidos: leerPedidosVencidos,
  leerAbonosDevueltos: leerFoliosConAbonoDevuelto,
}

export class OnlineOrderAcceptanceExpiryJob {
  private readonly dependencies: OnlineOrderAcceptanceExpiryDependencies
  private readonly job: CronHandle
  private isRunning = false

  constructor(overrides: Partial<OnlineOrderAcceptanceExpiryDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides }
    this.job =
      overrides.cron ??
      scheduleJob(
        'online-order-acceptance-expiry',
        DATABASE_JOB_SCHEDULES.onlineOrderAcceptanceExpiry,
        async () => {
          await this.checkNow()
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.job.start()
    logger.info('Online-order acceptance expiry job started')
  }

  stop(): void {
    this.job.stop()
    logger.info('Online-order acceptance expiry job stopped')
  }

  /** Lectura de entrada con reintento por conexión (regla cron-jobs.md). Los CAS, las transacciones y los avisos quedan FUERA. */
  private readEntry(context: string): ReadCandidates {
    return read =>
      this.dependencies.retryEntry(read, { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })
  }

  async checkNow(): Promise<ExpiryResult> {
    if (this.isRunning) {
      logger.warn('[Online-order expiry] tick skipped — previous run still in progress')
      return { scanned: 0, expired: 0, noop: 0, errors: 0, synced: 0, collected: 0, porEntregar: 0, skipped: true }
    }
    this.isRunning = true
    let synced = 0
    let collected = 0
    let porEntregar = 0

    try {
      // R52: `now` (la hora de la pasada) SÓLO elige candidatos. Lo que se escribe bajo un candado o en un CAS (`acceptedAt`,
      // `cancelledAt`, `expiredAt`, `completedAt`) y lo que decide días o plazos lee `reloj` en ese momento: una pasada que empieza a
      // las 03:59:50 y escribe a las 04:00:05 no fecha «ayer» lo que pasó hoy.
      const reloj = this.dependencies.now
      const now = reloj()

      // R2: sólo su lectura de candidatos va con reintento (A10); sus CAS no. Si falla, la pasada sigue.
      try {
        synced = await this.dependencies.syncCancelled(reloj, this.readEntry('online-order-acceptance-expiry.syncCancelled'))
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron cerrar los pedidos de cuentas canceladas (la pasada sigue)', { error })
      }
      // Después de R2, con la misma regla: reintento sólo en la lectura. «Mi equipo» como en develop: su `completedAt` sigue con la
      // hora de la pasada (R52 lo clasifica AJENO: no toca folios ni decide días).
      try {
        collected = await this.dependencies.syncPaidPickups(now, this.readEntry('online-order-acceptance-expiry.syncPaidPickups'))
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron entregar los pedidos ya pagados (la pasada sigue)', { error })
      }
      // Tienda híbrida (decisión 18): lo pagado pasa a «Por entregar» ANTES de vencer, con la misma regla de reintento.
      try {
        porEntregar += await this.dependencies.syncPaidFolios(reloj, this.readEntry('online-order-acceptance-expiry.syncPaidFolios'))
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron pasar a «Por entregar» los folios pagados (la pasada sigue)', { error })
      }
      try {
        porEntregar += await this.dependencies.syncPaidClosedFolios(
          reloj,
          this.readEntry('online-order-acceptance-expiry.syncPaidClosedFolios'),
        )
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron revivir los folios cerrados ya saldados (la pasada sigue)', { error })
      }

      // Decisión 18 (T9b): al final de lo que mete folios a la lista (así un folio revivido hoy no sale por un día viejo) y antes de vencer.
      try {
        await this.dependencies.cerrarFoliosDelDia(reloj, this.readEntry('online-order-acceptance-expiry.cerrarFoliosDelDia'))
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron entregar los folios del día terminado (la pasada sigue)', { error })
      }

      let scanned = 0
      let expired = 0
      let noop = 0
      let errors = 0
      /** Vence un candidato bajo su candado; si ya cambió (STALE) o tiene dinero (HAS_PAYMENTS), cuenta como noop. */
      const vencer = async (c: CandidatoAVencer) => {
        try {
          const r = await this.dependencies.expireOrder({ venueId: c.venueId, orderId: c.orderId, reloj })
          if (r.outcome === 'OK') expired += 1
          else noop += 1
        } catch (error) {
          errors += 1
          logger.error('Online-order expiry candidate failed', { orderId: c.orderId, venueId: c.venueId, error })
        }
      }
      /**
       * H7/R50: página tras página por llave estable (acceptDeadlineAt, id), con el cursor DENTRO de la pasada: lo que el candado
       * rechaza no se relee. El SQL de cada lectura ya excluye lo que se rechazaría de forma durable (dinero, cobro de terminal sin
       * desenlace), así que lo leído y no vencido es una carrera pasajera o un error: si hay, queda un aviso con el conteo.
       */
      const barrer = async (pasada: string, leer: LeerVencidos) => {
        const vencidosAntes = expired
        let leidos = 0
        let despues: CursorDeVencer | null = null
        for (let page = 0; page < EXPIRY_MAX_PAGES; page++) {
          const after: CursorDeVencer | null = despues
          const candidates: CandidatoAVencer[] = await this.readEntry(`online-order-acceptance-expiry.${pasada}`)(() => leer(now, after))
          for (const candidate of candidates) await vencer(candidate)
          scanned += candidates.length
          leidos += candidates.length
          if (candidates.length < EXPIRY_BATCH_SIZE) break
          const last = candidates[candidates.length - 1]
          despues = { at: last.acceptDeadlineAt, id: last.id }
        }
        const sinVencer = leidos - (expired - vencidosAntes)
        if (sinVencer > 0) {
          logger.warn('[Online-order expiry] candidatos leídos que no vencieron (carrera pasajera o error: lo durable lo excluye el SQL)', {
            pasada,
            leidos,
            sinVencer,
          })
        }
      }

      // R44/R49: los folios cuyo abono se devolvió completo van en su PASADA APARTE; su fallo no detiene el barrido principal.
      try {
        await barrer('abonosDevueltos', this.dependencies.leerAbonosDevueltos)
      } catch (error) {
        logger.error('Online-order expiry: no se pudieron vencer los folios con abono devuelto (la pasada sigue)', { error })
      }
      await barrer('findDue', this.dependencies.leerVencidos)

      return { scanned, expired, noop, errors, synced, collected, porEntregar }
    } catch (error) {
      logger.error('Online-order expiry pass failed', { error })
      return { scanned: 0, expired: 0, noop: 0, errors: 1, synced, collected, porEntregar }
    } finally {
      this.isRunning = false
    }
  }
}

export const onlineOrderAcceptanceExpiryJob = new OnlineOrderAcceptanceExpiryJob()

import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'
import { buscarParejasAMedias, type ParejaBloqueada, type ReparacionDelCierre } from '../services/shared/parejaDeCierre'
import { cerrarTurnoDeCaja } from '../services/shared/turnoDeCaja'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * NINGÚN CIERRE DE CAJA SE QUEDA A MEDIAS (Task 5l, 3-sep-2026).
 *
 * El cierre unificado son DOS commits: quien recibe el gesto cierra su registro y sólo después
 * cierra el otro. Si el proceso muere en medio —o la segunda mitad falla— queda una pareja partida,
 * y con la apertura ya unificada eso NO «degrada a lo de hoy». Degrada a dos daños de dinero:
 *
 *   · **mezclar jornadas**: el turno que sobrevive a su gaveta lo REUSA la cajera de la tarde
 *     (`abrirTurnoDeCaja` lo encuentra dentro del mismo día de negocio) y acaba firmando dos arqueos
 *     con los totales del día entero;
 *   · **efectivo sobre una gaveta sin turno**: la gaveta que sobrevive a su turno sigue recibiendo
 *     `CASH_SALE` de cobros que ya nacen sin turno, en una caja que nadie va a cuadrar.
 *
 * 🔴 **Sin tabla nueva, y no por ahorrar: la mitad que SÍ commiteó ES el registro durable.** Un
 * outbox existe para recordar una intención que no deja rastro; aquí la intención deja rastro por
 * construcción, y los cuatro datos que haría falta recordar —conteo, esperado, actor e instante— ya
 * están persistidos en la fila que ganó. Lo único que no se deriva es de qué turno era la gaveta, y
 * para eso está `CashDrawerSession.shiftId`, que los dos cierres escriben ANTES de su primer commit
 * (`asegurarLaLiga`). El detalle de por qué tampoco puede ser «una sola transacción» vive en
 * `services/shared/parejaDeCierre.ts`.
 *
 * Reparar es llamar al MISMO `cerrarTurnoDeCaja` con esos números, así que hereda su idempotencia:
 * las dos mitades cierran con un CAS (`updateMany where status='OPEN'`), de modo que barrer dos
 * veces —o barrer mientras un aparato cierra— no cierra nada dos veces ni firma nada distinto.
 *
 * 🔴 Y nunca inventa un conteo: si la mitad que falta no tiene uno que heredar, se cierra SIN
 * conteo (`actualAmount`/`overShort` en NULL), igual que el cierre automático.
 */

/**
 * Ventana hacia atrás. Una pareja más vieja ya la recogieron sus dueños —el relevo cierra el turno
 * de ayer al abrir, y el barrido de las 04:00 cierra el cajón—, y reabrir cierres antiguos con
 * conteos viejos es justo la dirección peligrosa. Dos días cubren de sobra un fin de semana cerrado.
 */
const LOOKBACK_DAYS = 2
const BATCH_LIMIT = 25
/** Un aviso por pareja atorada CADA MINUTO sería ruido; una hora deja la señal y no la ahoga. */
const AVISO_CADA_MS = 60 * 60 * 1000

type CronHandle = Pick<CronJob, 'start' | 'stop'>

export interface ResultadoDelBarridoDeParejas {
  scanned: number
  repaired: number
  failed: number
  skipped: number
  dryRun: boolean
  blocked: ParejaBloqueada[]
  candidates: ReparacionDelCierre[]
}

interface Dependencias {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  buscar: (opts: { limit: number; since: Date }) => Promise<{ parejas: ReparacionDelCierre[]; bloqueadas: ParejaBloqueada[] }>
  cerrar: typeof cerrarTurnoDeCaja
}

export const defaults: Dependencias = {
  now: () => new Date(),
  retryEntry: retry,
  buscar: opts => buscarParejasAMedias(prisma, opts),
  cerrar: cerrarTurnoDeCaja,
}

export class CashClosePairReconcilerJob {
  private readonly d: Dependencias
  private readonly cron: CronHandle
  private running = false
  private ultimoAviso = 0

  constructor(overrides: Partial<Dependencias> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'cash-close-pair-reconciler',
        DATABASE_JOB_SCHEDULES.cashClosePairReconciler,
        () => {
          void this.runNow().catch(error => logger.error('Cash close pair reconcile failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Cash close pair reconciler started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Cash close pair reconciler stopped')
  }

  /** `dryRun` lista sin tocar nada — es lo que hace seguro correrlo a mano contra producción. */
  async runNow(opts: { dryRun?: boolean; since?: Date } = {}): Promise<ResultadoDelBarridoDeParejas> {
    const dryRun = opts.dryRun === true
    const vacio: ResultadoDelBarridoDeParejas = { scanned: 0, repaired: 0, failed: 0, skipped: 0, dryRun, blocked: [], candidates: [] }
    if (this.running) return { ...vacio, skipped: 1 }
    this.running = true
    try {
      const now = this.d.now()
      const since = opts.since ?? new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      // La lectura de entrada va con retry: es la que muere en la estampida de crons (regla del repo).
      const { parejas, bloqueadas } = await this.d.retryEntry(() => this.d.buscar({ limit: BATCH_LIMIT, since }), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'cash-close-pair-reconciler.find',
      })
      const resultado: ResultadoDelBarridoDeParejas = { ...vacio, scanned: parejas.length, blocked: bloqueadas, candidates: parejas }

      this.avisarDeLasAtoradas(bloqueadas, now)
      if (dryRun) return resultado

      for (const pareja of parejas) {
        try {
          await this.d.cerrar(this.gestoQueFalta(pareja))
          resultado.repaired += 1
          // `logAction` nunca lanza (su contrato), así que esperarla no puede convertir una pareja
          // ya cerrada en un `failed`; y esperarla deja el asiento escrito antes de que el tic acabe.
          await logAction({
            // Quien firmó el cierre original. `null` cuando no había persona: fue un script o el
            // sistema, y decirlo es más honesto que atribuírselo a alguien.
            staffId: pareja.actorStaffId,
            venueId: pareja.venueId,
            action: 'CASH_CLOSE_PAIR_RECONCILED',
            // La entidad es la que ESTE barrido cerró, no la que ya estaba cerrada.
            entity: pareja.falta === 'TURNO' ? 'Shift' : 'CashDrawerSession',
            entityId: pareja.falta === 'TURNO' ? pareja.shiftId : pareja.cashDrawerSessionId,
            data: {
              falta: pareja.falta,
              shiftId: pareja.shiftId,
              cashDrawerSessionId: pareja.cashDrawerSessionId,
              // Importes en PESOS: es lo que lee una persona auditando, no un `Decimal` serializado.
              conteo: pareja.conteo != null ? Number(pareja.conteo) : null,
              esperado: pareja.esperado != null ? Number(pareja.esperado) : null,
              sinConteo: pareja.conteo == null,
              firmadoALas: pareja.momento.toISOString(),
              sweep: 'cash-close-pair-reconciler',
            },
          })
        } catch (error) {
          resultado.failed += 1
          logger.warn('💵 [cash-close-pair-reconciler] no se pudo cerrar la mitad que faltaba; se reintenta en el siguiente tic', {
            venueId: pareja.venueId,
            shiftId: pareja.shiftId,
            cashDrawerSessionId: pareja.cashDrawerSessionId,
            falta: pareja.falta,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (resultado.scanned > 0) {
        logger.info('💵 [cash-close-pair-reconciler] barrido', { ...resultado, candidates: undefined, blocked: undefined })
      }
      return resultado
    } finally {
      this.running = false
    }
  }

  /**
   * El gesto que falta, con los números de la mitad que ya firmó.
   *
   * 🔴 Los dos detalles que impiden mezclar jornadas: `shiftIdDeLaGaveta` viaja siempre —sin él,
   * `cerrarElTurnoDeLaGaveta` podría cerrar un turno abierto DESPUÉS con el conteo de esta gaveta—,
   * y el reloj del cierre de la gaveta es el instante que el turno firmó, no el del barrido, para
   * que la gaveta no absorba hacia atrás las ventas que entraron después del cierre.
   */
  private gestoQueFalta(pareja: ReparacionDelCierre): Parameters<typeof cerrarTurnoDeCaja>[0] {
    const comun = {
      venueId: pareja.venueId,
      staffId: pareja.actorStaffId,
      // Se resuelve del `Staff` en `cerrarTurnoDeCaja`; sin persona queda «Sistema».
      staffName: null,
      conteo: pareja.conteo,
      esperadoDelCajon: pareja.esperado,
    }
    return pareja.falta === 'TURNO'
      ? {
          ...comun,
          source: 'CAJA_MOVIL' as const,
          yaCerrado: { cashDrawerSessionId: pareja.cashDrawerSessionId },
          shiftIdDeLaGaveta: pareja.shiftId,
        }
      : {
          ...comun,
          source: 'TURNO_TPV' as const,
          yaCerrado: { shiftId: pareja.shiftId },
          now: () => pareja.momento,
        }
  }

  /**
   * 🔴 Lo tardío nunca se descarta en silencio. Lo que este barrido NO puede cerrar —una gaveta con
   * el turno de otro mientras alguien vende encima— es dinero mezclándose, y alguien tiene que
   * enterarse aunque tocarlo fuera peor. Se limita a un aviso por hora: una pareja atorada un día
   * entero escribiría 1,440 renglones y ahogaría justo la señal que quiere dar.
   */
  private avisarDeLasAtoradas(bloqueadas: ParejaBloqueada[], now: Date): void {
    if (bloqueadas.length === 0) return
    if (now.getTime() - this.ultimoAviso < AVISO_CADA_MS) return
    this.ultimoAviso = now.getTime()
    logger.warn(`💵 [cash-close-pair-reconciler] ${bloqueadas.length} pareja(s) de cierre no se pudieron cerrar solas`, { bloqueadas })
  }
}

export const cashClosePairReconcilerJob = new CashClosePairReconcilerJob()

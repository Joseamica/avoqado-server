import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'
import {
  buscarParejasAMedias,
  type ParejaBloqueada,
  type ParejasAMedias,
  type ReparacionDelCierre,
} from '../services/shared/parejaDeCierre'
import { cerrarTurnoDeCaja, type CerrarTurnoDeCajaResult } from '../services/shared/turnoDeCaja'
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
  /** Lo que se encontró y NO se cerró: las bloqueadas por la búsqueda MÁS las que fallaron aquí. */
  blocked: ParejaAtorada[]
  candidates: ReparacionDelCierre[]
}

/**
 * Una pareja que se encontró y NO se cerró — por la búsqueda o por el cierre.
 *
 * 🔴 El `motivo` acepta los DOS vocabularios sin traducir uno al otro: el de la búsqueda
 * (`MotivoNoReparable`) y el que devuelve `cerrarTurnoDeCaja`. Inventar un tercer nombre para
 * «`SIN_PAREJA`, pero al reparar» haría que el log no se pudiera cruzar con el del cierre, que es
 * exactamente lo que uno quiere hacer al investigar.
 */
export type ParejaAtorada = Omit<ParejaBloqueada, 'motivo'> & {
  motivo: ParejaBloqueada['motivo'] | NonNullable<CerrarTurnoDeCajaResult['motivo']>
  /** El mensaje, cuando lo que falló fue una EXCEPCIÓN y no un `motivo` del cierre. */
  detalle?: string
}

interface Dependencias {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  buscar: (opts: { limit: number; since: Date }) => Promise<ParejasAMedias>
  cerrar: typeof cerrarTurnoDeCaja
  medirLoTardio: (pareja: ReparacionDelCierre) => Promise<{ cobros: number; importe: number }>
}

/**
 * Lo que entró DESPUÉS de que se firmó el conteo y antes de que el barrido cerrara la otra mitad.
 *
 * 🔴 No se puede evitar (ver `gestoQueFalta`), así que se MIDE: sin esto, la única huella de que el
 * reporte y el arqueo dicen cosas distintas sería restarlos a mano meses después.
 *
 * Sólo se mide en la dirección TURNO, que es donde hay algo que atribuir: los cobros siguen naciendo
 * con el `shiftId` del turno que quedó abierto. En la dirección contraria el turno ya está cerrado,
 * así que lo que entra después no pertenece a ningún turno — es el hueco de «cobros sin turno», que
 * ya tiene dueño y no es éste.
 */
async function medirCobrosTardios(pareja: ReparacionDelCierre): Promise<{ cobros: number; importe: number }> {
  if (pareja.falta !== 'TURNO') return { cobros: 0, importe: 0 }
  const tardios = await prisma.payment.aggregate({
    where: { shiftId: pareja.shiftId, status: 'COMPLETED', createdAt: { gt: pareja.momento } },
    _count: { _all: true },
    _sum: { amount: true },
  })
  return { cobros: tardios._count._all, importe: Number(tardios._sum.amount ?? 0) }
}

export const defaults: Dependencias = {
  now: () => new Date(),
  retryEntry: retry,
  buscar: opts => buscarParejasAMedias(prisma, opts),
  cerrar: cerrarTurnoDeCaja,
  medirLoTardio: medirCobrosTardios,
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
      const { escaneadas, parejas, bloqueadas } = await this.d.retryEntry(() => this.d.buscar({ limit: BATCH_LIMIT, since }), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'cash-close-pair-reconciler.find',
      })
      const atoradas: ParejaAtorada[] = [...bloqueadas]
      const resultado: ResultadoDelBarridoDeParejas = {
        ...vacio,
        // FILAS miradas, no candidatas: un tic que sólo encuentra bloqueadas trabajó igual.
        scanned: escaneadas,
        blocked: atoradas,
        candidates: parejas,
      }

      if (dryRun) {
        this.avisarDeLasAtoradas(atoradas, now)
        return resultado
      }

      for (const pareja of parejas) {
        try {
          // 🔴 `cerrarTurnoDeCaja` NO LANZA cuando no cierra nada: devuelve un `motivo`. Descartar
          // este valor hacía que el barrido se anotara como reparado algo que no reparó Y escribiera
          // una fila en la bitácora de dinero nombrando un conteo y un esperado de un cierre que
          // nunca ocurrió — cada minuto, para siempre, y sin un solo aviso.
          const cierre = await this.d.cerrar(this.gestoQueFalta(pareja))
          if (cierre.motivo) {
            // `YA_CERRADO` es la carrera BENIGNA: el aparato cerró primero, que es el estado que
            // queríamos. No es un fallo, no se avisa, y el barrido no se lleva un crédito ajeno.
            if (cierre.motivo === 'YA_CERRADO') continue
            resultado.failed += 1
            atoradas.push({
              venueId: pareja.venueId,
              shiftId: pareja.shiftId,
              cashDrawerSessionId: pareja.cashDrawerSessionId,
              motivo: cierre.motivo,
            })
            continue
          }
          resultado.repaired += 1
          // Lo que no se pudo evitar, queda MEDIDO. Nunca puede tumbar una reparación ya ocurrida.
          const tardio = await this.d.medirLoTardio(pareja).catch(error => {
            logger.warn('💵 [cash-close-pair-reconciler] no se pudieron medir los cobros posteriores al conteo', {
              venueId: pareja.venueId,
              shiftId: pareja.shiftId,
              error: error instanceof Error ? error.message : String(error),
            })
            return null
          })
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
              // 🔴 Lo que entró entre el conteo y esta reparación: el reporte del turno lo incluye
              // y el arqueo no. `null` = no se pudo medir, que NO es lo mismo que cero.
              cobrosDespuesDelConteo: tardio?.cobros ?? null,
              importeDespuesDelConteo: tardio?.importe ?? null,
              sweep: 'cash-close-pair-reconciler',
            },
          })
        } catch (error) {
          // Una EXCEPCIÓN es otra cosa que un `motivo` —un fallo de base, un defecto—, así que
          // conserva su mensaje; pero sale por el MISMO aviso, o un fallo persistente escribiría
          // un renglón por minuto para siempre.
          resultado.failed += 1
          atoradas.push({
            venueId: pareja.venueId,
            shiftId: pareja.shiftId,
            cashDrawerSessionId: pareja.cashDrawerSessionId,
            motivo: 'CIERRE_EN_CURSO',
            detalle: error instanceof Error ? error.message : String(error),
          })
        }
      }

      this.avisarDeLasAtoradas(atoradas, now)

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
   * 🔴 `shiftIdDeLaGaveta` viaja siempre: sin él, `cerrarElTurnoDeLaGaveta` podría cerrar un turno
   * abierto DESPUÉS con el conteo de esta gaveta, que es exactamente mezclar jornadas.
   *
   * 🔴 **El reloj sólo se inyecta en la dirección GAVETA, y la asimetría NO es un descuido — es que
   * en la otra dirección inyectarlo sería peor que el problema que arregla.** Medido, no supuesto:
   *
   *   · `cerrarLaGavetaDelTurno` usa `p.now` para dos cosas suyas y de nadie más (el filtro
   *     `openedAt <= momento` y el `closedAt` que escribe), así que darle el instante que el turno
   *     firmó es gratis y correcto: la gaveta no absorbe hacia atrás las ventas posteriores.
   *   · En la dirección TURNO, el cierre pasa por `claimShiftForClose`, que **escribe
   *     `updatedAt: claimedAt` como testigo del CAS**. Inyectar un instante pasado dejaría el
   *     reclamo naciendo ya vencido: `SHIFT_CLOSE_STALE_MS` son **5 minutos**, y
   *     `shift-close-watchdog` corre **cada minuto** devolviendo a `OPEN` todo `CLOSING` más viejo
   *     que eso. Cualquier pareja de más de 5 minutos —justo las que estuvieron bloqueadas y por fin
   *     se pueden reparar— vería su reclamo revertido a media reparación y el CAS final fallaría,
   *     **para siempre**. Y de paso encogería la ventana `lte: claimedAt` del consumo de inventario.
   *
   * ⚠️ **El límite que eso deja, declarado y MEDIDO en cada reparación:** el turno se cierra con
   * `endTime` = la hora del barrido, así que un cobro en efectivo entre el conteo de la gaveta y la
   * reparación (≤ ~1 min en el caso normal) nace con el `shiftId` del turno todavía abierto y entra
   * a `totalCashPayments`, mientras que su `CASH_SALE` cae fuera de la gaveta ya cerrada. Reporte y
   * arqueo discrepan por ese importe. 🔑 Inyectar el reloj **tampoco lo arreglaría**: los cobros del
   * turno se agregan por `where: { shiftId }`, **sin filtro de fecha**, así que mover `endTime` no
   * saca ni una fila de la suma. Lo que sí se puede hacer —y se hace— es que el importe quede
   * escrito: `cobrosDespuesDelConteo` e `importeDespuesDelConteo` en el asiento de la bitácora.
   * La firma del DINERO, en cambio, no diverge: `cashDifference` se calcula contra el
   * `esperadoDelCajon` que se pasa aquí, que es el de la gaveta.
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
  private avisarDeLasAtoradas(bloqueadas: ParejaAtorada[], now: Date): void {
    if (bloqueadas.length === 0) return
    if (now.getTime() - this.ultimoAviso < AVISO_CADA_MS) return
    this.ultimoAviso = now.getTime()
    logger.warn(`💵 [cash-close-pair-reconciler] ${bloqueadas.length} pareja(s) de cierre no se pudieron cerrar solas`, { bloqueadas })
  }
}

export const cashClosePairReconcilerJob = new CashClosePairReconcilerJob()

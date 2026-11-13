import type { CronJob } from 'cron'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { logAction } from '../services/dashboard/activity-log.service'
import { conNegocio } from '../services/demo/candadoDemo'
import { buscarComercioDeMercadoPago, procesarPagoDeMercadoPago } from '../services/mercado-pago/payment-flow.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Cierre perdido de Mercado Pago (tarjeta D1, 12-nov): MP aprobó el cobro y no quedó venta.
 *
 * El aviso de MP (`handleIpn`) responde 200 aunque falle, y el mismo aviso repetido sale como `duplicate`, así que
 * nadie reintentaba. Este barrido retoma, cada 5 min:
 *   1. eventos de pago en `error` (el cierre o la consulta a MP fallaron) o `pending` de más de 3 min (el proceso murió a
 *      la mitad);
 *   2. sesiones con número de pago de MP, sin `Payment`, no reembolsadas (`FAILED`) y sin evento abierto ni desenlace final
 *      de MP (`ignored`): el cierre optimista falló y el aviso nunca llegó, o el aviso de la aprobación ni siquiera se pudo
 *      guardar (Codex r1 #1). `CANCELLED` entra: una cancelación sólo local (SDK) no cancela el pago en MP (Codex r2 #1);
 *      cuando MP dice rechazado/cancelado/reembolsado el evento queda `ignored` y la sesión ya no se revisa.
 *      A cada una le abre su evento `barrido:<sessionId>` y entra por el punto 1.
 * Por cada pago vuelve a preguntarle a MP y, si está aprobado, corre el cierre (idempotente por `session.paymentId` y
 * `Payment.idempotencyKey = mpPaymentId`). Un cobro recuperado deja `ActivityLog`.
 *
 * Tope VISIBLE sin migración: el contador vive en el propio evento (`errorMessage = "[barrido N/MAX] razón"`); al tope el
 * evento pasa a `abandonado` con `logger.error` y `ActivityLog`. Reabrirlo a mano = volver a ponerlo en `error`.
 */

const GRACIA_PENDIENTE_MS = 3 * 60_000
/** Una sesión se revisa como mucho cada 15 min (las de OXXO pueden seguir pendientes días); también da gracia al cierre en vuelo. */
const ESPACIADO_SESION_MS = 15 * 60_000
const VENTANA_MS = 30 * 24 * 60 * 60_000
/** ponytail: intervalo fijo (5 min × 72 ≈ 6 h); backoff si MP o un despliegue tardan más que eso. */
export const MAX_INTENTOS = 72
const LOTE = 25
const CONTADOR = /^\[barrido (\d+)\//

type CronHandle = Pick<CronJob, 'start' | 'stop'>

interface Dependencias {
  prisma: typeof prisma
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  procesar: typeof procesarPagoDeMercadoPago
  buscarComercio: typeof buscarComercioDeMercadoPago
  logAction: typeof logAction
}

const defaults: Dependencias = {
  prisma,
  now: () => new Date(),
  retryEntry: retry,
  procesar: procesarPagoDeMercadoPago,
  buscarComercio: buscarComercioDeMercadoPago,
  logAction,
}

export interface ResultadoDelBarrido {
  encoladas: number
  pagos: number
  recuperados: number
  errores: number
  abandonados: number
}

const intentosDe = (errorMessage: string | null): number => Number(CONTADOR.exec(errorMessage ?? '')?.[1] ?? 0)

export class MercadoPagoCierrePerdidoJob {
  private readonly d: Dependencias
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<Dependencias> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'mercadopago-cierre-perdido',
        DATABASE_JOB_SCHEDULES.mercadoPagoCierrePerdido,
        () => {
          void this.runNow().catch(error => logger.error('[MP barrido] Falló la vuelta', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Mercado Pago cierre-perdido sweeper started')
  }

  stop(): void {
    this.cron.stop()
  }

  async runNow(): Promise<ResultadoDelBarrido> {
    const r: ResultadoDelBarrido = { encoladas: 0, pagos: 0, recuperados: 0, errores: 0, abandonados: 0 }
    if (this.running) return r
    this.running = true
    try {
      const now = this.d.now()
      const desde = new Date(now.getTime() - VENTANA_MS)
      const opciones = (context: string) => ({ retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })

      // 2 → 1: sesiones con número de pago de MP, sin venta y sin desenlace final, sin ningún evento abierto de ese pago
      // (si lo hay, ya lo retoma el punto 1). Cada una se revisa como mucho cada 15 min: se le toca `updatedAt`.
      // Lectura de entrada: con reintento de conexión.
      const sinVenta = await this.d.retryEntry(
        () =>
          this.d.prisma.$queryRaw<Array<{ id: string; sessionId: string; mpPaymentId: string; mpUserId: string; status: string }>>`
            SELECT cs."id", cs."sessionId", cs."mpPaymentId", em."providerMerchantId" AS "mpUserId", cs."status"::text AS "status"
            FROM "CheckoutSession" cs
            JOIN "EcommerceMerchant" em ON em."id" = cs."ecommerceMerchantId"
            WHERE cs."paymentId" IS NULL
              AND cs."mpPaymentId" IS NOT NULL
              AND cs."status" <> 'FAILED'
              AND em."providerMerchantId" IS NOT NULL
              AND cs."createdAt" >= ${utcTs(desde)}
              AND cs."updatedAt" < ${utcTs(new Date(now.getTime() - ESPACIADO_SESION_MS))}
              AND NOT EXISTS (
                SELECT 1 FROM "MercadoPagoWebhookEvent" e
                WHERE e."mpUserId" = em."providerMerchantId"
                  AND e."dataId" = cs."mpPaymentId"
                  AND e."processingStatus" IN ('error', 'pending', 'abandonado', 'ignored')
              )
            ORDER BY cs."updatedAt" ASC, cs."id" ASC
            LIMIT ${LOTE}`,
        opciones('mercadopago-cierre-perdido.sesiones'),
      )
      for (const s of sinVenta) {
        // Un evento propio por sesión; si ya existía (procesado: MP decía «pendiente»), se reabre con el contador en cero.
        const errorMessage = `sesión ${s.status} sin venta: la retoma el barrido`
        await this.d.prisma.mercadoPagoWebhookEvent.upsert({
          where: { mpUserId_dataId_requestId: { mpUserId: s.mpUserId, dataId: s.mpPaymentId, requestId: `barrido:${s.sessionId}` } },
          create: {
            mpUserId: s.mpUserId,
            dataId: s.mpPaymentId,
            requestId: `barrido:${s.sessionId}`,
            eventType: 'payment',
            action: 'barrido.sesion_sin_venta',
            payload: { origen: 'barrido', sessionId: s.sessionId },
            processingStatus: 'error',
            errorMessage,
          },
          update: { processingStatus: 'error', errorMessage },
        })
      }
      if (sinVenta.length > 0) {
        await this.d.prisma.checkoutSession.updateMany({ where: { id: { in: sinVenta.map(s => s.id) } }, data: { updatedAt: now } })
        r.encoladas = sinVenta.length
        logger.info('[MP barrido] Sesiones de MP sin venta por revisar', { sesiones: sinVenta.map(s => `${s.sessionId}:${s.status}`) })
      }

      // 1. Eventos de pago que no terminaron.
      const eventos = await this.d.retryEntry(
        () =>
          this.d.prisma.mercadoPagoWebhookEvent.findMany({
            where: {
              eventType: 'payment',
              createdAt: { gte: desde },
              OR: [
                { processingStatus: 'error' },
                { processingStatus: 'pending', createdAt: { lt: new Date(now.getTime() - GRACIA_PENDIENTE_MS) } },
              ],
            },
            select: { id: true, mpUserId: true, dataId: true, errorMessage: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: LOTE,
          }),
        opciones('mercadopago-cierre-perdido.eventos'),
      )

      // Varios avisos del mismo pago = una sola consulta a MP y un solo cierre.
      const grupos = new Map<string, typeof eventos>()
      for (const e of eventos) {
        const clave = `${e.mpUserId}|${e.dataId}`
        grupos.set(clave, [...(grupos.get(clave) ?? []), e])
      }

      for (const grupo of grupos.values()) {
        r.pagos += 1
        const { mpUserId, dataId } = grupo[0]
        const ids = grupo.map(e => e.id)
        const intentos = Math.max(...grupo.map(e => intentosDe(e.errorMessage))) + 1
        let venueId: string | null = null
        try {
          const comercio = await this.d.buscarComercio(mpUserId)
          venueId = comercio?.venueId ?? null
          // candado demo, capa 3: el cierre corre con el negocio de su cobro en el contexto.
          const desenlace = comercio
            ? await conNegocio(comercio.venueId, () => this.d.procesar(comercio, dataId))
            : { estado: 'error' as const, razon: 'merchant_not_found', detalle: `no merchant matches mpUserId ${mpUserId}` }

          if (desenlace.estado !== 'error') {
            // Bitácora ANTES de marcar el evento: si el marcado falla, el reintento ve la venta hecha (ventaCreada=false)
            // y el renglón ya existe; al revés se perdía para siempre (Codex r2 #2).
            if (desenlace.ventaCreada) {
              r.recuperados += 1
              logger.warn('[MP barrido] Cobro aprobado sin venta RECUPERADO', {
                venueId,
                mpPaymentId: dataId,
                checkoutSessionId: desenlace.checkoutSessionId,
                intentos,
              })
              await this.d.logAction({
                venueId,
                action: 'MERCADOPAGO_CHARGE_RECOVERED',
                entity: 'CheckoutSession',
                entityId: desenlace.checkoutSessionId,
                data: { mpPaymentId: dataId, eventIds: ids, intentos },
              })
            }
            await this.d.prisma.mercadoPagoWebhookEvent.updateMany({
              where: { id: { in: ids } },
              data: { processingStatus: desenlace.estado, errorMessage: desenlace.estado === 'ignored' ? desenlace.detalle : null },
            })
            continue
          }
          await this.fallo(r, { ids, mpUserId, dataId, venueId, intentos, razon: desenlace.detalle ?? desenlace.razon })
        } catch (error) {
          await this.fallo(r, {
            ids,
            mpUserId,
            dataId,
            venueId,
            intentos,
            razon: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (eventos.length > 0) logger.info('[MP barrido] Vuelta terminada', { ...r })
      return r
    } finally {
      this.running = false
    }
  }

  private async fallo(
    r: ResultadoDelBarrido,
    f: { ids: string[]; mpUserId: string; dataId: string; venueId: string | null; intentos: number; razon: string },
  ): Promise<void> {
    r.errores += 1
    const abandonado = f.intentos >= MAX_INTENTOS
    await this.d.prisma.mercadoPagoWebhookEvent.updateMany({
      where: { id: { in: f.ids } },
      data: {
        processingStatus: abandonado ? 'abandonado' : 'error',
        errorMessage: `[barrido ${f.intentos}/${MAX_INTENTOS}] ${f.razon}`.slice(0, 1000),
      },
    })
    if (!abandonado) {
      logger.warn('[MP barrido] El cobro sigue sin cerrar; se reintenta en la próxima vuelta', { ...f })
      return
    }
    r.abandonados += 1
    logger.error('🚨 [MP barrido] Cobro de Mercado Pago ABANDONADO: alcanzó el tope de reintentos — requiere conciliación manual', {
      ...f,
      maxIntentos: MAX_INTENTOS,
    })
    await this.d.logAction({
      venueId: f.venueId,
      action: 'MERCADOPAGO_RECOVERY_ABANDONED',
      entity: 'MercadoPagoWebhookEvent',
      entityId: f.ids[0],
      data: { mpPaymentId: f.dataId, mpUserId: f.mpUserId, eventIds: f.ids, intentos: f.intentos, razon: f.razon },
    })
  }
}

export const mercadoPagoCierrePerdidoJob = new MercadoPagoCierrePerdidoJob()

// jobs/delivery-line-action-reconciler.job.ts

import type { CronJob } from 'cron'
import type { Prisma } from '@prisma/client'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { RESERVA_TTL_MS } from '../services/delivery-channels/core/deliveryOrderLock'
import * as reconciliacion from '../services/delivery-channels/core/deliveryReconciliation.service'
import { markDeliveryOrderReady } from '../services/delivery-channels/core/respondToDeliveryOrder.service'
import { RETIRO_SIN_REFLEJAR_MS } from '../services/mobile/kdsOutOfStock.mobile.service'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Recuperación de las salidas a Uber sobre un pedido (spec KDS Uber §3.4, [C-7][N-20]).
 *
 * Lo que la ruta del KDS deja a medias, este barrido lo termina. Cada 60 s, lote de 20,
 * una cosa a la vez, una transacción por acción:
 *
 *  1. `PENDING` con más de 2 min ⇒ `UNCERTAIN` (el proceso murió entre insertar y llamar).
 *     CAS sobre `attempts`: el reintento humano sigue apuntando al mismo intento.
 *  2. `UNCERTAIN` y `CONFIRMED` con `settlement PENDING|ACCREDITED` ⇒ la MISMA
 *     `reconcileDeliveryOrderFromProvider`. Una lectura sin cambios no prueba nada: no se
 *     reenvía jamás. Las órdenes con `deliveryReconcileBlocked` NO entran (esperan a una
 *     persona; si entraran, 20 bloqueadas se comerían el lote para siempre) — se ven en el 3.
 *  3. A las 24 h en ese estado ⇒ 🚨 una vez, con rastro en `ActivityLog`.
 *  4. Reservas huérfanas (> 2 min) ⇒ se limpian, por token.
 *  5. «Listo» que la reserva dejó sin avisar ⇒ se reintenta (Ruling P7 de la Tarea 7).
 *
 * Un throw de la reconciliación vale lo mismo que `READ_FAILED`: se registra y se sigue con la
 * siguiente. A la 3.ª falla seguida la orden espera un intervalo creciente, y ese conteo vive en
 * `ActivityLog` (sobrevive a un reinicio sin migración).
 */

const LOTE = 20
/** Spec §3.4: un PENDING sin respuesta en 2 min es un proceso que murió entre insertar y llamar. */
const PENDIENTE_SIN_RESPUESTA_MS = 2 * 60_000
/** Un «listo» se reintenta sólo si la comanda se marcó en las últimas 6 h. */
const LISTO_LOOKBACK_MS = 6 * 3_600_000
/** Las reservas y los «listos» sólo se buscan en pedidos del último día (rango sobre índice). */
const PEDIDO_LOOKBACK_MS = 24 * 3_600_000
const FALLOS_ANTES_DE_ESPERAR = 3
const ESPERA_MAXIMA_MIN = 6 * 60

const ERROR_RECONCILIACION = 'DELIVERY_RECONCILE_ERROR'
const RECONCILIACION_RECUPERADA = 'DELIVERY_RECONCILE_RECOVERED'
const RETIRO_SIN_REFLEJAR = 'DELIVERY_ITEM_REMOVAL_UNREFLECTED'

/** Minutos de espera tras `n` fallas seguidas: 0 hasta la 3.ª, luego 2, 4, 8… con tope de 6 h. */
export const esperaTrasFallosMin = (n: number) => (n < FALLOS_ANTES_DE_ESPERAR ? 0 : Math.min(2 ** (n - 2), ESPERA_MAXIMA_MIN))

type Contadores = { inciertas: number; reconciliadas: number; fallidas: number; alertas: number; reservas: number; listos: number }

export class DeliveryLineActionReconcilerJob {
  private job: CronJob | null = null
  private enCurso = false
  /**
   * Rotación del lote: un CONFIRMED cuya línea sigue en Uber nunca sale del barrido, y sin
   * cursor los 20 más viejos se comerían todas las pasadas.
   * ponytail: en memoria; un reinicio sólo vuelve a empezar la vuelta.
   */
  private cursor = ''
  /**
   * «Listo» ya dicho a Uber que no se acreditó (409, rechazo): espera creciente en vez de
   * martillar cada minuto durante 6 h. ponytail: en memoria, se pierde al reiniciar (a lo más
   * se repite un aviso); una columna si algún día corre en varias instancias.
   */
  private esperaListo = new Map<string, { n: number; hasta: number }>()

  start(): void {
    if (this.job) return
    this.job = scheduleJob('delivery-line-action-reconciler', DATABASE_JOB_SCHEDULES.deliveryLineActionReconciler, async () => {
      await this.runOnce()
    })
    this.job.start()
    logger.info(`🛵 Delivery line-action reconciler started — cada minuto, lote ${LOTE}`)
  }

  stop(): void {
    this.job?.stop()
    this.job = null
  }

  async runOnce(): Promise<Contadores> {
    const c: Contadores = { inciertas: 0, reconciliadas: 0, fallidas: 0, alertas: 0, reservas: 0, listos: 0 }
    if (this.enCurso) return c
    this.enCurso = true
    try {
      // Cada paso aislado: que uno truene no deja sin correr a los demás.
      const paso = async (nombre: string, fn: () => Promise<void>) => {
        try {
          await fn()
        } catch (error) {
          logger.error(`❌ [Delivery line-actions] falló el paso ${nombre}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      await paso('pendientes', async () => void (c.inciertas = await this.pendientesAInciertas()))
      await paso('reconciliar', async () => void Object.assign(c, await this.reconciliar()))
      await paso('alertas', async () => void (c.alertas = await this.alertarSinReflejar()))
      await paso('reservas', async () => void (c.reservas = await this.limpiarReservas()))
      await paso('listos', async () => void (c.listos = await this.reintentarListos()))
      if (Object.values(c).some(v => v > 0)) logger.info('🛵 [Delivery line-actions] pasada', c)
      return c
    } finally {
      this.enCurso = false
    }
  }

  /** 1. PENDING viejo ⇒ UNCERTAIN, con CAS sobre el intento que se vio. */
  private async pendientesAInciertas(): Promise<number> {
    const corte = new Date(Date.now() - PENDIENTE_SIN_RESPUESTA_MS)
    const filas = await retry(
      () =>
        prisma.deliveryLineAction.findMany({
          where: { status: 'PENDING', lastAttemptAt: { lt: corte } },
          select: { id: true, attempts: true, orderId: true },
          orderBy: { lastAttemptAt: 'asc' },
          take: LOTE,
        }),
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.pendientes' },
    )
    let n = 0
    for (const f of filas) {
      const r = await prisma.deliveryLineAction.updateMany({
        where: { id: f.id, status: 'PENDING', attempts: f.attempts, lastAttemptAt: { lt: corte } },
        data: { status: 'UNCERTAIN' },
      })
      if (r.count > 0) {
        n++
        logger.warn('[Delivery line-actions] retiro sin respuesta en 2 min ⇒ UNCERTAIN', { actionId: f.id, orderId: f.orderId })
      }
    }
    return n
  }

  /** 2. Reconciliación por pedido, rotando el lote y sin órdenes bloqueadas. */
  private async reconciliar(): Promise<{ reconciliadas: number; fallidas: number }> {
    const filas = await retry(
      () =>
        prisma.$queryRaw<Array<{ id: string; orderId: string; venueId: string }>>`
          SELECT a.id, a."orderId", a."venueId"
          FROM "DeliveryLineAction" a
          JOIN "Order" o ON o.id = a."orderId" AND o."venueId" = a."venueId"
          WHERE a.action = 'REMOVE_ITEM'
            AND (a.status = 'UNCERTAIN' OR (a.status = 'CONFIRMED' AND a.settlement IN ('PENDING', 'ACCREDITED')))
            AND o."deliveryReconcileBlocked" IS NULL
            AND a.id > ${this.cursor}
          ORDER BY a.id
          LIMIT ${LOTE}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.reconciliar' },
    )
    this.cursor = filas.length < LOTE ? '' : filas[filas.length - 1].id

    let reconciliadas = 0
    let fallidas = 0
    const vistas = new Set<string>()
    for (const f of filas) {
      if (vistas.has(f.orderId)) continue // una reconciliación cubre todas las acciones del pedido
      vistas.add(f.orderId)
      const racha = await this.rachaDeFallos(f.orderId)
      if (racha.hasta > Date.now()) continue

      let fallo: string | null = null
      try {
        const r = await reconciliacion.reconcileDeliveryOrderFromProvider(f.orderId, { trigger: 'JOB' })
        if (r.outcome === 'READ_FAILED') fallo = 'READ_FAILED'
      } catch (error) {
        fallo = error instanceof Error ? error.message : String(error)
      }

      if (fallo === null) {
        reconciliadas++
        if (racha.n > 0) await this.registrar(f.venueId, f.orderId, RECONCILIACION_RECUPERADA, { tras: racha.n })
        continue
      }
      fallidas++
      const n = racha.n + 1
      const retryAt = new Date(Date.now() + esperaTrasFallosMin(n) * 60_000)
      await this.registrar(f.venueId, f.orderId, ERROR_RECONCILIACION, {
        consecutive: n,
        retryAt: retryAt.toISOString(),
        error: fallo.slice(0, 300),
      })
      const detalle = { orderId: f.orderId, venueId: f.venueId, consecutive: n, retryAt, error: fallo.slice(0, 300) }
      if (n >= FALLOS_ANTES_DE_ESPERAR)
        logger.error('🚨 [Delivery line-actions] reconciliación sin resultado seguida: la orden espera', detalle)
      else logger.warn('[Delivery line-actions] reconciliación sin resultado; se reintenta', detalle)
    }
    return { reconciliadas, fallidas }
  }

  /** Fallas seguidas de la orden y hasta cuándo espera. La racha la corta un RECOVERED. */
  private async rachaDeFallos(orderId: string): Promise<{ n: number; hasta: number }> {
    const ultimo = await prisma.activityLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: { in: [ERROR_RECONCILIACION, RECONCILIACION_RECUPERADA] } },
      orderBy: { createdAt: 'desc' },
      select: { action: true, data: true },
    })
    if (ultimo?.action !== ERROR_RECONCILIACION) return { n: 0, hasta: 0 }
    const d = (ultimo.data ?? {}) as { consecutive?: number; retryAt?: string }
    return { n: d.consecutive ?? 1, hasta: d.retryAt ? new Date(d.retryAt).getTime() : 0 }
  }

  private registrar(venueId: string, orderId: string, action: string, data: Prisma.InputJsonObject) {
    return prisma.activityLog.create({ data: { venueId, staffId: null, action, entity: 'Order', entityId: orderId, data } })
  }

  /** 3. 24 h sin reflejarse en Uber (o bloqueada esperando a una persona) ⇒ 🚨 una sola vez. */
  private async alertarSinReflejar(): Promise<number> {
    const corte = new Date(Date.now() - RETIRO_SIN_REFLEJAR_MS)
    const filas = await retry(
      () =>
        prisma.$queryRaw<Array<{ id: string; venueId: string; orderId: string; lineId: string; status: string; bloqueo: string | null }>>`
          SELECT a.id, a."venueId", a."orderId", a."lineId", a.status, o."deliveryReconcileBlocked" AS bloqueo
          FROM "DeliveryLineAction" a
          JOIN "Order" o ON o.id = a."orderId" AND o."venueId" = a."venueId"
          WHERE a.action = 'REMOVE_ITEM'
            AND ((a.status = 'CONFIRMED' AND a.settlement IN ('PENDING', 'ACCREDITED'))
                 OR (a.status = 'UNCERTAIN' AND o."deliveryReconcileBlocked" IS NOT NULL))
            AND COALESCE(a."resolvedAt", a."lastAttemptAt") <= ${utcTs(corte)}
            AND NOT EXISTS (
              SELECT 1 FROM "ActivityLog" l
              WHERE l.entity = 'DeliveryLineAction' AND l."entityId" = a.id AND l.action = ${RETIRO_SIN_REFLEJAR})
          ORDER BY a.id
          LIMIT ${LOTE}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.alertas' },
    )
    for (const f of filas) {
      await prisma.activityLog.create({
        data: {
          venueId: f.venueId,
          staffId: null,
          action: RETIRO_SIN_REFLEJAR,
          entity: 'DeliveryLineAction',
          entityId: f.id,
          data: { orderId: f.orderId, lineId: f.lineId, status: f.status, bloqueo: f.bloqueo },
        },
      })
      logger.error('🚨 [Delivery line-actions] retiro sin reflejar en Uber tras 24 h: revisar el pedido', {
        actionId: f.id,
        orderId: f.orderId,
        venueId: f.venueId,
        bloqueo: f.bloqueo,
      })
    }
    return filas.length
  }

  /** 4. Reservas huérfanas, limpiadas por token (spec §3.2). */
  private async limpiarReservas(): Promise<number> {
    const corte = new Date(Date.now() - RESERVA_TTL_MS)
    const filas = await retry(
      () =>
        prisma.order.findMany({
          where: {
            createdAt: { gte: new Date(Date.now() - PEDIDO_LOOKBACK_MS) },
            deliveryOpInFlightAt: { lt: corte },
            deliveryOpToken: { not: null },
          },
          select: { id: true, venueId: true, deliveryOpInFlight: true, deliveryOpToken: true },
          take: LOTE,
        }),
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.reservas' },
    )
    let n = 0
    for (const f of filas) {
      const r = await prisma.order.updateMany({
        where: { id: f.id, deliveryOpToken: f.deliveryOpToken, deliveryOpInFlightAt: { lt: corte } },
        data: { deliveryOpInFlight: null, deliveryOpInFlightAt: null, deliveryOpToken: null },
      })
      if (r.count > 0) {
        n++
        logger.error('🚨 [Delivery line-actions] reserva huérfana limpiada', {
          orderId: f.id,
          venueId: f.venueId,
          op: f.deliveryOpInFlight,
        })
      }
    }
    return n
  }

  /** 5. «Listo» en cocina que no llegó a Uber (reserva tomada en el bump). */
  private async reintentarListos(): Promise<number> {
    const ahora = Date.now()
    for (const [id, e] of this.esperaListo) if (e.hasta + LISTO_LOOKBACK_MS < ahora) this.esperaListo.delete(id)

    const enEspera = [...this.esperaListo].filter(([, e]) => e.hasta > ahora).map(([id]) => id)
    const filas = await retry(
      () =>
        prisma.$queryRaw<Array<{ id: string; venueId: string }>>`
          SELECT o.id, o."venueId"
          FROM "Order" o
          WHERE o."createdAt" >= ${utcTs(new Date(ahora - PEDIDO_LOOKBACK_MS))}
            AND o.type = 'DELIVERY' AND o."externalId" IS NOT NULL
            AND o."readyReportedAt" IS NULL AND o.status <> 'CANCELLED'
            AND NOT (o.id = ANY(${enEspera}::text[]))
            AND EXISTS (
              SELECT 1 FROM "KdsOrder" k
              WHERE k."orderId" = o.id AND k."venueId" = o."venueId"
                AND k.status IN ('READY', 'COMPLETED') AND k."updatedAt" >= ${utcTs(new Date(ahora - LISTO_LOOKBACK_MS))})
          ORDER BY o."createdAt"
          LIMIT ${LOTE}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.listos' },
    )
    let n = 0
    for (const f of filas) {
      const espera = this.esperaListo.get(f.id)
      let outcome: string
      try {
        outcome = (await markDeliveryOrderReady(f.venueId, f.id)).outcome
      } catch (error) {
        outcome = 'THREW'
        logger.warn('[Delivery line-actions] reintento de «listo» falló', { orderId: f.id, error: String(error) })
      }
      // Reserva o retiro en curso: no se habló con Uber, se intenta el siguiente minuto.
      if (outcome === 'OP_IN_PROGRESS' || outcome === 'LINE_ACTION_IN_PROGRESS') continue
      n++
      const intentos = (espera?.n ?? 0) + 1
      this.esperaListo.set(f.id, { n: intentos, hasta: ahora + Math.min(2 ** intentos, 60) * 60_000 })
    }
    return n
  }
}

export const deliveryLineActionReconcilerJob = new DeliveryLineActionReconcilerJob()

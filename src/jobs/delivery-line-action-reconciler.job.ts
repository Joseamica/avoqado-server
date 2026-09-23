// jobs/delivery-line-action-reconciler.job.ts

import type { CronJob } from 'cron'
import { Prisma } from '@prisma/client'

import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { proveedoresConAdaptador } from '../services/delivery-channels/core/adapterRegistry'
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
 *     reenvía jamás. Las órdenes con `deliveryReconcileBlocked` (esperan a una persona) y las
 *     CANCELADAS (ya no son venta) NO entran — se ven en el 3. Las recientes van primero; las
 *     dormidas rotan y, si no avanzan, esperan por la misma racha que las fallas.
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
/**
 * Una acción con actividad (escritura) en las últimas 24 h es RECIENTE: ocupa hasta 15 de los 20
 * lugares del lote, las más nuevas primero. Las dormidas rotan por los lugares que sobren, y si una
 * pasada no avanza nada suman a la racha de espera: así un retiro nuevo nunca hace fila detrás de
 * los viejos que Uber nunca reflejó.
 */
const ACTIVIDAD_RECIENTE_MS = 24 * 3_600_000
const LOTE_RECIENTES = 15
const ESPERA_RECIENTE_MAX_MIN = 20
const FALLOS_ANTES_DE_ESPERAR = 3
const ESPERA_MAXIMA_MIN = 6 * 60

const ERROR_RECONCILIACION = 'DELIVERY_RECONCILE_ERROR'
const RECONCILIACION_RECUPERADA = 'DELIVERY_RECONCILE_RECOVERED'
const RETIRO_SIN_REFLEJAR = 'DELIVERY_ITEM_REMOVAL_UNREFLECTED'
const SIN_AVANCE = 'SIN_AVANCE'

/** Minutos de espera tras `n` fallas seguidas: 0 hasta la 3.ª, luego 2, 4, 8… con tope de 6 h. */
export const esperaTrasFallosMin = (n: number) => (n < FALLOS_ANTES_DE_ESPERAR ? 0 : Math.min(2 ** (n - 2), ESPERA_MAXIMA_MIN))

type Contadores = { inciertas: number; reconciliadas: number; fallidas: number; alertas: number; reservas: number; listos: number }

export class DeliveryLineActionReconcilerJob {
  private job: CronJob | null = null
  private enCurso = false
  /**
   * Rotación de las DORMIDAS: un CONFIRMED cuya línea sigue en Uber nunca sale del barrido, y sin
   * cursor las 20 más viejas se comerían todos sus lugares. ponytail: en memoria; un reinicio sólo
   * vuelve a empezar la vuelta de las dormidas — las recientes van primero de todos modos.
   */
  private cursor = ''
  /**
   * «Listo» ya dicho a Uber que no se acreditó (409, rechazo): espera creciente en vez de
   * martillar cada minuto durante 6 h. ponytail: en memoria, se pierde al reiniciar (a lo más
   * se repite un aviso); una columna si algún día corre en varias instancias.
   */
  private esperaListo = new Map<string, { n: number; hasta: number }>()
  /**
   * Acción RECIENTE que se revisó sin avance: espera 1, 2, 4… min (tope 20) antes de volver a la
   * cubeta de recientes. Sin esto, las 15 más nuevas atoradas se re-eligen cada minuto y una más
   * vieja no entra hasta volverse dormida (24 h). Por ACCIÓN, no por pedido: una acción nunca
   * revisada no tiene entrada y entra en su primer tick. ponytail: en memoria, como `esperaListo`.
   */
  private revisadaHasta = new Map<string, { n: number; hasta: number }>()

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

  /**
   * 2. Reconciliación por pedido. Fuera en SQL: órdenes bloqueadas (esperan a una persona),
   * canceladas (ya no son venta) y en espera por racha de fallas.
   */
  private async reconciliar(): Promise<{ reconciliadas: number; fallidas: number }> {
    const ahora = Date.now()
    const recienteDesde = new Date(ahora - ACTIVIDAD_RECIENTE_MS)
    // A las 24 h la acción ya es dormida y la gobierna la racha: su entrada aquí sobra.
    for (const [id, e] of this.revisadaHasta) if (e.hasta < ahora - ACTIVIDAD_RECIENTE_MS) this.revisadaHasta.delete(id)
    const revisadas = [...this.revisadaHasta].filter(([, e]) => e.hasta > ahora).map(([id]) => id)
    const candidatas = Prisma.sql`
      FROM "DeliveryLineAction" a
      JOIN "Order" o ON o.id = a."orderId" AND o."venueId" = a."venueId"
      WHERE a.action = 'REMOVE_ITEM'
        AND (a.status = 'UNCERTAIN' OR (a.status = 'CONFIRMED' AND a.settlement IN ('PENDING', 'ACCREDITED')))
        AND o."deliveryReconcileBlocked" IS NULL
        AND o.status <> 'CANCELLED'
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT l.action, l.data FROM "ActivityLog" l
            WHERE l.entity = 'Order' AND l."entityId" = a."orderId"
              AND l.action IN (${ERROR_RECONCILIACION}, ${RECONCILIACION_RECUPERADA})
            ORDER BY l."createdAt" DESC, l.id DESC
            LIMIT 1
          ) u
          WHERE u.action = ${ERROR_RECONCILIACION} AND (u.data->>'retryAt')::timestamptz > now())`
    type Fila = { id: string; orderId: string; venueId: string }
    const recientes = await retry(
      () =>
        prisma.$queryRaw<Fila[]>`
          SELECT a.id, a."orderId", a."venueId" ${candidatas} AND a."updatedAt" >= ${utcTs(recienteDesde)}
            AND NOT (a.id = ANY(${revisadas}::text[]))
          ORDER BY a."updatedAt" DESC, a.id DESC
          LIMIT ${LOTE_RECIENTES}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.recientes' },
    )
    const lugares = LOTE - recientes.length
    const dormidas = await retry(
      () =>
        prisma.$queryRaw<Fila[]>`
          SELECT a.id, a."orderId", a."venueId" ${candidatas} AND a."updatedAt" < ${utcTs(recienteDesde)} AND a.id > ${this.cursor}
          ORDER BY a.id
          LIMIT ${lugares}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.dormidas' },
    )
    this.cursor = dormidas.length < lugares ? '' : dormidas[dormidas.length - 1].id

    // Una reconciliación cubre todas las acciones del pedido; es «reciente» si alguna lo es.
    const porOrden = new Map<string, { venueId: string; reciente: boolean; acciones: string[] }>()
    for (const f of recientes) {
      const o = porOrden.get(f.orderId) ?? { venueId: f.venueId, reciente: true, acciones: [] }
      o.acciones.push(f.id)
      porOrden.set(f.orderId, o)
    }
    for (const f of dormidas) if (!porOrden.has(f.orderId)) porOrden.set(f.orderId, { venueId: f.venueId, reciente: false, acciones: [] })

    let reconciliadas = 0
    let fallidas = 0
    for (const [orderId, { venueId, reciente, acciones }] of porOrden) {
      let fallo: string | null = null
      try {
        const r = await reconciliacion.reconcileDeliveryOrderFromProvider(orderId, { trigger: 'JOB' })
        if (r.outcome === 'READ_FAILED') fallo = 'READ_FAILED'
        else if (r.outcome === 'NO_ACTIONS') {
          // Reciente y sin avance: espera corta en memoria. Dormida: cuenta para la racha, o la
          // leeríamos a Uber cada vuelta para siempre.
          if (reciente) {
            for (const id of acciones) {
              const n = (this.revisadaHasta.get(id)?.n ?? 0) + 1
              this.revisadaHasta.set(id, { n, hasta: Date.now() + Math.min(2 ** (n - 1), ESPERA_RECIENTE_MAX_MIN) * 60_000 })
            }
          } else fallo = SIN_AVANCE
        } else for (const id of acciones) this.revisadaHasta.delete(id) // hubo avance
      } catch (error) {
        fallo = error instanceof Error ? error.message : String(error)
      }

      const racha = await this.rachaDeFallos(orderId)
      if (fallo === null) {
        reconciliadas++
        if (racha > 0) await this.registrar(venueId, orderId, RECONCILIACION_RECUPERADA, { tras: racha })
        continue
      }
      fallidas++
      const n = racha + 1
      const retryAt = new Date(Date.now() + esperaTrasFallosMin(n) * 60_000)
      await this.registrar(venueId, orderId, ERROR_RECONCILIACION, {
        consecutive: n,
        retryAt: retryAt.toISOString(),
        error: fallo.slice(0, 300),
      })
      const detalle = { orderId, venueId, consecutive: n, retryAt, error: fallo.slice(0, 300) }
      // «Sin avance» no es una falla del sistema, así que va en warn y sin 🚨: un CONFIRMED así lo
      // reporta la alerta de 24 h; un UNCERTAIN de una orden NO bloqueada no tiene alerta — espera a
      // que una persona lo reintente, y el MCP lo muestra con `canRetryAt`.
      if (n >= FALLOS_ANTES_DE_ESPERAR && fallo !== SIN_AVANCE)
        logger.error('🚨 [Delivery line-actions] reconciliación sin resultado seguida: la orden espera', detalle)
      else logger.warn('[Delivery line-actions] reconciliación sin resultado; se reintenta', detalle)
    }
    return { reconciliadas, fallidas }
  }

  /** Fallas seguidas de la orden (la espera se filtra en SQL). La racha la corta un RECOVERED. */
  private async rachaDeFallos(orderId: string): Promise<number> {
    const ultimo = await prisma.activityLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: { in: [ERROR_RECONCILIACION, RECONCILIACION_RECUPERADA] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, data: true },
    })
    if (ultimo?.action !== ERROR_RECONCILIACION) return 0
    return ((ultimo.data ?? {}) as { consecutive?: number }).consecutive ?? 1
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
          // Índice parcial `Order_deliveryOpInFlightAt_pending_idx` (sólo filas con reserva).
          where: { deliveryOpToken: { not: null }, deliveryOpInFlightAt: { lt: corte } },
          orderBy: { deliveryOpInFlightAt: 'asc' },
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

  /**
   * 5. «Listo» en cocina que no llegó a Uber (reserva tomada en el bump). Se busca por la COMANDA
   * marcada en las últimas 6 h (índice parcial `KdsOrder_delivery_done_updatedAt_idx`), no por
   * cuándo se colocó el pedido: un programado se coloca días antes de salir de cocina.
   */
  private async reintentarListos(): Promise<number> {
    const ahora = Date.now()
    for (const [id, e] of this.esperaListo) if (e.hasta + LISTO_LOOKBACK_MS < ahora) this.esperaListo.delete(id)

    const enEspera = [...this.esperaListo].filter(([, e]) => e.hasta > ahora).map(([id]) => id)
    // M-5: sólo pedidos de proveedores con adaptador (`UBER_EATS:…`); un Deliverect con `externalId`
    // caería en NOT_A_DELIVERY_ORDER y gastaría un lugar del lote. `_` y `%` se escapan para LIKE.
    const prefijos = proveedoresConAdaptador().map(p => `${p.replace(/[\\%_]/g, '\\$&')}:%`)
    const filas = await retry(
      () =>
        prisma.$queryRaw<Array<{ id: string; venueId: string }>>`
          SELECT o.id, o."venueId"
          FROM "KdsOrder" k
          JOIN "Order" o ON o.id = k."orderId" AND o."venueId" = k."venueId"
          WHERE k."orderType" = 'DELIVERY' AND k.status IN ('READY', 'COMPLETED')
            AND k."updatedAt" >= ${utcTs(new Date(ahora - LISTO_LOOKBACK_MS))}
            AND o.type = 'DELIVERY' AND o."externalId" LIKE ANY(${prefijos}::text[])
            AND o."readyReportedAt" IS NULL AND o.status <> 'CANCELLED'
            AND NOT (o.id = ANY(${enEspera}::text[]))
            -- Un retiro en curso bloquea el «listo» (spec §3.2): reintentarlo sólo gastaría reservas.
            AND NOT EXISTS (
              SELECT 1 FROM "DeliveryLineAction" a WHERE a."orderId" = o.id AND a.status IN ('PENDING', 'UNCERTAIN'))
          GROUP BY o.id, o."venueId"
          ORDER BY MIN(k."updatedAt"), o.id
          LIMIT ${LOTE}`,
      { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryLineActions.listos' },
    )
    let llamadas = 0
    for (const f of filas) {
      let outcome: string
      try {
        outcome = (await markDeliveryOrderReady(f.venueId, f.id)).outcome
      } catch (error) {
        outcome = 'THREW'
        logger.warn('[Delivery line-actions] reintento de «listo» falló', { orderId: f.id, error: String(error) })
      }
      // Reserva en curso o ya acreditado: no se habló con el proveedor.
      if (outcome === 'OP_IN_PROGRESS' || outcome === 'LINE_ACTION_IN_PROGRESS' || outcome === 'ALREADY_DONE') continue
      // Sin canal o sin «listo» en el proveedor: nada que reintentar en toda la ventana.
      if (outcome === 'NOT_A_DELIVERY_ORDER') {
        this.esperaListo.set(f.id, { n: 0, hasta: ahora + LISTO_LOOKBACK_MS })
        continue
      }
      // Se le habló al proveedor (o no se sabe): 409 o rechazo esperan 2, 4, 8… min.
      llamadas++
      const intentos = (this.esperaListo.get(f.id)?.n ?? 0) + 1
      this.esperaListo.set(f.id, { n: intentos, hasta: ahora + Math.min(2 ** intentos, 60) * 60_000 })
    }
    return llamadas
  }
}

export const deliveryLineActionReconcilerJob = new DeliveryLineActionReconcilerJob()

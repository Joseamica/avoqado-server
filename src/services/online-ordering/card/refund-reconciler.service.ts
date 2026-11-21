// src/services/online-ordering/card/refund-reconciler.service.ts
/**
 * Fase 2 (T10) — el recorrido de las devoluciones a la tarjeta (cada minuto, en el job del conciliador de cargos): termina lo que
 * quedó en duda (`REQUESTED` sin enviar, `SENDING` sin id, `PENDING`, `SUCCEEDED` sin renglón, la reversa del sello) y revisa las
 * `RECORDED` a 1 h, 1, 3, 7 y 30 días por un fallo tardío. Cada fila va en su propio `try` y TODA fila tomada mueve su
 * `nextCheckAt` (también la que truena, r5 #4), así un lote que no cambia no tapa a las de atrás (r4 #6). D661 (Task 5): después,
 * cierra «Devuelto» los pedidos de «Nadie» cuya devolución ya quedó anotada y no se cerraron (`cerrarDevueltosPendientes`).
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { CARD_RECONCILE_BATCH } from '../constants'
import type { ReadCandidates } from '../types'
import { OnlineOrderCardRefundStatus, OnlineOrderPaymentMode } from '@prisma/client'
import { DEVOLUCION_ANOTADA, ENTREGABLE, YA_ENTREGADO } from './devuelto'
import { SWEPT_CARD_REFUND_STATUSES, advanceCardRefundForSweep, cerrarComoDevuelto } from './refund.service'

const SEALED_STATUSES = [OnlineOrderCardRefundStatus.REVERSED, OnlineOrderCardRefundStatus.RESOLVED]
/** D661 (C5): el barrido de cierres sólo mira las devoluciones del último mes (lo que pudo quedar sin cerrar). */
const CIERRES_VENTANA_MS = 31 * 24 * 60 * 60_000
/**
 * D661 (C5): por dónde va la vuelta del barrido de cierres, por alcance: el lote siguiente empieza después del último leído, así 50
 * cierres que fallan siempre no tapan a los de atrás; una página corta cierra la vuelta. ponytail: en memoria (una sola instancia);
 * con dos, cada una rota por su lado y sólo repite lecturas.
 */
const vueltaDeCierres = new Map<string, { createdAt: Date; id: string }>()

export interface CardRefundSweepResult {
  scanned: number
  advanced: number
  alerted: number
  errors: number
  /** D661: pedidos de «Nadie» cerrados «Devuelto» en esta pasada. */
  closed: number
}

export async function sweepCardRefunds(now: Date, readEntry: ReadCandidates): Promise<CardRefundSweepResult> {
  const result: CardRefundSweepResult = { scanned: 0, advanced: 0, alerted: 0, errors: 0, closed: 0 }
  const due = await readEntry(() =>
    prisma.onlineOrderCardRefund.findMany({
      where: {
        nextCheckAt: { lte: now },
        // Las que ya no se revisan (REVERSED/RESOLVED) sólo vuelven si les falta la reversa del sello (fix r1 M2).
        OR: [{ status: { in: SWEPT_CARD_REFUND_STATUSES } }, { status: { in: SEALED_STATUSES }, stampReversedAt: null }],
      },
      orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
      take: CARD_RECONCILE_BATCH,
      select: { id: true, status: true },
    }),
  )
  result.scanned = due.length
  for (const row of due) {
    try {
      const out = await advanceCardRefundForSweep(row.id, now)
      if (out.status !== row.status) result.advanced += 1
      if (out.alerted) result.alerted += 1
    } catch (error) {
      result.errors += 1
      logger.error('[OnlineOrderCardRefund] el recorrido no pudo con una devolución (sigue con las demás)', {
        cardRefundId: row.id,
        status: row.status,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  try {
    result.closed = await cerrarDevueltosPendientes({}, now, readEntry)
  } catch (error) {
    result.errors += 1
    logger.error('[OnlineOrderCardRefund] el recorrido no pudo leer los pedidos por cerrar «Devuelto»', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return result
}

/**
 * D661 (Task 5): cierra «Devuelto» los pedidos de «Nadie» cuya devolución YA quedó anotada (con su renglón REFUND: RECORDED, REVERSED o
 * RESOLVED) y que no se cerraron: el proceso murió entre anotar y cerrar, o la fila avanzó (reversa, resuelta) antes del cierre. Lee por
 * la fila de devolución y no por el calendario de revisión de Stripe: una fila RESOLVED que el recorrido ya no visita (sello revertido,
 * `nextCheckAt` fuera) también cierra su pedido (r5 #4). Acotada (cada pedido sale de la lista al cerrarse) y sólo con lo que el cierre
 * puede cerrar, así nada se vuelve a tomar en cada pasada. `scope.venueId` acota a una sucursal (pruebas); el job la corre sin él.
 * D661 (C5): sólo el último mes, y en vueltas (`vueltaDeCierres`): lo que no se pudo cerrar no se vuelve a leer hasta la vuelta siguiente.
 */
export async function cerrarDevueltosPendientes(
  scope: { venueId?: string },
  now: Date,
  readEntry: ReadCandidates = read => read(),
): Promise<number> {
  const alcance = scope.venueId ?? '*'
  const desde = vueltaDeCierres.get(alcance)
  const filas = await readEntry(() =>
    prisma.onlineOrderCardRefund.findMany({
      where: {
        ...(scope.venueId !== undefined ? { venueId: scope.venueId } : {}),
        createdAt: { gte: new Date(now.getTime() - CIERRES_VENTANA_MS) },
        ...(desde ? { OR: [{ createdAt: { gt: desde.createdAt } }, { createdAt: desde.createdAt, id: { gt: desde.id } }] } : {}),
        status: { in: DEVOLUCION_ANOTADA },
        charge: {
          onlineOrder: {
            requiresAcceptance: false,
            paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
            refundedAt: null,
            OR: [{ status: { in: ENTREGABLE }, refundRequestedAt: { not: null } }, { status: { in: YA_ENTREGADO } }],
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CARD_RECONCILE_BATCH,
      select: {
        id: true,
        createdAt: true,
        venueId: true,
        staffId: true,
        charge: { select: { onlineOrder: { select: { orderId: true } } } },
      },
    }),
  )
  const ultima = filas.at(-1)
  if (filas.length < CARD_RECONCILE_BATCH || !ultima) vueltaDeCierres.delete(alcance)
  else vueltaDeCierres.set(alcance, { createdAt: ultima.createdAt, id: ultima.id })
  let cerrados = 0
  for (const fila of filas) {
    const orderId = fila.charge.onlineOrder?.orderId
    if (!orderId) continue
    try {
      if (await cerrarComoDevuelto({ venueId: fila.venueId, orderId, now, staffId: fila.staffId })) cerrados += 1
    } catch (error) {
      logger.error('[OnlineOrderCardRefund] el recorrido no pudo cerrar «Devuelto» un pedido (sigue con los demás)', {
        venueId: fila.venueId,
        orderId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return cerrados
}

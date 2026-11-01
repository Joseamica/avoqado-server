// src/services/online-ordering/card/refund-reconciler.service.ts
/**
 * Fase 2 (T10) — el recorrido de las devoluciones a la tarjeta (cada minuto, en el job del conciliador de cargos): termina lo que
 * quedó en duda (`REQUESTED` sin enviar, `SENDING` sin id, `PENDING`, `SUCCEEDED` sin renglón, la reversa del sello) y revisa las
 * `RECORDED` a 1 h, 1, 3, 7 y 30 días por un fallo tardío. Cada fila va en su propio `try` y TODA fila tomada mueve su
 * `nextCheckAt` (también la que truena, r5 #4), así un lote que no cambia no tapa a las de atrás (r4 #6).
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { CARD_RECONCILE_BATCH } from '../constants'
import type { ReadCandidates } from '../types'
import { OnlineOrderCardRefundStatus } from '@prisma/client'
import { SWEPT_CARD_REFUND_STATUSES, advanceCardRefundForSweep } from './refund.service'

const SEALED_STATUSES = [OnlineOrderCardRefundStatus.REVERSED, OnlineOrderCardRefundStatus.RESOLVED]

export interface CardRefundSweepResult {
  scanned: number
  advanced: number
  alerted: number
  errors: number
}

export async function sweepCardRefunds(now: Date, readEntry: ReadCandidates): Promise<CardRefundSweepResult> {
  const result: CardRefundSweepResult = { scanned: 0, advanced: 0, alerted: 0, errors: 0 }
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
  return result
}

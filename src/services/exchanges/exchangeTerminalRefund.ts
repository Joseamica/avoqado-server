// src/services/exchanges/exchangeTerminalRefund.ts
/**
 * La devolución de la TERMINAL que llega después de un cambio (Codex rM1 P1, decisión «A» del founder, 28-oct).
 *
 * La terminal devuelve a la tarjeta con el SDK y DESPUÉS avisa (`recordRefund`). Si en medio un cambio usó ese cobro —el gemelo
 * del crédito no toca al banco y la diferencia devuelta sale en efectivo o transferencia—, el tope de siempre rechazaría una
 * devolución que el banco YA hizo: dinero fuera sin asiento. Aquí se mide lo que el banco todavía tiene del cobro, se anota hasta
 * eso, y los cambios que usaron el cobro van a «Cambios por revisar». Sólo con tarjeta procesada por Avoqado: en efectivo la
 * terminal avisa antes de entregar nada y el rechazo de siempre es correcto.
 * Promesa: docs/audit/2026-10-20-cambio-de-producto/promesa-devolucion-de-terminal-tras-cambio.md
 */
import type { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { aCentavos } from '@/services/shared/repartoDescuento'
import { paymentIsAvoqadoSettled, type TenderSemanticsPayment } from '@/services/shared/tenderSemantics'
import { EXCHANGE_REFUND_ROLE } from './exchangeMarks'

export const TERMINAL_REFUND_AFTER_EXCHANGE = 'TERMINAL_REFUND_AFTER_EXCHANGE'

interface FilaDeReembolso {
  amount: unknown
  tipAmount: unknown
  status: string
  processorData?: unknown
}

/** CREDIT y DIFFERENCE no pasaron por el banco. CHAIN no aplica: la terminal no devuelve cobros con crédito. */
function marcaDeCambio(fila: FilaDeReembolso): { exchangeId: string | null } | null {
  const exchange = (fila.processorData as { exchange?: { role?: unknown; exchangeId?: unknown } } | null)?.exchange
  if (exchange?.role !== EXCHANGE_REFUND_ROLE.CREDIT && exchange?.role !== EXCHANGE_REFUND_ROLE.DIFFERENCE) return null
  return { exchangeId: typeof exchange.exchangeId === 'string' ? exchange.exchangeId : null }
}

/** Lo que los cambios usaron de este cobro sin pasar por el banco, en centavos (venta + propina, sólo COMPLETED). */
export function centavosQueUsaronLosCambios(filas: readonly FilaDeReembolso[]): number {
  return filas
    .filter(f => f.status === 'COMPLETED' && marcaDeCambio(f))
    .reduce((sum, f) => sum + Math.abs(aCentavos(f.amount)) + Math.abs(aCentavos(f.tipAmount)), 0)
}

/** Sólo una tarjeta que procesó Avoqado: ahí la terminal ya devolvió antes de avisar. */
export function laTerminalYaDevolvio(cobro: TenderSemanticsPayment): boolean {
  return (cobro.method === 'CREDIT_CARD' || cobro.method === 'DEBIT_CARD') && paymentIsAvoqadoSettled(cobro)
}

/**
 * Manda a revisar, en la MISMA transacción de la devolución, los cambios que usaron el cobro. Sólo un COMPLETED cambia de estado
 * (CAS por `status` y `resultRevision`); uno pendiente de cobro, cancelado o ya en revisión sólo deja su línea en la bitácora,
 * porque cambiarle el estado rompería el cierre del cobro de la diferencia.
 */
export async function mandarCambiosARevisarEnTx(
  tx: Prisma.TransactionClient,
  args: { venueId: string; filas: readonly FilaDeReembolso[]; originalPaymentId: string; refundPaymentId: string; refundCents: number; staffId: string | null },
): Promise<string[]> {
  const ids = [...new Set(args.filas.filter(f => f.status === 'COMPLETED').flatMap(f => marcaDeCambio(f)?.exchangeId ?? []))].sort()
  for (const exchangeId of ids) {
    // Codex rM2 #1: apartada ANTES de leerla. Guardar la liga del recibo (`patchExchangePresentation`) sube `resultRevision`; leída
    // sin candado, el CAS de abajo fallaba y el cambio se quedaba COMPLETED, fuera de «Cambios por revisar».
    await tx.$queryRaw`SELECT id FROM "Exchange" WHERE id = ${exchangeId} AND "venueId" = ${args.venueId} FOR UPDATE`
    const actual = await tx.exchange.findFirst({
      where: { id: exchangeId, venueId: args.venueId },
      select: { status: true, resultRevision: true, result: true },
    })
    if (!actual) continue
    let paso = false
    if (actual.status === 'COMPLETED') {
      const result = actual.result && typeof actual.result === 'object' ? (actual.result as Prisma.JsonObject) : null
      const escrito = await tx.exchange.updateMany({
        where: { id: exchangeId, venueId: args.venueId, status: 'COMPLETED', resultRevision: actual.resultRevision },
        data: {
          status: 'NEEDS_REVIEW',
          reviewReason: TERMINAL_REFUND_AFTER_EXCHANGE,
          resultRevision: { increment: 1 },
          ...(result ? { result: { ...result, status: 'NEEDS_REVIEW', reviewReason: TERMINAL_REFUND_AFTER_EXCHANGE } } : {}),
        },
      })
      paso = escrito.count === 1
    }
    await tx.activityLog.create({
      data: {
        venueId: args.venueId,
        entity: 'Exchange',
        entityId: exchangeId,
        action: 'EXCHANGE_NEEDS_REVIEW',
        staffId: args.staffId,
        data: {
          reviewReason: TERMINAL_REFUND_AFTER_EXCHANGE,
          originalPaymentId: args.originalPaymentId,
          refundPaymentId: args.refundPaymentId,
          refundCents: args.refundCents,
          estadoDelCambio: paso ? 'NEEDS_REVIEW' : actual.status,
          origin: 'TERMINAL_REFUND',
        },
      },
    })
  }
  logger.error('La terminal devolvió a la tarjeta un cobro que ya respaldaba un cambio: se anota y el cambio va a revisar', {
    venueId: args.venueId,
    originalPaymentId: args.originalPaymentId,
    refundPaymentId: args.refundPaymentId,
    refundCents: args.refundCents,
    exchangeIds: ids,
  })
  return ids
}

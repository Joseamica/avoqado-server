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
 *
 * Lo mismo después de un SALDO A FAVOR (spec 2026-10-30-saldo-a-favor §5.5, opción 1 del founder: avisar y congelar; S7): lo que se
 * pasó a saldo tampoco salió del banco. Se anota, y en la misma transacción se escribe la anomalía `STORE_CREDIT_DOUBLE_REFUND` y se
 * bloquean los sobres que recibieron ese saldo. No se recupera nada solo: las ventas quedan con la doble resta hasta que el contador
 * lo corrija.
 */
import type { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { aCentavos } from '@/services/shared/repartoDescuento'
import { paymentIsAvoqadoSettled, type TenderSemanticsPayment } from '@/services/shared/tenderSemantics'
import { lockGiftCardsForUpdate, operarSobreDeGerenteEnTx, type LockedGiftCard } from '@/services/giftCards/giftCardLedger'
import { recordGiftCardAnomaly } from '@/services/giftCards/giftCardAnomaly'
import { EXCHANGE_REFUND_ROLE, sqlOrigenEconomico } from './exchangeMarks'
import type { TxConReintento } from '@/utils/serializableRetry'

export const TERMINAL_REFUND_AFTER_EXCHANGE = 'TERMINAL_REFUND_AFTER_EXCHANGE'

interface FilaDeReembolso {
  amount: unknown
  tipAmount: unknown
  status: string
  processorData?: unknown
  tenderType?: { systemKind: string | null } | null
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

/**
 * El tope de la terminal: lo que el BANCO todavía tiene = lo que queda por devolver + lo que se devolvió sin pasar por el banco (los
 * cambios —gemelo del crédito y diferencia— y el saldo a favor). Cada fila cuenta una vez: la diferencia de un Cambio que se fue a saldo
 * lleva las dos marcas. Sólo COMPLETED.
 */
export function centavosQueNoPasaronPorElBanco(filas: readonly FilaDeReembolso[]): number {
  return filas
    .filter(f => f.status === 'COMPLETED' && (marcaDeCambio(f) || f.tenderType?.systemKind === 'STORE_CREDIT'))
    .reduce((sum, f) => sum + Math.abs(aCentavos(f.amount)) + Math.abs(aCentavos(f.tipAmount)), 0)
}

/**
 * Lo devuelto de más que trae ESTA devolución de la terminal: el exceso nuevo sobre el cobro, medido bajo su candado (Codex plan r1,
 * h8). Lo que ya se avisó en una devolución anterior no se vuelve a contar: $400 + $150 de saldo sobre $500 → $50; otra de $100 → $100.
 */
export function duplicadoCents(p: { totalCents: number; devueltoAntesCents: number; esteCents: number }): number {
  return Math.max(0, p.devueltoAntesCents + p.esteCents - p.totalCents) - Math.max(0, p.devueltoAntesCents - p.totalCents)
}

export interface AbonoDeSaldoDelCobro {
  refundPaymentId: string
  giftCardId: string
  montoCents: number
}

/**
 * Los abonos a saldo a favor que salieron de este cobro y sus sobres, BLOQUEADOS (un solo `lockGiftCardsForUpdate`, id ASC). Por ORIGEN
 * económico (`sqlOrigenEconomico`): los REFUND que lo tienen como `originalPaymentId` y los de la cadena de un Cambio que lo tienen como
 * `rootPaymentId`; de ésos, los que se abonaron a saldo (sólo ellos tienen el movimiento `saldo-a-favor:<id del REFUND>` de la libreta,
 * que da el sobre).
 * Se llama bajo el candado del cobro y ANTES de reclamar el turno (Codex plan r2, h1): Order → Payment → sobres → Shift, como el
 * cobro con saldo. Sin abonos, ningún candado.
 */
export async function sobresDeSaldoDelCobroEnTx(
  tx: TxConReintento,
  p: { venueId: string; paymentId: string },
): Promise<{ abonos: AbonoDeSaldoDelCobro[]; sobres: LockedGiftCard[] }> {
  const filas = await tx.$queryRaw<Array<{ refundPaymentId: string; giftCardId: string; montoCents: bigint | number }>>`
    SELECT r.id AS "refundPaymentId", a."giftCardId", ROUND(a.amount * 100)::bigint AS "montoCents"
    FROM "Payment" r
    JOIN "GiftCardActivity" a ON a."venueId" = r."venueId" AND a."operationKey" = 'saldo-a-favor:' || r.id
    WHERE r."venueId" = ${p.venueId}
      AND r.type = 'REFUND'
      AND r.status = 'COMPLETED'
      AND ${sqlOrigenEconomico('r')} = ${p.paymentId}
    ORDER BY r.id`
  const abonos = filas.map(f => ({ refundPaymentId: f.refundPaymentId, giftCardId: f.giftCardId, montoCents: Number(f.montoCents) }))
  return {
    abonos,
    sobres: await lockGiftCardsForUpdate(
      tx,
      abonos.map(a => a.giftCardId),
    ),
  }
}

/**
 * Opción 1 (avisar y congelar), en la MISMA transacción que anota la devolución de la terminal. Nunca rechaza: el banco ya devolvió.
 * - Bloquea cada sobre ACTIVE (`SUSPICIOUS_ACTIVITY` y la nota del folio); uno ya bloqueado o desactivado no se toca.
 *   Sus filas ya están apartadas desde antes del turno (`sobresDeSaldoDelCobroEnTx`): aquí no se toma ningún candado nuevo.
 * - UNA anomalía por devolución de la terminal (`giftcard:STORE_CREDIT_DOUBLE_REFUND:<id del REFUND>`), con lo duplicado nuevo y TODOS
 *   los abonos de ese cobro (puede haber varias destinatarias).
 */
export async function avisarYCongelarSaldoDuplicadoEnTx(
  tx: TxConReintento,
  p: {
    venueId: string
    originalPaymentId: string
    refundPaymentId: string
    refundCents: number
    duplicadoCents: number
    folio: string
    staffId: string
    saldo: { abonos: AbonoDeSaldoDelCobro[]; sobres: LockedGiftCard[] }
  },
): Promise<void> {
  if (p.saldo.abonos.length === 0 || p.duplicadoCents <= 0) return
  const congelados: string[] = []
  for (const sobre of p.saldo.sobres) {
    if (sobre.status !== 'ACTIVE') continue
    await operarSobreDeGerenteEnTx(tx, {
      venueId: p.venueId,
      giftCardId: sobre.id,
      staffId: p.staffId,
      operationKey: `doble-devolucion:${p.refundPaymentId}:${sobre.id}`,
      op: {
        tipo: 'BLOQUEAR',
        reason: 'SUSPICIOUS_ACTIVITY',
        note: `Doble devolución: la terminal devolvió el cobro ${p.folio}, que ya tenía saldo a favor`,
      },
    })
    congelados.push(sobre.id)
  }
  const sobrePorId = new Map(p.saldo.sobres.map(s => [s.id, s]))
  await recordGiftCardAnomaly(tx, {
    check: 'STORE_CREDIT_DOUBLE_REFUND',
    id: p.refundPaymentId,
    venueId: p.venueId,
    detail: {
      originalPaymentId: p.originalPaymentId,
      terminalRefundPaymentId: p.refundPaymentId,
      terminalRefundCents: p.refundCents,
      duplicadoCents: p.duplicadoCents,
      // `estado` y `saldoCents`: como estaba el sobre cuando llegó la terminal (bajo su candado); `congelados`, los que se bloquearon aquí.
      abonos: p.saldo.abonos.map(a => {
        const sobre = sobrePorId.get(a.giftCardId)
        return {
          storeCreditRefundPaymentId: a.refundPaymentId,
          giftCardId: a.giftCardId,
          montoCents: a.montoCents,
          saldoCents: sobre ? Math.round(sobre.balance.toNumber() * 100) : null,
          estado: sobre?.status ?? null,
        }
      }),
      congelados,
    },
  })
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
  args: {
    venueId: string
    filas: readonly FilaDeReembolso[]
    originalPaymentId: string
    refundPaymentId: string
    refundCents: number
    staffId: string | null
  },
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

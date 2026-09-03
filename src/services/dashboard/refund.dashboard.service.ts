/**
 * Dashboard Refund Service
 *
 * Issues a refund from the dashboard against an existing Payment.
 * Creates a new Payment with type=REFUND and a negative amount, tracking the
 * cumulative refunded total on the original payment's `processorData`.
 *
 * Simpler than the TPV flow (which needs terminal SDK data) — works for cash
 * and "manual" refunds entered by staff from the web dashboard.
 */

import { PaymentFundsFlow, PaymentMethod, PaymentSource, PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { restockItem } from './inventoryRestock.service'
import { generateAndStoreReceipt } from './receipt.dashboard.service'
import { createRefundCommission } from './commission/commission-calculation.service'
import { createRefundTransactionCost } from '../payments/transactionCost.service'
import { logAction } from './activity-log.service'
import { postCashRefundToDrawer } from '../shared/cashDrawerPosting'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'

export type RefundReason = 'RETURNED_GOODS' | 'ACCIDENTAL_CHARGE' | 'CANCELLED_ORDER' | 'FRAUDULENT_CHARGE' | 'OTHER'

/**
 * El motivo, en español, para la nota del movimiento de caja: ese texto lo IMPRIME el
 * ticket del corte del POS. Un "Reembolso: RETURNED_GOODS" en el papel que le queda al
 * dueño para cuadrar su caja no le dice nada.
 */
const REFUND_REASON_LABEL_ES: Record<RefundReason, string> = {
  RETURNED_GOODS: 'Devolución de producto',
  ACCIDENTAL_CHARGE: 'Cobro por error',
  CANCELLED_ORDER: 'Pedido cancelado',
  FRAUDULENT_CHARGE: 'Cargo fraudulento',
  OTHER: 'Otro motivo',
}

export interface RefundItemInput {
  orderItemId: string
  quantity?: number // defaults to full original quantity
}

export interface IssueRefundInput {
  venueId: string
  paymentId: string
  // Either `amount` (amount refund) or `items` (item refund) — if `items` is
  // provided, amount is computed server-side as sum(item.total).
  amount?: number // in cents — positive
  items?: RefundItemInput[] // item-level refund
  /** Order item ids to restock (subset of refunded items with QUANTITY inventory) */
  restockItemIds?: string[]
  reason: RefundReason
  staffId?: string | null
  note?: string | null
  /**
   * Explicit tip-side of the refund, in cents. When omitted, amount-only
   * refunds split proportionally to the original's sale/tip ratio. When set,
   * the full `amount` is split as: tipRefund = tipRefundCents,
   * salesRefund = amount - tipRefundCents. Must be >= 0 and not exceed the
   * remaining refundable tip. Item-refunds ignore this override (items never
   * carry tip).
   *
   * Use cases:
   *   - `tipRefundCents = 0`: refund only the sale portion, leave the staff tip intact.
   *   - `tipRefundCents = amount`: refund only the tip (accidental tip charge, etc.).
   *   - `tipRefundCents = X`: custom split (e.g. partial tip return).
   */
  tipRefundCents?: number
}

export interface IssueRefundResult {
  refundId: string
  originalPaymentId: string
  amount: number // decimal (positive)
  remainingRefundable: number
  status: string
}

interface LockedPaymentRow {
  id: string
  venueId: string
  status: string
  type: PaymentType
  method: string
  source: string | null
  amount: unknown
  tipAmount: unknown
  orderId: string | null
  shiftId: string | null
  merchantAccountId: string | null
  processorData: Prisma.JsonValue | null
  // Proyección de `tenderSemantics`: la ÚNICA autoridad sobre "¿este dinero estaba
  // en el cajón?". Se leen del pago ORIGINAL porque el reembolso hereda su método.
  fundsFlow: string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
  // Identidad del tipo del catálogo. El reembolso la HEREDA: el desglose del corte
  // agrupa por `tenderLabel`, así que sin esto la venta salía bajo "Uber Eats" y su
  // devolución en el genérico — el neto POR TIPO mentía.
  tenderRevision: number | null
  tenderLabel: string | null
  tenderCaptureTip: boolean | null
  tenderSatFormaPago: string | null
}

interface RefundPaymentRow {
  id: string
  amount: unknown
  processorData: Prisma.JsonValue | null
  createdAt: Date
  status: string
}

interface ExistingRefundedItem {
  orderItemId: string
  quantity: number
  amountCents: number
}

interface RefundedItemSnapshot {
  orderItemId: string
  quantity: number
  amountCents: number
  amount: number
  productName: string | null
  productId: string | null
}

function toCents(value: unknown): number {
  return Math.round(Number(value || 0) * 100)
}

function centsToNumber(cents: number): number {
  return cents / 100
}

function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100)
}

function asRecord(value: Prisma.JsonValue | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function getUnitRefundCents(totalCents: number, quantity: number, offset: number, count: number): number {
  if (quantity <= 0 || count <= 0) return 0
  const baseUnit = Math.floor(totalCents / quantity)
  const remainder = totalCents % quantity
  const end = offset + count
  const bonusUnits = Math.max(0, Math.min(remainder, end) - Math.min(remainder, offset))
  return baseUnit * count + bonusUnits
}

function collectExistingRefundedItems(refundRows: RefundPaymentRow[]): Map<string, ExistingRefundedItem> {
  const byOrderItemId = new Map<string, ExistingRefundedItem>()

  for (const refund of refundRows) {
    const processorData = asRecord(refund.processorData)
    const refundedItemsRaw = Array.isArray(processorData.refundedItems) ? processorData.refundedItems : []

    for (const itemRaw of refundedItemsRaw) {
      if (!itemRaw || typeof itemRaw !== 'object' || Array.isArray(itemRaw)) continue
      const item = itemRaw as Record<string, unknown>
      const orderItemId = typeof item.orderItemId === 'string' ? item.orderItemId : null
      if (!orderItemId) continue

      const quantity = Number(item.quantity || 0)
      const amountCents =
        typeof item.amountCents === 'number' ? item.amountCents : typeof item.amount === 'number' ? Math.round(item.amount * 100) : 0

      const current = byOrderItemId.get(orderItemId) || { orderItemId, quantity: 0, amountCents: 0 }
      current.quantity += quantity
      current.amountCents += amountCents
      byOrderItemId.set(orderItemId, current)
    }
  }

  return byOrderItemId
}

export interface RefundableLine {
  id: string
  orderPromotionId: string | null
  total: number | { toString(): string }
}

/**
 * Una promoción se reembolsa COMPLETA o no se reembolsa.
 *
 * 🔴 Devolver un componente suelto dejaría el resto cobrado a precio de
 * promoción —hamburguesa + papas por $99— y no hay regla escrita de cómo se
 * reprecia lo que queda. Peor: el reembolso por artículo usa `OrderItem.total`
 * y no sabría si la unidad devuelta era la pagada o la regalada de un 2x1.
 */
/**
 * 🔴 Una línea de promoción se reembolsa con su cantidad COMPLETA: en un 2x1 la
 * línea (quantity 2) mezcla una unidad pagada y una regalada; reembolsar 1
 * prorratearía neto/2 sin saber CUÁL unidad regresó — la ambigüedad
 * pagada-vs-regalada que el todo-o-nada de la promoción existe para bloquear.
 */
export function assertPromotionLineFullQuantity(line: { orderPromotionId?: string | null; quantity: number }, refundQty: number): void {
  if (line.orderPromotionId && refundQty !== line.quantity) {
    throw new BadRequestError('Las líneas de una promoción se reembolsan completas: devuelve la promoción entera, no una parte.')
  }
}

export function assertRefundableLines(lines: RefundableLine[], selectedIds: string[]): void {
  const selected = new Set(selectedIds)
  const porPromocion = new Map<string, RefundableLine[]>()

  for (const line of lines) {
    if (!line.orderPromotionId) continue
    const grupo = porPromocion.get(line.orderPromotionId) ?? []
    grupo.push(line)
    porPromocion.set(line.orderPromotionId, grupo)
  }

  for (const [, grupo] of porPromocion) {
    const elegidas = grupo.filter(l => selected.has(l.id)).length
    if (elegidas > 0 && elegidas < grupo.length) {
      throw new BadRequestError('Una promoción se reembolsa completa. Selecciona todos sus artículos o ninguno.')
    }
  }
}

export async function issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
  logger.info('[REFUND.DASHBOARD] Issuing refund', {
    venueId: input.venueId,
    paymentId: input.paymentId,
    amount: input.amount,
    itemCount: input.items?.length ?? 0,
    restockCount: input.restockItemIds?.length ?? 0,
    reason: input.reason,
  })

  if (!input.reason) {
    throw new BadRequestError('Refund reason is required')
  }

  // Mutually-exclusive guard: either amount or items.
  const hasItems = Array.isArray(input.items) && input.items.length > 0
  if (!hasItems && (!input.amount || input.amount <= 0)) {
    throw new BadRequestError('Either amount (cents) or items[] is required')
  }

  const result = await prisma.$transaction(async tx => {
    const lockedOriginalRows = await tx.$queryRaw<LockedPaymentRow[]>(Prisma.sql`
      SELECT
        id,
        "venueId",
        status,
        type,
        method,
        source,
        amount,
        "tipAmount",
        "orderId",
        "shiftId",
        "merchantAccountId",
        "processorData",
        "fundsFlow",
        "tenderTypeId",
        "tenderCountsAsCash",
        "tenderRevision",
        "tenderLabel",
        "tenderCaptureTip",
        "tenderSatFormaPago"
      FROM "Payment"
      WHERE id = ${input.paymentId}
      FOR UPDATE
    `)

    const original = lockedOriginalRows[0]
    if (!original) {
      throw new NotFoundError(`Payment ${input.paymentId} not found`)
    }
    if (original.venueId !== input.venueId) {
      throw new BadRequestError('Payment does not belong to this venue')
    }
    if (original.status !== 'COMPLETED') {
      throw new BadRequestError(`Cannot refund payment with status: ${original.status}`)
    }
    if (original.type === PaymentType.REFUND) {
      throw new BadRequestError('Cannot refund a refund')
    }
    if (!original.orderId) {
      throw new BadRequestError('Original payment is missing an associated order')
    }

    const existingRefunds = await tx.$queryRaw<RefundPaymentRow[]>(Prisma.sql`
      SELECT id, amount, "processorData", "createdAt", status
      FROM "Payment"
      WHERE
        "venueId" = ${input.venueId}
        AND type = CAST(${PaymentType.REFUND} AS "PaymentType")
        AND "processorData"->>'originalPaymentId' = ${input.paymentId}
      ORDER BY "createdAt" ASC, id ASC
    `)

    const alreadyRefundedCents = existingRefunds.reduce((sum, refund) => sum + Math.abs(toCents(refund.amount)), 0)
    const totalOriginalCents = toCents(original.amount) + toCents(original.tipAmount)
    const remainingBeforeCents = Math.max(0, totalOriginalCents - alreadyRefundedCents)
    const refundedItemsByOrderItemId = collectExistingRefundedItems(existingRefunds)

    let refundCents = 0
    const refundedItems: RefundedItemSnapshot[] = []

    if (hasItems) {
      const orderItemIds = input.items!.map(i => i.orderItemId)
      const orderItems = await tx.orderItem.findMany({
        where: { id: { in: orderItemIds }, orderId: original.orderId },
        select: { id: true, productId: true, productName: true, quantity: true, total: true, orderPromotionId: true },
      })

      if (orderItems.length !== orderItemIds.length) {
        throw new BadRequestError('One or more orderItemIds do not belong to this payment order')
      }

      // Una promoción se reembolsa completa o nada: se evalúa contra TODAS las
      // líneas de la orden, no sólo las seleccionadas.
      const allOrderLines = await tx.orderItem.findMany({
        where: { orderId: original.orderId },
        select: { id: true, orderPromotionId: true, total: true },
      })
      assertRefundableLines(allOrderLines, orderItemIds)

      for (const req of input.items!) {
        const orderItem = orderItems.find(o => o.id === req.orderItemId)!
        const refundQty = req.quantity ?? orderItem.quantity
        const alreadyRefundedItem = refundedItemsByOrderItemId.get(orderItem.id)
        const alreadyRefundedQty = alreadyRefundedItem?.quantity ?? 0

        if (refundQty <= 0) {
          throw new BadRequestError(`Invalid refund quantity ${refundQty} for item ${orderItem.id}`)
        }
        if (refundQty > orderItem.quantity) {
          throw new BadRequestError(`Invalid refund quantity ${refundQty} for item ${orderItem.id} (ordered ${orderItem.quantity})`)
        }
        assertPromotionLineFullQuantity(orderItem as any, refundQty)
        if (alreadyRefundedQty + refundQty > orderItem.quantity) {
          throw new BadRequestError(
            `Refund quantity ${refundQty} for item ${orderItem.id} exceeds remaining refundable quantity (${orderItem.quantity - alreadyRefundedQty})`,
          )
        }

        const lineTotalCents = toCents(orderItem.total)
        const lineRefundCents = getUnitRefundCents(lineTotalCents, orderItem.quantity, alreadyRefundedQty, refundQty)
        refundCents += lineRefundCents
        refundedItems.push({
          orderItemId: orderItem.id,
          quantity: refundQty,
          amountCents: lineRefundCents,
          amount: centsToNumber(lineRefundCents),
          productName: orderItem.productName,
          productId: orderItem.productId,
        })
      }
    } else {
      refundCents = input.amount!
    }

    if (refundCents <= 0) {
      throw new BadRequestError('Refund amount must be greater than zero')
    }
    if (refundCents > remainingBeforeCents) {
      throw new BadRequestError(
        `Refund (${centsToNumber(refundCents).toFixed(2)}) exceeds remaining refundable (${centsToNumber(remainingBeforeCents).toFixed(2)})`,
      )
    }

    // Split the refund between the original's sale portion (amount) and tip
    // (tipAmount).
    //   - Item-refunds are always 100% sale (items have no tip component).
    //   - Amount-refunds with an explicit `tipRefundCents` use the caller's
    //     split (e.g. caller wants "refund only the sale, keep staff tip").
    //   - Otherwise, split proportionally to the original's sale/tip ratio so
    //     shift reports and staff-tip balances stay consistent by default.
    const originalAmountCents = toCents(original.amount)
    const originalTipCents = toCents(original.tipAmount)
    let tipRefundCents = 0
    let salesRefundCents = refundCents

    if (!hasItems) {
      if (typeof input.tipRefundCents === 'number') {
        // Explicit caller override.
        if (input.tipRefundCents < 0) {
          throw new BadRequestError('tipRefundCents must be >= 0')
        }
        if (input.tipRefundCents > refundCents) {
          throw new BadRequestError(`tipRefundCents (${input.tipRefundCents}) exceeds total refund (${refundCents})`)
        }
        if (input.tipRefundCents > originalTipCents) {
          throw new BadRequestError(`tipRefundCents (${input.tipRefundCents}) exceeds original tip (${originalTipCents})`)
        }
        tipRefundCents = input.tipRefundCents
        salesRefundCents = refundCents - tipRefundCents
        if (salesRefundCents > originalAmountCents) {
          throw new BadRequestError(`Sale portion of refund (${salesRefundCents}) exceeds original sale amount (${originalAmountCents})`)
        }
      } else if (originalTipCents > 0 && totalOriginalCents > 0) {
        // Default: proportional split.
        tipRefundCents = Math.round((refundCents * originalTipCents) / totalOriginalCents)
        tipRefundCents = Math.min(tipRefundCents, originalTipCents)
        salesRefundCents = refundCents - tipRefundCents
      }
    }

    // Defensive (proportional path): sales side must also not exceed the
    // original amount portion. Re-balance by pushing the excess to tip.
    if (salesRefundCents > originalAmountCents && typeof input.tipRefundCents !== 'number') {
      const excess = salesRefundCents - originalAmountCents
      salesRefundCents -= excess
      tipRefundCents += excess
    }

    // ── ¿DE QUÉ TURNO SALE ESTE REEMBOLSO? ────────────────────────────────────────────────
    //
    // El turno abierto del NEGOCIO (`../shared/turnoDeCaja.ts`), resuelto y RECLAMADO **dentro** de
    // la transacción, igual que los otros dos rieles (`refund.tpv`, `refund.mobile`). El claim ES
    // el decremento: un `updateMany` condicionado a `{ venueId, status: 'OPEN', endTime: null }`.
    //
    // 🔴 Tres cosas cambian respecto de la versión anterior, y las tres son de dinero:
    //
    //   · **Ya no se cae a `original.shiftId`.** Ese turno normalmente está CERRADO, y
    //     decrementarle sus totales reescribe hacia atrás un corte que una persona ya firmó,
    //     imprimió y cuadró. Sin turno abierto el reembolso queda con `shiftId` nulo, que es
    //     REATRIBUIBLE después (`scripts/reatribuir-cobros-al-turno.ts`); uno estampado en un turno
    //     cerrado con conteo es justo lo que ese script se niega a tocar.
    //   · **El `where` lleva `venueId` y `status`.** Era un `update({ where: { id } })` pelón, que
    //     aceptaba el turno de otro negocio y uno ya cerrado.
    //   · **El `Payment` se sella con el turno SÓLO si el claim GANÓ.** Sellar antes de reclamar
    //     dejaba un REFUND colgando de un turno al que nunca se le restó, y el cierre selecciona
    //     estrictamente por `shiftId`: un recálculo desde los pagos discreparía de su propio
    //     `totalSales` por el monto del reembolso.
    //
    // El efectivo físico no se pierde en ningún caso: el `PAY_OUT` al cajón se publica post-commit
    // contra la `CashDrawerSession` abierta del venue, que no depende del `Shift`.
    let shiftId: string | null = null
    const turnoDelNegocio = await turnoAbiertoDelNegocio(tx, input.venueId)
    if (turnoDelNegocio) {
      const reclamado = await tx.shift.updateMany({
        where: { id: turnoDelNegocio.id, venueId: input.venueId, status: 'OPEN', endTime: null },
        data: {
          totalSales: { decrement: centsToDecimal(salesRefundCents) },
          ...(tipRefundCents > 0 ? { totalTips: { decrement: centsToDecimal(tipRefundCents) } } : {}),
        },
      })
      if (reclamado.count === 1) shiftId = turnoDelNegocio.id
    }

    const originalProcessorData = asRecord(original.processorData)
    const refundPayment = await tx.payment.create({
      data: {
        venueId: input.venueId,
        orderId: original.orderId,
        ...(shiftId ? { shiftId } : {}),
        ...(input.staffId ? { processedById: input.staffId } : {}),
        ...(original.merchantAccountId ? { merchantAccountId: original.merchantAccountId } : {}),

        // Negative amount/tip so that sum(refunds) mirrors the original split.
        amount: centsToDecimal(-salesRefundCents),
        tipAmount: centsToDecimal(-tipRefundCents),
        netAmount: centsToDecimal(-refundCents),
        feeAmount: new Prisma.Decimal(0),
        feePercentage: 0,

        method: original.method as PaymentMethod,
        // 🔴 El reembolso hereda la IDENTIDAD y la SEMÁNTICA del tipo original, no sólo el
        // `method`. Sin esto, devolver un vale que SÍ entraba al cajón caía al fallback
        // legacy (`method === 'CASH'` = false) y el arqueo seguía exigiendo un efectivo que
        // YA salió — un faltante inventado, en la dirección que acusa al cajero.
        //
        // La COMISIÓN no se hereda a propósito: que Uber devuelva su 30% cuando el cliente
        // cancela es un acuerdo comercial que no conocemos, e inventarlo daría un costo o un
        // ingreso falso. Queda vacía hasta que haya una decisión.
        ...(original.tenderTypeId
          ? {
              tenderTypeId: original.tenderTypeId,
              ...(original.tenderRevision != null ? { tenderRevision: original.tenderRevision } : {}),
              ...(original.tenderLabel != null ? { tenderLabel: original.tenderLabel } : {}),
              ...(original.tenderCountsAsCash != null ? { tenderCountsAsCash: original.tenderCountsAsCash } : {}),
              ...(original.tenderCaptureTip != null ? { tenderCaptureTip: original.tenderCaptureTip } : {}),
              ...(original.tenderSatFormaPago != null ? { tenderSatFormaPago: original.tenderSatFormaPago } : {}),
            }
          : {}),
        // `fundsFlow` va aparte del bloque de arriba: un pago SIN tender también lo tiene
        // (lo estampa su punto de entrada), y es la autoridad de "¿esto estaba en el cajón?".
        ...(original.fundsFlow ? { fundsFlow: original.fundsFlow as PaymentFundsFlow } : {}),
        ...(original.source || undefined ? { source: original.source as PaymentSource } : {}),
        status: TransactionStatus.COMPLETED,
        type: PaymentType.REFUND,

        processor: 'dashboard',
        processorData: {
          originalPaymentId: original.id,
          refundReason: input.reason,
          note: input.note ?? null,
          amountCents: refundCents,
          amount: centsToNumber(refundCents),
          refundedItems: refundedItems.length > 0 ? refundedItems : undefined,
          // Marker so `scripts/backfill-refund-shift-totals.ts` skips this row —
          // shift decrement is applied in-line below when a shift is resolved.
          shiftBackfilled: true,
        } as Prisma.InputJsonValue,
      },
    })

    // Bump refundedAmount on the original payment's processorData
    const updatedProcessorData = {
      ...originalProcessorData,
      refundedAmount: centsToNumber(alreadyRefundedCents + refundCents),
      refundedAmountCents: alreadyRefundedCents + refundCents,
      refunds: [
        ...((Array.isArray(originalProcessorData.refunds) ? originalProcessorData.refunds : []) as any[]),
        {
          refundPaymentId: refundPayment.id,
          amount: centsToNumber(refundCents),
          amountCents: refundCents,
          reason: input.reason,
          at: new Date().toISOString(),
        },
      ],
    }
    await tx.payment.update({
      where: { id: original.id },
      data: { processorData: updatedProcessorData as any },
    })

    // Venue transaction for financial tracking
    await tx.venueTransaction.create({
      data: {
        venueId: input.venueId,
        paymentId: refundPayment.id,
        type: 'REFUND',
        grossAmount: centsToDecimal(-refundCents),
        feeAmount: new Prisma.Decimal(0),
        netAmount: centsToDecimal(-refundCents),
        status: 'SETTLED',
      },
    })

    // El decremento del turno YA ocurrió arriba: el claim ES el decremento, y sellar el `Payment`
    // después es lo que garantiza que nunca haya un REFUND en un turno al que no se le restó.

    return {
      refundPaymentId: refundPayment.id,
      originalPaymentId: original.id,
      originalOrderId: original.orderId,
      refundedItems,
      remainingAfterCents: Math.max(0, remainingBeforeCents - refundCents),
      refundAmountCents: refundCents,
      // Semántica del pago ORIGINAL, para el movimiento de caja de abajo.
      originalTender: {
        method: original.method,
        fundsFlow: original.fundsFlow,
        tenderTypeId: original.tenderTypeId,
        tenderCountsAsCash: original.tenderCountsAsCash,
      },
    }
  })

  // 🔴 EL CAJÓN RESTA EL REEMBOLSO (el defecto medido en hardware el 2026-08-16).
  //
  // Este servicio es el que la app usa DE VERDAD (`POST /mobile/venues/:venueId/
  // payments/:paymentId/refund`) y no tocaba la caja: el arqueo marcaba $50,380 con
  // $50,230 físicos — un sobrante inventado exactamente del tamaño de lo devuelto,
  // que el cierre convierte en una acusación silenciosa contra el cajero.
  //
  // Va DESPUÉS del commit y FUERA de la transacción, igual que los demás enganches:
  // una falla del cajón jamás puede revertir una devolución ya hecha.
  // `postCashRefundToDrawer` no lanza —devuelve el resultado— y es idempotente por
  // `localId` derivado del id del reembolso, así que un reintento no resta dos veces.
  //
  // 🔴 Se resta IGUAL cuando la orden viene del dashboard web o del MCP, donde no hay
  // cajón enfrente: el evento mide dinero FÍSICO del local, no desde qué pantalla se
  // tecleó. El razonamiento completo y lo que se acepta a cambio están en
  // `services/shared/cashDrawerPosting.ts` (`postCashRefundToDrawer`).
  //
  // ⚠️ CROSS-REPO: mientras Android siga mandando su propio PAY_OUT
  // (`IssueRefundSheet.kt`) tras un reembolso, el cajón restaría DOS veces — la llave
  // del cliente es un UUID local y no colisiona con la nuestra. Ese parche se retira
  // en el mismo trabajo; iOS hace lo propio con su escritura local.
  try {
    await postCashRefundToDrawer({
      venueId: input.venueId,
      refundPaymentId: result.refundPaymentId,
      ...result.originalTender,
      // El efectivo que sale es el TOTAL devuelto (venta + propina): el split
      // interno es contable, el cajón sólo ve billetes.
      amount: centsToNumber(result.refundAmountCents),
      staffId: input.staffId ?? null,
      orderId: result.originalOrderId,
      reason: REFUND_REASON_LABEL_ES[input.reason] ?? input.reason,
    })
  } catch (err) {
    logger.error('[REFUND.DASHBOARD] Cash drawer posting failed (refund unaffected)', {
      refundPaymentId: result.refundPaymentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // REFERRAL HOOK: trigger referral void if the original order had a QUALIFIED referral
  // (idempotent: no-ops if no QUALIFIED Referral matches this orderId)
  if (result.originalOrderId) {
    try {
      const { onOrderRefunded } = await import('@/services/referrals/referralRefund.service')
      await onOrderRefunded({ orderId: result.originalOrderId, venueId: input.venueId })
    } catch (err) {
      console.error('[referral hook] onOrderRefunded failed for order', result.originalOrderId, err)
    }
  }

  // Restock inventory for selected items (best-effort, outside the payment tx
  // because it touches multiple Inventory rows and a partial failure shouldn't
  // roll back the refund itself).
  if (input.restockItemIds && input.restockItemIds.length > 0) {
    const restockSet = new Set(input.restockItemIds)
    const toRestock = result.refundedItems.filter(r => r.productId && restockSet.has(r.orderItemId))
    for (const item of toRestock) {
      try {
        await restockItem({
          venueId: input.venueId,
          productId: item.productId!,
          quantity: item.quantity,
          refundPaymentId: result.refundPaymentId,
          staffId: input.staffId ?? undefined,
        })
      } catch (err: any) {
        logger.warn('[REFUND.DASHBOARD] Failed to restock item', {
          refundPaymentId: result.refundPaymentId,
          orderItemId: item.orderItemId,
          productId: item.productId,
          error: err?.message ?? err,
        })
      }
    }
  }

  // Auto-generate DigitalReceipt for the REFUND so the customer gets a
  // comprobante just like the original payment does. Fire-and-forget:
  // receipt failures must not fail the refund itself.
  generateAndStoreReceipt(input.venueId, result.refundPaymentId).catch(err => {
    logger.error('[REFUND.DASHBOARD] Failed to auto-generate refund receipt', {
      refundPaymentId: result.refundPaymentId,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  // Reverse the staff commission that was earned on the original payment.
  // Same fire-and-forget pattern — commission ledger can catch up if this
  // fails, but the refund itself must succeed.
  createRefundCommission(result.refundPaymentId, result.originalPaymentId).catch(err => {
    logger.error('[REFUND.DASHBOARD] Failed to create refund commission', {
      refundPaymentId: result.refundPaymentId,
      originalPaymentId: result.originalPaymentId,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  // Create negative TransactionCost so settlement / profit reports see the
  // refund. TPV refunds already do this — mirror the pattern here so dashboard-
  // originated refunds aren't invisible to settlement and other reports that
  // INNER JOIN Payment with TransactionCost.
  createRefundTransactionCost(result.refundPaymentId, result.originalPaymentId).catch(err => {
    logger.error('[REFUND.DASHBOARD] Failed to create refund TransactionCost', {
      refundPaymentId: result.refundPaymentId,
      originalPaymentId: result.originalPaymentId,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  logger.info('[REFUND.DASHBOARD] Refund issued', {
    refundId: result.refundPaymentId,
    originalPaymentId: result.originalPaymentId,
    amount: centsToNumber(result.refundAmountCents),
    remainingRefundable: centsToNumber(result.remainingAfterCents),
  })

  // Audit trail: a refund is a money op, so dual-write to ActivityLog (the owner
  // audit screen reads ONLY ActivityLog). Fire-and-forget, OUTSIDE the tx — a
  // logging failure must never roll back or fail the refund itself. Mirrors the
  // REFUND_CREATED action written by the TPV + mobile refund services.
  void logAction({
    staffId: input.staffId ?? null,
    venueId: input.venueId,
    action: 'REFUND_CREATED',
    entity: 'Payment',
    entityId: result.refundPaymentId,
    data: {
      amount: centsToNumber(result.refundAmountCents), // pesos (major units), NOT cents
      reason: input.reason,
      originalPaymentId: result.originalPaymentId,
      note: input.note ?? null,
      refundedItemCount: result.refundedItems.length,
      source: 'DASHBOARD',
    },
  })

  return {
    refundId: result.refundPaymentId,
    originalPaymentId: result.originalPaymentId,
    amount: centsToNumber(result.refundAmountCents),
    remainingRefundable: centsToNumber(result.remainingAfterCents),
    status: 'COMPLETED',
  }
}

/**
 * Return the set of REFUND payments that reference a given original payment.
 */
export async function listRefundsForPayment(venueId: string, originalPaymentId: string) {
  const refunds = await prisma.payment.findMany({
    where: {
      venueId,
      type: PaymentType.REFUND,
      // processorData->>originalPaymentId = :originalPaymentId
      // Prisma JSON filters don't hit this cleanly, so we filter in JS below.
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      status: true,
      method: true,
      createdAt: true,
      processedBy: { select: { firstName: true, lastName: true } },
      processorData: true,
    },
  })

  // Since 2026-04-19 refunds split the refund across Payment.amount (sale) and
  // Payment.tipAmount (tip). Consumers built before that split only read `amount`
  // and would under-report the total refund by the tip portion. Return `amount`
  // as the NEGATIVE TOTAL so those consumers keep working, and expose the
  // split in separate fields for anyone that cares.
  return refunds
    .filter(r => {
      const pd = (r.processorData as Record<string, unknown>) || {}
      return pd.originalPaymentId === originalPaymentId
    })
    .map(r => {
      const sale = Number(r.amount)
      const tip = Number(r.tipAmount ?? 0)
      const total = sale + tip // both are negative for refunds
      return {
        id: r.id,
        amount: total,
        saleAmount: sale,
        tipAmount: tip,
        status: r.status,
        method: r.method,
        createdAt: r.createdAt,
        processedBy: r.processedBy,
        processorData: r.processorData,
      }
    })
}

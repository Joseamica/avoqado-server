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

import { MovementType, PaymentMethod, PaymentSource, PaymentType, Prisma, RawMaterialMovementType, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { adjustStock } from './rawMaterial.service'
import { generateAndStoreReceipt } from './receipt.dashboard.service'
import { createRefundCommission } from './commission/commission-calculation.service'
import { createRefundTransactionCost } from '../payments/transactionCost.service'

export type RefundReason = 'RETURNED_GOODS' | 'ACCIDENTAL_CHARGE' | 'CANCELLED_ORDER' | 'FRAUDULENT_CHARGE' | 'OTHER'

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

  // Find active shift for the staff (optional, for reconciliation)
  let shiftId: string | null = null
  if (input.staffId) {
    const openShift = await prisma.shift.findFirst({
      where: { venueId: input.venueId, staffId: input.staffId, status: 'OPEN', endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true },
    })
    if (openShift) shiftId = openShift.id
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
        "processorData"
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
        select: { id: true, productId: true, productName: true, quantity: true, total: true },
      })

      if (orderItems.length !== orderItemIds.length) {
        throw new BadRequestError('One or more orderItemIds do not belong to this payment order')
      }

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

    const originalProcessorData = asRecord(original.processorData)
    const refundPayment = await tx.payment.create({
      data: {
        venueId: input.venueId,
        orderId: original.orderId,
        ...(shiftId || original.shiftId ? { shiftId: shiftId || original.shiftId! } : {}),
        ...(input.staffId ? { processedById: input.staffId } : {}),
        ...(original.merchantAccountId ? { merchantAccountId: original.merchantAccountId } : {}),

        // Negative amount/tip so that sum(refunds) mirrors the original split.
        amount: centsToDecimal(-salesRefundCents),
        tipAmount: centsToDecimal(-tipRefundCents),
        netAmount: centsToDecimal(-refundCents),
        feeAmount: new Prisma.Decimal(0),
        feePercentage: 0,

        method: original.method as PaymentMethod,
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

    // Decrement shift totals for whatever shift the refund is attributed to.
    // The refund Payment uses `shiftId || original.shiftId` (see refundPayment
    // create above), so mirror the same resolution here. Otherwise refunds
    // issued outside a staff's open shift (e.g. via dashboard) would leave the
    // original shift's totalSales inflated.
    const resolvedShiftId = shiftId || original.shiftId
    if (resolvedShiftId) {
      await tx.shift.update({
        where: { id: resolvedShiftId },
        data: {
          totalSales: { decrement: centsToDecimal(salesRefundCents) },
          ...(tipRefundCents > 0 ? { totalTips: { decrement: centsToDecimal(tipRefundCents) } } : {}),
        },
      })
    }

    return {
      refundPaymentId: refundPayment.id,
      originalPaymentId: original.id,
      refundedItems,
      remainingAfterCents: Math.max(0, remainingBeforeCents - refundCents),
      refundAmountCents: refundCents,
    }
  })

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
  // originated refunds aren't invisible to moneygiver-settlement and other
  // reports that INNER JOIN Payment with TransactionCost.
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

  return {
    refundId: result.refundPaymentId,
    originalPaymentId: result.originalPaymentId,
    amount: centsToNumber(result.refundAmountCents),
    remainingRefundable: centsToNumber(result.remainingAfterCents),
    status: 'COMPLETED',
  }
}

/**
 * Add stock back for a refunded item.
 *
 * Routes by inventoryMethod:
 *   - QUANTITY: atomic increment on the product's `Inventory` row + ADJUSTMENT
 *     movement.
 *   - RECIPE:   for each recipe line (skipping optional/variable lines), call
 *     `adjustStock` on the raw material with `quantity * portions`. This
 *     creates a new batch at current cost and an ADJUSTMENT movement. Note
 *     this is an approximation — FIFO batches consumed during the original
 *     sale aren't tracked back to their exact origin.
 *
 *     Modifier substitutions (SUBSTITUTION mode) are *not* reversed here —
 *     the default recipe ingredients are the ones restocked.
 */
async function restockItem(args: { venueId: string; productId: string; quantity: number; refundPaymentId: string; staffId?: string }) {
  const { venueId, productId, quantity, refundPaymentId, staffId } = args

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, inventoryMethod: true, trackInventory: true },
  })
  if (!product || !product.trackInventory) return

  // Explicit QUANTITY, or fall back: if an Inventory row exists, treat as QUANTITY.
  const method = product.inventoryMethod
  if (method === 'QUANTITY') {
    const inventory = await prisma.inventory.findUnique({ where: { productId } })
    if (!inventory) return
    await prisma.$transaction(async tx => {
      const updated = await tx.inventory.update({
        where: { productId },
        data: { currentStock: { increment: quantity } },
      })
      const newStock = updated.currentStock
      const previousStock = newStock.sub(quantity)
      await tx.inventoryMovement.create({
        data: {
          inventoryId: inventory.id,
          type: MovementType.ADJUSTMENT,
          quantity: new Prisma.Decimal(quantity),
          previousStock,
          newStock,
          reason: `Refund restock (paymentId=${refundPaymentId})`,
          reference: refundPaymentId,
          createdBy: staffId,
        },
      })
    })
    logger.info('[REFUND.DASHBOARD] Restocked (QUANTITY)', { venueId, productId, quantity, refundPaymentId })
    return
  }

  if (method === 'RECIPE') {
    const recipe = await prisma.recipe.findUnique({
      where: { productId },
      include: { lines: { include: { rawMaterial: { select: { id: true, name: true, unit: true } } } } },
    })
    if (!recipe) return

    for (const line of recipe.lines) {
      if (line.isOptional) continue
      // Skip variable (substitution-capable) lines — we can't know without the
      // original OrderItemModifier set whether the default or substitute was used.
      if (line.isVariable) continue

      const addQty = Number(line.quantity) * quantity
      if (addQty <= 0) continue

      try {
        await adjustStock(
          venueId,
          line.rawMaterialId,
          {
            quantity: addQty,
            type: RawMaterialMovementType.ADJUSTMENT,
            reason: `Refund restock for ${product.name} (paymentId=${refundPaymentId})`,
            reference: refundPaymentId,
          },
          staffId,
        )
      } catch (err: any) {
        logger.warn('[REFUND.DASHBOARD] Failed to restock raw material', {
          rawMaterialId: line.rawMaterialId,
          productId,
          addQty,
          error: err?.message ?? err,
        })
      }
    }
    logger.info('[REFUND.DASHBOARD] Restocked (RECIPE)', {
      venueId,
      productId,
      portions: quantity,
      lines: recipe.lines.length,
      refundPaymentId,
    })
    return
  }

  logger.info('[REFUND.DASHBOARD] Skipped restock (no inventoryMethod)', { productId })
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

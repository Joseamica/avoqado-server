import { Prisma } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import { TOPES_POR_ORDEN } from '../fiscal/librosDeOrdenes'
import { lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { computeOrderBalance } from '../shared/orderBalance'
import { assertRefundableLines, assertPromotionLineFullQuantity, bloquearCobroParaReembolso } from '../dashboard/refund.dashboard.service'
import { createSalePostingInTx } from '../inventory/inventoryPosting.service'
import { exchangeChargeEvidence } from './exchangeCharge'
import { exchangeAccountingAt } from './exchangeAccountingAt'
import { loadSaleForExchange, MAX_EXCHANGE_SALE_PAYMENTS } from './exchangeSale'
import { allocateAcrossPayments, effectiveExchangeCapacity, lineBlockReason, saleBlockReason } from './exchangeRules'
import { ensureExchangeCreditTender, resolveExchangeCreditTenderInTx } from './exchangeCreditTender'
import { ExchangeError } from './exchangeErrors'
import { prepareExchangeCreditsInTx, type PreparedExchange, type ExchangeTxEarly } from './exchangeTx'
import type { CreateExchangeBody, ExchangeResponse, ExchangeTxInput } from './exchange.service'

export interface ExchangeSettleTxInput {
  mode: 'SETTLE_CARD_CHARGE'
  venueId: string
  exchangeId: string
  actorStaffId: string | null
}
export type ExchangeReviewReason = 'ORIGINAL_CHANGED_WHILE_PENDING' | 'CHARGE_AMOUNT_MISMATCH' | 'LATE_CHARGE_AFTER_RELEASE'

export class ExchangeGenerationChanged extends Error {}

/** The stored sale is already grouped; never rebuild it from today's catalog. */
export async function exchangeSalePostingInTx(tx: Prisma.TransactionClient, venueId: string, orderId: string, staffId: string) {
  const items = await tx.orderItem.findMany({
    where: { orderId, order: { venueId } },
    take: TOPES_POR_ORDEN.renglones + 1,
    include: { modifiers: { include: { modifier: true } } },
  })
  if (items.length > TOPES_POR_ORDEN.renglones) throw new Error('EXCHANGE_SALE_TOO_LARGE')
  return createSalePostingInTx(tx, { venueId, orderId, items, staffId })
}

export async function prepareCardSettlementInTx(
  tx: Prisma.TransactionClient,
  input: ExchangeSettleTxInput,
): Promise<PreparedExchange | ExchangeTxEarly> {
  const { venueId, exchangeId } = input
  const initial = await tx.exchange.findFirst({ where: { id: exchangeId, venueId } })
  if (!initial) throw new NotFoundError('No se encontró el cambio en esta sucursal.')
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange:v1:' + venueId + ':' + initial.idempotencyKey}, 0))::text`
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: initial.newOrderId, additionalOrderIds: [initial.originalOrderId] })))
    throw new NotFoundError('No se encontró la venta del cambio.')
  const exchange = await tx.exchange.findFirstOrThrow({ where: { id: exchangeId, venueId } })
  if (exchange.newOrderId !== initial.newOrderId || exchange.originalOrderId !== initial.originalOrderId)
    throw new ExchangeGenerationChanged()
  if (!exchange.result) throw new Error('EXCHANGE_RESULT_MISSING')
  const stored = exchange.result as unknown as ExchangeResponse
  if (!['PENDING_PAYMENT', 'CANCELLED'].includes(exchange.status)) return { unsettled: stored, evidence: null }
  if (exchange.settlementKind !== 'COLLECT' || exchange.settlementMethod !== 'CARD_TERMINAL') return { unsettled: stored, evidence: null }
  const evidence = await exchangeChargeEvidence(tx, venueId, exchange.newOrderId)
  if (evidence.kind !== 'CHARGED') return { unsettled: stored, evidence: exchange.status === 'CANCELLED' ? null : evidence }
  let sale: Awaited<ReturnType<typeof loadSaleForExchange>> | null = null
  try {
    sale = await loadSaleForExchange(tx, venueId, exchange.originalOrderId)
  } catch (error) {
    if (!(error instanceof ExchangeError || error instanceof NotFoundError)) throw error
  }
  const lockIds = [...new Set([...evidence.paymentIds, ...(sale?.payments.flatMap(p => [p.id, p.rootPaymentId]) ?? [])])].sort()
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE "venueId"=${venueId} AND id=ANY(${lockIds}::text[]) ORDER BY id ASC FOR UPDATE`
  const freshEvidence = await exchangeChargeEvidence(tx, venueId, exchange.newOrderId)
  if (freshEvidence.kind !== 'CHARGED' || JSON.stringify(freshEvidence.paymentIds) !== JSON.stringify(evidence.paymentIds))
    throw new ExchangeGenerationChanged()
  const pending = await tx.payment.findFirst({
    where: { venueId, orderId: exchange.newOrderId, status: { in: ['PENDING', 'PROCESSING'] } },
    select: { id: true },
  })
  const { terminalPaymentService } = await import('../terminal-payment.service')
  const blocking = await terminalPaymentService.findChargeBlockingOrderCancel(venueId, exchange.newOrderId, tx)
  if (pending || blocking)
    return { unsettled: stored, evidence: { kind: 'UNRESOLVED', requestId: blocking?.requestId ?? null, positiveRequestId: null } }
  const accountingAt = await exchangeAccountingAt(tx, venueId, [exchange.newOrderId, exchange.originalOrderId])
  const charge = await tx.payment.findFirstOrThrow({ where: { venueId, orderId: exchange.newOrderId, id: evidence.paymentIds[0] } })
  const expectedCents = exchange.differenceAmount.mul(100).toNumber()
  const review = async (reason: ExchangeReviewReason): Promise<ExchangeTxEarly> => {
    const late = reason === 'LATE_CHARGE_AFTER_RELEASE'
    const posting = late ? null : await exchangeSalePostingInTx(tx, venueId, exchange.newOrderId, exchange.staffId)
    const response: ExchangeResponse = {
      ...stored,
      status: 'NEEDS_REVIEW',
      chargePaymentId: exchange.chargePaymentId ?? charge.id,
      reviewReason: reason,
      paymentIds: evidence.paymentIds,
      chargedSaleCents: evidence.chargedSaleCents,
      chargePaymentCount: evidence.paymentCount,
      expectedCents,
    }
    delete response.amountToChargeCents
    const written = await tx.exchange.updateMany({
      where: { id: exchangeId, venueId, status: exchange.status, resultRevision: exchange.resultRevision },
      data: {
        status: 'NEEDS_REVIEW',
        reviewReason: reason,
        chargePaymentId: response.chargePaymentId,
        result: response as unknown as Prisma.InputJsonValue,
        resultRevision: { increment: 1 },
        ...(!late ? { createdAt: accountingAt } : {}),
      },
    })
    if (written.count !== 1) throw new ExchangeGenerationChanged()
    await tx.activityLog.create({
      data: {
        venueId,
        entity: 'Exchange',
        entityId: exchangeId,
        action: 'EXCHANGE_NEEDS_REVIEW',
        staffId: input.actorStaffId,
        createdAt: late ? new Date() : accountingAt,
        data: {
          reviewReason: reason,
          chargePaymentId: response.chargePaymentId,
          chargedSaleCents: evidence.chargedSaleCents,
          chargePaymentCount: evidence.paymentCount,
          expectedCents,
          originalStaffId: exchange.staffId,
          origin: input.actorStaffId === null ? 'SWEEP' : 'HTTP',
        },
      },
    })
    return { review: response, salePostingId: posting?.id ?? null }
  }
  const order = await tx.order.findFirstOrThrow({ where: { venueId, id: exchange.newOrderId } })
  if (exchange.status === 'CANCELLED' || order.status === 'CANCELLED') return review('LATE_CHARGE_AFTER_RELEASE')
  const refundedCharge = await tx.payment.findFirst({
    where: {
      venueId,
      type: 'REFUND',
      processorData: { path: ['originalPaymentId'], equals: charge.id },
      status: { in: ['COMPLETED', 'PENDING', 'PROCESSING'] },
    },
    select: { id: true },
  })
  if (
    evidence.paymentCount !== 1 ||
    evidence.exceedsPaymentLimit ||
    evidence.chargedSaleCents !== expectedCents ||
    charge.status !== 'COMPLETED' ||
    !['CREDIT_CARD', 'DEBIT_CARD'].includes(charge.method) ||
    !charge.tipAmount.eq(0) ||
    refundedCharge ||
    effectiveExchangeCapacity({ amountCents: evidence.chargedSaleCents, tipCents: 0, processorData: charge.processorData, refunds: [] }) !==
      expectedCents ||
    (exchange.chargePaymentId !== null && exchange.chargePaymentId !== charge.id)
  )
    return review('CHARGE_AMOUNT_MISMATCH')
  if (!sale) return review('ORIGINAL_CHANGED_WHILE_PENDING')
  // Reload the capacities only after the union of credit/root/charge rows is owned.
  sale = await loadSaleForExchange(tx, venueId, exchange.originalOrderId)
  if (sale.payments.some(p => !lockIds.includes(p.id) || !lockIds.includes(p.rootPaymentId))) throw new ExchangeGenerationChanged()
  const frozen = exchange.lines as unknown as ExchangeResponse['lines'] & { returnLines: PreparedExchange['returnLines'] }
  if (!Array.isArray(frozen.returned) || !Array.isArray(frozen.taken) || !Array.isArray(frozen.returnLines))
    return review('ORIGINAL_CHANGED_WHILE_PENDING')
  const returnedCents = exchange.returnedAmount.mul(100).toNumber()
  const takenCents = exchange.takenAmount.mul(100).toNumber()
  const orderedPayments = [...sale.payments].sort(
    (a, b) => Number(b.id === exchange.originalPaymentId) - Number(a.id === exchange.originalPaymentId),
  )
  const allocation = allocateAcrossPayments(
    orderedPayments.map(p => ({ paymentId: p.id, saleRemainingCents: effectiveExchangeCapacity(p), modes: {} })),
    returnedCents,
    null,
  )
  let valid =
    allocation.ok &&
    sale.charged.atribuible &&
    !saleBlockReason({ ...sale.order, paymentSources: sale.payments.map(p => p.money.source ?? '') })
  const byId = new Map(sale.lines.map(l => [l.id, l]))
  try {
    assertRefundableLines(
      sale.charged.renglones,
      frozen.returned.map(l => l.orderItemId),
    )
    for (const line of frozen.returned) {
      const current = byId.get(line.orderItemId)
      const prior = sale.returnedByLine.get(line.orderItemId)
      if (
        !current ||
        line.quantity > current.quantity - (prior?.quantity ?? 0) ||
        line.valueCents > (sale.charged.cobradoCents.get(line.orderItemId) ?? 0) - (prior?.amountCents ?? 0) ||
        lineBlockReason({
          productId: current.productId,
          productType: current.product?.type ?? null,
          giftCardId: current.giftCardId,
          soldByWeight: current.product?.soldByWeight ?? false,
          remainingQtyOrder: current.quantity - (prior?.quantity ?? 0),
          serialized: current.serialized,
        })
      ) {
        valid = false
        break
      }
      assertPromotionLineFullQuantity(current, line.quantity)
    }
  } catch (error) {
    if (!(error instanceof Error) || !('statusCode' in error)) throw error
    valid = false
  }
  const grouped = await tx.orderItem.findMany({ where: { orderId: order.id, order: { venueId } }, take: TOPES_POR_ORDEN.renglones + 1 })
  const itemIds = new Set(frozen.taken.flatMap(l => l.newOrderItemIds))
  const expectedGroups = new Map<string, number>()
  for (const line of frozen.taken) {
    if (line.quantity !== line.pieces.length || line.priceCents !== line.pieces.reduce((sum, piece) => sum + piece.priceCents, 0))
      valid = false
    for (const piece of line.pieces) {
      const unit = piece.inheritedFromOrderItemId === null ? piece.priceCents : Math.max(line.listCents, piece.priceCents)
      const key = `${line.productId}:${unit}:${piece.priceCents}`
      expectedGroups.set(key, (expectedGroups.get(key) ?? 0) + 1)
    }
  }
  const groupedMatches =
    grouped.length === expectedGroups.size &&
    grouped.every(item => {
      const unit = item.unitPrice.mul(100)
      const paid = unit.minus((item.discountAmount ?? new Prisma.Decimal(0)).mul(100).div(item.quantity))
      return (
        expectedGroups.get(`${item.productId}:${unit.toString()}:${paid.toString()}`) === item.quantity &&
        item.total.eq(item.unitPrice.mul(item.quantity))
      )
    })
  const modifiers = await tx.orderItemModifier.count({ where: { orderItem: { orderId: order.id, order: { venueId } } } })
  const frozenBalance = computeOrderBalance(order, [charge])
  valid =
    valid &&
    grouped.length <= TOPES_POR_ORDEN.renglones &&
    grouped.length === itemIds.size &&
    grouped.every(i => itemIds.has(i.id)) &&
    groupedMatches &&
    modifiers === 0 &&
    grouped.filter(i => i.discountAmount?.gt(0)).length <= TOPES_POR_ORDEN.descuentos &&
    frozenBalance.total.mul(100).eq(takenCents) &&
    frozenBalance.remainingBalance.mul(100).eq(returnedCents) &&
    frozen.returned.reduce((sum, l) => sum + l.valueCents, 0) === returnedCents &&
    frozen.taken.reduce((sum, l) => sum + l.priceCents, 0) === takenCents
  if (!allocation.ok || !valid || allocation.slices.length + 1 > MAX_EXCHANGE_SALE_PAYMENTS) return review('ORIGINAL_CHANGED_WHILE_PENDING')
  const slices = allocation.slices
  if (returnedCents === 0) {
    if (!sale.payments.some(p => p.id === exchange.originalPaymentId)) return review('ORIGINAL_CHANGED_WHILE_PENDING')
    slices.push({ paymentId: exchange.originalPaymentId, cents: 0, role: 'CREDIT', mode: null })
  }
  const snapshots = new Map<string, Awaited<ReturnType<typeof bloquearCobroParaReembolso>>>()
  for (const id of [...new Set(slices.map(s => s.paymentId))].sort()) {
    const snapshot = await bloquearCobroParaReembolso(tx, { venueId, paymentId: id, expectedOrderId: sale.order.id })
    if (snapshot.unclassifiedPriorRefundCents > 0) return review('ORIGINAL_CHANGED_WHILE_PENDING')
    snapshots.set(id, snapshot)
  }
  await ensureExchangeCreditTender(tx, venueId, true)
  const ec = await resolveExchangeCreditTenderInTx(tx, venueId)
  const body: CreateExchangeBody = {
    idempotencyKey: exchange.idempotencyKey,
    originalPaymentId: exchange.originalPaymentId,
    returned: frozen.returned,
    taken: frozen.taken.map(l => ({ productId: l.productId, quantity: l.quantity })),
    settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: expectedCents },
    staffId: exchange.staffId,
    deviceId: exchange.deviceId ?? '',
    createdAtLocal: (exchange.createdAtLocal ?? exchange.createdAt).toISOString(),
  }
  const originalInput: ExchangeTxInput = {
    venueId,
    originalOrderId: exchange.originalOrderId,
    actorStaffId: exchange.staffId,
    body,
    requestHash: exchange.requestHash,
  }
  return prepareExchangeCreditsInTx(
    tx,
    {
      input: originalInput,
      accountingAt,
      actorStaffId: input.actorStaffId,
      expectedStatus: exchange.status,
      resultRevision: exchange.resultRevision,
      existingCharge: charge,
      finalStatus: 'COMPLETED',
      exchangeId,
      sale,
      newOrder: order,
      lines: { returned: frozen.returned, taken: frozen.taken },
      returnLines: frozen.returnLines,
      returnedCents,
      takenCents,
      differenceCents: expectedCents,
    },
    slices,
    new Map(),
    ec,
    null,
    snapshots,
  )
}

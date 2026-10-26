import type { ExchangeSettlementKind, ExchangeSettlementMethod, ExchangeStatus } from '@prisma/client'
import type { ExchangeReason } from './exchangePredicates'
import type { VariantFields } from '../product-variants/variantPayload'
import type { CobradoDeLaOrden } from '../fiscal/cobradoDeLaOrden'
import type { MoneyShape } from './exchangeRules'
import type { FilaDeReembolso } from '../shared/devueltoDeUnCobro'
import type { ChainRefundRoot } from './exchangeChainRefund'
import type { OrderInventoryWarning } from '../tpv/payment.tpv.service'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { operationHash } from '@/utils/operationHash'
import { validateStaffVenue } from '@/utils/staff-venue.util'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'
import { executeExchangeInTransaction, cancelOrderInTransaction, publishCancelledOrder } from '../mobile/order.mobile.service'
import { lockExistingOrderForPayment, ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import { ExchangeGenerationChanged } from './exchangeSettle'
import { ExchangeReleaseNotDue, releaseExchangeInTx } from './exchangeCharge'
import { OrderTableTopologyChanged } from '../shared/tableOrderLock'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { generateAndStoreReceipt } from '../dashboard/receipt.dashboard.service'
import { applySalePosting, applyCustomerReturnPosting } from '../inventory/inventoryPosting.service'
import { buildInventoryWarning, mapDigitalReceiptResponse } from '../tpv/payment.tpv.service'
import { awardLoyaltyForPaidOrder } from '../shared/loyaltyOnPaidOrder'
import { postCashSaleToDrawer, postCashRefundToDrawer } from '../shared/cashDrawerPosting'
import { effectiveExchangesEnabled } from './exchangeRules'
import { ExchangeError } from './exchangeErrors'
import type { ExchangeTxOutcome } from './exchangeTx'

export interface CreateExchangeBody {
  idempotencyKey: string
  originalPaymentId: string
  returned: Array<{ orderItemId: string; quantity: number; restock: boolean; reason: ExchangeReason }>
  taken: Array<{
    productId: string
    quantity: number
    inheritsFromOrderItemId?: string | null
    displayedUnitPriceCents?: number
    catalogAt?: string
  }>
  settlement: {
    kind: ExchangeSettlementKind
    method: ExchangeSettlementMethod | null
    expectedDifferenceCents: number
    cashDrawerSessionId?: string | null
    terminalId?: string | null
    tenderTypeId?: string | null
    tenderRevision?: number | null
    cashFromNonCash?: boolean
  }
  staffId: string
  deviceId: string
  createdAtLocal: string
  isOfflineReplay?: boolean
}
export interface ExchangeTxInput {
  venueId: string
  actorStaffId: string
  body: CreateExchangeBody
  requestHash: string
  originalOrderId: string
}
export interface SaleForExchange {
  /** Batch reads retain business refusals; the single-sale writer still throws for missing settlement evidence. */
  settlementUnavailable?: boolean
  orderLockScopeTooLarge?: boolean
  order: {
    id: string
    orderNumber: string
    status: string
    paymentStatus: string
    source: string
    type: string
    servedById: string | null
    createdById: string | null
    customerId: string | null
    primaryCustomerId: string | null
  }
  lines: Array<{
    id: string
    productId: string | null
    productName: string
    quantity: number
    orderPromotionId: string | null
    giftCardId: string | null
    serialized: boolean
    product: {
      type: string
      soldByWeight: boolean
      trackInventory: boolean
      inventoryMethod: string | null
      priceCents: number
      deletedAt: Date | null
      productGroupId: string | null
      variantOptions: VariantFields['variantOptions']
      hasInventoryRow: boolean
    } | null
  }>
  charged: CobradoDeLaOrden
  returnedByLine: Map<string, { orderItemId: string; quantity: number; amountCents: number }>
  chainByPaymentId: Map<string, { link: { exchangeId: string }; root: ChainRefundRoot | undefined }>
  payments: Array<{
    id: string
    createdAt: Date
    amountCents: number
    tipCents: number
    tenderLabel: string | null
    saleRemainingCents: number
    processorData: unknown
    refunds: FilaDeReembolso[]
    saleRefundedCents: number
    money: MoneyShape
    rootPaymentId: string
    rootMoney: MoneyShape
  }>
}
export interface ExchangeReturnedLine {
  orderItemId: string
  productId: string | null
  productName: string
  quantity: number
  reason: ExchangeReason
  restock: boolean
  pieceValuesCents: number[]
  valueCents: number
}
export interface ExchangeTakenLine {
  productId: string
  productName: string
  quantity: number
  listCents: number
  priceCents: number
  pieces: Array<{ priceCents: number; inheritedFromOrderItemId: string | null }>
  newOrderItemIds: string[]
}
export interface ExchangeResponse {
  id: string
  status: ExchangeStatus
  originalOrderId: string
  originalOrderNumber: string
  newOrderId: string
  newOrderNumber: string
  returnedCents: number
  takenCents: number
  differenceCents: number
  settlement: {
    kind: ExchangeSettlementKind
    method: ExchangeSettlementMethod | null
    amountCents: number
    sources: Array<{ originalPaymentId: string; refundPaymentId: string; method: string; amountCents: number }>
  }
  lines: { returned: ExchangeReturnedLine[]; taken: ExchangeTakenLine[] }
  refundPaymentIds: string[]
  paymentIds: string[]
  pendingCardRefundCents: number
  receiptUrl: string | null
  amountToChargeCents?: number
  chargePaymentId?: string | null
  chargedSaleCents?: number
  chargePaymentCount?: number
  expectedCents?: number
  reviewReason?: import('./exchangeSettle').ExchangeReviewReason | null
  inventoryWarning?: OrderInventoryWarning
}
export async function createExchange(input: {
  venueId: string
  actorStaffId: string
  body: CreateExchangeBody
}): Promise<{ exchange: ExchangeResponse; replay: boolean }> {
  const { venueId, actorStaffId, body } = input
  if (body.staffId !== actorStaffId) throw new ExchangeError('ACTOR_MISMATCH', 'El cambio lo hace la persona con la sesión abierta.', 400)
  const requestHash = operationHash({ venueId, ...body, idempotencyKey: undefined, isOfflineReplay: undefined })
  const readReplay = async () => {
    const existing = await prisma.exchange.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: body.idempotencyKey } },
    })
    if (!existing) return null
    if (existing.requestHash !== requestHash)
      throw new ExchangeError('IDEMPOTENCY_KEY_REUSED', 'Esta llave ya se usó para otro cambio.', 409)
    if (!existing.result) throw new Error('EXCHANGE_RESULT_MISSING')
    const response = existing.result as unknown as ExchangeResponse
    await exchangeReceipt(venueId, response)
    return { exchange: await patchExchangePresentation(venueId, response, existing.resultRevision), replay: true }
  }
  const replay = await readReplay()
  if (replay) return replay
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { type: true, settings: { select: { exchangesEnabled: true } } },
  })
  if (!venue) throw new NotFoundError('No se encontró la sucursal.')
  if (!effectiveExchangesEnabled(venue.settings?.exchangesEnabled, venue.type))
    throw new ExchangeError(
      'EXCHANGES_DISABLED',
      'Los cambios de producto están apagados en esta sucursal. Actívalos en el panel: Configuración › Devoluciones y cambios.',
      422,
    )
  await assertVenueSalesEnabled(venueId)
  await validateStaffVenue(actorStaffId, venueId)
  const original = await prisma.payment.findFirst({
    where: { id: body.originalPaymentId, venueId, OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    select: { orderId: true },
  })
  if (!original?.orderId) throw new NotFoundError('No se encontró el cobro en esta sucursal.')
  let outcome: Awaited<ReturnType<typeof executeExchangeInTransaction>>
  try {
    outcome = await executeExchangeInTransaction({ ...input, requestHash, originalOrderId: original.orderId })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await readReplay()
      if (winner) return winner
    }
    throw error
  }
  if ('replay' in outcome) {
    await exchangeReceipt(venueId, outcome.replay)
    return { exchange: await patchExchangePresentation(venueId, outcome.replay, outcome.resultRevision), replay: true }
  }
  if ('reserved' in outcome) return { exchange: outcome.reserved, replay: false }
  if (!('postCommit' in outcome)) throw new Error('EXCHANGE_CREATE_OUTCOME_INVALID')
  await runExchangePostCommit(outcome, input)
  return { exchange: outcome.response, replay: false }
}

/** Cada efecto falla por separado: el dinero ya quedó y nunca se presenta el cambio como fallido. */
async function bestEffort(exchangeId: string, step: string, run: () => Promise<unknown>) {
  try {
    await run()
  } catch (error) {
    logger.error('[Cambio] efecto después del commit pendiente', { exchangeId, step, error })
  }
}

async function exchangeReceipt(venueId: string, response: ExchangeResponse, receiptPaymentId?: string) {
  if (!response.paymentIds.length || response.status !== 'COMPLETED') return
  await bestEffort(response.id, 'receipt', async () => {
    const paymentId = receiptPaymentId ?? response.chargePaymentId ?? response.paymentIds[response.paymentIds.length - 1]
    // El candado y toda la consulta/creación usan la misma conexión; el dinero ya está confirmado.
    const receipt = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange-receipt:v1:' + paymentId}, 0))::text`
      return generateAndStoreReceipt(venueId, paymentId, undefined, tx)
    })
    response.receiptUrl = mapDigitalReceiptResponse(receipt)?.receiptUrl ?? null
  })
}

async function runExchangePostCommit(outcome: ExchangeTxOutcome, input: { venueId: string; actorStaffId: string }) {
  const { exchangeId, response, postCommit: p } = outcome
  const { venueId, actorStaffId } = input
  await bestEffort(exchangeId, 'saleInventory', async () => {
    if (!p.salePostingId) return
    const applied = await applySalePosting(p.salePostingId, actorStaffId)
    if (applied?.issues?.length) response.inventoryWarning = buildInventoryWarning(applied.issues, applied.applied)
  })
  await bestEffort(exchangeId, 'returnInventory', async () => {
    if (p.returnPostingId) await applyCustomerReturnPosting(p.returnPostingId, actorStaffId)
  })
  if (p.cashSale?.sessionId)
    await bestEffort(exchangeId, 'cashSale', () =>
      postCashSaleToDrawer({
        ...p.cashSale!.money,
        venueId,
        paymentId: p.cashSale!.paymentId,
        targetSessionId: p.cashSale!.sessionId,
        exigirAbierta: true,
        status: 'COMPLETED',
        type: 'REGULAR',
        amount: p.cashSale!.amountPesos,
        tipAmount: 0,
        staffId: actorStaffId,
        orderId: p.newOrderId,
      }),
    )
  for (const payout of p.cashPayouts)
    if (payout.sessionId)
      await bestEffort(exchangeId, 'cashPayout', () =>
        postCashRefundToDrawer({
          ...payout.money,
          venueId,
          refundPaymentId: payout.refundPaymentId,
          targetSessionId: payout.sessionId,
          amount: payout.amountPesos,
          staffId: actorStaffId,
          orderId: p.originalOrderId,
          reason: 'Cambio de producto',
        }),
      )
  await exchangeReceipt(venueId, response, p.receiptPaymentId)
  await bestEffort(exchangeId, 'loyalty', async () => {
    const order = await prisma.order.findFirst({
      where: { id: p.newOrderId, venueId },
      select: { customer: { select: { id: true, firstName: true, lastName: true } } },
    })
    await awardLoyaltyForPaidOrder({
      venueId,
      orderId: p.newOrderId,
      orderTotal: p.loyaltyBasePesos,
      staffId: actorStaffId,
      legacyCustomer: order?.customer,
    })
  })
  await bestEffort(exchangeId, 'sockets', async () => {
    const broadcasting = socketManager.getBroadcastingService()
    if (!broadcasting) return
    broadcasting.broadcastToVenue(venueId, SocketEventType.ORDER_CREATED, {
      orderId: p.newOrderId,
      orderNumber: response.newOrderNumber,
      orderType: p.orderType,
      source: p.source,
      total: response.takenCents / 100,
    })
    for (const orderId of [p.originalOrderId, p.newOrderId])
      broadcasting.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, { orderId })
  })
  await bestEffort(exchangeId, 'response', async () => {
    outcome.response = await patchExchangePresentation(venueId, response, outcome.resultRevision)
  })
}

/** A slow receipt may patch presentation, never restore its old financial snapshot. */
async function patchExchangePresentation(venueId: string, response: ExchangeResponse, revision: number): Promise<ExchangeResponse> {
  if (response.status !== 'COMPLETED' || !response.paymentIds.length) return response
  const initial = await prisma.exchange.findFirstOrThrow({ where: { id: response.id, venueId } })
  if (!initial.result) throw new Error('EXCHANGE_RESULT_MISSING')
  let current = initial.result as unknown as ExchangeResponse
  let canReplacePresentation = initial.resultRevision === revision
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      current.status !== response.status ||
      current.chargePaymentId !== response.chargePaymentId ||
      operationHash({ ...current, receiptUrl: null, inventoryWarning: undefined }) !==
        operationHash({ ...response, receiptUrl: null, inventoryWarning: undefined })
    )
      return current
    const merged = {
      ...current,
      ...(response.receiptUrl && (canReplacePresentation || !current.receiptUrl) ? { receiptUrl: response.receiptUrl } : {}),
      ...(response.inventoryWarning && (canReplacePresentation || !current.inventoryWarning)
        ? { inventoryWarning: response.inventoryWarning }
        : {}),
    }
    if (
      merged.receiptUrl === current.receiptUrl &&
      operationHash(merged.inventoryWarning ?? null) === operationHash(current.inventoryWarning ?? null)
    )
      return current
    const written = await prisma.exchange.updateMany({
      where: { id: response.id, venueId, status: response.status, resultRevision: revision },
      data: { result: merged as unknown as Prisma.InputJsonValue, resultRevision: { increment: 1 } },
    })
    if (written.count === 1) return merged
    canReplacePresentation = false
    const row = await prisma.exchange.findFirstOrThrow({ where: { id: response.id, venueId } })
    if (!row.result) throw new Error('EXCHANGE_RESULT_MISSING')
    current = row.result as unknown as ExchangeResponse
    if (
      row.status !== response.status ||
      current.chargePaymentId !== response.chargePaymentId ||
      JSON.stringify(current.paymentIds) !== JSON.stringify(response.paymentIds) ||
      operationHash({ ...current, receiptUrl: null, inventoryWarning: undefined }) !==
        operationHash({ ...response, receiptUrl: null, inventoryWarning: undefined })
    )
      return current
    revision = row.resultRevision
  }
  return current
}

export async function settleExchangeCharge(input: { venueId: string; exchangeId: string; actorStaffId: string | null }): Promise<{
  exchange: ExchangeResponse
  outcome: 'SETTLED' | 'REVIEW' | 'FINAL' | 'NOT_CHARGED' | 'UNRESOLVED'
  requestId?: string | null
}> {
  const result = await executeExchangeInTransaction({ mode: 'SETTLE_CARD_CHARGE', ...input })
  if ('unsettled' in result)
    return {
      exchange: result.unsettled,
      outcome: result.evidence === null ? 'FINAL' : result.evidence.kind === 'NOT_CHARGED' ? 'NOT_CHARGED' : 'UNRESOLVED',
      requestId: result.evidence?.kind === 'UNRESOLVED' ? result.evidence.requestId : null,
    }
  if ('review' in result) {
    await bestEffort(result.review.id, 'reviewInventory', async () => {
      if (result.salePostingId) {
        const author = await prisma.exchange.findFirstOrThrow({
          where: { id: input.exchangeId, venueId: input.venueId },
          select: { staffId: true },
        })
        await applySalePosting(result.salePostingId, author.staffId)
      }
    })
    if (result.review.reviewReason === 'LATE_CHARGE_AFTER_RELEASE')
      logger.error('🚨 [Exchange] Cobro tardío sobre un cambio ya liberado', {
        exchangeId: result.review.id,
        chargePaymentId: result.review.chargePaymentId,
      })
    return { exchange: result.review, outcome: 'REVIEW' }
  }
  if (!('postCommit' in result)) throw new Error('EXCHANGE_SETTLE_OUTCOME_INVALID')
  const author = await prisma.exchange.findFirstOrThrow({
    where: { id: input.exchangeId, venueId: input.venueId },
    select: { staffId: true },
  })
  await runExchangePostCommit(result, { venueId: input.venueId, actorStaffId: author.staffId })
  return { exchange: result.response, outcome: 'SETTLED' }
}

export async function completeExchange(input: { venueId: string; exchangeId: string; actorStaffId: string }): Promise<ExchangeResponse> {
  const result = await settleExchangeCharge(input)
  if (result.outcome === 'NOT_CHARGED')
    throw new ExchangeError(
      'EXCHANGE_NOT_CHARGED',
      'No consta ningún cobro de la diferencia. Puedes volver a cobrar o cancelar el cambio.',
      409,
    )
  if (result.outcome === 'UNRESOLVED')
    throw new ExchangeError(
      'EXCHANGE_CHARGE_UNRESOLVED',
      'Todavía no consta si la terminal cobró la diferencia. Espera a que conste antes de cancelar o volver a cobrar.',
      409,
      { requestId: result.requestId ?? null },
    )
  return result.exchange
}

export async function cancelExchange(input: {
  venueId: string
  exchangeId: string
  actorStaffId: string | null
  origin: 'POS' | 'SWEEP'
  reason?: string
}): Promise<ExchangeResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await prisma.$transaction(async tx => {
        const initial = await tx.exchange.findFirst({ where: { id: input.exchangeId, venueId: input.venueId } })
        if (!initial) throw new NotFoundError('No se encontró el cambio en esta sucursal.')
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange:v1:' + input.venueId + ':' + initial.idempotencyKey}, 0))::text`
        const exchange = await tx.exchange.findFirstOrThrow({ where: { id: input.exchangeId, venueId: input.venueId } })
        if (!exchange.result) throw new Error('EXCHANGE_RESULT_MISSING')
        if (exchange.status === 'CANCELLED') return { exchange: exchange.result as unknown as ExchangeResponse }
        if (exchange.status !== 'PENDING_PAYMENT' || exchange.settlementKind !== 'COLLECT' || exchange.settlementMethod !== 'CARD_TERMINAL')
          throw new ExchangeError('EXCHANGE_ALREADY_SETTLED', 'Este cambio ya se cerró; no se puede cancelar.', 409)
        const order = await tx.order.findFirstOrThrow({
          where: { id: exchange.newOrderId, venueId: input.venueId },
          select: { status: true },
        })
        if (order.status === 'CANCELLED' || order.status === 'DELETED') {
          await lockExistingOrderForPayment(tx, { venueId: input.venueId, orderId: exchange.newOrderId })
          return { exchange: await releaseExchangeInTx(tx, input) }
        }
        let released!: ExchangeResponse
        const cancelledOrder = await cancelOrderInTransaction(
          tx,
          input.venueId,
          exchange.newOrderId,
          'Cambio cancelado: no se cobró la diferencia',
          input.actorStaffId ?? undefined,
          async locked => {
            released = await releaseExchangeInTx(locked, input)
          },
        )
        return { exchange: released, cancelledOrder }
      }, ORDER_LOCK_WAIT_BUDGET)
      if (result.cancelledOrder)
        await bestEffort(input.exchangeId, 'cancelledOrder', () =>
          publishCancelledOrder(input.venueId, result.cancelledOrder!, input.actorStaffId ?? undefined, input.reason),
        )
      return result.exchange
    } catch (error) {
      if (error instanceof ExchangeReleaseNotDue) return error.exchange
      if (
        error instanceof ExchangeGenerationChanged ||
        error instanceof OrderTableTopologyChanged ||
        (error as { code?: string }).code === 'ORDER_LOCK_SCOPE_CHANGED'
      ) {
        if (attempt < 2) continue
        throw new ExchangeError('EXCHANGE_RETRY_CONFLICT', 'El cambio se movió mientras lo cerrábamos. Intenta de nuevo.', 409)
      }
      // Only the two money refusals of assertOrderCancellableUnderLock are translated; other business errors keep their type.
      const moneyGuard =
        error instanceof BadRequestError &&
        !error.code &&
        ['Cannot cancel a paid order', 'Esta cuenta ya tiene pagos registrados. Reembólsalos antes de cancelarla.'].includes(error.message)
      const code = (error as { code?: string }).code
      if (code === 'EXCHANGE_CHARGE_EXISTS' || code === 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE' || moneyGuard) {
        // The cancellation transaction has rolled back before this opener takes original/root Orders.
        const settled = await settleExchangeCharge(input)
        if (settled.outcome === 'UNRESOLVED')
          throw new ExchangeError(
            'EXCHANGE_CHARGE_UNRESOLVED',
            'Todavía no consta si la terminal cobró la diferencia. Espera a que conste antes de cancelar o volver a cobrar.',
            409,
            { requestId: settled.requestId ?? null },
          )
        if (settled.outcome === 'NOT_CHARGED') throw error
        if (settled.outcome === 'FINAL' && settled.exchange.status === 'CANCELLED') return settled.exchange
        throw new ExchangeError(
          'EXCHANGE_CHARGE_EXISTS',
          'La terminal sí cobró la diferencia, así que el cambio ya no se puede cancelar. Revisa cómo quedó.',
          409,
          { exchange: settled.exchange },
        )
      }
      throw error
    }
  }
}

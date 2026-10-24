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
import { NotFoundError } from '@/errors/AppError'
import { operationHash } from '@/utils/operationHash'
import { validateStaffVenue } from '@/utils/staff-venue.util'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'
import { executeExchangeInTransaction } from '../mobile/order.mobile.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { generateAndStoreReceipt } from '../dashboard/receipt.dashboard.service'
import { logAction } from '../dashboard/activity-log.service'
import { applySalePosting, applyCustomerReturnPosting } from '../inventory/inventoryPosting.service'
import { buildInventoryWarning, mapDigitalReceiptResponse } from '../tpv/payment.tpv.service'
import { awardLoyaltyForPaidOrder } from '../shared/loyaltyOnPaidOrder'
import { postCashSaleToDrawer, postCashRefundToDrawer } from '../shared/cashDrawerPosting'
import { effectiveExchangesEnabled } from './exchangeRules'
import { ensureExchangeCreditTender } from './exchangeCreditTender'
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
    return { exchange: response, replay: true }
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
  await ensureExchangeCreditTender(prisma, venueId)
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
    return { exchange: outcome.replay, replay: true }
  }
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

async function exchangeReceipt(venueId: string, response: ExchangeResponse) {
  await bestEffort(response.id, 'receipt', async () => {
    const paymentId = response.paymentIds[response.paymentIds.length - 1]
    // El candado y toda la consulta/creación usan la misma conexión; el dinero ya está confirmado.
    const receipt = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange-receipt:v1:' + paymentId}, 0))::text`
      return generateAndStoreReceipt(venueId, paymentId, undefined, tx)
    })
    response.receiptUrl = mapDigitalReceiptResponse(receipt)?.receiptUrl ?? null
  })
}

async function runExchangePostCommit(
  outcome: ExchangeTxOutcome,
  input: { venueId: string; actorStaffId: string; body: CreateExchangeBody },
) {
  const { exchangeId, response, postCommit: p } = outcome
  const { venueId, actorStaffId, body } = input
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
  await exchangeReceipt(venueId, response)
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
  await bestEffort(exchangeId, 'audit', async () => {
    void logAction({
      action: 'EXCHANGE_CREATED',
      entity: 'Exchange',
      entityId: exchangeId,
      staffId: actorStaffId,
      venueId,
      data: {
        originalOrderNumber: response.originalOrderNumber,
        newOrderNumber: response.newOrderNumber,
        returnedAmount: response.returnedCents / 100,
        takenAmount: response.takenCents / 100,
        differenceAmount: response.differenceCents / 100,
        settlement: { kind: response.settlement.kind, method: response.settlement.method, amount: response.settlement.amountCents / 100 },
        reasons: body.returned.map(r => ({ orderItemId: r.orderItemId, reason: r.reason, quantity: r.quantity, restock: r.restock })),
        deviceId: body.deviceId,
        isOfflineReplay: false,
      },
    })
  })
  await bestEffort(exchangeId, 'response', async () => {
    await prisma.exchange.update({ where: { id: exchangeId, venueId }, data: { result: response as unknown as Prisma.InputJsonValue } })
  })
}

import { OrderSource, OrderType, Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, ConflictError } from '@/errors/AppError'
import { exchangeAccountingAt } from './exchangeAccountingAt'
import { prepareCardSettlementInTx, exchangeSalePostingInTx, ExchangeGenerationChanged, type ExchangeSettleTxInput } from './exchangeSettle'
import type { ExchangeChargeEvidence } from './exchangeCharge'
import type { Payment, ExchangeStatus } from '@prisma/client'
import { TOPES_POR_ORDEN } from '../fiscal/librosDeOrdenes'
import { computeOrderBalance } from '../shared/orderBalance'
import { lockExistingOrderForPayment, MAX_ORDER_LOCK_SCOPE } from '../shared/paymentShiftClaim'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { keptMarkdownDiscountRow } from '../shared/discount.service'
import { sincronizarRepartos } from '../shared/repartoDescuentoTx'
import { assertRefundableLines, assertPromotionLineFullQuantity, bloquearCobroParaReembolso } from '../dashboard/refund.dashboard.service'
import type { RefundMoneySemantics } from '../dashboard/refund.dashboard.service'
import { writeRefundInTx } from '../shared/writeRefundInTx'
import { createCustomerReturnPostingInTx } from '../inventory/inventoryPosting.service'
import type { AbonoEnTx, AbonoEnTxContexto, AbonoEnTxEntrada } from '../mobile/order.mobile.service'
import type { TenderSemanticsPayment } from '../shared/tenderSemantics'
import { paymentCountsAsDrawerCash } from '../shared/tenderSemantics'
import { isGiftCardTenderKind } from '../giftCards/giftCardTender'
import { bloquearSobresDelReembolsoEnTx, alRegistrarReembolsoEnTx } from '../giftCards/giftCardCancel.service'
import { enqueueRefundPaymentEffectsInTx } from '../tpv/paymentEffects.service'
import { loadSaleForExchange, MAX_EXCHANGE_SALE_PAYMENTS } from './exchangeSale'
import { resolveChainRefund, type ChainRefundResolution } from './exchangeChainRefund'
import { calculateExchange, pieceValuesCents, splitItemsAcrossRefundRows, type ReturnedPiece } from './exchangeCalculator'
import {
  allocateAcrossPayments,
  effectiveExchangeCapacity,
  lineBlockReason,
  modesForExchangeCreditRoot,
  payoutModesFor,
  saleBlockReason,
  type AllocationSlice,
} from './exchangeRules'
import { EXCHANGE_REFUND_ROLE } from './exchangeMarks'
import { ensureExchangeCreditTender, resolveExchangeCreditTenderInTx } from './exchangeCreditTender'
import { ExchangeError, itemNotReturnable as notReturnable } from './exchangeErrors'
import { isExchangeCreditTenderKind, NON_MERCHANDISE_PRODUCT_TYPES } from './exchangePredicates'
import { resolverPreciosDeLineas } from '../mobile/precioQueVioElCliente'
import type { ExchangeResponse, ExchangeReturnedLine, ExchangeTakenLine, ExchangeTxInput, SaleForExchange } from './exchange.service'

export type { ChainRefundResolution } from './exchangeChainRefund'

export interface PreparedExchange {
  input: ExchangeTxInput
  accountingAt: Date
  actorStaffId: string | null
  expectedStatus: ExchangeStatus
  resultRevision: number
  existingCharge: Payment | null
  finalStatus: 'COMPLETED'
  exchangeId: string
  sale: SaleForExchange
  newOrder: { id: string; orderNumber: string; createdAt: Date }
  lines: ExchangeResponse['lines']
  returnedCents: number
  takenCents: number
  differenceCents: number
  refundRows: Array<{
    id: string
    paymentId: string
    role: AllocationSlice['role']
    cents: number
    rootPaymentId: string
    money: TenderSemanticsPayment & { method: string }
    sessionId: string | null
  }>
  newSalePayments: Array<{
    ctx: AbonoEnTxContexto
    entrada: AbonoEnTxEntrada
    role: 'CREDIT' | 'DIFFERENCE'
    slice?: AllocationSlice
    rootPaymentId?: string
  }>
  returnLines: Array<{
    orderItemId: string
    productId: string
    quantity: number
    eligibility: { inventoryMethod: 'QUANTITY'; eligible: true }
  }>
}
export interface ExchangeTxOutcome {
  exchangeId: string
  resultRevision: number
  response: ExchangeResponse
  postCommit: {
    salePostingId: string | null
    returnPostingId: string | null
    cashSale: { paymentId: string; sessionId: string | null; amountPesos: number; money: TenderSemanticsPayment } | null
    cashPayouts: Array<{ refundPaymentId: string; sessionId: string | null; amountPesos: number; money: TenderSemanticsPayment }>
    receiptPaymentId: string
    newOrderId: string
    originalOrderId: string
    loyaltyBasePesos: number
    orderType: string
    source: string
  }
}
export type ExchangeTxEarly =
  | { replay: ExchangeResponse; resultRevision: number }
  | { reserved: ExchangeResponse }
  | { review: ExchangeResponse; salePostingId: string | null }
  | { unsettled: ExchangeResponse; evidence: ExchangeChargeEvidence | null }

const pesos = (c: number) => new Prisma.Decimal(c).div(100)

/** Sólo lee: el reembolso ya bloqueó el crédito; la vista previa y el detalle reutilizan la misma regla sin candados. */
export async function chainRefundSemanticsInTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  creditPaymentId: string,
): Promise<ChainRefundResolution> {
  const link = await tx.exchangeCreditLink.findFirst({ where: { venueId, creditPaymentId } })
  const root = link
    ? await tx.payment.findFirst({
        where: { venueId, id: link.originPaymentId },
        include: { tenderType: { select: { systemKind: true } } },
      })
    : null
  return resolveChainRefund(link, root)
}

/** La llave decide antes que el estado vigente de la venta: repetir algo ya hecho nunca devuelve dos piezas. */
export async function prepareExchangeInTx(
  tx: Prisma.TransactionClient,
  input: ExchangeTxInput | ExchangeSettleTxInput,
): Promise<PreparedExchange | ExchangeTxEarly> {
  if ('mode' in input) return prepareCardSettlementInTx(tx, input)
  const { venueId, body, actorStaffId, originalOrderId } = input
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange:v1:' + venueId + ':' + body.idempotencyKey}, 0))::text`
  const existing = await tx.exchange.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: body.idempotencyKey } } })
  if (existing) {
    if (existing.requestHash !== input.requestHash)
      throw new ExchangeError('IDEMPOTENCY_KEY_REUSED', 'Esta llave ya se usó para otro cambio.', 409)
    if (!existing.result) throw new Error('EXCHANGE_RESULT_MISSING')
    return { replay: existing.result as unknown as ExchangeResponse, resultRevision: existing.resultRevision }
  }
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: originalOrderId }))) throw new NotFoundError('No se encontró la venta.')
  const accountingAt = await exchangeAccountingAt(tx, venueId, [originalOrderId])
  const sale = await loadSaleForExchange(tx, venueId, originalOrderId)
  if (!sale.payments.some(p => p.id === body.originalPaymentId)) notReturnable('NOT_PAID')
  if (!sale.charged.atribuible) notReturnable('NOT_ATTRIBUTABLE')
  const saleReason = saleBlockReason({ ...sale.order, paymentSources: sale.payments.map(p => p.money.source ?? '') })
  if (saleReason) notReturnable(saleReason)
  if (!body.returned.length || !body.taken.length) throw new BadRequestError('Selecciona lo que regresa y lo que se lleva.')
  const byId = new Map(sale.lines.map(l => [l.id, l]))
  const used = new Map<string, { quantity: number; cents: number }>()
  const returned: ExchangeReturnedLine[] = []
  const pieces: ReturnedPiece[] = []
  for (const r of body.returned) {
    const l = byId.get(r.orderItemId)
    if (!l) notReturnable('NOT_MERCHANDISE', r.orderItemId)
    const line = l!
    const prior = sale.returnedByLine.get(line.id)
    const soFar = used.get(line.id) ?? { quantity: 0, cents: 0 }
    const left = line.quantity - (prior?.quantity ?? 0) - soFar.quantity
    const reason = lineBlockReason({
      productId: line.productId,
      productType: line.product?.type ?? null,
      giftCardId: line.giftCardId,
      soldByWeight: line.product?.soldByWeight ?? false,
      remainingQtyOrder: left,
      serialized: line.serialized,
    })
    if (reason) notReturnable(reason, line.id, left)
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 1 || r.quantity > left) notReturnable('ALREADY_RETURNED', line.id, left)
    const values = pieceValuesCents(
      sale.charged.cobradoCents.get(line.id)!,
      line.quantity,
      (prior?.quantity ?? 0) + soFar.quantity,
      (prior?.amountCents ?? 0) + soFar.cents,
      r.quantity,
    )
    const valueCents = values.reduce((sum, c) => sum + c, 0)
    used.set(line.id, { quantity: soFar.quantity + r.quantity, cents: soFar.cents + valueCents })
    returned.push({ ...r, productId: line.productId, productName: line.productName, pieceValuesCents: values, valueCents })
    for (const paidCents of values)
      pieces.push({
        orderItemId: line.id,
        productId: line.productId,
        productGroupId: line.product?.productGroupId ?? null,
        paidCents,
        listCents: line.product && !line.product.deletedAt ? line.product.priceCents : null,
      })
  }
  let promotionItemId: string | null = null
  try {
    assertRefundableLines(sale.charged.renglones, [...used.keys()])
    for (const [id, selection] of used) {
      promotionItemId = id
      assertPromotionLineFullQuantity(byId.get(id)!, selection.quantity)
    }
  } catch (error) {
    if (!(error instanceof BadRequestError)) throw error
    notReturnable('PROMOTION_PARTIAL', promotionItemId)
  }
  const ids = [...new Set(body.taken.map(l => l.productId))]
  // Si vuelve a llevarse el mismo producto, usa la misma lista/familia que decidió su rebaja.
  const missingIds = ids.filter(id => !sale.catalogProducts.has(id))
  const products = missingIds.length
    ? await tx.product.findMany({ take: missingIds.length, where: { venueId, id: { in: missingIds } } })
    : []
  const productById = new Map([...sale.catalogProducts, ...products.map(p => [p.id, p] as const)])
  const taken = body.taken.map(l => {
    const p = productById.get(l.productId)
    const reason = !p
      ? 'NOT_FOUND'
      : p.deletedAt
        ? 'ARCHIVED'
        : !p.active
          ? 'INACTIVE'
          : NON_MERCHANDISE_PRODUCT_TYPES.has(p.type)
            ? 'NOT_MERCHANDISE'
            : p.soldByWeight
              ? 'SOLD_BY_WEIGHT'
              : null
    if (reason)
      throw new ExchangeError(
        'EXCHANGE_TAKEN_NOT_SELLABLE',
        'Este producto no se puede vender ahora (archivado, apagado o no es mercancía).',
        422,
        {
          productId: l.productId,
          reason,
        },
      )
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new BadRequestError('La cantidad debe ser un entero mayor que cero.')
    const product = p!
    return {
      productId: product.id,
      productGroupId: product.productGroupId,
      listCents: product.price.mul(100).toNumber(),
      quantity: l.quantity,
      inheritsFromOrderItemId: l.inheritsFromOrderItemId ?? null,
    }
  })
  const pairing = calculateExchange(pieces, taken)
  const unpairedLines = new Set(pairing.takenPieces.filter(p => p.inheritedFrom === null).map(p => p.lineIndex))
  const prices = await resolverPreciosDeLineas(
    venueId,
    taken.map((l, i) => ({
      productId: l.productId,
      actualCents: l.listCents,
      displayedUnitPrice: unpairedLines.has(i) ? body.taken[i].displayedUnitPriceCents : undefined,
      catalogAt: body.taken[i].catalogAt,
    })),
    new Date(),
    tx,
  )
  const calc = calculateExchange(
    pieces,
    taken.map((l, i) => ({ ...l, unitPriceCents: prices[i].unitPriceCents })),
  )
  const takenLines: ExchangeTakenLine[] = taken.map((l, i) => {
    const prices = calc.takenPieces.filter(p => p.lineIndex === i)
    return {
      productId: l.productId,
      productName: productById.get(l.productId)!.name,
      quantity: l.quantity,
      listCents: l.listCents,
      priceCents: prices.reduce((sum, p) => sum + p.priceCents, 0),
      pieces: prices.map(p => ({ priceCents: p.priceCents, inheritedFromOrderItemId: p.inheritedFrom?.orderItemId ?? null })),
      newOrderItemIds: [],
    }
  })
  if (calc.differenceCents !== body.settlement.expectedDifferenceCents)
    throw new ExchangeError(
      'EXCHANGE_DIFFERENCE_CHANGED',
      'La diferencia cambió desde que abriste el cambio (cambió un precio). Revisa el nuevo total antes de continuar.',
      409,
      {
        calculation: {
          returnedCents: calc.returnedCents,
          takenCents: calc.takenCents,
          differenceCents: calc.differenceCents,
          kind: calc.kind,
          lines: { returned, taken: takenLines },
        },
      },
    )
  const { settlement } = body
  if (settlement.kind !== calc.kind || (calc.kind === 'EVEN' ? settlement.method !== null : settlement.method === null))
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'El medio elegido no corresponde a la diferencia del cambio.', 422)
  const reserveCard = calc.kind === 'COLLECT' && settlement.method === 'CARD_TERMINAL'
  if (settlement.method === 'CARD_TERMINAL' && body.isOfflineReplay)
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'Cobrar o devolver con tarjeta necesita conexión.', 422, {
      reason: 'CARD_NEEDS_CONNECTION',
    })
  if (settlement.method === 'CARD_TERMINAL' && !reserveCard)
    throw new ExchangeError(
      'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      'Cobrar o devolver con tarjeta en un cambio todavía no está disponible.',
      422,
      {
        reason: 'CARD_TERMINAL_NOT_ENABLED',
      },
    )
  if (calc.kind === 'COLLECT' && settlement.method === 'GIFT_CARD_BALANCE')
    throw new ExchangeError(
      'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      'Cobrar la diferencia con saldo de tarjeta de regalo todavía no está disponible.',
      422,
      {
        reason: 'GIFT_CARD_COLLECT_NOT_AVAILABLE',
      },
    )
  if (settlement.method === 'TENDER' && (calc.kind !== 'COLLECT' || !settlement.tenderTypeId || settlement.tenderRevision == null))
    throw new BadRequestError('Selecciona un tipo de pago vigente para cobrar la diferencia.')
  const orderedPayments = [...sale.payments].sort(
    (a, b) =>
      Number(b.id === body.originalPaymentId) - Number(a.id === body.originalPaymentId) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  )
  // Una raíz con procesador tampoco presta capacidad de PAYOUT aunque su método diga efectivo.
  const chains = new Map<string, ChainRefundResolution>()
  const capacities = []
  for (const p of orderedPayments) {
    const loaded = sale.chainByPaymentId.get(p.id)
    const chain = isExchangeCreditTenderKind(p.money.tenderSystemKind) ? resolveChainRefund(loaded?.link, loaded?.root) : null
    if (chain) chains.set(p.id, chain)
    capacities.push({
      paymentId: p.id,
      saleRemainingCents: effectiveExchangeCapacity(p),
      modes: chain ? (chain.kind === 'INHERIT' ? modesForExchangeCreditRoot(p.rootMoney) : {}) : payoutModesFor(p.money),
    })
  }
  const payoutMethod = settlement.method
  if (calc.kind === 'PAYOUT' && payoutMethod !== 'CASH' && payoutMethod !== 'BANK_TRANSFER' && payoutMethod !== 'GIFT_CARD_BALANCE')
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'Selecciona un medio disponible para devolver la diferencia.', 422)
  const allocation = allocateAcrossPayments(
    capacities,
    Math.min(calc.returnedCents, calc.takenCents),
    calc.kind === 'PAYOUT'
      ? { method: payoutMethod as 'CASH' | 'BANK_TRANSFER' | 'GIFT_CARD_BALANCE', cents: -calc.differenceCents }
      : null,
  )
  if (!allocation.ok) {
    if (allocation.reason === 'NOTHING_LEFT_TO_REFUND') notReturnable(allocation.reason)
    const max = allocation.payoutOptions.find(o => o.method === settlement.method)?.maxCents ?? 0
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', `Por este medio sólo se pueden devolver $${pesos(max).toFixed(2)}.`, 422, {
      reason: 'INSUFFICIENT_FOR_METHOD',
      payoutOptions: allocation.payoutOptions,
    })
  }
  if (allocation.needsRefundToCash && !settlement.cashFromNonCash)
    throw new ExchangeError(
      'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      'Devolver en efectivo lo que se pagó con otro medio necesita autorización.',
      422,
      {
        reason: 'NEEDS_REFUND_TO_CASH',
      },
    )
  const slices: AllocationSlice[] = allocation.slices
  if (calc.returnedCents === 0) slices.push({ paymentId: body.originalPaymentId, cents: 0, role: 'CREDIT', mode: null })
  const paymentById = new Map(sale.payments.map(p => [p.id, p]))
  const credits = slices.filter(s => s.role === 'CREDIT' && s.cents > 0)
  const paymentCount = credits.length + Number(calc.kind === 'COLLECT') + Number(calc.takenCents === 0)
  const resultTooLarge = () =>
    new ConflictError(
      'El cambio generaría una venta con demasiados cobros o ventas enlazadas para poder devolverla con seguridad. Haz un cambio más pequeño.',
      'EXCHANGE_RESULT_TOO_LARGE',
    )
  if (paymentCount > MAX_EXCHANGE_SALE_PAYMENTS) throw resultTooLarge()
  const roots = [...new Set(credits.map(s => paymentById.get(s.paymentId)!.rootPaymentId))]
  if (roots.length || reserveCard) {
    // El crédito apunta a las raíces, no necesariamente al origen. Incluye SU ascendencia (incluso créditos ya devueltos).
    const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
      WITH RECURSIVE ancestors(id) AS (
        SELECT "orderId" FROM "Payment" WHERE "venueId"=${venueId} AND id=ANY(${roots}::text[]) AND "orderId" IS NOT NULL
        UNION SELECT id FROM "Order" WHERE ${reserveCard} AND id=${originalOrderId} AND "venueId"=${venueId}
        UNION
        SELECT parent.id FROM ancestors child
        JOIN "Payment" credit ON credit."orderId"=child.id AND credit."venueId"=${venueId}
        JOIN "ExchangeCreditLink" link ON link."creditPaymentId"=credit.id AND link."venueId"=credit."venueId"
        JOIN "Payment" root ON root.id=link."originPaymentId" AND root."venueId"=credit."venueId"
        JOIN "Order" parent ON parent.id=root."orderId" AND parent."venueId"=credit."venueId"
      ), scope AS MATERIALIZED (SELECT id FROM ancestors LIMIT ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE))})
      SELECT COUNT(*)::int AS n FROM scope`
    // La venta nueva es una Order adicional. Leer sólo MAX alcanza para rechazar, nunca para truncar y aceptar.
    if (n + 1 > MAX_ORDER_LOCK_SCOPE) throw resultTooLarge()
  }
  // Se crea sólo tras validar topes y en ESTA transacción: no se suelta el cerco Venue/Orders ni se deja configuración al rechazar.
  await ensureExchangeCreditTender(tx, venueId, true)
  const ec = await resolveExchangeCreditTenderInTx(tx, venueId)
  // Las órdenes y TODAS sus raíces ya están tomadas por fecha; aquí el id sólo ordena Payments, nunca Orders.
  const lockIds = [...new Set(slices.flatMap(s => [s.paymentId, paymentById.get(s.paymentId)!.rootPaymentId]))].sort()
  for (const id of lockIds) {
    const p = await tx.payment.findFirst({ where: { venueId, id }, select: { orderId: true } })
    const locked = await bloquearCobroParaReembolso(tx, { venueId, paymentId: id, expectedOrderId: p?.orderId ?? null })
    const portion = slices.filter(s => s.paymentId === id).reduce((sum, s) => sum + s.cents, 0)
    if (
      slices.some(s => s.paymentId === id) &&
      (locked.unclassifiedPriorRefundCents > 0 ||
        portion >
          effectiveExchangeCapacity({
            amountCents: new Prisma.Decimal(String(locked.original.amount ?? 0)).mul(100).toDecimalPlaces(0).toNumber(),
            tipCents: new Prisma.Decimal(String(locked.original.tipAmount ?? 0)).mul(100).toDecimalPlaces(0).toNumber(),
            processorData: locked.original.processorData,
            refunds: locked.existingRefunds,
          }))
    )
      notReturnable('NOT_ATTRIBUTABLE')
  }
  // Todos los sobres se toman antes del primer reclamo de turno (también si otro cobro aporta crédito).
  const giftPayoutIds = slices
    .filter(s => s.role === 'PAYOUT' && isGiftCardTenderKind(paymentById.get(s.paymentId)!.money.tenderSystemKind))
    .map(s => s.paymentId)
  if (giftPayoutIds.length > 0)
    await bloquearSobresDelReembolsoEnTx(tx, {
      venueId,
      originalPaymentId: giftPayoutIds,
      original: {
        orderId: originalOrderId,
        tenderSystemKind: 'GIFT_CARD',
      },
    })
  const payoutCash = calc.kind === 'PAYOUT' && settlement.method === 'CASH'
  const drawer = payoutCash ? await tx.cashDrawerSession.findFirst({ where: { venueId, status: 'OPEN' }, select: { id: true } }) : null
  if (payoutCash && settlement.cashDrawerSessionId && drawer?.id !== settlement.cashDrawerSessionId)
    throw new ExchangeError(
      'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      'La caja del cambio ya no está abierta. Revisa la caja antes de continuar.',
      422,
    )
  const newOrder = await createExchangeSaleInTx(tx, input, sale, takenLines, accountingAt)
  const lines = { returned, taken: takenLines }
  const returnLines = [...used].flatMap(([orderItemId]) => {
    const l = byId.get(orderItemId)!
    const quantity = returned.filter(r => r.orderItemId === orderItemId && r.restock).reduce((sum, r) => sum + r.quantity, 0)
    return quantity > 0 && l.productId && l.product?.trackInventory && l.product.inventoryMethod === 'QUANTITY' && l.product.hasInventoryRow
      ? [{ orderItemId, productId: l.productId, quantity, eligibility: { inventoryMethod: 'QUANTITY' as const, eligible: true as const } }]
      : []
  })
  const exchange = await tx.exchange.create({
    data: {
      venueId,
      idempotencyKey: body.idempotencyKey,
      requestHash: input.requestHash,
      status: reserveCard ? 'PENDING_PAYMENT' : 'COMPLETED',
      originalOrderId,
      originalPaymentId: body.originalPaymentId,
      newOrderId: newOrder.id,
      returnedAmount: pesos(calc.returnedCents),
      takenAmount: pesos(calc.takenCents),
      differenceAmount: pesos(calc.differenceCents),
      settlementKind: calc.kind,
      settlementMethod: settlement.method,
      cashDrawerSessionId: drawer?.id ?? null,
      lines: { ...lines, returnLines } as unknown as Prisma.InputJsonValue,
      staffId: actorStaffId,
      deviceId: body.deviceId,
      createdAtLocal: new Date(body.createdAtLocal),
      createdAt: accountingAt,
      isOfflineReplay: false,
    },
  })
  const prepared: Omit<PreparedExchange, 'refundRows' | 'newSalePayments'> = {
    input,
    exchangeId: exchange.id,
    sale,
    newOrder,
    lines,
    returnLines,
    returnedCents: calc.returnedCents,
    takenCents: calc.takenCents,
    differenceCents: calc.differenceCents,
    accountingAt,
    actorStaffId,
    expectedStatus: exchange.status,
    resultRevision: exchange.resultRevision,
    existingCharge: null,
    finalStatus: 'COMPLETED',
  }
  if (reserveCard) {
    const response: ExchangeResponse = {
      id: exchange.id,
      status: 'PENDING_PAYMENT',
      originalOrderId,
      originalOrderNumber: sale.order.orderNumber,
      newOrderId: newOrder.id,
      newOrderNumber: newOrder.orderNumber,
      returnedCents: calc.returnedCents,
      takenCents: calc.takenCents,
      differenceCents: calc.differenceCents,
      amountToChargeCents: calc.differenceCents,
      chargePaymentId: null,
      settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', amountCents: calc.differenceCents, sources: [] },
      lines,
      refundPaymentIds: [],
      paymentIds: [],
      pendingCardRefundCents: 0,
      receiptUrl: null,
    }
    await tx.exchange.update({ where: { id: exchange.id, venueId }, data: { result: response as unknown as Prisma.InputJsonValue } })
    await tx.activityLog.create({
      data: {
        venueId,
        entity: 'Exchange',
        entityId: exchange.id,
        action: 'EXCHANGE_RESERVED',
        staffId: actorStaffId,
        createdAt: accountingAt,
        data: { originalOrderId, newOrderId: newOrder.id, differenceAmount: calc.differenceCents / 100 },
      },
    })
    return { reserved: response }
  }
  return prepareExchangeCreditsInTx(tx, prepared, slices, chains, ec, drawer?.id ?? null)
}

/** Shared CREDIT writers; all existing Orders/Payments were claimed before this function. */
export async function prepareExchangeCreditsInTx(
  tx: Prisma.TransactionClient,
  prepared: Omit<PreparedExchange, 'refundRows' | 'newSalePayments'>,
  slices: AllocationSlice[],
  chains: Map<string, ChainRefundResolution>,
  ec: Awaited<ReturnType<typeof resolveExchangeCreditTenderInTx>>,
  drawerId: string | null = null,
  snapshots = new Map<string, Awaited<ReturnType<typeof bloquearCobroParaReembolso>>>(),
): Promise<PreparedExchange> {
  const { input, sale, newOrder, accountingAt, exchangeId } = prepared
  const { venueId, actorStaffId, body, originalOrderId } = input
  const { settlement } = body
  const calc = prepared
  const paymentById = new Map(sale.payments.map(p => [p.id, p]))
  const pieces = prepared.lines.returned.flatMap(line =>
    line.pieceValuesCents.map(paidCents => ({ orderItemId: line.orderItemId, paidCents })),
  )
  const money: RefundMoneySemantics = { ...ec, merchantAccountId: null, source: 'OTHER' }
  const split = splitItemsAcrossRefundRows(
    pieces.map(p => ({ orderItemId: p.orderItemId, cents: p.paidCents })),
    slices.map((s, i) => ({ key: String(i), cents: s.cents })),
  )
  const refundRows: PreparedExchange['refundRows'] = []
  for (const [i, slice] of slices.entries()) {
    const rootPaymentId = paymentById.get(slice.paymentId)!.rootPaymentId
    const credit = slice.role === 'CREDIT'
    const chain = chains.get(slice.paymentId)
    const refund = await writeRefundInTx(tx, {
      venueId,
      originalPaymentId: slice.paymentId,
      salesRefundCents: slice.cents,
      tipRefundCents: 0,
      refundedItems: split.get(String(i))!,
      reason: 'RETURNED_GOODS',
      note: `Cambio ${newOrder.orderNumber}`,
      staffId: actorStaffId,
      tenderCommission: 'NONE',
      shift: 'CLAIM_LIVE',
      bloqueado: snapshots.get(slice.paymentId),
      createdAt: accountingAt,
      ...(credit
        ? { moneyAs: money, skipNegativeCostObligation: true }
        : chain?.kind === 'INHERIT'
          ? { moneyAs: chain.money }
          : { devolverCon: slice.mode === 'CHOSEN' ? (settlement.method as 'CASH' | 'BANK_TRANSFER') : undefined }),
      exchangeMark: {
        exchangeId,
        role: credit ? EXCHANGE_REFUND_ROLE.CREDIT : EXCHANGE_REFUND_ROLE.DIFFERENCE,
        rootPaymentId,
      },
    })
    if (!credit) {
      await enqueueRefundPaymentEffectsInTx(tx, refund.refundPaymentId, rootPaymentId)
      if (isGiftCardTenderKind(paymentById.get(slice.paymentId)!.money.tenderSystemKind))
        await alRegistrarReembolsoEnTx(tx, {
          venueId,
          originalPaymentId: slice.paymentId,
          refundPaymentId: refund.refundPaymentId,
          amount: pesos(slice.cents),
          staffId: actorStaffId,
          devuelveTodoElCobro:
            slice.cents === paymentById.get(slice.paymentId)!.amountCents - paymentById.get(slice.paymentId)!.saleRefundedCents,
          original: { orderId: originalOrderId, tenderSystemKind: 'GIFT_CARD' },
        })
    }
    // La fecha contable es única; el cuid desempata en el orden de las porciones, sin desplazarla.
    const row = await tx.payment.findUniqueOrThrow({ where: { id: refund.refundPaymentId, venueId } })
    refundRows.push({
      id: refund.refundPaymentId,
      paymentId: slice.paymentId,
      role: slice.role,
      cents: slice.cents,
      rootPaymentId,
      money: row,
      sessionId: drawerId,
    })
  }
  const ctx: AbonoEnTxContexto = {
    venueId,
    orderId: newOrder.id,
    effectiveStaffId: actorStaffId,
    marcarCocina: false,
    conSesionDeVales: false,
    rechazoDelPersonal: null,
  }
  const newSalePayments: PreparedExchange['newSalePayments'] = slices
    .filter(s => s.role === 'CREDIT' && s.cents > 0)
    .map(s => ({
      ctx,
      role: 'CREDIT',
      slice: s,
      rootPaymentId: paymentById.get(s.paymentId)!.rootPaymentId,
      entrada: {
        method: 'OTHER',
        amountCents: s.cents,
        tipCents: 0,
        tender: { resuelto: ec },
        canal: { turno: 'exchange', reapertura: 'exchange' },
        trasCandadoDeOrden: async (_tx, cuenta) => {
          if (pesos(s.cents).greaterThan(computeOrderBalance(cuenta.fresh, cuenta.previousPayments).remainingBalance))
            throw new Error('EXCHANGE_SALE_BALANCE_MISMATCH')
        },
      },
    }))
  if (body.settlement.kind === 'COLLECT' && !prepared.existingCharge)
    newSalePayments.push({
      ctx,
      role: 'DIFFERENCE',
      entrada: {
        method: settlement.method === 'TENDER' ? 'OTHER' : (settlement.method as 'CASH' | 'BANK_TRANSFER'),
        amountCents: calc.differenceCents,
        tipCents: 0,
        tender: settlement.method === 'TENDER' ? { ref: { id: settlement.tenderTypeId!, revision: settlement.tenderRevision! } } : null,
        canal: { turno: 'exchange', reapertura: 'exchange' },
      },
    })
  if (calc.takenCents === 0)
    newSalePayments.push({
      ctx,
      role: 'CREDIT',
      entrada: { method: 'CASH', amountCents: 0, tipCents: 0, tender: null, canal: { turno: 'exchange', reapertura: 'exchange' } },
    })
  for (const [i, payment] of newSalePayments.entries()) {
    payment.entrada.createdAt = accountingAt
    if (i < newSalePayments.length - 1) payment.entrada.cierreDiferido = true
  }
  return { ...prepared, refundRows, newSalePayments }
}

/** La venta es privada hasta el commit: no pasa por el constructor general ni vuelve a aplicar promociones. */
async function createExchangeSaleInTx(
  tx: Prisma.TransactionClient,
  input: ExchangeTxInput,
  sale: SaleForExchange,
  lines: ExchangeTakenLine[],
  accountingAt: Date,
) {
  const { venueId, body, actorStaffId } = input
  const items: Array<Prisma.OrderItemUncheckedCreateWithoutOrderInput> = []
  const owners: Array<Set<number>> = []
  const grouped = new Map<string, number>()
  for (const [i, line] of lines.entries()) {
    const append = (quantity: number, priceCents: number, inherited: boolean) => {
      const unit = inherited ? Math.max(line.listCents, priceCents) : priceCents
      const discount = (unit - priceCents) * quantity
      const key = `${line.productId}:${unit}:${priceCents}`
      const existing = grouped.get(key)
      if (existing !== undefined) {
        const item = items[existing]
        item.quantity += quantity
        item.discountAmount = (item.discountAmount as Prisma.Decimal).plus(pesos(discount))
        item.total = (item.total as Prisma.Decimal).plus(pesos(unit * quantity))
        owners[existing].add(i)
        return
      }
      grouped.set(key, items.length)
      items.push({
        productId: line.productId,
        productName: line.productName,
        quantity,
        unitPrice: pesos(unit),
        discountAmount: pesos(discount),
        total: pesos(unit * quantity),
        taxAmount: pesos(0),
        externalId: `exchange:${body.idempotencyKey}:${items.length}`,
      })
      owners.push(new Set([i]))
    }
    for (const piece of line.pieces.filter(p => p.inheritedFromOrderItemId !== null)) append(1, piece.priceCents, true)
    const unpaired = line.pieces.filter(p => p.inheritedFromOrderItemId === null)
    if (unpaired.length) append(unpaired.length, unpaired[0].priceCents, false)
  }
  if (
    items.length > TOPES_POR_ORDEN.renglones ||
    items.filter(i => (i.discountAmount as Prisma.Decimal).gt(0)).length > TOPES_POR_ORDEN.descuentos
  )
    throw new ConflictError(
      'El cambio genera demasiados renglones o rebajas para poder devolverlo por artículos y calcular sus reportes. Haz cambios más pequeños.',
      'EXCHANGE_SALE_TOO_LARGE',
    )
  const subtotal = items.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.unitPrice as Prisma.Decimal).mul(item.quantity)), pesos(0))
  const discountAmount = items.reduce((sum, item) => sum.plus(item.discountAmount as Prisma.Decimal), pesos(0))
  const returnedIds = new Set(body.returned.map(line => line.orderItemId))
  const productIds = [
    ...new Set([
      ...lines.map(line => line.productId),
      ...sale.lines.flatMap(line => (returnedIds.has(line.id) && line.productId ? [line.productId] : [])),
    ]),
  ]
  // Las FK de artículos también toman KEY SHARE: toda la unión antes de insertar evita un orden por renglón.
  await tx.$queryRaw`SELECT id FROM "Product" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(productIds)}) ORDER BY id FOR KEY SHARE`
  const shift = await turnoAbiertoDelNegocio(tx, venueId)
  const order = await tx.order.create({
    data: {
      venueId,
      createdAt: accountingAt,
      orderNumber: `ORD-${Date.now()}`,
      externalId: `exchange:${body.idempotencyKey}`,
      shiftId: shift?.id ?? null,
      servedById: sale.order.servedById,
      createdById: sale.order.createdById,
      customerId: sale.order.customerId,
      type: sale.order.type as OrderType,
      source: sale.order.source as OrderSource,
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      kitchenStatus: 'SERVED',
      contratoDePrecio: 'IVA_INCLUIDO',
      taxAmount: pesos(0),
      subtotal,
      discountAmount,
      total: subtotal.minus(discountAmount),
      remainingBalance: subtotal.minus(discountAmount),
      orderCustomers: sale.order.primaryCustomerId ? { create: { customerId: sale.order.primaryCustomerId, isPrimary: true } } : undefined,
      items: { create: items },
    },
    include: { items: { orderBy: { externalId: 'asc' }, take: items.length } },
  })
  const staffVenue = await tx.staffVenue.findFirst({ where: { venueId, staffId: actorStaffId }, select: { id: true } })
  // El sufijo numérico relaciona las piezas incluso cuando el orden lexicográfico es 0, 1, 10, 11, 2.
  for (const item of order.items) {
    const index = Number(item.externalId!.slice(item.externalId!.lastIndexOf(':') + 1))
    for (const owner of owners[index]) lines[owner].newOrderItemIds.push(item.id)
    if (item.discountAmount.greaterThan(0))
      await tx.orderDiscount.create({
        data: keptMarkdownDiscountRow({
          orderId: order.id,
          itemId: item.id,
          discountAmountPesos: item.discountAmount.toNumber(),
          appliedById: staffVenue?.id ?? null,
        }),
      })
  }
  await sincronizarRepartos(tx, order.id)
  return { id: order.id, orderNumber: order.orderNumber, createdAt: order.createdAt }
}

export async function finishExchangeInTx(
  tx: Prisma.TransactionClient,
  prepared: PreparedExchange,
  settled: AbonoEnTx[],
): Promise<ExchangeTxOutcome> {
  const p = prepared
  const { venueId } = p.input
  const cardOnly = p.existingCharge !== null && p.returnedCents === 0 && p.newSalePayments.length === 0 && settled.length === 0
  if (settled.length !== p.newSalePayments.length || (!cardOnly && !settled.at(-1)?.isFullyPaid))
    throw new Error('EXCHANGE_SALE_BALANCE_MISMATCH')
  if (cardOnly) {
    const order = await tx.order.findFirstOrThrow({ where: { id: p.newOrder.id, venueId } })
    if (!computeOrderBalance(order, [p.existingCharge!]).isFullyPaid) throw new Error('EXCHANGE_SALE_BALANCE_MISMATCH')
    const { settleStandalonePaymentInTx } = await import('../tpv/payment.tpv.service')
    await settleStandalonePaymentInTx(tx, venueId, p.newOrder.id, p.existingCharge!, p.input.actorStaffId)
  }
  const lastPayment = settled.at(-1)?.newPayment ?? p.existingCharge!
  const salePosting = p.existingCharge ? await exchangeSalePostingInTx(tx, venueId, p.newOrder.id, p.input.actorStaffId) : null
  for (const [i, payment] of p.newSalePayments.entries()) {
    if (!payment.slice || payment.slice.cents === 0) continue
    const refund = p.refundRows.find(r => r.paymentId === payment.slice!.paymentId && r.role === 'CREDIT')!
    await tx.exchangeCreditLink.create({
      data: {
        venueId,
        exchangeId: p.exchangeId,
        originPaymentId: payment.rootPaymentId!,
        creditRefundPaymentId: refund.id,
        creditPaymentId: settled[i].newPayment.id,
        amount: pesos(payment.slice.cents),
        createdAt: p.accountingAt,
      },
    })
  }
  const returnPosting = await createCustomerReturnPostingInTx(tx, {
    venueId,
    refundPaymentId: p.refundRows[0].id,
    orderId: p.sale.order.id,
    staffId: p.input.actorStaffId,
    lines: p.returnLines,
  })
  const response: ExchangeResponse = {
    id: p.exchangeId,
    status: p.finalStatus,
    originalOrderId: p.sale.order.id,
    originalOrderNumber: p.sale.order.orderNumber,
    newOrderId: p.newOrder.id,
    newOrderNumber: p.newOrder.orderNumber,
    returnedCents: p.returnedCents,
    takenCents: p.takenCents,
    differenceCents: p.differenceCents,
    settlement: {
      kind: p.input.body.settlement.kind,
      method: p.input.body.settlement.method,
      amountCents: Math.abs(p.differenceCents),
      sources: p.refundRows.map(r => ({
        originalPaymentId: r.paymentId,
        refundPaymentId: r.id,
        method: r.money.method,
        amountCents: r.cents,
      })),
    },
    lines: p.lines,
    refundPaymentIds: p.refundRows.map(r => r.id),
    paymentIds: [...(p.existingCharge ? [p.existingCharge.id] : []), ...settled.map(s => s.newPayment.id)],
    pendingCardRefundCents: 0,
    receiptUrl: null,
    ...(p.existingCharge ? { chargePaymentId: p.existingCharge.id, reviewReason: null } : {}),
  }
  const cashSale = p.newSalePayments.at(-1)?.role === 'DIFFERENCE' && paymentCountsAsDrawerCash(settled.at(-1)!.newPayment)
  // La venta nació antes del reclamo: conserva el turno que ganaron sus cobros, incluso si quedó sin turno.
  await tx.order.update({ where: { id: p.newOrder.id, venueId }, data: { shiftId: lastPayment.shiftId ?? null } })
  const transition = await tx.exchange.updateMany({
    where: { id: p.exchangeId, venueId, status: p.expectedStatus, resultRevision: p.resultRevision },
    data: {
      status: p.finalStatus,
      createdAt: p.accountingAt,
      resultRevision: { increment: 1 },
      ...(p.existingCharge ? { chargePaymentId: p.existingCharge.id, reviewReason: null } : {}),
      result: response as unknown as Prisma.InputJsonValue,
      ...(cashSale ? { cashDrawerSessionId: settled.at(-1)!.cajaAlCobrarId } : {}),
    },
  })
  if (transition.count !== 1) throw new ExchangeGenerationChanged()
  await tx.activityLog.create({
    data: {
      action: 'EXCHANGE_CREATED',
      createdAt: p.accountingAt,
      entity: 'Exchange',
      entityId: p.exchangeId,
      staffId: p.actorStaffId,
      venueId,
      data: {
        originalOrderNumber: response.originalOrderNumber,
        newOrderNumber: response.newOrderNumber,
        returnedAmount: response.returnedCents / 100,
        takenAmount: response.takenCents / 100,
        differenceAmount: response.differenceCents / 100,
        settlement: { kind: response.settlement.kind, method: response.settlement.method, amount: response.settlement.amountCents / 100 },
        reasons: p.input.body.returned.map(r => ({
          orderItemId: r.orderItemId,
          reason: r.reason,
          quantity: r.quantity,
          restock: r.restock,
        })),
        deviceId: p.input.body.deviceId,
        isOfflineReplay: false,
        ...(p.existingCharge
          ? {
              chargePaymentId: p.existingCharge.id,
              originalStaffId: p.input.actorStaffId,
              origin: p.actorStaffId === null ? 'SWEEP' : 'HTTP',
            }
          : {}),
      },
    },
  })
  return {
    exchangeId: p.exchangeId,
    resultRevision: p.resultRevision + 1,
    response,
    postCommit: {
      salePostingId: salePosting?.id ?? settled.at(-1)?.postingId ?? null,
      returnPostingId: returnPosting?.id ?? null,
      cashSale: cashSale
        ? {
            paymentId: settled.at(-1)!.newPayment.id,
            sessionId: settled.at(-1)!.cajaAlCobrarId,
            amountPesos: p.differenceCents / 100,
            money: settled.at(-1)!.newPayment,
          }
        : null,
      cashPayouts: p.refundRows
        .filter(r => r.role === 'PAYOUT')
        .map(r => ({ refundPaymentId: r.id, sessionId: r.sessionId, amountPesos: r.cents / 100, money: r.money })),
      receiptPaymentId: p.existingCharge?.id ?? lastPayment.id,
      newOrderId: p.newOrder.id,
      originalOrderId: p.sale.order.id,
      loyaltyBasePesos: p.existingCharge ? p.takenCents / 100 : settled.at(-1)!.loyaltyBase,
      orderType: p.sale.order.type,
      source: p.sale.order.source,
    },
  }
}

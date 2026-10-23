import { OrderSource, OrderType, Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { computeOrderBalance } from '../shared/orderBalance'
import { lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { keptMarkdownDiscountRow } from '../shared/discount.service'
import { sincronizarRepartos } from '../shared/repartoDescuentoTx'
import { bloquearCobroParaReembolso } from '../dashboard/refund.dashboard.service'
import type { RefundMoneySemantics } from '../dashboard/refund.dashboard.service'
import { writeRefundInTx } from '../shared/writeRefundInTx'
import { createCustomerReturnPostingInTx } from '../inventory/inventoryPosting.service'
import type { AbonoEnTx, AbonoEnTxContexto, AbonoEnTxEntrada } from '../mobile/order.mobile.service'
import type { TenderSemanticsPayment } from '../shared/tenderSemantics'
import { loadSaleForExchange } from './exchangeSale'
import { calculateExchange, pieceValuesCents, splitItemsAcrossRefundRows, type ReturnedPiece } from './exchangeCalculator'
import {
  allocateAcrossPayments,
  lineBlockReason,
  modesForExchangeCreditRoot,
  payoutModesFor,
  saleBlockReason,
  type AllocationSlice,
} from './exchangeRules'
import { EXCHANGE_REFUND_ROLE } from './exchangeMarks'
import { resolveExchangeCreditTenderInTx } from './exchangeCreditTender'
import { ExchangeError } from './exchangeErrors'
import type { ExchangeResponse, ExchangeReturnedLine, ExchangeTakenLine, ExchangeTxInput, SaleForExchange } from './exchange.service'

export interface PreparedExchange {
  input: ExchangeTxInput
  exchangeId: string
  sale: SaleForExchange
  newOrder: { id: string; orderNumber: string }
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
    money: RefundMoneySemantics
  }>
  newSalePayments: Array<{
    ctx: AbonoEnTxContexto
    entrada: AbonoEnTxEntrada
    role: 'CREDIT' | 'DIFFERENCE'
    slice?: AllocationSlice
    rootPaymentId?: string
  }>
  returnLines: Array<{ orderItemId: string; productId: string; quantity: number }>
}
export interface ExchangeTxOutcome {
  exchangeId: string
  response: ExchangeResponse
  postCommit: {
    salePostingId: string | null
    returnPostingId: string | null
    cashSale: { paymentId: string; sessionId: string | null; amountPesos: number } | null
    cashPayouts: Array<{ refundPaymentId: string; amountPesos: number; money: TenderSemanticsPayment }>
    receiptPaymentId: string
    newOrderId: string
    originalOrderId: string
    loyaltyBasePesos: number
    orderType: string
    source: string
  }
}
const pesos = (c: number) => new Prisma.Decimal(c).div(100)

/** La llave decide antes que el estado vigente de la venta: repetir algo ya hecho nunca devuelve dos piezas. */
export async function prepareExchangeInTx(
  tx: Prisma.TransactionClient,
  input: ExchangeTxInput,
): Promise<PreparedExchange | { replay: ExchangeResponse }> {
  const { venueId, body, actorStaffId, originalOrderId } = input
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'avoqado:exchange:v1:' + venueId + ':' + body.idempotencyKey}, 0))::text`
  const existing = await tx.exchange.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: body.idempotencyKey } } })
  if (existing) {
    if (existing.requestHash !== input.requestHash)
      throw new ExchangeError('IDEMPOTENCY_KEY_REUSED', 'Esta llave ya se usó para otro cambio.', 409)
    if (!existing.result) throw new Error('EXCHANGE_RESULT_MISSING')
    return { replay: existing.result as unknown as ExchangeResponse }
  }
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: originalOrderId }))) throw new NotFoundError('No se encontró la venta.')
  const sale = await loadSaleForExchange(tx, venueId, originalOrderId)
  if (body.settlement.kind !== 'EVEN' || body.settlement.method !== null)
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'El cobro o devolución de diferencias aún no está disponible.', 422)
  const notReturnable = (reason: string, orderItemId?: string): never => {
    throw new ExchangeError('EXCHANGE_ITEM_NOT_RETURNABLE', 'Este artículo no se puede cambiar.', 422, { reason, orderItemId })
  }
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
    if (!l) notReturnable('NOT_IN_ORDER', r.orderItemId)
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
    if (reason) notReturnable(reason, line.id)
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 1 || r.quantity > left) notReturnable('ALREADY_RETURNED', line.id)
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
  const ids = [...new Set(body.taken.map(l => l.productId))]
  const products = await tx.product.findMany({ take: ids.length, where: { venueId, id: { in: ids } } })
  const productById = new Map(products.map(p => [p.id, p]))
  const taken = body.taken.map(l => {
    const p = productById.get(l.productId)
    if (!p || !p.active || p.deletedAt || !Number.isSafeInteger(l.quantity) || l.quantity < 1)
      throw new ExchangeError('EXCHANGE_TAKEN_NOT_SELLABLE', 'Este producto ya no está disponible para vender.', 422, {
        productId: l.productId,
      })
    return {
      productId: p.id,
      productGroupId: p.productGroupId,
      listCents: p.price.mul(100).toNumber(),
      quantity: l.quantity,
      inheritsFromOrderItemId: l.inheritsFromOrderItemId ?? null,
    }
  })
  const calc = calculateExchange(pieces, taken)
  if (calc.differenceCents !== body.settlement.expectedDifferenceCents)
    throw new ExchangeError(
      'EXCHANGE_DIFFERENCE_CHANGED',
      'La diferencia cambió desde que abriste el cambio (cambió un precio). Revisa el nuevo total antes de continuar.',
      409,
      { returnedCents: calc.returnedCents, takenCents: calc.takenCents, differenceCents: calc.differenceCents },
    )
  if (calc.kind !== 'EVEN')
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'El cobro o devolución de diferencias aún no está disponible.', 422)
  const orderedPayments = [...sale.payments].sort(
    (a, b) =>
      Number(b.id === body.originalPaymentId) - Number(a.id === body.originalPaymentId) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  )
  const allocation = allocateAcrossPayments(
    orderedPayments.map(p => ({
      paymentId: p.id,
      saleRemainingCents: p.amountCents - p.saleRefundedCents,
      modes: p.money.tenderSystemKind === 'EXCHANGE_CREDIT' ? modesForExchangeCreditRoot(p.rootMoney) : payoutModesFor(p.money),
    })),
    Math.min(calc.returnedCents, calc.takenCents),
    null,
  )
  if (!allocation.ok) notReturnable(allocation.reason)
  const slices: AllocationSlice[] = allocation.ok ? allocation.slices : []
  if (calc.returnedCents === 0) slices.push({ paymentId: body.originalPaymentId, cents: 0, role: 'CREDIT', mode: null })
  const paymentById = new Map(sale.payments.map(p => [p.id, p]))
  // Payment antes que Shift: pone en fila la edición manual de las raíces contra la nueva liga del crédito.
  const lockIds = [...new Set(slices.flatMap(s => [s.paymentId, paymentById.get(s.paymentId)!.rootPaymentId]))].sort()
  for (const id of lockIds) {
    const p = await tx.payment.findFirst({ where: { venueId, id }, select: { orderId: true } })
    const locked = await bloquearCobroParaReembolso(tx, { venueId, paymentId: id, expectedOrderId: p?.orderId ?? null })
    const portion = slices.filter(s => s.paymentId === id).reduce((sum, s) => sum + s.cents, 0)
    if (
      slices.some(s => s.paymentId === id) &&
      (locked.unclassifiedPriorRefundCents > 0 ||
        portion > locked.remainingBeforeCents ||
        portion > paymentById.get(id)!.amountCents - locked.refundedSalesCents)
    )
      notReturnable('NOT_ATTRIBUTABLE')
  }
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
  const newOrder = await createExchangeSaleInTx(tx, input, sale, takenLines)
  const lines = { returned, taken: takenLines }
  const exchange = await tx.exchange.create({
    data: {
      venueId,
      idempotencyKey: body.idempotencyKey,
      requestHash: input.requestHash,
      status: 'COMPLETED',
      originalOrderId,
      originalPaymentId: body.originalPaymentId,
      newOrderId: newOrder.id,
      returnedAmount: pesos(calc.returnedCents),
      takenAmount: pesos(calc.takenCents),
      differenceAmount: pesos(calc.differenceCents),
      settlementKind: 'EVEN',
      settlementMethod: null,
      lines: lines as unknown as Prisma.InputJsonValue,
      staffId: actorStaffId,
      deviceId: body.deviceId,
      createdAtLocal: new Date(body.createdAtLocal),
      isOfflineReplay: false,
    },
  })
  const ec = await resolveExchangeCreditTenderInTx(tx, venueId)
  const money: RefundMoneySemantics = { ...ec, merchantAccountId: null, source: 'OTHER' }
  const split = splitItemsAcrossRefundRows(
    pieces.map(p => ({ orderItemId: p.orderItemId, cents: p.paidCents })),
    slices.map((s, i) => ({ key: String(i), cents: s.cents })),
  )
  const refundRows: PreparedExchange['refundRows'] = []
  const refundAt = Date.now()
  for (const [i, slice] of slices.entries()) {
    const rootPaymentId = paymentById.get(slice.paymentId)!.rootPaymentId
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
      moneyAs: money,
      skipNegativeCostObligation: true,
      exchangeMark: { exchangeId: exchange.id, role: EXCHANGE_REFUND_ROLE.CREDIT, rootPaymentId },
    })
    // El libro ordena por fecha e id; el reloj de Postgres es fijo durante la transacción.
    await tx.payment.update({ where: { id: refund.refundPaymentId, venueId }, data: { createdAt: new Date(refundAt + i) } })
    refundRows.push({ id: refund.refundPaymentId, paymentId: slice.paymentId, role: slice.role, cents: slice.cents, rootPaymentId, money })
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
    .filter(s => s.cents > 0)
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
  if (calc.takenCents === 0)
    newSalePayments.push({
      ctx,
      role: 'CREDIT',
      entrada: { method: 'CASH', amountCents: 0, tipCents: 0, tender: null, canal: { turno: 'exchange', reapertura: 'exchange' } },
    })
  for (let i = 0; i < newSalePayments.length - 1; i++) newSalePayments[i].entrada.cierreDiferido = true
  const returnLines = [...used].flatMap(([orderItemId]) => {
    const l = byId.get(orderItemId)!
    const quantity = returned.filter(r => r.orderItemId === orderItemId && r.restock).reduce((sum, r) => sum + r.quantity, 0)
    return quantity > 0 && l.productId && l.product?.trackInventory && l.product.inventoryMethod === 'QUANTITY' && l.product.hasInventoryRow
      ? [{ orderItemId, productId: l.productId, quantity }]
      : []
  })
  return {
    input,
    exchangeId: exchange.id,
    sale,
    newOrder,
    lines,
    returnedCents: calc.returnedCents,
    takenCents: calc.takenCents,
    differenceCents: calc.differenceCents,
    refundRows,
    newSalePayments,
    returnLines,
  }
}

/** La venta es privada hasta el commit: no pasa por el constructor general ni vuelve a aplicar promociones. */
async function createExchangeSaleInTx(
  tx: Prisma.TransactionClient,
  input: ExchangeTxInput,
  sale: SaleForExchange,
  lines: ExchangeTakenLine[],
) {
  const { venueId, body, actorStaffId } = input
  const items: Array<Prisma.OrderItemUncheckedCreateWithoutOrderInput> = []
  const owner: number[] = []
  for (const [i, line] of lines.entries()) {
    const append = (quantity: number, priceCents: number, inherited: boolean) => {
      const unit = inherited ? Math.max(line.listCents, priceCents) : priceCents
      const discount = (unit - priceCents) * quantity
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
      owner.push(i)
    }
    for (const piece of line.pieces.filter(p => p.inheritedFromOrderItemId !== null)) append(1, piece.priceCents, true)
    const unpaired = line.pieces.filter(p => p.inheritedFromOrderItemId === null)
    if (unpaired.length) append(unpaired.length, unpaired[0].priceCents, false)
  }
  const subtotal = items.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.unitPrice as Prisma.Decimal).mul(item.quantity)), pesos(0))
  const discountAmount = items.reduce((sum, item) => sum.plus(item.discountAmount as Prisma.Decimal), pesos(0))
  const shift = await turnoAbiertoDelNegocio(tx, venueId)
  const order = await tx.order.create({
    data: {
      venueId,
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
    lines[owner[index]].newOrderItemIds.push(item.id)
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
  return { id: order.id, orderNumber: order.orderNumber }
}

export async function finishExchangeInTx(
  tx: Prisma.TransactionClient,
  prepared: PreparedExchange,
  settled: AbonoEnTx[],
): Promise<ExchangeTxOutcome> {
  const p = prepared
  const { venueId } = p.input
  if (settled.length !== p.newSalePayments.length || !settled.at(-1)?.isFullyPaid) throw new Error('EXCHANGE_SALE_BALANCE_MISMATCH')
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
    status: 'COMPLETED',
    originalOrderId: p.sale.order.id,
    originalOrderNumber: p.sale.order.orderNumber,
    newOrderId: p.newOrder.id,
    newOrderNumber: p.newOrder.orderNumber,
    returnedCents: p.returnedCents,
    takenCents: p.takenCents,
    differenceCents: p.differenceCents,
    settlement: {
      kind: 'EVEN',
      method: null,
      amountCents: 0,
      sources: p.refundRows.map(r => ({
        originalPaymentId: r.paymentId,
        refundPaymentId: r.id,
        method: r.money.method,
        amountCents: r.cents,
      })),
    },
    lines: p.lines,
    refundPaymentIds: p.refundRows.map(r => r.id),
    paymentIds: settled.map(s => s.newPayment.id),
    pendingCardRefundCents: 0,
    receiptUrl: null,
  }
  await tx.exchange.update({ where: { id: p.exchangeId, venueId }, data: { result: response as unknown as Prisma.InputJsonValue } })
  return {
    exchangeId: p.exchangeId,
    response,
    postCommit: {
      salePostingId: settled.at(-1)!.postingId ?? null,
      returnPostingId: returnPosting?.id ?? null,
      cashSale: null,
      cashPayouts: [],
      receiptPaymentId: settled.at(-1)!.newPayment.id,
      newOrderId: p.newOrder.id,
      originalOrderId: p.sale.order.id,
      loyaltyBasePesos: settled.at(-1)!.loyaltyBase,
      orderType: p.sale.order.type,
      source: p.sale.order.source,
    },
  }
}

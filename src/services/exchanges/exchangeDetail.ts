import type { ExchangeStatus, PrismaClient } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import type { VariantFields } from '../product-variants/variantPayload'
import { ExchangeError } from './exchangeErrors'
import { isExchangeCreditTenderKind, type LineBlockReason } from './exchangePredicates'
import {
  lineBlockReason,
  effectiveExchangeCapacity,
  modesForExchangeCreditRoot,
  payoutModesFor,
  payoutOptionsOf,
  saleBlockReason,
  type PaymentCapacity,
  type PayoutOption,
} from './exchangeRules'
import { loadSaleForExchange } from './exchangeSale'
import { resolveChainRefund, type ChainRefundResolution } from './exchangeChainRefund'

export interface ExchangeItemExtras {
  productId: string | null
  /**
   * Los cuatro enteros para espejar `pieceValuesCents` en las apps: chargedTotalCents, quantity, returnedQtyOrder y
   * returnedCentsOrder. Para las siguientes k piezas: max(0, parteDeUnidades(cobrado, cantidad, devueltas + j, 1));
   * si la suma excede max(0, cobrado − centavosDevueltos), recortar el exceso desde la ÚLTIMA pieza. Nunca un arreglo
   * de todas las piezas restantes ni el total bruto del renglón: es lo que COBRÓ `cobradoDeLaOrden`.
   */
  chargedTotalCents: number
  quantity: number
  /** Cuenta todos los estados de reembolso, igual que la política del escritor de reembolsos. */
  returnedQtyOrder: number
  returnedCentsOrder: number
  remainingQtyOrder: number
  productGroupId: string | null
  variantOptions: VariantFields['variantOptions']
  productType: string | null
  isPromotionLine: boolean
  notExchangeableReason: LineBlockReason | null
  restockable: boolean
  currentListPriceCents: number | null
}

export interface ExchangeDetailFields {
  exchangeable: boolean
  notExchangeableReason: LineBlockReason | 'NOT_A_SALE' | null
  tenderSystemKind: 'GIFT_CARD' | 'EXCHANGE_CREDIT' | null
  chainRefundMethod: 'CARD_TERMINAL' | 'CASH' | 'GIFT_CARD_BALANCE' | 'BANK_TRANSFER' | 'OTHER' | null
  chainRefundLabel: string | null
  chainRefundBlockedCode?: string | null
  chainRefundBlockedReason?: string | null
  payoutOptions: PayoutOption[]
  exchange: {
    asOriginalTotal: number
    asOriginal: Array<{ exchangeId: string; newOrderNumber: string; status: ExchangeStatus }>
    asNew: { exchangeId: string; originalOrderNumber: string } | null
  }
}

/** Sólo lecturas acotadas: el detalle reutiliza la venta y las capacidades que valida el escritor del cambio. */
export async function exchangeDetailFields(
  db: PrismaClient,
  venueId: string,
  paymentId: string,
): Promise<{ fields: ExchangeDetailFields; itemExtras: Map<string, ExchangeItemExtras> }> {
  const payment = await db.payment.findFirst({
    where: { venueId, id: paymentId },
    select: { orderId: true, type: true, status: true, tenderType: { select: { systemKind: true } } },
  })
  if (!payment) throw new NotFoundError('No se encontró el cobro en esta sucursal.')
  const kind = payment.tenderType?.systemKind
  const fields: ExchangeDetailFields = {
    exchangeable: false,
    notExchangeableReason: 'NOT_A_SALE',
    tenderSystemKind: kind === 'EXCHANGE_CREDIT' || kind === 'GIFT_CARD' ? kind : null,
    chainRefundMethod: null,
    chainRefundLabel: null,
    chainRefundBlockedCode: null,
    chainRefundBlockedReason: null,
    payoutOptions: [],
    exchange: { asOriginal: [], asOriginalTotal: 0, asNew: null },
  }
  const itemExtras = new Map<string, ExchangeItemExtras>()
  if (payment.type === 'REFUND' || !payment.orderId) return { fields, itemExtras }
  const [asOriginal, asNew, asOriginalTotal] = await Promise.all([
    db.exchange.findMany({
      take: 50,
      where: { venueId, originalOrderId: payment.orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, newOrderId: true, status: true },
    }),
    db.exchange.findUnique({
      where: { newOrderId: payment.orderId, venueId },
      select: { id: true, originalOrderId: true },
    }),
    db.exchange.count({ where: { venueId, originalOrderId: payment.orderId } }),
  ])
  const orders = await db.order.findMany({
    take: 51,
    where: { venueId, id: { in: [...asOriginal.map(e => e.newOrderId), ...(asNew ? [asNew.originalOrderId] : [])] } },
    select: { id: true, orderNumber: true },
  })
  const numberById = new Map(orders.map(o => [o.id, o.orderNumber]))
  fields.exchange.asOriginalTotal = asOriginalTotal
  fields.exchange.asOriginal = asOriginal.flatMap(e => {
    const newOrderNumber = numberById.get(e.newOrderId)
    return newOrderNumber ? [{ exchangeId: e.id, newOrderNumber, status: e.status }] : []
  })
  const originalOrderNumber = asNew && numberById.get(asNew.originalOrderId)
  fields.exchange.asNew = asNew && originalOrderNumber ? { exchangeId: asNew.id, originalOrderNumber } : null

  let sale
  try {
    sale = await loadSaleForExchange(db, venueId, payment.orderId, paymentId)
  } catch (error) {
    if (
      !(error instanceof ExchangeError) ||
      ((error.details as { reason?: unknown } | undefined)?.reason !== 'NOT_ATTRIBUTABLE' &&
        error.code !== 'EXCHANGE_SETTLEMENT_UNAVAILABLE')
    )
      throw error
    fields.notExchangeableReason = 'NOT_ATTRIBUTABLE'
    if (isExchangeCreditTenderKind(kind) && error.code === 'EXCHANGE_SETTLEMENT_UNAVAILABLE') fields.chainRefundBlockedCode = error.code
    return { fields, itemExtras }
  }
  const chains = new Map<string, ChainRefundResolution>()
  const readChain = (id: string): ChainRefundResolution => {
    const cached = chains.get(id)
    if (cached) return cached
    let chain: ChainRefundResolution
    try {
      const data = sale.chainByPaymentId.get(id)
      chain = resolveChainRefund(data?.link, data?.root)
    } catch (error) {
      if (!(error instanceof ExchangeError) || error.code !== 'EXCHANGE_SETTLEMENT_UNAVAILABLE') throw error
      chain = { kind: 'BLOCKED', error }
    }
    chains.set(id, chain)
    return chain
  }

  if (isExchangeCreditTenderKind(kind)) {
    const chain = readChain(paymentId)
    if (chain.kind === 'BLOCKED') {
      fields.chainRefundBlockedCode = chain.error.code ?? null
      const reason = (chain.error.details as { reason?: unknown } | undefined)?.reason
      fields.chainRefundBlockedReason = typeof reason === 'string' ? reason : null
    } else {
      const method = chain.money.method
      fields.chainRefundMethod =
        method === 'CASH' || method === 'BANK_TRANSFER'
          ? method
          : method === 'CREDIT_CARD' || method === 'DEBIT_CARD'
            ? 'CARD_TERMINAL'
            : 'OTHER'
      fields.chainRefundLabel =
        chain.money.tenderLabel ??
        (method === 'CASH'
          ? 'Efectivo'
          : method === 'BANK_TRANSFER'
            ? 'Transferencia'
            : method === 'CREDIT_CARD' || method === 'DEBIT_CARD'
              ? 'Tarjeta'
              : 'Otro')
    }
  }

  if (!sale.charged.atribuible) {
    fields.notExchangeableReason = 'NOT_ATTRIBUTABLE'
    return { fields, itemExtras }
  }
  for (const line of sale.lines) {
    const prior = sale.returnedByLine.get(line.id)
    const remainingQtyOrder = Math.max(0, line.quantity - (prior?.quantity ?? 0))
    const product = line.product
    itemExtras.set(line.id, {
      productId: line.productId,
      chargedTotalCents: sale.charged.cobradoCents.get(line.id)!,
      quantity: line.quantity,
      returnedQtyOrder: prior?.quantity ?? 0,
      returnedCentsOrder: prior?.amountCents ?? 0,
      remainingQtyOrder,
      productGroupId: product?.productGroupId ?? null,
      variantOptions: product?.variantOptions ?? null,
      productType: product?.type ?? null,
      isPromotionLine: line.orderPromotionId != null,
      notExchangeableReason: lineBlockReason({
        productId: line.productId,
        productType: product?.type ?? null,
        giftCardId: line.giftCardId,
        soldByWeight: product?.soldByWeight ?? false,
        remainingQtyOrder,
        serialized: line.serialized,
      }),
      restockable: !!product?.trackInventory && product.inventoryMethod === 'QUANTITY' && product.hasInventoryRow,
      currentListPriceCents: product && !product.deletedAt ? product.priceCents : null,
    })
  }
  const capacities: PaymentCapacity[] = []
  for (const p of sale.payments) {
    const chain = isExchangeCreditTenderKind(p.money.tenderSystemKind) ? readChain(p.id) : null
    capacities.push({
      paymentId: p.id,
      saleRemainingCents: effectiveExchangeCapacity(p),
      modes: chain ? (chain.kind === 'INHERIT' ? modesForExchangeCreditRoot(p.rootMoney) : {}) : payoutModesFor(p.money),
    })
  }
  fields.payoutOptions = payoutOptionsOf(capacities)
  const lines = [...itemExtras.values()]
  const merchandise = lines.filter(l => l.notExchangeableReason === null || l.notExchangeableReason === 'ALREADY_RETURNED')
  fields.notExchangeableReason =
    saleBlockReason({ ...sale.order, paymentSources: sale.payments.map(p => p.money.source ?? '') }) ??
    (merchandise.length && merchandise.every(l => l.remainingQtyOrder === 0)
      ? 'ALREADY_RETURNED'
      : payment.status !== 'COMPLETED' || !sale.payments.some(p => p.id === paymentId)
        ? 'NOT_PAID'
        : lines.some(l => l.notExchangeableReason === null)
          ? null
          : (lines[0]?.notExchangeableReason ?? 'NOT_MERCHANDISE'))
  fields.exchangeable = fields.notExchangeableReason === null
  return { fields, itemExtras }
}

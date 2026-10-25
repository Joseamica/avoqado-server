import { Prisma, type ExchangeStatus, type PrismaClient } from '@prisma/client'
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
import type { SaleForExchange } from './exchange.service'
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
  notExchangeableReason: LineBlockReason | 'NOT_A_SALE' | 'ORDER_LOCK_SCOPE_TOO_LARGE' | null
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
  fields.exchange = (await loadExchangeLinksForOrders(db, venueId, [payment.orderId])).get(payment.orderId)!

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
  const result = fieldsForSale(sale, fields.exchange, payment.status === 'COMPLETED' && sale.payments.some(p => p.id === paymentId))
  return {
    fields: { ...fields, ...result.fields, ...fieldsForPayment(sale, paymentId, kind ?? null) },
    itemExtras: result.itemExtras,
  }
}

export type SaleExchangeFields = Pick<ExchangeDetailFields, 'exchangeable' | 'notExchangeableReason' | 'payoutOptions' | 'exchange'>
export type PaymentExchangeFields = Pick<
  ExchangeDetailFields,
  'tenderSystemKind' | 'chainRefundMethod' | 'chainRefundLabel' | 'chainRefundBlockedCode' | 'chainRefundBlockedReason'
>

const MAX_EXCHANGE_ORIGINAL_LINKS = 50

export async function loadExchangeLinksForOrders(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  orderIds: string[],
): Promise<Map<string, ExchangeDetailFields['exchange']>> {
  const result = new Map<string, ExchangeDetailFields['exchange']>()
  if (!orderIds.length) return result
  // LIMIT belongs inside each order's lateral read; a global limit starves the other orders.
  const rows = await db.$queryRaw<
    Array<{
      orderId: string
      total: number
      direction: string | null
      id: string | null
      otherOrderId: string | null
      status: ExchangeStatus | null
    }>
  >(Prisma.sql`
    WITH orders AS MATERIALIZED (
      SELECT o.id, (SELECT count(*)::int FROM "Exchange" x
        WHERE x."venueId" = ${venueId} AND x."originalOrderId" = o.id) AS total
      FROM "Order" o WHERE o."venueId" = ${venueId} AND o.id IN (${Prisma.join(orderIds)})
    )
    SELECT o.id AS "orderId", o.total, e.id, e.direction, e."otherOrderId", e.status
    FROM orders o LEFT JOIN LATERAL (
      (SELECT x.id, 'original' AS direction, x."newOrderId" AS "otherOrderId", x.status, x."createdAt"
       FROM "Exchange" x WHERE x."venueId" = ${venueId} AND x."originalOrderId" = o.id
       ORDER BY x."createdAt" DESC, x.id DESC LIMIT ${MAX_EXCHANGE_ORIGINAL_LINKS})
      UNION ALL
      (SELECT x.id, 'new' AS direction, x."originalOrderId" AS "otherOrderId", x.status, x."createdAt"
       FROM "Exchange" x WHERE x."venueId" = ${venueId} AND x."newOrderId" = o.id LIMIT 1)
    ) e ON true
    ORDER BY o.id, e."createdAt" DESC, e.id DESC
  `)
  const otherIds = [...new Set(rows.flatMap(r => (r.otherOrderId ? [r.otherOrderId] : [])))]
  const orders = await db.order.findMany({
    take: otherIds.length,
    where: { venueId, id: { in: otherIds } },
    select: { id: true, orderNumber: true },
  })
  const numberById = new Map(orders.map(o => [o.id, o.orderNumber]))
  for (const row of rows) {
    let links = result.get(row.orderId)
    if (!links) {
      links = { asOriginal: [], asOriginalTotal: row.total, asNew: null }
      result.set(row.orderId, links)
    }
    const number = row.otherOrderId && numberById.get(row.otherOrderId)
    if (!row.id || !number) continue
    if (row.direction === 'original') links.asOriginal.push({ exchangeId: row.id, newOrderNumber: number, status: row.status! })
    else links.asNew = { exchangeId: row.id, originalOrderNumber: number }
  }
  return result
}

function readChain(sale: SaleForExchange, id: string): ChainRefundResolution {
  try {
    const data = sale.chainByPaymentId.get(id)
    return resolveChainRefund(data?.link, data?.root)
  } catch (error) {
    if (!(error instanceof ExchangeError) || error.code !== 'EXCHANGE_SETTLEMENT_UNAVAILABLE') throw error
    return { kind: 'BLOCKED', error }
  }
}

export function paymentExchangeFields(sale: SaleForExchange, paymentId: string): PaymentExchangeFields {
  const payment = sale.payments.find(p => p.id === paymentId)
  const kind = payment ? payment.money.tenderSystemKind : sale.chainByPaymentId.has(paymentId) ? 'EXCHANGE_CREDIT' : null
  return fieldsForPayment(sale, paymentId, kind)
}

function fieldsForPayment(sale: SaleForExchange, paymentId: string, kind: string | null): PaymentExchangeFields {
  const fields: PaymentExchangeFields = {
    tenderSystemKind: kind === 'EXCHANGE_CREDIT' || kind === 'GIFT_CARD' ? kind : null,
    chainRefundMethod: null,
    chainRefundLabel: null,
    chainRefundBlockedCode: null,
    chainRefundBlockedReason: null,
  }
  if (sale.settlementUnavailable) {
    if (isExchangeCreditTenderKind(kind)) fields.chainRefundBlockedCode = 'EXCHANGE_SETTLEMENT_UNAVAILABLE'
    return fields
  }
  if (isExchangeCreditTenderKind(kind)) {
    const chain = readChain(sale, paymentId)
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

  return fields
}

export function saleExchangeFields(
  sale: SaleForExchange,
  exchange: ExchangeDetailFields['exchange'],
): { fields: SaleExchangeFields; itemExtras: Map<string, ExchangeItemExtras> } {
  return fieldsForSale(sale, exchange, sale.payments.length > 0)
}

function fieldsForSale(
  sale: SaleForExchange,
  exchange: ExchangeDetailFields['exchange'],
  openedPaymentIsPaid: boolean,
): { fields: SaleExchangeFields; itemExtras: Map<string, ExchangeItemExtras> } {
  const fields: SaleExchangeFields = { exchangeable: false, notExchangeableReason: 'NOT_ATTRIBUTABLE', payoutOptions: [], exchange }
  const itemExtras = new Map<string, ExchangeItemExtras>()

  if (sale.settlementUnavailable || !sale.charged.atribuible) {
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
    const chain = isExchangeCreditTenderKind(p.money.tenderSystemKind) ? readChain(sale, p.id) : null
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
    (sale.orderLockScopeTooLarge ? 'ORDER_LOCK_SCOPE_TOO_LARGE' : null) ??
    (merchandise.length && merchandise.every(l => l.remainingQtyOrder === 0)
      ? 'ALREADY_RETURNED'
      : !openedPaymentIsPaid
        ? 'NOT_PAID'
        : lines.some(l => l.notExchangeableReason === null)
          ? null
          : (lines[0]?.notExchangeableReason ?? 'NOT_MERCHANDISE'))
  fields.exchangeable = fields.notExchangeableReason === null
  return { fields, itemExtras }
}

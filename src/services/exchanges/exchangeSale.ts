import { Prisma, type PrismaClient } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import { leerCobradoDeLaOrden } from '../fiscal/cobradoDeLaOrden'
import { TOPES_POR_ORDEN } from '../fiscal/librosDeOrdenes'
import { refundedItemsOfOrder } from '../dashboard/refund.dashboard.service'
import { centavosDevueltosPorComponente } from '../shared/devueltoDeUnCobro'
import { productGroupInclude, withVariantFields } from '../product-variants/variantPayload'
import { ExchangeError, itemNotReturnable } from './exchangeErrors'
import type { SaleForExchange } from './exchange.service'
import type { MoneyShape } from './exchangeRules'

const cents = (v: Prisma.Decimal) => v.mul(100).toDecimalPlaces(0).toNumber()
const moneyOf = (p: {
  method: string
  source: string | null
  externalSource: string | null
  fundsFlow: string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
  tenderSatFormaPago: string | null
  tenderType: { systemKind: string | null } | null
}): MoneyShape => ({
  method: p.method,
  source: p.source,
  externalSource: p.externalSource,
  fundsFlow: p.fundsFlow,
  tenderTypeId: p.tenderTypeId,
  tenderCountsAsCash: p.tenderCountsAsCash,
  tenderSatFormaPago: p.tenderSatFormaPago,
  tenderSystemKind: p.tenderType?.systemKind ?? null,
})

/** Una sola lectura acotada de la venta para el cambio y su pantalla. Quien escribe ya tiene el candado de Order. */
export const MAX_EXCHANGE_SALE_PAYMENTS = 50

export async function loadSaleForExchange(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  orderId: string,
  detailPaymentId?: string,
): Promise<SaleForExchange> {
  const order = await db.order.findFirst({
    where: { venueId, id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      source: true,
      type: true,
      servedById: true,
      createdById: true,
      customerId: true,
      orderCustomers: { where: { isPrimary: true }, take: 1, select: { customerId: true } },
    },
  })
  if (!order) throw new NotFoundError('No se encontró la venta en esta sucursal.')
  const lines = await db.orderItem.findMany({
    take: TOPES_POR_ORDEN.renglones + 1,
    where: { orderId, order: { venueId } },
    orderBy: { id: 'asc' },
    include: {
      serializedItem: { select: { id: true } },
      product: { include: { ...productGroupInclude, inventory: { select: { id: true } } } },
    },
  })
  const payments = await db.payment.findMany({
    take: MAX_EXCHANGE_SALE_PAYMENTS + 1,
    where: { venueId, orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { tenderType: { select: { systemKind: true } } },
  })
  const refunds = await db.payment.findMany({
    take: TOPES_POR_ORDEN.movimientos + 1,
    where: {
      venueId,
      type: 'REFUND',
      // El candado de reembolso busca por cobro original, incluso si una fila histórica trae otra orden.
      OR: [{ orderId }, ...payments.map(p => ({ processorData: { path: ['originalPaymentId'], equals: p.id } }))],
    },
    select: { amount: true, tipAmount: true, status: true, processorData: true },
  })
  if (
    lines.length > TOPES_POR_ORDEN.renglones ||
    payments.length > MAX_EXCHANGE_SALE_PAYMENTS ||
    refunds.length > TOPES_POR_ORDEN.movimientos
  ) {
    itemNotReturnable('NOT_ATTRIBUTABLE')
  }
  // El detalle conserva el origen del cobro abierto aunque ya esté REFUNDED, sin aportarlo al dinero disponible.
  const chainPaymentIds = [...payments.map(p => p.id), ...(detailPaymentId ? [detailPaymentId] : [])]
  const links = await db.exchangeCreditLink.findMany({ take: 51, where: { venueId, creditPaymentId: { in: chainPaymentIds } } })
  const roots = await db.payment.findMany({
    take: 51,
    where: { venueId, id: { in: links.map(l => l.originPaymentId) } },
    include: { tenderType: { select: { systemKind: true } } },
  })
  const rootById = new Map(roots.map(p => [p.id, p]))
  const linkById = new Map(links.map(l => [l.creditPaymentId, l]))
  return {
    order: { ...order, primaryCustomerId: order.orderCustomers[0]?.customerId ?? null },
    lines: lines.map(l => {
      const p = l.product && withVariantFields(l.product)
      return {
        id: l.id,
        productId: l.productId,
        productName: l.productName ?? p?.name ?? 'Producto',
        quantity: l.quantity,
        orderPromotionId: l.orderPromotionId,
        giftCardId: l.giftCardId,
        serialized: l.serializedItem != null,
        product: p
          ? {
              type: p.type,
              soldByWeight: p.soldByWeight,
              trackInventory: p.trackInventory,
              inventoryMethod: p.inventoryMethod,
              priceCents: cents(p.price),
              deletedAt: p.deletedAt,
              productGroupId: p.productGroupId,
              variantOptions: p.variantOptions,
              hasInventoryRow: p.inventory != null,
            }
          : null,
      }
    }),
    charged: await leerCobradoDeLaOrden(db, orderId),
    returnedByLine: await refundedItemsOfOrder(db, venueId, orderId),
    chainByPaymentId: new Map(links.map(link => [link.creditPaymentId, { link, root: rootById.get(link.originPaymentId) }])),
    payments: payments.map(p => {
      const link = linkById.get(p.id)
      const root = link ? rootById.get(link.originPaymentId) : p
      if (!root || (p.tenderType?.systemKind === 'EXCHANGE_CREDIT' && !link)) {
        throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'No se pudo comprobar el origen de este crédito de cambio.', 422)
      }
      const ownRefunds = refunds.filter(r => (r.processorData as Record<string, unknown> | null)?.originalPaymentId === p.id)
      return {
        id: p.id,
        createdAt: p.createdAt,
        amountCents: cents(p.amount),
        tipCents: p.tipAmount ? cents(p.tipAmount) : 0,
        processorData: p.processorData,
        refunds: ownRefunds,
        saleRefundedCents: centavosDevueltosPorComponente(ownRefunds).salesCents,
        money: moneyOf(p),
        rootPaymentId: root.id,
        rootMoney: moneyOf(root),
      }
    }),
  }
}

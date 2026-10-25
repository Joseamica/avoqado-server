import { Prisma, type PrismaClient, type Product } from '@prisma/client'
import { NotFoundError } from '@/errors/AppError'
import { leerCobradoDeLaOrden, leerCobradoDeLasOrdenes, NO_SE_PUEDE_POR_ARTICULOS } from '../fiscal/cobradoDeLaOrden'
import { TOPES_POR_ORDEN } from '../fiscal/librosDeOrdenes'
import { refundedItemsOfOrder, collectExistingRefundedItems } from '../dashboard/refund.dashboard.service'
import { centavosDevueltosPorComponente } from '../shared/devueltoDeUnCobro'
import { productGroupInclude, withVariantFields } from '../product-variants/variantPayload'
import { ExchangeError, itemNotReturnable } from './exchangeErrors'
import type { SaleForExchange } from './exchange.service'
import { effectiveExchangeCapacity, type MoneyShape } from './exchangeRules'
import { MAX_ORDER_LOCK_SCOPE } from '../shared/paymentShiftClaim'

const ORDER_SELECT = {
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
} as const
const LINE_INCLUDE = {
  serializedItem: { select: { id: true } },
  product: { include: { ...productGroupInclude, inventory: { select: { id: true } } } },
} as const
const REFUND_SELECT = { amount: true, tipAmount: true, status: true, processorData: true } as const
export type LoadedSaleForExchange = SaleForExchange & { catalogProducts: Map<string, Product> }

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

/** detailPaymentIds preserves the optional opened-payment context of the single-sale reader. */
export async function loadSalesForExchange(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  orderIds: string[],
  detailPaymentIds: string[] = [],
): Promise<Map<string, LoadedSaleForExchange>> {
  // shortcut: no read snapshot; use REPEATABLE READ per page if clients observe mixed balances.
  const result = new Map<string, LoadedSaleForExchange>()
  if (!orderIds.length) return result
  const sizes = await db.$queryRaw<Array<{ id: string; lines: number; payments: number; refunds: number; scope: number }>>(Prisma.sql`
    WITH refunds AS MATERIALIZED (
      SELECT r."orderId", r."processorData"->>'originalPaymentId' AS "originalPaymentId"
      FROM "Payment" r WHERE r."venueId" = ${venueId} AND r.type = 'REFUND'
    )
    SELECT o.id,
      (SELECT count(*)::int FROM "OrderItem" l WHERE l."orderId" = o.id) AS lines,
      (SELECT count(*)::int FROM "Payment" p WHERE p."venueId" = ${venueId} AND p."orderId" = o.id
        AND p.status = 'COMPLETED' AND (p.type IS NULL OR p.type <> 'REFUND')) AS payments,
      (SELECT count(*)::int FROM refunds r
        WHERE (r."orderId" = o.id OR r."originalPaymentId" IN (
          SELECT p.id FROM "Payment" p WHERE p."venueId" = ${venueId} AND p."orderId" = o.id
            AND p.status = 'COMPLETED' AND (p.type IS NULL OR p.type <> 'REFUND')
        ))) AS refunds,
      (WITH RECURSIVE ancestors(id) AS (
        SELECT o.id
        UNION
        SELECT parent.id FROM ancestors child
        JOIN "Payment" credit ON credit."orderId" = child.id AND credit."venueId" = ${venueId}
        JOIN "ExchangeCreditLink" link ON link."creditPaymentId" = credit.id AND link."venueId" = ${venueId}
        JOIN "Payment" root ON root.id = link."originPaymentId" AND root."venueId" = ${venueId}
        JOIN "Order" parent ON parent.id = root."orderId" AND parent."venueId" = ${venueId}
      ) SELECT count(*)::int FROM (SELECT id FROM ancestors LIMIT ${MAX_ORDER_LOCK_SCOPE + 1}) scope) AS scope
    FROM "Order" o WHERE o."venueId" = ${venueId} AND o.id IN (${Prisma.join(orderIds)})
  `)
  const charged = await leerCobradoDeLasOrdenes(
    db,
    venueId,
    sizes.map(o => o.id),
  )
  const eligible = sizes.filter(
    o =>
      o.lines <= TOPES_POR_ORDEN.renglones &&
      o.payments <= MAX_EXCHANGE_SALE_PAYMENTS &&
      o.refunds <= TOPES_POR_ORDEN.movimientos &&
      charged.get(o.id)?.motivo !== NO_SE_PUEDE_POR_ARTICULOS.TOPE,
  )
  if (!eligible.length) return result
  const ids = eligible.map(o => o.id)
  const orders = await db.order.findMany({ take: ids.length, where: { venueId, id: { in: ids } }, select: ORDER_SELECT })
  const lines = await db.orderItem.findMany({
    take: eligible.reduce<number>((sum, o) => sum + o.lines, 0),
    where: { orderId: { in: ids }, order: { venueId } },
    orderBy: [{ orderId: 'asc' }, { id: 'asc' }],
    include: LINE_INCLUDE,
  })
  const payments = await db.payment.findMany({
    take: eligible.reduce<number>((sum, o) => sum + o.payments, 0),
    where: { venueId, orderId: { in: ids }, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { tenderType: { select: { systemKind: true } } },
  })
  const refunds = await db.payment.findMany({
    take: eligible.reduce<number>((sum, o) => sum + o.refunds, 0),
    where: {
      venueId,
      type: 'REFUND',
      OR: [{ orderId: { in: ids } }, ...payments.map(p => ({ processorData: { path: ['originalPaymentId'], equals: p.id } }))],
    },
    select: { ...REFUND_SELECT, orderId: true },
  })
  // Quantities follow the order, in every status; monetary capacity follows originalPaymentId instead.
  const returned = await db.$queryRaw<Array<{ orderId: string; processorData: Prisma.JsonValue }>>(Prisma.sql`
    SELECT "orderId", jsonb_build_object('refundedItems', "processorData"->'refundedItems') AS "processorData"
    FROM "Payment" WHERE "venueId" = ${venueId} AND "orderId" IN (${Prisma.join(ids)}) AND type = 'REFUND'
    ORDER BY "createdAt" ASC, id ASC LIMIT ${eligible.reduce((sum, o) => sum + o.refunds, 0)}
  `)
  const contexts = await db.payment.findMany({
    take: detailPaymentIds.length,
    where: { venueId, orderId: { in: ids }, id: { in: detailPaymentIds } },
    select: { id: true, orderId: true },
  })
  const links = await db.exchangeCreditLink.findMany({
    take: payments.length + contexts.length,
    where: { venueId, creditPaymentId: { in: [...payments.map(p => p.id), ...contexts.map(p => p.id)] } },
  })
  const roots = await db.payment.findMany({
    take: links.length,
    where: { venueId, id: { in: links.map(l => l.originPaymentId) } },
    include: { tenderType: { select: { systemKind: true } } },
  })
  const linesByOrder = new Map(ids.map(id => [id, [] as typeof lines]))
  const paymentsByOrder = new Map(ids.map(id => [id, [] as typeof payments]))
  const refundsByOrder = new Map(ids.map(id => [id, [] as Array<Omit<(typeof refunds)[number], 'orderId'>>]))
  const returnedByOrder = new Map(ids.map(id => [id, [] as typeof returned]))
  const orderByPayment = new Map([...payments, ...contexts].map(p => [p.id, p.orderId]))
  for (const line of lines) linesByOrder.get(line.orderId)!.push(line)
  for (const payment of payments) paymentsByOrder.get(payment.orderId)!.push(payment)
  for (const { orderId, ...row } of refunds) {
    const originalId = (row.processorData as Record<string, unknown> | null)?.originalPaymentId
    const originalOrderId = typeof originalId === 'string' ? orderByPayment.get(originalId) : undefined
    for (const id of new Set([orderId, originalOrderId])) if (id) refundsByOrder.get(id)?.push(row)
  }
  for (const row of returned) returnedByOrder.get(row.orderId)!.push(row)
  const linksByOrder = new Map(ids.map(id => [id, [] as typeof links]))
  for (const link of links) {
    const id = orderByPayment.get(link.creditPaymentId)
    if (id) linksByOrder.get(id)!.push(link)
  }
  const scopeByOrder = new Map(eligible.map(o => [o.id, o.scope]))
  for (const order of orders) {
    const sale = buildSale(
      venueId,
      order,
      linesByOrder.get(order.id)!,
      paymentsByOrder.get(order.id)!,
      refundsByOrder.get(order.id)!,
      linksByOrder.get(order.id)!,
      roots,
      charged.get(order.id)!,
      collectExistingRefundedItems(returnedByOrder.get(order.id)!),
    )
    if (scopeByOrder.get(order.id)! > MAX_ORDER_LOCK_SCOPE) sale.orderLockScopeTooLarge = true
    result.set(order.id, sale)
  }
  return result
}

export async function loadSaleForExchange(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
  orderId: string,
  detailPaymentId?: string,
): Promise<SaleForExchange & { catalogProducts: Map<string, Product> }> {
  const order = await db.order.findFirst({
    where: { venueId, id: orderId },
    select: ORDER_SELECT,
  })
  if (!order) throw new NotFoundError('No se encontró la venta en esta sucursal.')
  const lines = await db.orderItem.findMany({
    take: TOPES_POR_ORDEN.renglones + 1,
    where: { orderId, order: { venueId } },
    orderBy: { id: 'asc' },
    include: LINE_INCLUDE,
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
  const sale = buildSale(
    venueId,
    order,
    lines,
    payments,
    refunds,
    links,
    roots,
    await leerCobradoDeLaOrden(db, orderId),
    await refundedItemsOfOrder(db, venueId, orderId),
  )
  if (sale.settlementUnavailable)
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'No se pudo comprobar el origen de este crédito de cambio.', 422)
  return sale
}

function buildSale(
  venueId: string,
  order: Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>,
  lines: Prisma.OrderItemGetPayload<{ include: typeof LINE_INCLUDE }>[],
  payments: Prisma.PaymentGetPayload<{ include: { tenderType: { select: { systemKind: true } } } }>[],
  refunds: Prisma.PaymentGetPayload<{ select: typeof REFUND_SELECT }>[],
  links: Prisma.ExchangeCreditLinkGetPayload<object>[],
  roots: Prisma.PaymentGetPayload<{ include: { tenderType: { select: { systemKind: true } } } }>[],
  charged: SaleForExchange['charged'],
  returnedByLine: SaleForExchange['returnedByLine'],
): LoadedSaleForExchange {
  const rootById = new Map(roots.map(p => [p.id, p]))
  const linkById = new Map(links.map(l => [l.creditPaymentId, l]))
  const settlementUnavailable = payments.some(p => {
    const link = linkById.get(p.id)
    return (link && !rootById.has(link.originPaymentId)) || (p.tenderType?.systemKind === 'EXCHANGE_CREDIT' && !link)
  })
  return {
    ...(settlementUnavailable ? { settlementUnavailable: true } : {}),
    catalogProducts: new Map(lines.flatMap(l => (l.product?.venueId === venueId ? [[l.product.id, l.product] as const] : []))),
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
    charged,
    returnedByLine,
    chainByPaymentId: new Map(links.map(link => [link.creditPaymentId, { link, root: rootById.get(link.originPaymentId) }])),
    payments: payments.map(p => {
      const link = linkById.get(p.id)
      const root = link ? rootById.get(link.originPaymentId) : p
      const ownRefunds = refunds.filter(r => (r.processorData as Record<string, unknown> | null)?.originalPaymentId === p.id)
      return {
        id: p.id,
        createdAt: p.createdAt,
        amountCents: cents(p.amount),
        tenderLabel: p.tenderLabel,
        saleRemainingCents: effectiveExchangeCapacity({
          amountCents: cents(p.amount),
          tipCents: p.tipAmount ? cents(p.tipAmount) : 0,
          processorData: p.processorData,
          refunds: ownRefunds,
        }),
        tipCents: p.tipAmount ? cents(p.tipAmount) : 0,
        processorData: p.processorData,
        refunds: ownRefunds,
        saleRefundedCents: centavosDevueltosPorComponente(ownRefunds).salesCents,
        money: moneyOf(p),
        rootPaymentId: (root ?? p).id,
        rootMoney: moneyOf(root ?? p),
      }
    }),
  }
}

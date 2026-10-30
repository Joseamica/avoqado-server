import { Prisma } from '@prisma/client'
import { WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT } from '@/services/exchanges/exchangeMarks'

export async function isOrderFullyReversed(orderId: string, venueId: string, db: Prisma.TransactionClient): Promise<boolean> {
  const order = await db.order.findUnique({
    where: { id: orderId, venueId },
    select: { status: true, paymentStatus: true, total: true, tipAmount: true },
  })
  if (!order) return false

  if (order.status === 'CANCELLED' || order.status === 'DELETED') return true
  if (order.paymentStatus === 'REFUNDED') return true

  const merchandiseTotal = Math.max(0, Number(order.total) - Number(order.tipAmount ?? 0))
  if (merchandiseTotal <= 0.01) return false

  // Sin las devoluciones de crédito de cambio (spec §7.6): lo que pasó a la venta nueva no regresó a la clienta.
  const refunds = await db.payment.findMany({
    where: { orderId, venueId, type: 'REFUND', status: 'COMPLETED', AND: [WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT] },
    select: { amount: true },
  })
  const totalRefundedSale = refunds.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0)
  return totalRefundedSale >= merchandiseTotal - 0.01
}

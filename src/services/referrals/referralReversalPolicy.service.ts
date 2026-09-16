import { Prisma } from '@prisma/client'

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

  const refunds = await db.payment.findMany({
    where: { orderId, venueId, type: 'REFUND', status: 'COMPLETED' },
    select: { amount: true },
  })
  const totalRefundedSale = refunds.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0)
  return totalRefundedSale >= merchandiseTotal - 0.01
}

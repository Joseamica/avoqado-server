/**
 * Dashboard Reports Service
 *
 * Financial and operational reports for venue management.
 */

import prisma from '@/utils/prismaClient'

/**
 * Pay-Later Aging Report
 *
 * Returns all pay-later orders grouped by age brackets (0-30, 31-60, 61-90, 90+ days)
 * with summary totals and detailed order information.
 */
export async function getPayLaterAgingReport(venueId: string) {
  const now = new Date()

  // Helper function to calculate days old
  const daysOld = (date: Date) => {
    const diffMs = now.getTime() - date.getTime()
    return Math.floor(diffMs / (1000 * 60 * 60 * 24))
  }

  // Fetch all pay-later orders (PENDING/PARTIAL + has customer)
  const payLaterOrders = await prisma.order.findMany({
    where: {
      venueId,
      paymentStatus: { in: ['PENDING', 'PARTIAL'] },
      remainingBalance: { gt: 0 },
      status: { not: 'CANCELLED' },
      orderCustomers: { some: {} }, // Must have customer linkage
    },
    include: {
      orderCustomers: {
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
        },
      },
      table: {
        select: {
          number: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' }, // Oldest first
  })

  // Categorize by age
  const aging_0_30 = payLaterOrders.filter(o => daysOld(o.createdAt) <= 30)
  const aging_31_60 = payLaterOrders.filter(o => daysOld(o.createdAt) > 30 && daysOld(o.createdAt) <= 60)
  const aging_61_90 = payLaterOrders.filter(o => daysOld(o.createdAt) > 60 && daysOld(o.createdAt) <= 90)
  const aging_90_plus = payLaterOrders.filter(o => daysOld(o.createdAt) > 90)

  // Helper to sum remaining balance
  const sumBalance = (orders: typeof payLaterOrders) => orders.reduce((sum, o) => sum + Number(o.remainingBalance), 0)

  // Format orders for response
  const formatOrders = (orders: typeof payLaterOrders) =>
    orders.map(o => ({
      id: o.id,
      orderNumber: o.orderNumber,
      total: Number(o.total),
      paidAmount: Number(o.paidAmount),
      remainingBalance: Number(o.remainingBalance),
      daysOld: daysOld(o.createdAt),
      createdAt: o.createdAt,
      tableName: o.table?.number || null,
      customer: o.orderCustomers[0]
        ? {
            name: `${o.orderCustomers[0].customer.firstName} ${o.orderCustomers[0].customer.lastName}`.trim(),
            phone: o.orderCustomers[0].customer.phone,
          }
        : null,
    }))

  return {
    summary: {
      aging_0_30_total: sumBalance(aging_0_30),
      aging_0_30_count: aging_0_30.length,
      aging_31_60_total: sumBalance(aging_31_60),
      aging_31_60_count: aging_31_60.length,
      aging_61_90_total: sumBalance(aging_61_90),
      aging_61_90_count: aging_61_90.length,
      aging_90_plus_total: sumBalance(aging_90_plus),
      aging_90_plus_count: aging_90_plus.length,
      total_balance: sumBalance(payLaterOrders),
      total_count: payLaterOrders.length,
    },
    orders: {
      aging_0_30: formatOrders(aging_0_30),
      aging_31_60: formatOrders(aging_31_60),
      aging_61_90: formatOrders(aging_61_90),
      aging_90_plus: formatOrders(aging_90_plus),
    },
  }
}

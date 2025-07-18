import prisma from '../../utils/prismaClient'
import { Order } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'

/**
 * Get all open orders (orders) for a venue
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @returns Array of orders with payment status PENDING or PARTIAL
 */
export async function getOrders(orgId: string, venueId: string): Promise<Order[]> {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      paymentStatus: {
        in: ['PENDING', 'PARTIAL'], // Equivalent to legacy 'OPEN' status
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
        },
      },
      payments: {
        include: {
          allocations: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  return orders
}

/**
 * Get a specific order (order) by ID
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param orderId Order ID (Order ID)
 * @returns Order with detailed payment information
 */
export async function getOrder(orgId: string, venueId: string, orderId: string): Promise<Order & { amount_left: number }> {
  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
      paymentStatus: {
        in: ['PENDING', 'PARTIAL'], // Equivalent to legacy 'OPEN' status
      },
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              price: true,
            },
          },
          paymentAllocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      payments: {
        include: {
          allocations: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      createdBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      servedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Calculate amount left to pay
  const orderTotal = Number(order.total || 0)
  const totalPayments = order.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const amount_left = orderTotal - totalPayments

  return {
    ...order,
    amount_left,
  }
}

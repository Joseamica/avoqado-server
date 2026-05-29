import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text, formatMoney } from '../context'

export function registerOrderTools(server: McpServer) {
  server.tool(
    'find_order',
    'Find an order by its id, or by a product serial number (ICCID/barcode) that was sold on it. Returns order number, status, total, venue, terminal and timestamps.',
    {
      orderId: z.string().optional().describe('Exact order id'),
      serialNumber: z.string().optional().describe('Serial of a sold item linked to the order'),
    },
    async ({ orderId, serialNumber }) => {
      if (!orderId && !serialNumber) return text({ error: 'Provide orderId or serialNumber' })

      let resolvedOrderId = orderId
      if (!resolvedOrderId && serialNumber) {
        const item = await prisma.serializedItem.findFirst({
          where: { serialNumber },
          select: { orderItem: { select: { orderId: true } } },
        })
        if (!item?.orderItem?.orderId) return text({ error: `No order found for serial ${serialNumber}` })
        resolvedOrderId = item.orderItem.orderId
      }

      const order = await prisma.order.findUnique({
        where: { id: resolvedOrderId },
        select: {
          id: true,
          orderNumber: true,
          type: true,
          status: true,
          total: true,
          createdAt: true,
          completedAt: true,
          venue: { select: { id: true, name: true } },
          terminal: { select: { id: true, name: true, serialNumber: true } },
          payments: { select: { id: true, amount: true, method: true, status: true, type: true } },
        },
      })
      if (!order) return text({ error: `Order ${resolvedOrderId} not found` })
      return text({ ...order, totalFormatted: formatMoney(order.total) })
    },
  )

  server.tool(
    'find_payment',
    'Find a payment by its id. Returns amount, method, status, type, venue, terminal, order and timestamp.',
    {
      paymentId: z.string().describe('Exact payment id'),
    },
    async ({ paymentId }) => {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          amount: true,
          method: true,
          status: true,
          type: true,
          createdAt: true,
          venue: { select: { id: true, name: true } },
          terminal: { select: { id: true, name: true, serialNumber: true } },
          order: { select: { id: true, orderNumber: true, status: true } },
        },
      })
      if (!payment) return text({ error: `Payment ${paymentId} not found` })
      return text({ ...payment, amountFormatted: formatMoney(payment.amount) })
    },
  )
}

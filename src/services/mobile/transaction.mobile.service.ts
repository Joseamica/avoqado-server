/**
 * Mobile Transaction Service
 *
 * Provides transaction (payment) data for the iOS/Android app.
 * Reuses query patterns from payment.dashboard.service.ts but
 * returns a lighter payload suitable for mobile clients.
 */

import { PaymentMethod, TransactionStatus } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { listRefundsForPayment } from '../dashboard/refund.dashboard.service'

export interface MobileTransactionFilters {
  search?: string
  method?: PaymentMethod
  dateFrom?: string // ISO date string
  dateTo?: string // ISO date string
}

/**
 * Get paginated transactions for a venue (mobile-optimized).
 */
export async function getTransactions(venueId: string, page: number, pageSize: number, filters?: MobileTransactionFilters) {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const whereClause: any = {
    venueId,
    status: {
      not: 'PENDING' as TransactionStatus,
    },
  }

  if (filters) {
    if (filters.method) {
      whereClause.method = filters.method
    }

    if (filters.dateFrom || filters.dateTo) {
      whereClause.createdAt = {}
      if (filters.dateFrom) {
        whereClause.createdAt.gte = new Date(filters.dateFrom)
      }
      if (filters.dateTo) {
        whereClause.createdAt.lte = new Date(filters.dateTo)
      }
    }

    if (filters.search) {
      const searchTerm = filters.search.trim()
      const searchNumber = parseFloat(searchTerm)

      whereClause.OR = [
        ...(isNaN(searchNumber) ? [] : [{ amount: { gte: searchNumber, lt: searchNumber + 1 } }]),
        { maskedPan: { contains: searchTerm, mode: 'insensitive' } },
        { referenceNumber: { contains: searchTerm, mode: 'insensitive' } },
        { authorizationNumber: { contains: searchTerm, mode: 'insensitive' } },
        {
          order: {
            orderNumber: { contains: searchTerm, mode: 'insensitive' },
          },
        },
        {
          processedBy: {
            OR: [{ firstName: { contains: searchTerm, mode: 'insensitive' } }, { lastName: { contains: searchTerm, mode: 'insensitive' } }],
          },
        },
      ]
    }
  }

  const [payments, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        method: true,
        status: true,
        cardBrand: true,
        maskedPan: true,
        referenceNumber: true,
        createdAt: true,
        order: {
          select: {
            orderNumber: true,
          },
        },
        processedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  return {
    data: payments.map(p => ({
      id: p.id,
      amount: Number(p.amount),
      tipAmount: Number(p.tipAmount),
      method: p.method,
      status: p.status,
      cardBrand: p.cardBrand,
      maskedPan: p.maskedPan,
      referenceNumber: p.referenceNumber,
      createdAt: p.createdAt.toISOString(),
      orderNumber: p.order?.orderNumber ?? null,
      staffName: p.processedBy ? `${p.processedBy.firstName ?? ''} ${p.processedBy.lastName ?? ''}`.trim() : null,
    })),
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Get full transaction detail with order items.
 */
export async function getTransactionDetail(venueId: string, paymentId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      venueId,
    },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      method: true,
      status: true,
      cardBrand: true,
      maskedPan: true,
      referenceNumber: true,
      authorizationNumber: true,
      createdAt: true,
      processedBy: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      order: {
        select: {
          orderNumber: true,
          items: {
            select: {
              id: true,
              productName: true,
              quantity: true,
              unitPrice: true,
              total: true,
              product: {
                select: {
                  name: true,
                  imageUrl: true,
                  trackInventory: true,
                },
              },
              modifiers: {
                select: {
                  name: true,
                  price: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  const refunds = payment.status !== 'PENDING' && payment.status !== 'REFUNDED' ? await listRefundsForPayment(venueId, payment.id) : []

  const refundedTotal = refunds.reduce((sum, refund) => sum + Math.abs(Number(refund.amount) || 0), 0)
  const remainingRefundable = Math.max(0, Number(payment.amount) + Number(payment.tipAmount) - refundedTotal)

  // Aggregate per-orderItemId refund totals across all refunds for this payment.
  // Used by the mobile UI to mark lines as "Reembolsado" / "N de X ya reembolsado"
  // and to clamp the stepper max to the remaining refundable quantity per line.
  type PerItemRefund = { quantity: number; amount: number }
  const refundedByOrderItemId = new Map<string, PerItemRefund>()
  for (const refund of refunds) {
    const pd = (refund.processorData as Record<string, unknown> | null) ?? {}
    const refundedItems = Array.isArray(pd.refundedItems) ? (pd.refundedItems as Array<Record<string, unknown>>) : []
    for (const ri of refundedItems) {
      const orderItemId = typeof ri.orderItemId === 'string' ? ri.orderItemId : null
      if (!orderItemId) continue
      const qty = Number(ri.quantity) || 0
      const amountCents =
        typeof ri.amountCents === 'number' ? ri.amountCents : typeof ri.amount === 'number' ? Math.round(ri.amount * 100) : 0
      const current = refundedByOrderItemId.get(orderItemId) ?? { quantity: 0, amount: 0 }
      current.quantity += qty
      current.amount += amountCents / 100
      refundedByOrderItemId.set(orderItemId, current)
    }
  }

  return {
    id: payment.id,
    amount: Number(payment.amount),
    tipAmount: Number(payment.tipAmount),
    method: payment.method,
    status: payment.status,
    cardBrand: payment.cardBrand,
    maskedPan: payment.maskedPan,
    referenceNumber: payment.referenceNumber,
    authorizationNumber: payment.authorizationNumber,
    createdAt: payment.createdAt.toISOString(),
    orderNumber: payment.order?.orderNumber ?? null,
    staffName: payment.processedBy ? `${payment.processedBy.firstName ?? ''} ${payment.processedBy.lastName ?? ''}`.trim() : null,
    remainingRefundable,
    refunds: refunds.map(refund => {
      const processorData = (refund.processorData as Record<string, unknown>) || {}
      return {
        id: refund.id,
        amount: Math.abs(Number(refund.amount) || 0),
        reason: typeof processorData.refundReason === 'string' ? processorData.refundReason : null,
        createdAt: refund.createdAt.toISOString(),
        status: refund.status,
      }
    }),
    items: (payment.order?.items ?? []).map(item => {
      const prior = refundedByOrderItemId.get(item.id) ?? { quantity: 0, amount: 0 }
      const refundedQty = Math.min(prior.quantity, item.quantity)
      const remainingQty = Math.max(0, item.quantity - refundedQty)
      return {
        id: item.id,
        productName: item.productName ?? item.product?.name ?? 'Producto',
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
        productImageUrl: item.product?.imageUrl ?? null,
        trackInventory: item.product?.trackInventory ?? false,
        refundedQty,
        refundedAmount: Math.round(prior.amount * 100) / 100,
        remainingQty,
        modifiers: item.modifiers.map(m => ({
          name: m.name,
          price: Number(m.price),
        })),
      }
    }),
  }
}

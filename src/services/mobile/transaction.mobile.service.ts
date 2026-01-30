/**
 * Mobile Transaction Service
 *
 * Provides transaction (payment) data for the iOS/Android app.
 * Reuses query patterns from payment.dashboard.service.ts but
 * returns a lighter payload suitable for mobile clients.
 */

import { TransactionStatus, PaymentMethod } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

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
    items: (payment.order?.items ?? []).map(item => ({
      id: item.id,
      productName: item.productName ?? item.product?.name ?? 'Producto',
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      total: Number(item.total),
      productImageUrl: item.product?.imageUrl ?? null,
      modifiers: item.modifiers.map(m => ({
        name: m.name,
        price: Number(m.price),
      })),
    })),
  }
}

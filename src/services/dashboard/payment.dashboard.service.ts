// services/dashboard/payment.dashboard.service.ts

import { TransactionStatus, PaymentMethod, CardBrand, CardEntryMode } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { PaginatedPaymentsResponse } from '../../schemas/dashboard/payment.schema'
import { logAction } from './activity-log.service'
import { MINDFORM_NEW_VENUE_ID, getLegacyPayments } from '../legacy/qrPayments.legacy.service'
import logger from '../../config/logger'

export interface PaymentFilters {
  // Multi-select filter arrays (preferred)
  merchantAccountIds?: string[]
  methods?: PaymentMethod[]
  sources?: string[]
  staffIds?: string[]
  // Single-value filters kept for backward compatibility (TPV, scripts, etc.)
  merchantAccountId?: string
  method?: PaymentMethod
  source?: string
  staffId?: string
  search?: string
  startDate?: string
  endDate?: string
}

export async function getPaymentsData(
  venueId: string,
  page: number,
  pageSize: number,
  filters?: PaymentFilters,
): Promise<PaginatedPaymentsResponse> {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  // Calculamos skip y take aquí para mantener la lógica de paginación en el servicio
  const skip = (page - 1) * pageSize
  const take = pageSize

  // La cláusula 'where' será la misma para la búsqueda y el conteo
  const whereClause: any = {
    venueId,
    status: {
      not: 'PENDING' as TransactionStatus, // No mostrar pagos pendientes de completar
    },
  }

  // Aplicar filtros opcionales (arrays have priority over single values)
  if (filters) {
    if (filters.merchantAccountIds && filters.merchantAccountIds.length > 0) {
      whereClause.merchantAccountId = { in: filters.merchantAccountIds }
    } else if (filters.merchantAccountId) {
      whereClause.merchantAccountId = filters.merchantAccountId
    }

    if (filters.methods && filters.methods.length > 0) {
      whereClause.method = { in: filters.methods }
    } else if (filters.method) {
      whereClause.method = filters.method
    }

    if (filters.sources && filters.sources.length > 0) {
      whereClause.source = { in: filters.sources }
    } else if (filters.source) {
      whereClause.source = filters.source
    }

    if (filters.staffIds && filters.staffIds.length > 0) {
      whereClause.processedById = { in: filters.staffIds }
    } else if (filters.staffId) {
      whereClause.processedById = filters.staffId
    }

    if (filters.startDate || filters.endDate) {
      whereClause.createdAt = {}
      if (filters.startDate) {
        whereClause.createdAt.gte = new Date(filters.startDate)
      }
      if (filters.endDate) {
        whereClause.createdAt.lte = new Date(filters.endDate)
      }
    }

    // Búsqueda por texto (amount, reference, last4, waiter name)
    if (filters.search) {
      const searchTerm = filters.search.trim()
      const searchNumber = parseFloat(searchTerm)

      whereClause.OR = [
        // Búsqueda por monto (amount o tipAmount)
        ...(isNaN(searchNumber)
          ? []
          : [{ amount: { gte: searchNumber, lt: searchNumber + 1 } }, { tipAmount: { gte: searchNumber, lt: searchNumber + 1 } }]),
        // Búsqueda por masked pan (últimos dígitos de tarjeta)
        { maskedPan: { contains: searchTerm, mode: 'insensitive' } },
        // Búsqueda por número de referencia
        { referenceNumber: { contains: searchTerm, mode: 'insensitive' } },
        // Búsqueda por número de autorización
        { authorizationNumber: { contains: searchTerm, mode: 'insensitive' } },
        // Búsqueda por nombre del mesero
        {
          processedBy: {
            OR: [{ firstName: { contains: searchTerm, mode: 'insensitive' } }, { lastName: { contains: searchTerm, mode: 'insensitive' } }],
          },
        },
      ]
    }
  }

  // ─── MindForm legacy QR bridge — short-circuit pagination ───
  // For MindForm we CANNOT use Prisma's skip/take here, because we need to
  // merge its legacy payments with the new-system ones before slicing the
  // current page. Otherwise page N of the new data + all legacy gets sliced
  // wrong and later pages end up almost empty.
  // MindForm's total volume is small (hundreds), so we fetch all rows and
  // slice in memory.
  if (venueId === MINDFORM_NEW_VENUE_ID) {
    logger.info('[Payments] MindForm detected — attempting legacy QR merge', {
      venueId,
      startDate: filters?.startDate,
      endDate: filters?.endDate,
    })

    const sharedInclude = {
      processedBy: true,
      shift: true,
      order: { include: { table: true } },
      merchantAccount: {
        include: {
          provider: { select: { id: true, code: true, name: true } },
        },
      },
      transactionCost: true,
    }

    const [allNewPayments, legacy] = await Promise.all([
      prisma.payment.findMany({
        where: whereClause,
        include: sharedInclude,
        orderBy: { createdAt: 'desc' },
      }),
      getLegacyPayments({
        startDate: filters?.startDate,
        endDate: filters?.endDate,
        search: filters?.search,
      }),
    ])

    logger.info('[Payments] Legacy merge result', {
      legacyRows: legacy.rows.length,
      legacyTotal: legacy.total,
      newRows: allNewPayments.length,
    })

    const merged = [...allNewPayments, ...legacy.rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    const combinedTotal = merged.length
    const paginated = merged.slice(skip, skip + take)

    return {
      data: paginated as any,
      meta: {
        total: combinedTotal,
        page,
        pageSize,
        pageCount: Math.ceil(combinedTotal / pageSize),
      },
    }
  }

  // Usamos $transaction para ejecutar ambas queries en paralelo en la misma versión de la BD
  const [payments, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: true, // El staff que procesó el pago
        shift: true, // Información del turno
        order: {
          include: {
            table: true, // Información de la mesa
          },
        },
        merchantAccount: {
          include: {
            provider: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        transactionCost: true, // Include profit/cost information for SUPERADMIN
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

  // Devolvemos el objeto con el formato esperado
  return {
    data: payments,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Función para obtener un solo pago, adaptada al nuevo schema.
 */
export async function getPaymentById(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      processedBy: true, // Staff que procesó el pago
      shift: true, // Información del turno
      order: {
        include: {
          table: true, // AQUÍ INCLUIMOS LA INFORMACIÓN DE LA MESA
          customer: true, // Customer associated with the order (nullable)
          items: {
            // Line items (products + custom "Otro importe" entries) with their modifiers,
            // so the mobile/web drawer can render the full breakdown.
            include: {
              modifiers: {
                include: { modifier: true },
              },
            },
            orderBy: { sequence: 'asc' },
          },
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      transactionCost: true, // Include profit/cost information
      saleVerification: true, // Pre-payment verification photos
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  return payment
}

/**
 * Update a payment (SUPERADMIN only)
 * Allows editing of specific fields
 */
export interface UpdatePaymentData {
  amount?: number
  tipAmount?: number
  status?: TransactionStatus
  method?: PaymentMethod
  cardBrand?: CardBrand
  last4?: string
  maskedPan?: string
  authorizationNumber?: string
  referenceNumber?: string
  entryMode?: CardEntryMode
}

export async function updatePayment(paymentId: string, data: UpdatePaymentData) {
  // First verify the payment exists
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  // Update the payment
  const updatedPayment = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      ...(data.amount !== undefined && { amount: data.amount }),
      ...(data.tipAmount !== undefined && { tipAmount: data.tipAmount }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.method !== undefined && { method: data.method }),
      ...(data.cardBrand !== undefined && { cardBrand: data.cardBrand }),
      ...(data.last4 !== undefined && { last4: data.last4 }),
      ...(data.maskedPan !== undefined && { maskedPan: data.maskedPan }),
      ...(data.authorizationNumber !== undefined && { authorizationNumber: data.authorizationNumber }),
      ...(data.referenceNumber !== undefined && { referenceNumber: data.referenceNumber }),
      ...(data.entryMode !== undefined && { entryMode: data.entryMode }),
    },
    include: {
      processedBy: true,
      shift: true,
      order: {
        include: {
          table: true,
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      transactionCost: true,
    },
  })

  logAction({
    venueId: updatedPayment.venueId,
    action: 'PAYMENT_UPDATED',
    entity: 'Payment',
    entityId: updatedPayment.id,
    data: { status: updatedPayment.status, method: updatedPayment.method, amount: updatedPayment.amount },
  })

  return updatedPayment
}

/**
 * Delete a payment (SUPERADMIN only)
 * This is a hard delete - use with caution
 */
export async function deletePayment(paymentId: string): Promise<void> {
  // First verify the payment exists
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactionCost: true,
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  // Delete related records first (cascading)
  await prisma.$transaction(async tx => {
    // Delete transaction cost if exists
    if (payment.transactionCost) {
      await tx.transactionCost.delete({
        where: { id: payment.transactionCost.id },
      })
    }

    // Delete digital receipts associated with this payment
    await tx.digitalReceipt.deleteMany({
      where: { paymentId },
    })

    // Finally delete the payment itself
    await tx.payment.delete({
      where: { id: paymentId },
    })
  })

  logAction({
    venueId: payment.venueId,
    action: 'PAYMENT_DELETED',
    entity: 'Payment',
    entityId: paymentId,
    data: { amount: payment.amount, method: payment.method },
  })
}

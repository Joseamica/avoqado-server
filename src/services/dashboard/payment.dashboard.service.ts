// services/dashboard/payment.dashboard.service.ts

import { TransactionStatus, PaymentMethod, CardBrand, CardEntryMode } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { PaginatedPaymentsResponse } from '../../schemas/dashboard/payment.schema'

export interface PaymentFilters {
  merchantAccountId?: string
  method?: PaymentMethod
  source?: string
  staffId?: string
  search?: string
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

  // Aplicar filtros opcionales
  if (filters) {
    if (filters.merchantAccountId) {
      whereClause.merchantAccountId = filters.merchantAccountId
    }

    if (filters.method) {
      whereClause.method = filters.method
    }

    if (filters.source) {
      whereClause.source = filters.source
    }

    if (filters.staffId) {
      whereClause.processedById = filters.staffId
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
}

// services/dashboard/payment.dashboard.service.ts

import { TransactionStatus } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { PaginatedPaymentsResponse } from '../../schemas/dashboard/payment.schema'

export async function getPaymentsData(venueId: string, page: number, pageSize: number): Promise<PaginatedPaymentsResponse> {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  // Calculamos skip y take aquí para mantener la lógica de paginación en el servicio
  const skip = (page - 1) * pageSize
  const take = pageSize

  // La cláusula 'where' será la misma para la búsqueda y el conteo
  const whereClause = {
    venueId,
    status: {
      not: 'PENDING' as TransactionStatus, // No mostrar pagos pendientes de completar
    },
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
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  return payment
}

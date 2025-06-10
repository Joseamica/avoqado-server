// services/dashboard/order.dashboard.service.ts

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { PaginatedOrdersResponse } from '../../schemas/dashboard/order.schena'
import { Order } from '@prisma/client'

export async function getOrders(venueId: string, page: number, pageSize: number): Promise<PaginatedOrdersResponse> {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const whereClause = { venueId }

  const [orders, total] = await prisma.$transaction([
    prisma.order.findMany({
      where: whereClause,
      // Incluimos relaciones para obtener datos como el nombre del mesero y la mesa
      include: {
        createdBy: true, // Quien creó la orden (equivale al mesero)
        servedBy: true, // Quien atendió la orden
        table: true, // Para obtener el número de la mesa
      },
      orderBy: {
        updatedAt: 'desc', // Ordenamos por la última actualización
      },
      skip,
      take,
    }),
    prisma.order.count({
      where: whereClause,
    }),
  ])

  return {
    data: orders,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}
/**
 * Obtener una orden por su ID con todos sus detalles.
 */
export async function getOrderById(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      createdBy: true,
      servedBy: true,
      table: true,
      payments: {
        // Incluimos los pagos asociados
        include: {
          processedBy: true, // Y quién procesó cada pago
        },
      },
      items: {
        // Incluimos los productos de la orden
        include: {
          product: true,
        },
      },
    },
  })

  if (!order) {
    throw new NotFoundError(`Order with ID ${orderId} not found`)
  }
  return order
}

/**
 * Actualizar una orden.
 * NOTA: Por seguridad, solo deberías permitir actualizar ciertos campos.
 */
export async function updateOrder(orderId: string, data: Partial<Order>) {
  // Aquí puedes validar qué campos se pueden actualizar, ej: status, customerName
  const { status, customerName } = data // Solo extraemos los campos permitidos

  return prisma.order.update({
    where: { id: orderId },
    data: {
      status,
      customerName,
      // No permitir actualizar montos directamente desde aquí
    },
  })
}

/**
 * Eliminar una orden.
 */
export async function deleteOrder(orderId: string) {
  // Podrías añadir lógica aquí para asegurar que solo se borren órdenes canceladas, etc.
  return prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
    },
  })
}

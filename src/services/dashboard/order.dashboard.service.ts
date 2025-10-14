// services/dashboard/order.dashboard.service.ts

import { NotFoundError } from '../../errors/AppError'
import { PaginatedOrdersResponse } from '../../schemas/dashboard/order.schema'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { Order } from '@prisma/client'
import { deductStockForRecipe } from './rawMaterial.service'

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

  // Get the current order to check previous status
  const currentOrder = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, venueId: true },
  })

  if (!currentOrder) {
    throw new NotFoundError(`Order with ID ${orderId} not found`)
  }

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      status,
      customerName,
      ...(status === 'COMPLETED' && { completedAt: new Date() }),
      // No permitir actualizar montos directamente desde aquí
    },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  const isNewlyCompleted = currentOrder.status !== 'COMPLETED' && status === 'COMPLETED'

  if (isNewlyCompleted) {
    try {
      logger.info('🎯 Starting inventory deduction for completed order (dashboard)', {
        orderId,
        venueId: updatedOrder.venueId,
        itemCount: updatedOrder.items.length,
        previousStatus: currentOrder.status,
        newStatus: status,
      })

      // Deduct stock for each product in the order
      for (const item of updatedOrder.items) {
        try {
          await deductStockForRecipe(updatedOrder.venueId, item.productId, item.quantity, orderId)

          logger.info('✅ Stock deducted successfully for product (dashboard)', {
            orderId,
            productId: item.productId,
            productName: item.product.name,
            quantity: item.quantity,
          })
        } catch (deductionError: any) {
          // Log individual product deduction errors but continue with other products
          logger.warn('⚠️ Failed to deduct stock for product - continuing with order (dashboard)', {
            orderId,
            productId: item.productId,
            productName: item.product.name,
            quantity: item.quantity,
            error: deductionError.message,
            reason: deductionError.message.includes('does not have a recipe')
              ? 'NO_RECIPE'
              : deductionError.message.includes('Insufficient stock')
                ? 'INSUFFICIENT_STOCK'
                : 'UNKNOWN',
          })
        }
      }

      logger.info('🎯 Inventory deduction completed for order (dashboard)', {
        orderId,
        totalItems: updatedOrder.items.length,
      })
    } catch (inventoryError) {
      // Log overall inventory deduction errors but don't fail the order update
      logger.error('❌ Failed to complete inventory deduction for order (dashboard)', {
        orderId,
        error: inventoryError,
      })
      // Order update is still successful - inventory deduction failure is logged but not critical
    }
  }

  return updatedOrder
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

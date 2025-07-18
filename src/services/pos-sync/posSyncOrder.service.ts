import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Order, OrderSource, OrderStatus, OriginSystem, Prisma, SyncStatus, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { posSyncStaffService } from './posSyncStaff.service'
import { getOrCreatePosTable } from './posSyncTable.service'
import { getOrCreatePosShift } from './posSyncShift.service'
import { RichPosPayload, PosPaymentMethod } from '@/types/pos.types'
import { PaymentMethod } from '@prisma/client'

/**
 * Procesa un evento de creación/actualización de una Orden desde el POS.
 * @param payload - Los datos mapeados de la orden desde el producer.
 */
export async function processPosOrderEvent(payload: RichPosPayload): Promise<Order> {
  const { venueId, orderData, staffData, tableData, shiftData, payments, paymentMethodsCatalog } = payload
  const { externalId } = orderData
  logger.info(`[🥾 PosSyncOrder] Procesando orden ${externalId} para Venue ${venueId}`)
  // logger.info(JSON.stringify(payload))

  const venue = await prisma.venue.findUnique({ where: { id: venueId } })
  if (!venue) {
    throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)
  }

  // 1. Sincronizar entidades relacionadas para obtener sus IDs de Prisma
  const staffId = await posSyncStaffService.syncPosStaff(staffData, venue.id, venue.organizationId)
  const tableId = await getOrCreatePosTable(tableData, venue.id) // Pasamos areaData
  const shiftId = await getOrCreatePosShift(shiftData, venue.id, staffId)

  // 2. Ejecutar el upsert final de la Orden
  return prisma.$transaction(async tx => {
    const order = await tx.order.upsert({
      where: {
        venueId_externalId: {
          venueId: venue.id,
          externalId: externalId,
        },
      },
      update: {
        status: orderData.status,
        paymentStatus: orderData.paymentStatus,
        subtotal: orderData.subtotal,
        taxAmount: orderData.taxAmount,
        discountAmount: orderData.discountAmount,
        tipAmount: orderData.tipAmount,
        total: orderData.total,
        completedAt: orderData.completedAt ? new Date(orderData.completedAt) : null,
        posRawData: orderData.posRawData as Prisma.InputJsonValue,
        syncedAt: new Date(),
        syncStatus: SyncStatus.SYNCED,
      },
      create: {
        externalId: externalId,
        orderNumber: orderData.orderNumber,
        source: OrderSource.POS,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        createdAt: new Date(orderData.createdAt),
        syncedAt: new Date(),
        status: orderData.status,
        paymentStatus: orderData.paymentStatus,
        subtotal: orderData.subtotal,
        taxAmount: orderData.taxAmount,
        discountAmount: orderData.discountAmount,
        tipAmount: orderData.tipAmount,
        total: orderData.total,
        posRawData: orderData.posRawData as Prisma.InputJsonValue,
        kitchenStatus: 'PENDING',
        type: 'DINE_IN',
        venue: { connect: { id: venue.id } },
        ...(staffId && { servedBy: { connect: { id: staffId } }, createdBy: { connect: { id: staffId } } }),
        ...(tableId && { table: { connect: { id: tableId } } }),
        ...(shiftId && { shift: { connect: { id: shiftId } } }),
        syncStatus: SyncStatus.SYNCED,
      },
    })

    logger.info(`[🥾 PosSyncOrder] Orden ${order.id} (externalId: ${order.externalId}) guardada/actualizada.`)

    // 2b. LÓGICA DE PAGOS MEJORADA
    if (order.paymentStatus === 'PAID' && payments && payments.length > 0) {
      logger.info(`[🥾 PosSyncOrder] La orden ${order.id} está pagada. Procesando ${payments.length} pago(s)...`)

      // Verificación de idempotencia (sin cambios)
      const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
      if (existingPayments > 0) {
        logger.warn(`[🥾 PosSyncOrder] Ya existen ${existingPayments} pagos para la orden ${order.id}. Saltando creación.`)
        return order
      }

      // Asegurarnos de que el catálogo de pagos vino en el payload
      if (!paymentMethodsCatalog || paymentMethodsCatalog.length === 0) {
        throw new Error('No se proporcionó el catálogo de métodos de pago para procesar los pagos.')
      }

      for (const posPayment of payments) {
        // ... (cálculo de comisiones sin cambios) ...
        const feePercentage = venue.feeValue
        const feeAmount = posPayment.amount * parseFloat(feePercentage.toString())
        const netAmount = posPayment.amount - feeAmount

        // Crear el registro de Pago (Payment)
        const newPayment = await tx.payment.create({
          data: {
            amount: posPayment.amount,
            tipAmount: posPayment.tipAmount,
            // ✅ LLAMADA A LA NUEVA FUNCIÓN DINÁMICA
            method: mapPaymentMethodFromCatalog(posPayment.methodExternalId, paymentMethodsCatalog),
            status: TransactionStatus.COMPLETED,
            feePercentage,
            feeAmount,
            netAmount,
            originSystem: OriginSystem.POS_SOFTRESTAURANT,
            posRawData: posPayment.posRawData as Prisma.InputJsonValue,
            externalId: `${order.externalId}-${posPayment.methodExternalId}`,
            venue: { connect: { id: venue.id } },
            order: { connect: { id: order.id } },
            ...(shiftId && { shift: { connect: { id: shiftId } } }),
            ...(staffId && { processedBy: { connect: { id: staffId } } }),
          },
        })

        logger.info(`[🥾 PosSyncOrder] Pago ${newPayment.id} creado para la orden ${order.id}.`)

        // Crear la asignación del pago (sin cambios)
        await tx.paymentAllocation.create({
          data: {
            amount: newPayment.amount,
            payment: { connect: { id: newPayment.id } },
            order: { connect: { id: order.id } },
          },
        })
        logger.info(`[🥾 PosSyncOrder] Asignación de pago creada para el pago ${newPayment.id}.`)
      }
    }

    return order
  })
}

/**
 * Procesa un evento de eliminación de una Orden desde el POS.
 * En lugar de borrar, actualiza el estado a DELETED.
 * @param payload - Los datos mapeados de la orden desde el producer.
 */
export async function processPosOrderDeleteEvent(payload: RichPosPayload): Promise<Order | null> {
  const { venueId, orderData } = payload
  const { externalId } = orderData

  logger.info(`[🥾 PosSyncOrder] Processing delete event for order ${externalId} at Venue ${venueId}`)

  const order = await prisma.order.findUnique({
    where: {
      venueId_externalId: {
        venueId: venueId,
        externalId: externalId,
      },
    },
  })

  if (!order) {
    logger.warn(`[🥾 PosSyncOrder] Order with externalId ${externalId} not found at Venue ${venueId} for deletion.`)
    return null
  }

  const updatedOrder = await prisma.order.update({
    where: {
      id: order.id,
    },
    data: {
      status: OrderStatus.DELETED,
      syncedAt: new Date(),
      syncStatus: SyncStatus.SYNCED,
    },
  })

  logger.info(`[🥾 PosSyncOrder] Order ${updatedOrder.id} (externalId: ${updatedOrder.externalId}) marked as DELETED.`)
  return updatedOrder
}

/**
 * Mapea un ID de método de pago del POS a nuestro enum de Prisma,
 * utilizando un catálogo dinámico proporcionado desde el POS.
 * @param posMethodId - El ID del método de pago del POS (ej. 'CRE', 'EFE').
 * @param catalog - El catálogo completo de formas de pago desde el POS.
 * @returns El enum PaymentMethod correspondiente.
 */
function mapPaymentMethodFromCatalog(posMethodId: string, catalog: PosPaymentMethod[]): PaymentMethod {
  const methodInfo = catalog.find(m => m.idformadepago.trim() === posMethodId.trim())

  if (!methodInfo) {
    logger.warn(`[🥾 PosSyncOrder] Información para el método de pago '${posMethodId}' no encontrada en el catálogo. Usando 'OTHER'.`)
    return PaymentMethod.OTHER
  }

  // La columna 'tipo' de formasdepago define la categoría del método de pago.
  // 1: Efectivo, 2: Tarjeta, 3: Vales, 4: Otros.
  switch (methodInfo.tipo) {
    case 1:
      return PaymentMethod.CASH
    case 2:
      // No podemos distinguir entre Crédito y Débito solo con el tipo.
      // Usamos una heurística basada en la descripción para ser más precisos.
      const description = methodInfo.descripcion.toUpperCase()
      if (description.includes('DEB') || description.includes('DÉBITO')) {
        return PaymentMethod.DEBIT_CARD
      }
      // Por defecto, cualquier tarjeta se considera de crédito.
      return PaymentMethod.CREDIT_CARD
    case 3: // Vales
    case 4: // Otros
    default:
      return PaymentMethod.OTHER
  }
}

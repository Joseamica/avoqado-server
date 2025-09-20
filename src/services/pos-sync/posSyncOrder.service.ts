import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Order, OrderSource, OrderStatus, OriginSystem, Prisma, SplitType, SyncStatus, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { posSyncStaffService } from './posSyncStaff.service'
import { getOrCreatePosTable } from './posSyncTable.service'
import { getOrCreatePosShift } from './posSyncShift.service'
import { RichPosPayload, PosPaymentMethod } from '@/types/pos.types'
import { PaymentMethod } from '@prisma/client'

/**
 * Encuentra una orden existente usando lógica de resolución inteligente.
 * Maneja el caso donde SoftRestaurant crea órdenes con idturno=0 inicialmente,
 * luego las actualiza al idturno real durante el pago.
 * @param externalId - El Entity ID actual de la orden
 * @param venueId - ID del venue
 * @param folio - Número de folio de la orden
 * @returns La orden existente o null si no existe
 */
async function findExistingOrderWithSmartResolution(externalId: string, venueId: string, _folio: string): Promise<Order | null> {
  // Paso 1: Buscar por el externalId exacto
  const exactMatch = await prisma.order.findUnique({
    where: {
      venueId_externalId: {
        venueId: venueId,
        externalId: externalId,
      },
    },
  })

  if (exactMatch) {
    return exactMatch
  }

  // Paso 2: Si no encontramos coincidencia exacta, implementar lógica de resolución
  // para el caso SoftRestaurant idturno=0 → idturno real
  const entityParts = externalId.split(':')
  if (entityParts.length === 3) {
    const [instanceId, currentIdTurno, orderFolio] = entityParts

    // Si el idturno actual no es 0, buscar si existe una orden con idturno=0
    if (currentIdTurno !== '0') {
      const zeroTurnoExternalId = `${instanceId}:0:${orderFolio}`

      logger.info(`[🔍 SmartResolution] Buscando orden huérfana con idturno=0: ${zeroTurnoExternalId}`)

      const orphanOrder = await prisma.order.findUnique({
        where: {
          venueId_externalId: {
            venueId: venueId,
            externalId: zeroTurnoExternalId,
          },
        },
      })

      if (orphanOrder) {
        logger.info(`[🎯 SmartResolution] ¡Orden huérfana encontrada! Actualizando externalId de ${zeroTurnoExternalId} a ${externalId}`)

        // Actualizar el externalId de la orden huérfana para que coincida con el real
        const updatedOrder = await prisma.order.update({
          where: { id: orphanOrder.id },
          data: { externalId: externalId },
        })

        return updatedOrder
      }
    }
  }

  return null
}

/**
 * Procesa un evento de creación/actualización de una Orden desde el POS.
 * Incluye lógica de resolución inteligente para manejar el caso SoftRestaurant
 * donde las órdenes se crean con idturno=0 y luego se actualizan al idturno real.
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

  // 2. Buscar orden existente con lógica de resolución inteligente
  const existingOrder = await findExistingOrderWithSmartResolution(externalId, venue.id, orderData.orderNumber)

  // 3. Ejecutar el upsert final de la Orden
  return prisma.$transaction(async tx => {
    // Si encontramos una orden existente con resolución inteligente, actualizarla
    if (existingOrder && existingOrder.externalId !== externalId) {
      // La orden existe pero con un externalId diferente (caso idturno=0 → idturno real)
      const order = await tx.order.update({
        where: { id: existingOrder.id },
        data: {
          externalId: externalId, // Actualizar al nuevo externalId
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
          ...(shiftId && { shift: { connect: { id: shiftId } } }),
        },
      })

      logger.info(
        `[🥾 PosSyncOrder] Orden ${order.id} actualizada con nuevo externalId: ${externalId} (antes: ${existingOrder.externalId})`,
      )

      // Procesar pagos si la orden está pagada
      if (order.paymentStatus === 'PAID' && payments && payments.length > 0) {
        await processPaymentsForOrder(tx, order, payments, paymentMethodsCatalog, venue, shiftId, staffId)
      }

      return order
    }

    // Si no hay orden existente o el externalId coincide, hacer upsert normal
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
      await processPaymentsForOrder(tx, order, payments, paymentMethodsCatalog, venue, shiftId, staffId)
    }

    return order
  })
}

/**
 * Procesa los pagos para una orden
 */
async function processPaymentsForOrder(
  tx: any,
  order: Order,
  payments: any[],
  paymentMethodsCatalog: PosPaymentMethod[],
  venue: any,
  shiftId: string | null,
  staffId: string | null,
) {
  logger.info(`[🥾 PosSyncOrder] La orden ${order.id} está pagada. Procesando ${payments.length} pago(s)...`)

  // Verificación de idempotencia
  const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
  if (existingPayments > 0) {
    logger.warn(`[🥾 PosSyncOrder] Ya existen ${existingPayments} pagos para la orden ${order.id}. Saltando creación.`)
    return
  }

  // Asegurarnos de que el catálogo de pagos vino en el payload
  if (!paymentMethodsCatalog || paymentMethodsCatalog.length === 0) {
    throw new Error('No se proporcionó el catálogo de métodos de pago para procesar los pagos.')
  }

  for (const posPayment of payments) {
    const feePercentage = venue.feeValue
    const feeAmount = posPayment.amount * parseFloat(feePercentage.toString())
    const netAmount = posPayment.amount - feeAmount

    // Crear el registro de Pago (Payment)
    const newPayment = await tx.payment.create({
      data: {
        amount: posPayment.amount,
        tipAmount: posPayment.tipAmount,
        method: mapPaymentMethodFromCatalog(posPayment.methodExternalId, paymentMethodsCatalog),
        splitType: SplitType.FULLPAYMENT,
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

    // Crear la asignación del pago
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

/**
 * Procesa un evento de eliminación de una Orden desde el POS.
 * En lugar de borrar, actualiza el estado a DELETED.
 * Incluye lógica de resolución inteligente para encontrar la orden correcta.
 * @param payload - Los datos mapeados de la orden desde el producer.
 */
export async function processPosOrderDeleteEvent(payload: RichPosPayload): Promise<Order | null> {
  const { venueId, orderData } = payload
  const { externalId } = orderData

  logger.info(`[🥾 PosSyncOrder] Processing delete event for order ${externalId} at Venue ${venueId}`)

  // Usar la misma lógica de resolución inteligente para encontrar la orden
  const entityParts = externalId.split(':')
  const folio = entityParts.length === 3 ? entityParts[2] : externalId

  const order = await findExistingOrderWithSmartResolution(externalId, venueId, folio)

  if (!order) {
    logger.warn(
      `[🥾 PosSyncOrder] Order with externalId ${externalId} not found at Venue ${venueId} for deletion (even with smart resolution).`,
    )
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

  logger.info(
    `[🥾 PosSyncOrder] Order ${updatedOrder.id} (externalId: ${updatedOrder.externalId}) marked as DELETED. Original request was for: ${externalId}`,
  )
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

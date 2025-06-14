import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Order, OrderSource, OriginSystem, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { RichPosPayload } from '../../types/pos.types'
import { posSyncStaffService } from './posSyncStaff.service'
import { getOrCreatePosTable } from './posSyncTable.service'
import { getOrCreatePosShift } from './posSyncShift.service'

/**
 * Processes an order creation/update event from a POS.
 * @param payload - The mapped order data from the POS.
 */
export async function processPosOrderEvent(payload: RichPosPayload): Promise<Order> {
  logger.info(`[PosSyncOrderService] Processing order with externalId: ${payload.orderData.externalId} for venue ${payload.venueId}`)

  const { venueId, orderData, staffData, tableData, shiftData } = payload

  const venue = await prisma.venue.findUnique({ where: { id: venueId } })
  if (!venue) {
    throw new NotFoundError(`[PosSyncOrderService] Venue with ID ${venueId} not found in Avoqado database.`)
  }

  // Step 1: Synchronize and get Prisma IDs for related entities
  const staffId = await posSyncStaffService.syncPosStaff(staffData, venue.id, venue.organizationId)
  const tableId = await getOrCreatePosTable(tableData, venue.id)
  const shiftId = await getOrCreatePosShift(shiftData, venue.id, staffId)

  // Step 2: Execute the final Order upsert
  const order = await prisma.order.upsert({
    where: {
      venueId_externalId: {
        venueId: venue.id,
        externalId: orderData.externalId,
      },
    },
    update: {
      source: OrderSource.POS,
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
      updatedAt: new Date(),
    },
    create: {
      externalId: orderData.externalId,
      orderNumber: orderData.orderNumber,
      source: OrderSource.POS,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      createdAt: new Date(orderData.createdAt),
      syncedAt: new Date(),
      status: orderData.status,
      paymentStatus: orderData.paymentStatus,
      subtotal: orderData.subtotal,
      taxAmount: orderData.taxAmount,
      discountAmount: orderData.discountAmount || 0,
      tipAmount: orderData.tipAmount || 0,
      total: orderData.total || 0,
      posRawData: orderData.posRawData as Prisma.InputJsonValue,
      kitchenStatus: 'PENDING', // Default value
      type: 'DINE_IN', // Default value
      venue: { connect: { id: venue.id } },
      ...(staffId && { servedBy: { connect: { id: staffId } }, createdBy: { connect: { id: staffId } } }),
      ...(tableId && { table: { connect: { id: tableId } } }),
      ...(shiftId && { shift: { connect: { id: shiftId } } }),
    },
  })

  logger.info(`[PosSyncOrderService] Order ${order.id} (externalId: ${order.externalId}) saved/updated successfully for venue ${venue.id}.`)
  return order
}

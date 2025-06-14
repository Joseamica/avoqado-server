import { PosOrderPayload } from '@/types/pos.types'
import { Order } from '@prisma/client'
import { posSyncService } from '../../../../src/services/pos-sync/posSync.service'

/**
 * Processes a simulated POS order for testing purposes.
 * This function acts as a wrapper around the actual `processPosOrder` logic,
 * allowing it to be triggered via an HTTP endpoint for posSync tests.
 * @param payload The POS order payload.
 * @returns The created or updated order.
 */
export const processTestPosOrder = async (payload: PosOrderPayload): Promise<Order> => {
  // Convert PosOrderPayload to RichPosPayload format for posSync.service
  const richPayload = {
    venueId: payload.venueId,
    orderData: {
      externalId: payload.externalId,
      orderNumber: payload.orderNumber,
      status: 'PENDING' as const,
      paymentStatus: 'PENDING' as const,
      subtotal: payload.subtotal,
      taxAmount: payload.taxAmount,
      discountAmount: payload.discountAmount,
      tipAmount: payload.tipAmount,
      total: payload.total,
      createdAt: payload.createdAt,
      completedAt: null,
      posRawData: payload.posRawData,
    },
    staffData: {
      externalId: null,
      name: null,
      pin: null,
    },
    tableData: {
      externalId: null,
    },
    shiftData: {
      externalId: null,
      startTime: null,
    },
  }

  // Call the actual service
  const order = await posSyncService.processPosOrderEvent(richPayload)
  return order
}

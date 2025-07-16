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
    payments: [
      {
        methodExternalId: 'PAY_METHOD_1',
        amount: 100,
        tipAmount: 10,
        reference: 'REF_123',
        posRawData: {},
      },
    ],
    paymentMethodsCatalog: [
      {
        idformadepago: 'PAY_METHOD_1',
        descripcion: 'Cash',
        tipo: 1,
      },
    ],
  }

  // Call the actual service
  const order = await posSyncService.processPosOrderEvent(richPayload)
  return order
}

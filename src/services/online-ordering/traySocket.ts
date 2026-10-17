import type { OnlineOrderStatus, OrderStatus } from '@prisma/client'
import logger from '@/config/logger'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'

/**
 * Aviso en vivo a la bandeja (hoy lo escucha el panel; las apps sondean). Lo usan las transiciones y las dos sincronizaciones
 * al leer (R2 y «pagado al recoger»), siempre DESPUÉS del commit. `orderStatus` (la cuenta) va sólo cuando esa misma pasada la
 * movió (M-7). Nunca lanza.
 */
export function emitOnlineOrderUpdated(e: {
  venueId: string
  orderId: string
  orderNumber: string
  onlineStatus: OnlineOrderStatus
  orderStatus?: OrderStatus | null
  now: Date
}): void {
  try {
    socketManager.broadcastToVenue(e.venueId, SocketEventType.ORDER_UPDATED, {
      orderId: e.orderId,
      orderNumber: e.orderNumber,
      venueId: e.venueId,
      onlineStatus: e.onlineStatus,
      ...(e.orderStatus ? { status: e.orderStatus } : {}),
      eventType: 'updated',
      timestamp: e.now.toISOString(),
    })
  } catch (error) {
    logger.error('[OnlineOrdering] socket emit falló (no fatal)', { orderId: e.orderId, error })
  }
}

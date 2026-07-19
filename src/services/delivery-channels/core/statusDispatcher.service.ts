/**
 * Status Dispatcher — notifica al canal de delivery (Deliverect hoy) cuando una orden
 * cambia de estado en el POS (aceptada, en preparación, lista, recogida, cancelada).
 *
 * REGRESIÓN CRÍTICA: solo órdenes `originSystem === DELIVERY_PLATFORM` disparan una
 * llamada saliente. Una orden de TPV/QR/dashboard JAMÁS debe notificar a Deliverect —
 * ese proveedor no sabe nada de esas órdenes y el link ni siquiera aplicaría.
 *
 * Un status update fallido (red caída, Deliverect 500, provider sin adapter) NUNCA
 * debe tumbar el flujo del POS — comp/void/pago/cambio de status internos siguen
 * funcionando aunque el canal esté inalcanzable. Por eso todo error se loguea y se traga.
 */
import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { DeliveryChannelStatus, DeliveryProvider, Order, OriginSystem } from '@prisma/client'
import { DeliveryOrderStatus, DeliveryProviderAdapter } from './types'
import { deliverectAdapter } from '../providers/deliverect/deliverect.adapter'

/** Registry simple provider→adapter. Providers sin entry (UBER_EATS/RAPPI/DIDI_FOOD directos) lanzan. */
const ADAPTER_REGISTRY: Partial<Record<DeliveryProvider, DeliveryProviderAdapter>> = {
  [DeliveryProvider.DELIVERECT]: deliverectAdapter,
}

export function getAdapter(provider: DeliveryProvider): DeliveryProviderAdapter {
  const adapter = ADAPTER_REGISTRY[provider]
  if (!adapter) {
    throw new Error(`Delivery provider sin adapter implementado: ${provider}`)
  }
  return adapter
}

export async function dispatchOrderStatus(order: Order, status: DeliveryOrderStatus): Promise<void> {
  // Regresión clave: TPV/QR/POS_SOFTRESTAURANT/AVOQADO jamás llaman a un proveedor externo.
  if (order.originSystem !== OriginSystem.DELIVERY_PLATFORM) {
    return
  }

  if (!order.externalId) {
    logger.warn(`[🛵 DeliveryDispatch] Order ${order.id} es DELIVERY_PLATFORM pero no tiene externalId — no-op`)
    return
  }

  // PAUSED/DISABLED/inexistente quedan todos fuera del filtro status:ACTIVE → no-op uniforme.
  const link = await prisma.deliveryChannelLink.findFirst({
    where: { venueId: order.venueId, status: DeliveryChannelStatus.ACTIVE },
  })
  if (!link) {
    logger.debug(`[🛵 DeliveryDispatch] Venue ${order.venueId} sin DeliveryChannelLink ACTIVE — no-op (order ${order.id})`)
    return
  }

  try {
    const adapter = getAdapter(link.provider)
    await adapter.sendStatusUpdate(link, order.externalId, status)
  } catch (error) {
    // Patrón del repo (blumon-webhook.service.ts): Error.message/stack son non-enumerable
    // y el JSON format de winston los tira si se loguea `{ error }` a secas.
    logger.error(
      `[❌ DeliveryDispatch] Fallo notificando status '${status}' al canal (order ${order.id}, provider ${link.provider}) — no se tumba el flujo del POS`,
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      },
    )
  }
}

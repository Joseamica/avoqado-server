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
import { DeliveryChannelLink, DeliveryChannelStatus, DeliveryProvider, Order, OriginSystem } from '@prisma/client'
import { DeliveryOrderStatus, DeliveryProviderAdapter } from './types'
import { deliverectAdapter } from '../providers/deliverect/deliverect.adapter'

/** Registry simple provider→adapter. Providers sin entry (UBER_EATS/RAPPI/DIDI_FOOD directos) lanzan. */
// ⚠️ DEUDA (plan 2026-08-20): este mapa y `core/adapterRegistry.ts` son DOS registros de
// lo mismo. Conviven porque `deliverectAdapter` implementa el contrato viejo. Se funden
// cuando Deliverect migre a `DeliveryProviderAdapter` (spec §8, paso 7).
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

/**
 * @param linkConocido El canal que originó el pedido, si el llamador ya lo tiene. La
 *   ingesta SIEMPRE lo tiene, y pasárselo evita dos problemas de golpe: una consulta
 *   innecesaria y una CARRERA (el `DeliveryOrderEvent` se liga a la orden DESPUÉS de
 *   ingerir, así que buscarlo en ese instante no lo encuentra nunca).
 */
export async function dispatchOrderStatus(order: Order, status: DeliveryOrderStatus, linkConocido?: DeliveryChannelLink): Promise<void> {
  // Regresión clave: TPV/QR/POS_SOFTRESTAURANT/AVOQADO jamás llaman a un proveedor externo.
  if (order.originSystem !== OriginSystem.DELIVERY_PLATFORM) {
    return
  }

  if (!order.externalId) {
    logger.warn(`[🛵 DeliveryDispatch] Order ${order.id} es DELIVERY_PLATFORM pero no tiene externalId — no-op`)
    return
  }

  // Fix B3 (audit §10.2): rutear por el link que ORIGINÓ el pedido, no por "el
  // primer link ACTIVE del venue" — con >1 canal activo eso mandaba el status
  // update al proveedor equivocado con un external order id ajeno. Esa protección
  // se conserva; lo que cambia es CÓMO se obtiene el link.
  //
  // 🔴 Si el llamador ya lo tiene, se usa y no se consulta nada. La búsqueda de abajo
  // fallaba SIEMPRE para un proveedor directo, por dos razones encadenadas (medido con
  // pedidos reales de Uber el 2026-08-20):
  //   1. filtraba `eventType: 'order'`, que es vocabulario de DELIVERECT — los eventos de
  //      Uber son `orders.notification` y jamás coincidían. Vocabulario de un proveedor
  //      metido en el núcleo: justo lo que el guardrail de `adapterRegistry` prohíbe, y se
  //      coló porque busca NOMBRES de proveedor, no sus cadenas de protocolo.
  //   2. el evento se liga a la orden DESPUÉS de ingerir, así que en ese instante no hay
  //      `orderId` que encontrar. Carrera, no dato faltante.
  // El resultado era un warning en CADA pedido — y un warning que sale siempre y nunca
  // importa entrena a la gente a ignorar el log entero.
  let link = linkConocido ?? null
  if (!link) {
    const originEvent = await prisma.deliveryOrderEvent.findFirst({
      // Sin filtro de `eventType`: el evento originador es el PRIMERO ligado a esta orden,
      // se llame como se llame en el protocolo de cada proveedor.
      where: { orderId: order.id, channelLinkId: { not: null } },
      orderBy: { receivedAt: 'asc' },
    })
    if (!originEvent?.channelLinkId) {
      logger.warn(`[🛵 DeliveryDispatch] Order ${order.id} sin DeliveryOrderEvent originador — no se puede determinar el canal, no-op`, {
        orderId: order.id,
      })
      return
    }
    link = await prisma.deliveryChannelLink.findUnique({ where: { id: originEvent.channelLinkId } })
  }
  if (!link || link.status !== DeliveryChannelStatus.ACTIVE) {
    logger.debug(`[🛵 DeliveryDispatch] Link originador no ACTIVE/inexistente — no-op (order ${order.id})`)
    return
  }

  // Un proveedor DIRECTO (Uber hoy) acepta el pedido con su propia llamada, dentro de su
  // procesador de eventos. No tiene —ni necesita— `sendStatusUpdate`: pedírselo sería
  // pedirle algo que su API no ofrece. Eso NO es una falla, así que no se loguea como tal.
  const adapter = ADAPTER_REGISTRY[link.provider]
  if (!adapter) {
    logger.debug(`[🛵 DeliveryDispatch] ${link.provider} gestiona el estado por su cuenta — no-op (order ${order.id})`)
    return
  }

  try {
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

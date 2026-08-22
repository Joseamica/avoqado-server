/**
 * Que la cocina pueda decir "sí lo hago" o "no puedo" a un pedido de marketplace.
 *
 * 🔴 POR QUÉ EXISTE: el modo MANUAL ya se podía activar desde el dashboard, pero NO había
 * forma de aceptar un pedido. El resultado era una trampa perfecta: el dueño prende MANUAL
 * creyendo que va a revisar cada pedido, entran los pedidos, nadie puede aceptarlos, y Uber
 * los cancela a los ~11.5 minutos. TODOS. En silencio, y sin que nada falle.
 *
 * 🔴 Y responde la otra mitad del problema: ¿qué pasa cuando el marketplace vende algo que
 * la cocina no puede preparar? Pasa de verdad —un venue sin inventario nunca marca nada como
 * agotado, así que Uber lo sigue vendiendo—, y hasta hoy el personal no tenía salida: el
 * pedido se aceptaba solo y llegaba a la cocina un platillo imposible.
 *
 * Hay DOS momentos y no son lo mismo:
 *   · ANTES de aceptar  → `denyDeliveryOrder`. Es un rechazo limpio; el cliente se entera
 *     de inmediato y Uber le devuelve su dinero sin fricción.
 *   · DESPUÉS de aceptar → cancelar (`cancelDeliveryOrder`). Ya dijimos que sí, así que
 *     cuesta más caro: el cliente ya está esperando. Sigue siendo mejor que no entregar.
 */
import { DeliveryProvider, OrderStatus } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { adapterFor, hasAdapter } from './adapterRegistry'
import { cancelDeliveryOrder } from './cancelDeliveryOrder.service'

export type MotivoRechazo = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface RespuestaPedido {
  outcome: 'ACCEPTED' | 'DENIED' | 'CANCELLED' | 'ALREADY_DONE' | 'NOT_A_DELIVERY_ORDER' | 'FAILED'
  error?: string
}

/** El pedido, su canal y el id que el proveedor entiende. Sin esto no se le puede contestar. */
async function contexto(venueId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, externalId: true, status: true, orderNumber: true },
  })
  if (!order?.externalId) return null

  // `PROVEEDOR:idDelProveedor` — el prefijo existe porque dos marketplaces pueden repetir
  // folio, y aquí hay que devolverle a Uber el id que ÉL conoce, sin el prefijo.
  const sep = order.externalId.indexOf(':')
  if (sep < 0) return null
  const provider = order.externalId.slice(0, sep) as DeliveryProvider
  const externalOrderId = order.externalId.slice(sep + 1)
  if (!hasAdapter(provider)) return null

  const link = await prisma.deliveryChannelLink.findFirst({ where: { venueId, provider }, select: { externalLocationId: true } })
  if (!link) return null

  return { order, provider, externalOrderId, storeId: link.externalLocationId, adapter: adapterFor(provider) }
}

/** "Sí lo preparo." Para venues en modo MANUAL, donde nadie acepta por ellos. */
export async function acceptDeliveryOrder(venueId: string, orderId: string, staffId?: string): Promise<RespuestaPedido> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return { outcome: 'NOT_A_DELIVERY_ORDER' }
  if (typeof ctx.adapter.acceptOrder !== 'function') return { outcome: 'FAILED', error: 'PROVEEDOR_SIN_ACEPTAR' }

  const r = await ctx.adapter.acceptOrder(ctx.externalOrderId, ctx.storeId)
  if (!r.ok) {
    // Pasado el plazo, el proveedor ya lo canceló y no hay nada que aceptar. Se dice con
    // ese nombre para que el mesero entienda que no es un error suyo ni un reintento útil.
    const muerto = /no longer active|not active|cancel/i.test(r.raw)
    logger.error('🚨 [Delivery] no se pudo aceptar el pedido', { orderId, status: r.status, muerto })
    return { outcome: 'FAILED', error: muerto ? 'PEDIDO_YA_NO_ACTIVO' : `HTTP ${r.status}` }
  }

  logger.info('👍 [Delivery] pedido aceptado a mano', { orderId, orderNumber: ctx.order.orderNumber, staffId })
  return { outcome: 'ACCEPTED' }
}

/**
 * "No puedo prepararlo."
 *
 * Elige solo el camino correcto según dónde esté el pedido: rechazo limpio si todavía no se
 * había aceptado, cancelación si ya. Que el mesero tenga que saber la diferencia sería
 * pedirle que entienda el protocolo de Uber para poder decir que se acabó la carne.
 */
export async function denyDeliveryOrder(
  venueId: string,
  orderId: string,
  motivo: MotivoRechazo = 'OUT_OF_ITEMS',
  staffId?: string,
): Promise<RespuestaPedido> {
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return { outcome: 'NOT_A_DELIVERY_ORDER' }
  if (ctx.order.status === OrderStatus.CANCELLED) return { outcome: 'ALREADY_DONE' }

  // CONFIRMED significa que ya le dijimos que sí al proveedor: el camino es cancelar.
  const yaAceptado = ctx.order.status === OrderStatus.CONFIRMED

  if (yaAceptado) {
    if (typeof ctx.adapter.cancelOrder === 'function') {
      const r = await ctx.adapter.cancelOrder(ctx.externalOrderId, ctx.storeId, motivo)
      if (!r.ok) return { outcome: 'FAILED', error: `HTTP ${r.status}` }
    }
    // Y del lado de Avoqado: sale de la cocina, deja de contar como venta, y el inventario
    // regresa. Es la misma rutina que una cancelación del proveedor.
    await cancelDeliveryOrder(ctx.externalOrderId, ctx.provider, `el negocio no pudo prepararlo: ${motivo}`)
    logger.info('🚫 [Delivery] pedido ya aceptado, CANCELADO por el negocio', { orderId, motivo, staffId })
    return { outcome: 'CANCELLED' }
  }

  if (typeof ctx.adapter.denyOrder !== 'function') return { outcome: 'FAILED', error: 'PROVEEDOR_SIN_RECHAZAR' }
  const r = await ctx.adapter.denyOrder(ctx.externalOrderId, ctx.storeId, motivo)
  if (!r.ok) return { outcome: 'FAILED', error: `HTTP ${r.status}` }

  await cancelDeliveryOrder(ctx.externalOrderId, ctx.provider, `rechazado por el negocio: ${motivo}`)
  logger.info('🚫 [Delivery] pedido RECHAZADO antes de aceptar', { orderId, motivo, staffId })
  return { outcome: 'DENIED' }
}

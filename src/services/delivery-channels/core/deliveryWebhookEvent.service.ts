import prisma from '../../../utils/prismaClient'
import { DeliveryOrderEvent, DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'

/**
 * Persiste un evento de webhook de delivery ANTES de cualquier ACK (patrón
 * Blumon/ProviderEventLog): si la ingesta falla después, ya tenemos un registro
 * durable que la reconciliación puede reintentar. Idempotencia por
 * @@unique([provider, externalEventId, eventType]) — un P2002 significa que el
 * proveedor reenvió el mismo evento (retry), así que devolvemos el row existente
 * marcado `duplicate: true` en vez de fallar.
 */
export async function persistDeliveryEvent(params: {
  provider: DeliveryProvider
  externalEventId: string
  eventType: string
  channelLinkId: string
  venueId: string
  payload: unknown
}): Promise<{ event: DeliveryOrderEvent; duplicate: boolean }> {
  try {
    const event = await prisma.deliveryOrderEvent.create({
      data: {
        provider: params.provider,
        externalEventId: params.externalEventId,
        eventType: params.eventType,
        channelLinkId: params.channelLinkId,
        venueId: params.venueId,
        payload: params.payload as Prisma.InputJsonValue,
      },
    })
    return { event, duplicate: false }
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const existing = await prisma.deliveryOrderEvent.findUnique({
        where: {
          provider_externalEventId_eventType: {
            provider: params.provider,
            externalEventId: params.externalEventId,
            eventType: params.eventType,
          },
        },
      })
      if (existing) return { event: existing, duplicate: true }
    }
    throw e
  }
}

/**
 * Marca el resultado del procesamiento de un DeliveryOrderEvent ya persistido.
 * Se llama SIEMPRE después del ACK-crítico (persistDeliveryEvent) — nunca puede
 * ser la causa de un 503, porque el evento ya está guardado.
 */
export async function markEventResult(eventId: string, status: DeliveryOrderEventStatus, orderId?: string, error?: string): Promise<void> {
  await prisma.deliveryOrderEvent.update({
    where: { id: eventId },
    data: { status, orderId, error, processedAt: new Date() },
  })
}

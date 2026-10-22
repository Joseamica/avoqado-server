import { randomUUID } from 'crypto'

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { DeliveryOrderEvent, DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'

/**
 * Persiste un evento de webhook de delivery ANTES de cualquier ACK (patrón
 * Blumon/ProviderEventLog): si la ingesta falla después, ya tenemos un registro
 * durable que la reconciliación puede reintentar. Idempotencia por
 * @@unique([provider, channelLinkId, externalEventId, eventType]) — un P2002
 * significa que el proveedor reenvió el mismo evento (retry) POR EL MISMO CANAL,
 * así que devolvemos el row existente marcado `duplicate: true` en vez de fallar.
 *
 * Fix B1 (audit §10.2): la llave incluye `channelLinkId` porque `externalEventId`
 * (channelOrderId) nace en el marketplace y NO es único global — sin el link, dos
 * canales/venues distintos con el mismo channelOrderId colisionaban y el 2do
 * tenant recibía DUPLICATE sin ingerir nunca su pedido.
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
          provider_channelLinkId_externalEventId_eventType: {
            provider: params.provider,
            channelLinkId: params.channelLinkId,
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

// ── El reclamo del evento ───────────────────────────────────────────────────────────────
// 🔴 Dos procesos (la petición viva, un carril del job, otro carril) pueden tomar el MISMO evento a la vez y
// aceptar o registrar dos veces el mismo pedido. El reclamo es un lease en la propia fila, sin Redis: un
// `updateMany` condicional sobre `claimToken`/`lockedUntil` que la base decide en UN solo UPDATE. Quien lo
// obtiene trabaja con su token; renovar y cerrar exigen ese token, así que el cierre de un dueño viejo (al que
// se le venció el reclamo) nunca borra ni pisa el del nuevo. `markEventResult` queda igual para quien no reclama.

/**
 * Reclama el evento por `duracionMs`. Excluye lo ya PROCESSED y un reclamo vigente de otro (uno vencido sí se
 * retoma: su dueño murió o se colgó). Devuelve el token si la fila quedó suya, o `null` si no (otro lo tiene,
 * ya terminó o no existe).
 */
export async function reclamarEvento(eventId: string, duracionMs: number): Promise<string | null> {
  const ahora = new Date()
  const token = randomUUID()
  const { count } = await prisma.deliveryOrderEvent.updateMany({
    where: {
      id: eventId,
      status: { not: DeliveryOrderEventStatus.PROCESSED },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: ahora } }],
    },
    data: { claimToken: token, lockedUntil: new Date(ahora.getTime() + duracionMs) },
  })
  return count === 1 ? token : null
}

/** Extiende el reclamo `duracionMs` desde ahora, sólo si `token` sigue siendo el dueño. `false` = otro lo tomó. */
export async function renovarReclamo(eventId: string, token: string, duracionMs: number): Promise<boolean> {
  const { count } = await prisma.deliveryOrderEvent.updateMany({
    where: { id: eventId, claimToken: token },
    data: { lockedUntil: new Date(Date.now() + duracionMs) },
  })
  return count === 1
}

/**
 * Como `markEventResult`, y además suelta el reclamo, pero SÓLO si `token` sigue siendo el dueño. Con `false` (el
 * reclamo ya era de otro) no se escribe nada: el resultado lo escribe el dueño vigente.
 */
export async function cerrarEventoReclamado(
  eventId: string,
  token: string,
  status: DeliveryOrderEventStatus,
  orderId?: string,
  error?: string,
): Promise<boolean> {
  const { count } = await prisma.deliveryOrderEvent.updateMany({
    where: { id: eventId, claimToken: token },
    data: { status, orderId, error, processedAt: new Date(), claimToken: null, lockedUntil: null },
  })
  if (count === 1) return true
  logger.error('🚨 [Delivery] el cierre del evento llegó sin su reclamo (se venció y lo tomó otro): no se sobrescribe nada', {
    eventId,
    status,
    orderId,
    error: error?.slice(0, 300),
  })
  return false
}

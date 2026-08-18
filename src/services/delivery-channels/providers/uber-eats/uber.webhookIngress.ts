/**
 * Ingreso durable de webhooks de Uber Eats (spec paso 3).
 *
 * Contrato ACK persist-first: la firma se verifica ANTES de mirar el payload
 * (la identidad de la tienda viene DENTRO del cuerpo: sin firma válida no se
 * confía en él), y el 200 solo sale con el evento ya guardado.
 *
 * 🔴 NO reutiliza `core/deliveryWebhookEvent.service.ts`: ese contrato exige un
 * `channelLinkId` conocido y deduplica con semántica de Deliverect. Uber manda
 * UNA sola URL por aplicación, así que el link se resuelve DESPUÉS de la firma
 * y puede no existir todavía. Deliverect queda congelado (decisión founder).
 *
 * Dedup por `dedupKey = UBER_EATS:{event_id}` con @unique real en Postgres:
 * [doc] Uber reintenta hasta 7 veces ante 5xx/timeout y documenta `event_id`
 * como identificador único para deduplicar. La carrera la resuelve la base de
 * datos (P2002), no un "¿existe?" previo que dejaría ventana.
 */
import { Prisma, DeliveryProvider, DeliveryOrderEventStatus } from '@prisma/client'
import prisma from '../../../../utils/prismaClient'
import { verifyUberSignature } from './uber.signature'

export type UberIngressOutcome = 'PERSISTED' | 'DUPLICATE' | 'INVALID_SIGNATURE' | 'MALFORMED'

export interface UberIngressResult {
  outcome: UberIngressOutcome
  eventRowId?: string
}

export interface UberIngressInput {
  rawBody: Buffer
  signatureHeader: string | undefined
  /** Principal y (opcional) secundaria: Uber ofrece rotación nativa con dos llaves vivas. */
  signingKeys: string[]
}

interface UberEnvelope {
  event_id?: unknown
  event_type?: unknown
  meta?: { resource_id?: unknown; user_id?: unknown } | null
}

export async function persistUberWebhookEvent(input: UberIngressInput): Promise<UberIngressResult> {
  const keys = (input.signingKeys ?? []).filter(k => typeof k === 'string' && k.length > 0)
  if (keys.length === 0) return { outcome: 'INVALID_SIGNATURE' }

  // Cualquiera de las llaves vivas puede haber firmado (ventana de rotación).
  const firmaValida = keys.some(k => verifyUberSignature(input.rawBody, input.signatureHeader, k))
  if (!firmaValida) return { outcome: 'INVALID_SIGNATURE' }

  let sobre: UberEnvelope
  try {
    sobre = JSON.parse(input.rawBody.toString('utf8')) as UberEnvelope
  } catch {
    return { outcome: 'MALFORMED' }
  }

  const eventId = typeof sobre.event_id === 'string' ? sobre.event_id : ''
  const eventType = typeof sobre.event_type === 'string' ? sobre.event_type : ''
  if (!eventId || !eventType) return { outcome: 'MALFORMED' }

  const storeId = typeof sobre.meta?.user_id === 'string' ? sobre.meta.user_id : null
  const externalOrderId = typeof sobre.meta?.resource_id === 'string' ? sobre.meta.resource_id : null

  // Link por store_id del payload FIRMADO. Puede no existir: el evento se guarda
  // igual con venue/link nulos — un pedido real jamás se tira por eso.
  const link = storeId
    ? await prisma.deliveryChannelLink.findUnique({
        where: { provider_externalLocationId: { provider: DeliveryProvider.UBER_EATS, externalLocationId: storeId } },
        select: { id: true, venueId: true },
      })
    : null

  try {
    const row = await prisma.deliveryOrderEvent.create({
      data: {
        provider: DeliveryProvider.UBER_EATS,
        externalEventId: eventId,
        eventType,
        dedupKey: `UBER_EATS:${eventId}`,
        externalOrderId,
        channelLinkId: link?.id ?? null,
        venueId: link?.venueId ?? null,
        payload: JSON.parse(input.rawBody.toString('utf8')) as Prisma.InputJsonValue,
        status: DeliveryOrderEventStatus.RECEIVED,
      },
      select: { id: true },
    })
    return { outcome: 'PERSISTED', eventRowId: row.id }
  } catch (e) {
    // P2002 = violación de unique ⇒ ya lo teníamos. Es éxito, no error: Uber
    // reintentó y la base de datos resolvió la carrera por nosotros.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { outcome: 'DUPLICATE' }
    throw e
  }
}

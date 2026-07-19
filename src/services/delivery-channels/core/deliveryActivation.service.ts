/**
 * Servicio de solicitud de activación de delivery (DeliveryActivationRequest) — self-serve.
 *
 * Distinto de DeliveryChannelLink (la conexión técnica real con un proveedor): esto es la
 * INTENCIÓN de un venue de activar delivery. El dueño la crea desde el dashboard; ops la
 * avanza manualmente (PENDING → CONTACTED → CONNECTED, o DISMISSED) mientras configura la
 * integración real con Deliverect fuera de este flujo.
 *
 * Reglas clave:
 * - "Viva" = status PENDING o CONTACTED. Solo puede haber una viva por venue a la vez.
 * - `createActivationRequest` es idempotente: si ya hay una viva para el venue, la devuelve
 *   tal cual (NO crea otra, NO vuelve a loguear) — evita que un dueño impaciente genere
 *   solicitudes duplicadas en la cola de ops.
 * - `updateActivationStatus` es la transición de ops (fuera del alcance de este service quién
 *   puede llamarla — eso lo gatea el controller/permisos). Sella `contactedAt`/`connectedAt`
 *   automáticamente al entrar a ese status.
 * - Cada mutación escribe ActivityLog vía `logAction` (fire-and-forget, `void`, fuera de
 *   cualquier transacción) — mismo patrón que el resto de `delivery-channels/core/`.
 */
import prisma from '../../../utils/prismaClient'
import { DeliveryActivationRequest, DeliveryActivationStatus, Prisma } from '@prisma/client'
import { logAction } from '../../dashboard/activity-log.service'

const LIVE_STATUSES: DeliveryActivationStatus[] = [DeliveryActivationStatus.PENDING, DeliveryActivationStatus.CONTACTED]

/** La solicitud "viva" (PENDING o CONTACTED) del venue, o null si no hay ninguna en curso. */
export async function getActivationRequest(venueId: string): Promise<DeliveryActivationRequest | null> {
  return prisma.deliveryActivationRequest.findFirst({
    where: { venueId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  })
}

export interface CreateActivationRequestInput {
  requestedChannels: string[]
  note?: string
}

/**
 * Crea una solicitud de activación. Idempotente: si el venue ya tiene una viva, la devuelve
 * sin crear otra ni volver a escribir ActivityLog.
 */
export async function createActivationRequest(
  venueId: string,
  requestedById: string,
  input: CreateActivationRequestInput,
): Promise<DeliveryActivationRequest> {
  const existing = await getActivationRequest(venueId)
  if (existing) return existing // idempotente: no duplicar una solicitud viva

  const created = await prisma.deliveryActivationRequest.create({
    data: {
      venueId,
      requestedById,
      requestedChannels: input.requestedChannels,
      note: input.note ?? null,
    },
  })

  void logAction({
    action: 'DELIVERY_ACTIVATION_REQUESTED',
    entity: 'DeliveryActivationRequest',
    entityId: created.id,
    staffId: requestedById,
    venueId,
    data: { requestedChannels: input.requestedChannels, note: input.note ?? null },
  })

  return created
}

const STATUS_ACTION: Record<DeliveryActivationStatus, string> = {
  PENDING: 'DELIVERY_ACTIVATION_REQUESTED',
  CONTACTED: 'DELIVERY_ACTIVATION_CONTACTED',
  CONNECTED: 'DELIVERY_ACTIVATION_CONNECTED',
  DISMISSED: 'DELIVERY_ACTIVATION_DISMISSED',
}

/**
 * Transición de ops sobre una solicitud existente. Sella `contactedAt` al entrar a CONTACTED
 * y `connectedAt` al entrar a CONNECTED; DISMISSED solo cambia el status.
 */
export async function updateActivationStatus(
  id: string,
  status: DeliveryActivationStatus,
  performedBy: string,
): Promise<DeliveryActivationRequest> {
  const data: Prisma.DeliveryActivationRequestUpdateInput = { status }
  if (status === DeliveryActivationStatus.CONTACTED) data.contactedAt = new Date()
  if (status === DeliveryActivationStatus.CONNECTED) data.connectedAt = new Date()

  const updated = await prisma.deliveryActivationRequest.update({ where: { id }, data })

  void logAction({
    action: STATUS_ACTION[status],
    entity: 'DeliveryActivationRequest',
    entityId: id,
    staffId: performedBy,
    venueId: updated.venueId,
    data: { status },
  })

  return updated
}

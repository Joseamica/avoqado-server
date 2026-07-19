/**
 * Gestión de canales de delivery (DeliveryChannelLink) — CRUD + pause/resume (Task 10).
 *
 * Reglas clave:
 * - `webhookSecret` se genera una sola vez en create (crypto.randomBytes(32).toString('hex'))
 *   y JAMÁS se devuelve al caller — todo read/return pasa por `SAFE_SELECT`, que lo excluye
 *   explícitamente. El adapter (`setChannelPaused`) sí necesita el registro completo
 *   (interfaz `DeliveryProviderAdapter` recibe el link entero), así que `pauseChannelLink`
 *   lee una vez sin `select` para ese uso interno y solo strippea el secret al devolver.
 * - update/pause SIEMPRE filtran por `where: { id, venueId }` en la mutación misma
 *   (vía `updateMany` + chequeo de `count`) — tenant isolation a nivel de query, no solo
 *   de una lectura previa. Un link de otro venue → NotFoundError, nunca se toca.
 * - pause llama al adapter del proveedor (`getAdapter`, registry de `statusDispatcher.service`)
 *   best-effort: un fallo de red/proveedor NUNCA debe tumbar la mutación de status interna
 *   (mismo patrón que `dispatchOrderStatus`) — se loguea y se traga.
 * - Cada mutación escribe ActivityLog vía `logAction` (fire-and-forget, `void`, fuera de
 *   cualquier transacción) — auditoría de conexión/edición/pausa de canales.
 */
import crypto from 'crypto'
import { DeliveryChannelLink, DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { NotFoundError } from '../../../errors/AppError'
import { logAction } from '../../dashboard/activity-log.service'
import { getAdapter } from './statusDispatcher.service'

/** Select explícito — NUNCA incluye `webhookSecret`. Usado por list/create/update. */
const SAFE_SELECT = {
  id: true,
  venueId: true,
  provider: true,
  externalLocationId: true,
  externalAccountId: true,
  orderAcceptanceMode: true,
  status: true,
  autoSyncMenu: true,
  lastMenuSyncAt: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliveryChannelLinkSelect

export type DeliveryChannelLinkSafe = Omit<DeliveryChannelLink, 'webhookSecret'>

/** GET /venues/:venueId/channels — lista los canales del venue. NUNCA expone webhookSecret. */
export async function listChannelLinks(venueId: string): Promise<DeliveryChannelLinkSafe[]> {
  return prisma.deliveryChannelLink.findMany({
    where: { venueId },
    select: SAFE_SELECT,
    orderBy: { createdAt: 'desc' },
  }) as unknown as Promise<DeliveryChannelLinkSafe[]>
}

export interface CreateChannelLinkInput {
  provider: DeliveryProvider
  externalLocationId: string
  externalAccountId?: string | null
  orderAcceptanceMode?: OrderAcceptanceMode
  autoSyncMenu?: boolean
  config?: Prisma.InputJsonValue | null
}

/**
 * POST /venues/:venueId/channels — vincula un nuevo canal. Genera webhookSecret aleatorio
 * (verificado por el proveedor al firmar webhooks entrantes) y arranca en PENDING — el link
 * pasa a ACTIVE solo cuando el proveedor confirma la conexión (fuera de este service).
 */
export async function createChannelLink(
  venueId: string,
  data: CreateChannelLinkInput,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  const webhookSecret = crypto.randomBytes(32).toString('hex')

  const link = await prisma.deliveryChannelLink.create({
    data: {
      venueId,
      provider: data.provider,
      externalLocationId: data.externalLocationId,
      externalAccountId: data.externalAccountId ?? null,
      webhookSecret,
      orderAcceptanceMode: data.orderAcceptanceMode ?? OrderAcceptanceMode.AUTO,
      status: DeliveryChannelStatus.PENDING,
      autoSyncMenu: data.autoSyncMenu ?? true,
      config: data.config ?? undefined,
    },
    select: SAFE_SELECT,
  })

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_CONNECTED',
    entity: 'DeliveryChannelLink',
    entityId: link.id,
    data: { provider: data.provider, externalLocationId: data.externalLocationId },
  })

  return link as unknown as DeliveryChannelLinkSafe
}

export interface UpdateChannelLinkInput {
  externalLocationId?: string
  externalAccountId?: string | null
  orderAcceptanceMode?: OrderAcceptanceMode
  autoSyncMenu?: boolean
  config?: Prisma.InputJsonValue | null
}

/**
 * PATCH /venues/:venueId/channels/:linkId — edita un canal existente.
 * Tenant isolation: la mutación misma filtra por `{ id: linkId, venueId }` — un link
 * de otro venue no matchea ninguna fila (`count === 0`) → NotFoundError, nada se toca.
 */
export async function updateChannelLink(
  venueId: string,
  linkId: string,
  data: UpdateChannelLinkInput,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  const result = await prisma.deliveryChannelLink.updateMany({
    where: { id: linkId, venueId },
    data: {
      ...(data.externalLocationId !== undefined && { externalLocationId: data.externalLocationId }),
      ...(data.externalAccountId !== undefined && { externalAccountId: data.externalAccountId }),
      ...(data.orderAcceptanceMode !== undefined && { orderAcceptanceMode: data.orderAcceptanceMode }),
      ...(data.autoSyncMenu !== undefined && { autoSyncMenu: data.autoSyncMenu }),
      ...(data.config !== undefined && { config: data.config === null ? Prisma.JsonNull : data.config }),
    },
  })

  if (result.count === 0) {
    throw new NotFoundError('Canal de delivery no encontrado')
  }

  const link = await prisma.deliveryChannelLink.findUnique({ where: { id: linkId }, select: SAFE_SELECT })

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_UPDATED',
    entity: 'DeliveryChannelLink',
    entityId: linkId,
    data: data as Prisma.InputJsonValue,
  })

  return link as unknown as DeliveryChannelLinkSafe
}

/**
 * POST /venues/:venueId/channels/:linkId/pause — pausa o reactiva un canal.
 * Tenant isolation igual que update. Tras confirmar la mutación, notifica al proveedor
 * (`getAdapter(provider).setChannelPaused`) best-effort — un fallo de red/proveedor
 * NUNCA revierte ni bloquea el cambio de status interno, solo se loguea.
 */
export async function pauseChannelLink(
  venueId: string,
  linkId: string,
  paused: boolean,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  const newStatus = paused ? DeliveryChannelStatus.PAUSED : DeliveryChannelStatus.ACTIVE

  const result = await prisma.deliveryChannelLink.updateMany({
    where: { id: linkId, venueId },
    data: { status: newStatus },
  })

  if (result.count === 0) {
    throw new NotFoundError('Canal de delivery no encontrado')
  }

  // Registro completo (incluye webhookSecret) — lo necesita el adapter, pero NUNCA se
  // devuelve tal cual al caller (se strippea el secret antes de retornar, abajo).
  const fullLink = await prisma.deliveryChannelLink.findUnique({ where: { id: linkId } })

  if (!fullLink) {
    // Defensivo: updateMany confirmó count>=1 pero la fila desapareció antes del re-read
    // (borrado concurrente). No debería ocurrir en la práctica.
    throw new NotFoundError('Canal de delivery no encontrado')
  }

  try {
    const adapter = getAdapter(fullLink.provider)
    await adapter.setChannelPaused(fullLink, paused)
  } catch (error) {
    logger.error(
      `[🛵 DeliveryChannel] Fallo notificando pausa=${paused} al proveedor (link ${linkId}) — no se revierte el cambio de status`,
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      },
    )
  }

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_PAUSED',
    entity: 'DeliveryChannelLink',
    entityId: linkId,
    data: { paused },
  })

  const { webhookSecret: _webhookSecret, ...safeLink } = fullLink
  return safeLink
}

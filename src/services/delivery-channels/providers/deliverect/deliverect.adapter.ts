/**
 * Deliverect Adapter — junta hmac + mapper + client detrás del contrato
 * `DeliveryProviderAdapter` (Task 2, `core/types.ts`).
 *
 * Quién consume qué (por diseño, NO es deuda):
 * - Camino de SALIDA (status/menu/pause): el dispatcher (`statusDispatcher.service.ts`)
 *   consume SOLO esta interfaz vía el registry `getAdapter(provider)` — nunca el client directo.
 * - Camino de ENTRADA (webhook): `deliverect.webhook.controller.ts` llama
 *   `verifyDeliverectHmac` + `parseDeliverectOrder` DIRECTAMENTE (bypass del adapter) —
 *   ya tiene el raw Buffer y el link resuelto por `:channelLinkId`, y su contrato ACK
 *   (401/404/400/200/503) necesita distinguir cada fase, no una interfaz opaca.
 *   Los métodos `verifySignature`/`parseOrderWebhook` de este objeto existen para
 *   completar el contrato `DeliveryProviderAdapter` (un webhook genérico multi-provider
 *   futuro los usaría), no porque el controller actual pase por aquí.
 */
import prisma from '../../../../utils/prismaClient'
import type { DeliveryChannelLink } from '@prisma/client'
import type { DeliveryProviderAdapter } from '../../core/types'
import type { MenuSnapshot } from '../../core/menuSnapshot.service'
import { verifyDeliverectHmac, DELIVERECT_HMAC_HEADER } from './deliverect.hmac'
import { parseDeliverectOrder, DELIVERECT_STATUS_MAP, mapSnapshotToDeliverectProducts } from './deliverect.mapper'
import { deliverectClient } from './deliverect.client'

/** req.headers trae string | string[] | undefined — un HMAC repetido en headers duplicados usa el primero. */
function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export const deliverectAdapter: DeliveryProviderAdapter = {
  provider: 'DELIVERECT',

  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, link: DeliveryChannelLink): boolean {
    return verifyDeliverectHmac(rawBody, getHeaderValue(headers, DELIVERECT_HMAC_HEADER), link.webhookSecret)
  },

  parseOrderWebhook(rawBody: Buffer, link: DeliveryChannelLink) {
    return parseDeliverectOrder(rawBody, link)
  },

  async sendStatusUpdate(_link: DeliveryChannelLink, externalOrderId: string, status): Promise<void> {
    const statusCode = DELIVERECT_STATUS_MAP[status]
    await deliverectClient.postOrderStatus(externalOrderId, statusCode)
  },

  async pushMenu(link: DeliveryChannelLink, snapshot: MenuSnapshot): Promise<void> {
    if (!link.externalAccountId) {
      // externalAccountId es null para proveedores directos (futuro) — Deliverect SIEMPRE lo requiere.
      throw new Error(`DeliveryChannelLink ${link.id} sin externalAccountId — no se puede publicar el menú a Deliverect`)
    }
    const payload = mapSnapshotToDeliverectProducts(snapshot)
    await deliverectClient.pushProducts(link.externalAccountId, link.externalLocationId, payload)
    await prisma.deliveryChannelLink.update({ where: { id: link.id }, data: { lastMenuSyncAt: new Date() } })
  },

  async setChannelPaused(link: DeliveryChannelLink, paused: boolean): Promise<void> {
    await deliverectClient.setBusyMode(link.externalLocationId, paused)
  },
}

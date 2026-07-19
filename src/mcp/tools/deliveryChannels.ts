import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { getDeliveryDailySummary } from '@/services/delivery-channels/core/deliverySummary.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'

export function registerDeliveryChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_channels',
    'Estado de los canales de delivery del venue (Uber Eats/Rappi/DiDi vía Deliverect): canales conectados, estado (activo/pausado), último sync de menú, y pedidos de delivery de hoy por canal. Responde "¿cómo van mis canales de delivery? ¿cuántos pedidos de Uber/Rappi hoy?". Pass venueId.',
    { venueId: z.string().describe('Venue cuyos canales de delivery leer (debe estar en tu scope)') },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('delivery-channels:read', venueId) // mirror the dashboard's delivery-channels:read gate (MANAGER+)
      const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Los canales de delivery') // PREMIUM tier
      if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
      const links = await prisma.deliveryChannelLink.findMany({
        where: { venueId: where.venueId ?? venueId },
        select: {
          id: true,
          provider: true,
          status: true,
          orderAcceptanceMode: true,
          autoSyncMenu: true,
          lastMenuSyncAt: true,
          externalLocationId: true,
        },
      })
      // Task 5: fuente compartida con el REST GET .../delivery/summary (DRY) — misma lógica
      // venue-local (venueStartOfDay) que antes vivía inline aquí, ahora en deliverySummary.service.
      const { channels: todayByChannel } = await getDeliveryDailySummary(venueId)
      return text({
        venueId,
        channels: links.map(l => ({ ...l, lastMenuSyncAt: l.lastMenuSyncAt?.toISOString() ?? null })),
        todayByChannel,
      })
    },
  )
}

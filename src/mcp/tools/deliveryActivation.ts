import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeliveryActivationStatus } from '@prisma/client'
import { listActivationRequests } from '@/services/delivery-channels/core/deliveryActivation.service'
import { hasPermission } from '@/services/access/access.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'

const STATUS_VALUES = Object.values(DeliveryActivationStatus) as [DeliveryActivationStatus, ...DeliveryActivationStatus[]]

/**
 * Task 6 (delivery-activation-backend): read-only MCP view of DeliveryActivationRequest — the
 * dueño's self-serve INTENCIÓN of activating delivery (PENDING → CONTACTED → CONNECTED, or
 * DISMISSED), distinct from `delivery_channels` (the technical connection once it's live).
 *
 * `listActivationRequests` (Task 4) backs the SUPERADMIN ops REST queue and is intentionally
 * cross-venue/cross-org (no venueId filter param — see its docstring). This tool is the CUSTOMER
 * MCP, so it must never leak another tenant's requests: every row returned is filtered down to
 * venues in the caller's scope (and, for the all-venues call, only venues the caller can actually
 * read) BEFORE it leaves this function — mirrors get_activity_log's "expose only what the scope
 * permits" pattern (src/mcp/tools/activity-log.ts).
 */
export function registerDeliveryActivationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_activation_requests',
    'Cola de solicitudes de activación de delivery (Uber Eats/Rappi/DiDi) de tus venues: la INTENCIÓN del dueño de activar delivery y su avance (PENDING → CONTACTED → CONNECTED, o DISMISSED) mientras ops configura la integración real con Deliverect. Distinto de delivery_channels (la conexión técnica YA activa) — esto es la solicitud/cola de espera antes de eso. Responde "¿cómo va mi solicitud de delivery? ¿ya me contactaron?". Pass venueId para un solo venue, o omite para ver todos los tuyos. Filtra opcionalmente por status. Solo lectura.',
    {
      venueId: z
        .string()
        .optional()
        .describe('Venue específico cuyas solicitudes leer (debe estar en tu scope); omite para ver todos tus venues'),
      status: z.enum(STATUS_VALUES).optional().describe('Filtra por status: PENDING, CONTACTED, CONNECTED o DISMISSED'),
    },
    async ({ venueId, status }) => {
      let venueIds: string[]
      if (venueId) {
        guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('delivery-channels:read', venueId) // mirror the dashboard's delivery-channels:read gate (MANAGER+)
        const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Las solicitudes de activación de delivery') // PREMIUM tier
        if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
        venueIds = [venueId]
      } else {
        // Cross-venue call: NEVER throw — a broad "show me all my venues" ask should just return
        // whatever the caller is entitled to see, filtering out venues that fail either gate
        // (same two checks as the single-venue branch above, applied per-venue instead of thrown).
        const permitted = scope.allowedVenueIds.filter(v => {
          const access = scope.perVenueAccess.get(v)
          return !!access && hasPermission(access, 'delivery-channels:read')
        })
        const entitled = await Promise.all(permitted.map(v => venueHasFeatureAccess(v, 'DELIVERY_CHANNELS')))
        venueIds = permitted.filter((_, i) => entitled[i])
        if (venueIds.length === 0) return text({ count: 0, requests: [] })
      }

      const allowed = new Set(venueIds)
      const rows = await listActivationRequests(status ? { status } : undefined)
      // listActivationRequests is cross-tenant by design (ops queue) — this filter is what keeps
      // the customer MCP tenant-isolated. Never remove it / never pass venueIds into a query the
      // service doesn't support instead of this post-filter.
      const scoped = rows.filter(r => allowed.has(r.venueId))

      return text({
        count: scoped.length,
        requests: scoped.map(r => ({
          id: r.id,
          venueId: r.venueId,
          venueName: r.venue.name,
          venueSlug: r.venue.slug,
          status: r.status,
          requestedChannels: r.requestedChannels,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
          contactedAt: r.contactedAt?.toISOString() ?? null,
          connectedAt: r.connectedAt?.toISOString() ?? null,
        })),
      })
    },
  )
}

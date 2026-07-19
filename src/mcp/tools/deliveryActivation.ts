import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeliveryActivationStatus } from '@prisma/client'
import { listActivationRequests, type ActivationRequestWithVenue } from '@/services/delivery-channels/core/deliveryActivation.service'
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
      const filter = status ? { status } : undefined
      let scoped: ActivationRequestWithVenue[]

      if (venueId) {
        guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('delivery-channels:read', venueId) // mirror the dashboard's delivery-channels:read gate (MANAGER+)
        const gate = await planGateMessage(venueId, 'DELIVERY_CHANNELS', 'Las solicitudes de activación de delivery') // PREMIUM tier
        if (gate) return text({ ok: false, planRequired: true, feature: 'DELIVERY_CHANNELS', error: gate })
        // Fix 5 (audit, API-CONTRACT): scope the query itself by venueId (server-side) instead
        // of fetching the FULL cross-tenant ops queue (every venue, every org, platform-wide)
        // just to keep one venue's rows via an in-memory filter.
        const rows = await listActivationRequests({ ...filter, venueId })
        scoped = rows.filter(r => r.venueId === venueId) // defense-in-depth, kept even though the query is now scoped
      } else {
        // Cross-venue call: NEVER throw — a broad "show me all my venues" ask should just return
        // whatever the caller is entitled to see. Fetch the ops queue FIRST (1 query, low volume),
        // THEN bound the per-venue feature fan-out to venues that ACTUALLY have rows — never the
        // whole scope. For a SUPERADMIN, scope.allowedVenueIds is the entire platform (hundreds);
        // resolving venueHasFeatureAccess for every one of them would be hundreds of concurrent
        // resolutions (≥1 query each) against a ~18-conn pool → P2024/pool-exhaustion (the repo has
        // hit this before — see memory pool 9→18 + analyticsLimiter). Filtering to venues-with-rows
        // keeps the fan-out tiny (the ops queue is small), so it stays safe for large orgs.
        //
        // Fix 5 (audit): also bound this ONE fetch to scope.allowedVenueIds — defense-in-depth,
        // zero extra cost (still exactly one query; allowedVenueIds is already resolved). The
        // finer-grained permission-bit + feature-gate filtering below is UNCHANGED and still runs
        // — this only means the DB itself can never hand back another tenant's row to begin with.
        const rows = await listActivationRequests({ ...filter, venueIds: scope.allowedVenueIds })
        // Scope + permission are pure in-memory checks (no queries) — apply them first to shrink
        // the set BEFORE the only DB fan-out (the feature check) runs.
        const permitted = [...new Set(rows.map(r => r.venueId))].filter(v => {
          const access = scope.perVenueAccess.get(v)
          return scope.allowedVenueIds.includes(v) && !!access && hasPermission(access, 'delivery-channels:read')
        })
        const entitled = await Promise.all(permitted.map(v => venueHasFeatureAccess(v, 'DELIVERY_CHANNELS')))
        // listActivationRequests is cross-tenant by design (ops queue) — this allow-set is what keeps
        // the customer MCP tenant-isolated. Never remove it / never trust the service's rows directly.
        const allowed = new Set(permitted.filter((_, i) => entitled[i]))
        scoped = rows.filter(r => allowed.has(r.venueId))
      }

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

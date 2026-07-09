import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from '../scope'
import { ScopeError } from '../guard'
import { text } from '../respond'
import { getOrgTerminalLocations, type TerminalLocationRow } from '@/services/promoters/terminalLocation.service'
import { isWhiteLabelOrg } from '@/controllers/dashboard/organizationStockControl.controller'

const WHITE_LABEL_OFF_MSG =
  'El seguimiento de terminales no está activo en esta organización (módulo WHITE_LABEL_DASHBOARD apagado en todos sus locales).'

function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

function describeRow(row: TerminalLocationRow): Record<string, unknown> {
  const label = row.serialNumber ?? row.terminalId
  const promoter = row.promoter?.name ?? '—'
  const venue = row.venue?.name ?? '—'
  const summary = row.latest
    ? `${label} — promotor: ${promoter} — tienda: ${venue} — última ubicación: ${row.latest.capturedAt} — ${mapsUrl(row.latest.latitude, row.latest.longitude)}`
    : `${label} — promotor: ${promoter} — tienda: ${venue} — sin ubicación`
  return {
    terminalId: row.terminalId,
    serialNumber: row.serialNumber,
    venueId: row.venue?.id ?? null,
    venueName: row.venue?.name ?? null,
    promoterId: row.promoter?.staffId ?? null,
    promoterName: row.promoter?.name ?? null,
    latest: row.latest,
    mapsUrl: row.latest ? mapsUrl(row.latest.latitude, row.latest.longitude) : null,
    summary,
  }
}

export function registerTerminalLocationTools(server: McpServer, scope: McpScope) {
  /** Org-level gate: caller must hold `teams:read` in SOME venue of the active org. Mirrors cash-out.ts's requireOrgReadAccess. */
  function requireOrgReadAccess(): string {
    if (!scope.activeOrg) {
      throw new ScopeError('No hay una organización activa en esta conexión — reconéctate eligiendo una organización.')
    }
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'teams:read')) return scope.activeOrg
    }
    throw new ScopeError('Missing permission teams:read in this organization')
  }

  server.tool(
    'terminal_location',
    'Última ubicación conocida de cada TPV (device-centric) de tu organización activa: serial, promotor que la trae, tienda y link a Google Maps. Agrega TODOS los venues de la organización — a diferencia de promoter_location (que rastrea a UN promotor en UN venue por día), esta es la vista de flota completa "¿dónde está cada terminal ahora?". No requiere venueId — usa la organización activa de esta conexión. sinceHours (default 24) limita qué tan viejo puede ser el último ping considerado.',
    {
      sinceHours: z.number().positive().optional().describe('Ventana en horas para considerar el último ping (default 24)'),
    },
    async ({ sinceHours }) => {
      try {
        const orgId = requireOrgReadAccess()

        // Mirror the platform gate: org-wide terminal/promoter tracking lives inside the
        // white-label dashboard (organizationStockControl.routes.ts requires at least one
        // venue in the org to have WHITE_LABEL_DASHBOARD enabled).
        const whiteLabelActive = await isWhiteLabelOrg(orgId)
        if (!whiteLabelActive) return text({ ok: false, moduleRequired: true, error: WHITE_LABEL_OFF_MSG })

        const { terminals } = await getOrgTerminalLocations({ orgId, sinceHours })
        return text({
          ok: true,
          orgId,
          count: terminals.length,
          terminals: terminals.map(describeRow),
          note: terminals.length === 0 ? 'Sin ubicaciones de terminales registradas en esta ventana de tiempo.' : undefined,
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}

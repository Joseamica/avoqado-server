import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { getPromoterTrackForVenue } from '@/services/promoters/promoterLocation.service'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'

const WHITE_LABEL_OFF_MSG = 'El seguimiento de promotores no está activo en este local (módulo WHITE_LABEL_DASHBOARD apagado).'

export function registerPromoterLocationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'promoter_location',
    'Location track ("cambaceo") of a field promoter for ONE venue-local day: the ordered route (hourly pings 11:00–18:00) plus the latest live position. White-label venues only (PROMOTERS_AUDIT). Identify the promoter by promoterId, or by promoterName — an ambiguous name returns the candidates instead of guessing. Answers "¿dónde anda / por dónde anduvo el promotor hoy?". Pass venueId; date optional (YYYY-MM-DD, defaults to venue-local today).',
    {
      venueId: z.string().describe('Venue the promoter reports to (must be in your scope)'),
      promoterId: z.string().optional().describe('Staff id of the promoter (preferred when known)'),
      promoterName: z.string().optional().describe('Promoter name to resolve when the id is unknown'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Venue-local calendar day (YYYY-MM-DD); omit for today'),
    },
    async ({ venueId, promoterId, promoterName, date }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // WHY: a colleague's live GPS route is sensitive staff data. The dashboard gates
      // promoter tracking behind a role check (verifyAccess PROMOTERS_AUDIT); there is no
      // dedicated promoters permission, so mirror with teams:read (the staff-data read gate,
      // MANAGER+), so a low-role staffer can't pull another promoter's location via the MCP.
      guard.requirePermission('teams:read', venueId)

      // Mirror the platform gate: promoter tracking lives inside the white-label
      // dashboard (verifyAccess requireWhiteLabel on /dashboard/.../promoters).
      const whiteLabelActive = await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD)
      if (!whiteLabelActive) return text({ ok: false, moduleRequired: true, error: WHITE_LABEL_OFF_MSG })

      let staffId = promoterId ?? null
      if (!staffId) {
        if (!promoterName) return text({ ok: false, error: 'Indica promoterId o promoterName.' })
        const matches = await prisma.staffVenue.findMany({
          where: {
            venueId,
            active: true,
            staff: {
              OR: [
                { firstName: { contains: promoterName, mode: 'insensitive' } },
                { lastName: { contains: promoterName, mode: 'insensitive' } },
              ],
            },
          },
          select: { staff: { select: { id: true, firstName: true, lastName: true } } },
          take: 10,
        })
        if (matches.length === 0) {
          return text({ ok: false, error: `No encontré un promotor "${promoterName}" en este local.` })
        }
        if (matches.length > 1) {
          // resolve-don't-guess: return the candidates, never pick one
          return text({
            ok: false,
            ambiguous: true,
            candidates: matches.map(m => ({ promoterId: m.staff.id, name: `${m.staff.firstName} ${m.staff.lastName}`.trim() })),
            error: 'Hay varios promotores con ese nombre — indica promoterId.',
          })
        }
        staffId = matches[0].staff.id
      }

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone ?? DEFAULT_TIMEZONE
      const track = await getPromoterTrackForVenue({ venueId, promoterId: staffId, date })

      const fmt = (d: Date) => formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm')
      const toPoint = (p: (typeof track.points)[number]) => ({
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy,
        capturedAt: fmt(p.capturedAt),
        source: p.source,
      })
      return text({
        ok: true,
        promoterId: staffId,
        date: date ?? formatInTimeZone(new Date(), tz, 'yyyy-MM-dd'),
        latest: track.latest ? toPoint(track.latest) : null,
        points: track.points.map(toPoint),
        note: track.points.length === 0 ? 'Sin ubicaciones registradas ese día.' : undefined,
      })
    },
  )
}

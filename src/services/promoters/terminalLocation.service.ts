/**
 * Terminal Location Service
 * Supervisor-facing read model over PromoterLocationPing: "where are my
 * terminals right now" — one row per terminal, most recent ping only, scoped
 * to the requester's custody (MANAGER) or the whole venue (ADMIN/OWNER/SUPERADMIN).
 */
import prisma from '../../utils/prismaClient'

export interface TerminalLocationRow {
  terminalId: string
  serialNumber: string | null
  venue: { id: string; name: string } | null
  promoter: { staffId: string; name: string } | null
  latest: { latitude: number; longitude: number; accuracy: number | null; capturedAt: string; source: string } | null
}

// pings vienen ordenados capturedAt desc → el primero por terminal es el más reciente
function latestPingPerTerminal<T extends { terminalId: string | null }>(pings: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const ping of pings) {
    if (!ping.terminalId || seen.has(ping.terminalId)) continue
    seen.add(ping.terminalId)
    out.push(ping)
  }
  return out
}

function fullName(s: { firstName?: string | null; lastName?: string | null } | null): string {
  if (!s) return ''
  return `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim()
}

const PING_INCLUDE = {
  terminal: { select: { serialNumber: true } },
  venue: { select: { id: true, name: true } },
  staff: { select: { id: true, firstName: true, lastName: true } },
} as const

function toRow(ping: any): TerminalLocationRow {
  return {
    terminalId: ping.terminalId,
    serialNumber: ping.terminal?.serialNumber ?? null,
    venue: ping.venue ? { id: ping.venue.id, name: ping.venue.name } : null,
    promoter: ping.staff ? { staffId: ping.staff.id, name: fullName(ping.staff) } : null,
    latest: {
      latitude: Number(ping.latitude),
      longitude: Number(ping.longitude),
      accuracy: ping.accuracy != null ? Number(ping.accuracy) : null,
      capturedAt: ping.capturedAt.toISOString(),
      source: ping.source,
    },
  }
}

/**
 * Latest known position per terminal, scoped to what the requester is allowed
 * to see: MANAGER only sees terminals whose latest ping belongs to a promoter
 * currently holding custody of one of their assigned SIMs; ADMIN/OWNER/SUPERADMIN
 * see every terminal in the venue.
 */
export async function getSupervisorTerminalLocations(params: {
  venueId: string
  requesterStaffId: string
  requesterRole: string
  sinceHours?: number
}): Promise<{ terminals: TerminalLocationRow[]; trackingEnabled: boolean }> {
  const { venueId, requesterStaffId, requesterRole, sinceHours = 24 } = params

  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { trackPromoterLocation: true },
  })
  const trackingEnabled = !!settings?.trackPromoterLocation

  const isElevated = ['ADMIN', 'OWNER', 'SUPERADMIN'].includes(requesterRole)

  let staffFilter: { in: string[] } | undefined
  if (!isElevated) {
    // Promotores que cuelgan de la custodia de SIMs de este supervisor.
    const items = await prisma.serializedItem.findMany({
      where: {
        assignedSupervisorId: requesterStaffId,
        custodyState: 'PROMOTER_HELD',
        assignedPromoterId: { not: null },
      },
      select: { assignedPromoterId: true },
      distinct: ['assignedPromoterId'],
    })
    const promoterIds = items.map(i => i.assignedPromoterId!).filter(Boolean)
    if (promoterIds.length === 0) return { terminals: [], trackingEnabled }
    staffFilter = { in: promoterIds }
  }

  const since = new Date(Date.now() - sinceHours * 3600_000)
  const pings = await prisma.promoterLocationPing.findMany({
    where: {
      venueId,
      capturedAt: { gte: since },
      terminalId: { not: null },
      ...(staffFilter ? { staffId: staffFilter } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    include: PING_INCLUDE,
  })

  return { terminals: latestPingPerTerminal(pings).map(toRow), trackingEnabled }
}

/**
 * Latest known position per terminal across an entire organization — for the
 * org OWNER's fleet-wide view (not scoped to a single venue). Gathers the
 * org's venue ids, then reduces to one row per terminal the same way as
 * `getSupervisorTerminalLocations`.
 */
export async function getOrgTerminalLocations(params: {
  orgId: string
  sinceHours?: number
}): Promise<{ terminals: TerminalLocationRow[] }> {
  const { orgId, sinceHours = 24 } = params

  const venues = await prisma.venue.findMany({ where: { organizationId: orgId }, select: { id: true } })
  const venueIds = venues.map(v => v.id)
  if (venueIds.length === 0) return { terminals: [] }

  const since = new Date(Date.now() - sinceHours * 3600_000)
  const pings = await prisma.promoterLocationPing.findMany({
    where: { venueId: { in: venueIds }, capturedAt: { gte: since }, terminalId: { not: null } },
    orderBy: { capturedAt: 'desc' },
    include: PING_INCLUDE,
  })

  return { terminals: latestPingPerTerminal(pings).map(toRow) }
}

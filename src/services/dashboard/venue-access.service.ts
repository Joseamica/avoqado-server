import prisma from '@/utils/prismaClient'
import { StaffRole } from '@prisma/client'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

export interface VenueAccessGrant {
  staffId: string
  role: StaffRole
  pin?: string
}

export interface GrantResult {
  staffId: string
  role: StaffRole
  pin: string | null
}

/**
 * Grant venue access to a batch of staff ATOMICALLY.
 *
 * Pre-validates the batch (no duplicate staff, no duplicate PINs), then upserts
 * all assignments in ONE transaction — all succeed or none do, so a destination
 * venue never ends up half-provisioned. Audit logs are written only AFTER the
 * transaction commits (best-effort, never throws).
 *
 * This is the primitive behind both the migration wizard's carry-over step and
 * the standalone "Dar acceso a una persona" action. Each upsert independently
 * re-checks staff ∈ org + PIN uniqueness (see upsertVenueAssignment).
 */
export async function grantVenueAccessBatch(venueId: string, grants: VenueAccessGrant[], actor: TerminalActor): Promise<GrantResult[]> {
  if (grants.length === 0) {
    throw new BadRequestError('Selecciona al menos una persona')
  }

  const ids = grants.map(g => g.staffId)
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestError('Una persona aparece dos veces en la lista.')
  }

  const pins = grants.map(g => g.pin).filter((p): p is string => !!p)
  if (new Set(pins).size !== pins.length) {
    throw new BadRequestError('Dos personas tienen el mismo PIN. Cada PIN debe ser distinto.')
  }

  await prisma.$transaction(async tx => {
    for (const g of grants) {
      await upsertVenueAssignment(tx, g.staffId, venueId, g.role, g.pin)
    }
  })

  for (const g of grants) {
    await logAction({
      staffId: actor.staffId ?? null,
      venueId,
      action: 'STAFF_VENUE_ACCESS_GRANTED',
      entity: 'StaffVenue',
      entityId: g.staffId,
      data: { grantedStaffId: g.staffId, role: g.role, viaPin: !!g.pin },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }

  return grants.map(g => ({ staffId: g.staffId, role: g.role, pin: g.pin ?? null }))
}

export interface AccessCandidate {
  staffId: string
  name: string
  email: string
  inSourceVenue: boolean
  currentRoleAtSource: StaffRole | null
  alreadyAtDestination: boolean
  currentRoleAtDestination: StaffRole | null
  suggestedPin: string | null
  rolesHeld: StaffRole[]
}

function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null
  const counts = new Map<string, number>()
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * List the candidate staff for granting access to a destination venue: everyone
 * in that venue's organization, annotated for the picker so the UI can pre-select
 * the role the person had at the source venue and pre-fill their existing PIN.
 */
export async function listVenueAccessCandidates(destVenueId: string, sourceVenueId?: string): Promise<AccessCandidate[]> {
  const venue = await prisma.venue.findUnique({ where: { id: destVenueId }, select: { id: true, organizationId: true } })
  if (!venue) {
    throw new NotFoundError('Sucursal no encontrada')
  }

  const staff = await prisma.staff.findMany({
    where: { active: true, organizations: { some: { organizationId: venue.organizationId, isActive: true } } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      venues: { select: { venueId: true, role: true, pin: true, active: true } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  })

  return staff.map(s => {
    const activeVenues = s.venues.filter(v => v.active)
    const sourceRow = sourceVenueId ? activeVenues.find(v => v.venueId === sourceVenueId) : undefined
    const destRow = activeVenues.find(v => v.venueId === destVenueId)
    const pins = activeVenues.map(v => v.pin).filter((p): p is string => !!p)
    return {
      staffId: s.id,
      name: `${s.firstName} ${s.lastName}`.trim() || s.email,
      email: s.email,
      inSourceVenue: !!sourceRow,
      currentRoleAtSource: sourceRow?.role ?? null,
      alreadyAtDestination: !!destRow,
      currentRoleAtDestination: destRow?.role ?? null,
      suggestedPin: sourceRow?.pin ?? mostCommon(pins),
      rolesHeld: [...new Set(activeVenues.map(v => v.role))],
    }
  })
}

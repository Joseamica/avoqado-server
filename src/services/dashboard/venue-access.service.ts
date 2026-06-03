import prisma from '@/utils/prismaClient'
import { StaffRole } from '@prisma/client'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { TerminalActor } from '@/services/dashboard/terminals.superadmin.service'

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
export async function grantVenueAccessBatch(
  venueId: string,
  grants: VenueAccessGrant[],
  actor: TerminalActor,
): Promise<GrantResult[]> {
  if (grants.length === 0) {
    const error: any = new Error('Selecciona al menos una persona')
    error.statusCode = 400
    throw error
  }

  const ids = grants.map(g => g.staffId)
  if (new Set(ids).size !== ids.length) {
    const error: any = new Error('Una persona aparece dos veces en la lista.')
    error.statusCode = 400
    throw error
  }

  const pins = grants.map(g => g.pin).filter((p): p is string => !!p)
  if (new Set(pins).size !== pins.length) {
    const error: any = new Error('Dos personas tienen el mismo PIN. Cada PIN debe ser distinto.')
    error.statusCode = 400
    throw error
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

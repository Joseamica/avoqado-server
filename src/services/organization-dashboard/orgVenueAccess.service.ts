import prisma from '@/utils/prismaClient'
import { grantVenueAccessBatch, listVenueAccessCandidates, type VenueAccessGrant } from '@/services/dashboard/venue-access.service'
import type { TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { ForbiddenError } from '@/errors/AppError'

/**
 * Org-scoped wrappers around the venue-access service. Every venue touched by an
 * org-owner MUST belong to that owner's organization — this is the cross-tenant
 * guard (defense in depth: grantVenueAccessBatch → upsertVenueAssignment also
 * re-checks that each staff ∈ the venue's org).
 */

async function assertVenueInOrg(venueId: string, orgId: string) {
  const venue = await prisma.venue.findFirst({ where: { id: venueId, organizationId: orgId }, select: { id: true } })
  if (!venue) {
    throw new ForbiddenError('La sucursal no pertenece a esta organización')
  }
}

export async function grantVenueAccessForOrg(orgId: string, venueId: string, grants: VenueAccessGrant[], actor: TerminalActor) {
  await assertVenueInOrg(venueId, orgId)
  return grantVenueAccessBatch(venueId, grants, actor)
}

export async function listVenueAccessCandidatesForOrg(orgId: string, venueId: string, sourceVenueId?: string) {
  await assertVenueInOrg(venueId, orgId)
  if (sourceVenueId) await assertVenueInOrg(sourceVenueId, orgId)
  return listVenueAccessCandidates(venueId, sourceVenueId)
}

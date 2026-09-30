import prisma from '@/utils/prismaClient'
import { FEATURE_CATALOG } from '@/config/featureCatalog'

// Bounded by the supported catalog, not by the number of historical contracts.
const codes = FEATURE_CATALOG.flatMap(entry => (entry.featureCode ? [entry.featureCode] : []))
const activeWhere = (now = new Date()) => ({ revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } })

export async function hasCapabilityGrant(venueId: string, featureCode: string): Promise<boolean> {
  const grant = await prisma.capabilityGrant.findFirst({
    where: { venueId, featureCode, ...activeWhere() },
    select: { id: true },
  })
  return grant != null
}

export async function grantedCapabilityCodes(venueId: string): Promise<string[]> {
  const grants = await prisma.capabilityGrant.groupBy({
    by: ['featureCode'],
    where: { venueId, featureCode: { in: codes }, ...activeWhere() },
    orderBy: { featureCode: 'asc' },
    take: codes.length,
  })
  return grants.map(grant => grant.featureCode)
}

export async function venuesWithCapabilityGrant(venueIds: string[], featureCode: string): Promise<string[]> {
  if (venueIds.length === 0) return []
  const grants = await prisma.capabilityGrant.groupBy({
    by: ['venueId'],
    where: { venueId: { in: venueIds }, featureCode, ...activeWhere() },
    orderBy: { venueId: 'asc' },
    take: venueIds.length,
  })
  return grants.map(grant => grant.venueId)
}

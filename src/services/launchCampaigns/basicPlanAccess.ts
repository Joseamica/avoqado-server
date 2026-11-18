import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { activeGrantWhere } from '@/services/access/capabilityGrants.service'

/** Prisma filter for a publication whose definition is a Plan Básico (`basicPlan: true`, Task 1). */
export const BASIC_PLAN_DEFINITION_WHERE = { path: ['basicPlan'], equals: true }

/** True when an offer definition (a publication's immutable JSON) is a Plan Básico. */
export function isBasicPlanDefinition(definition: unknown): boolean {
  return (definition as { basicPlan?: unknown } | null)?.basicPlan === true
}

/**
 * «Básico vigente» per venue: a contract of a Plan Básico with a CapabilityGrant that covers `now` (the same rule as
 * `hasCapabilityGrant`), not merely an open contract. Value = that publication's `seatCap` (null or absent = unlimited).
 * Venues without one are absent from the map. One query, bounded by the number of venues. Two Básicos covering the same
 * venue should not exist (the purchase prevents it); if they do, the most permissive wins and it is logged.
 */
export async function activeBasicSeatCaps(venueIds: string[], now: Date): Promise<Map<string, number | null>> {
  const ids = [...new Set(venueIds)]
  const caps = new Map<string, number | null>()
  if (ids.length === 0) return caps
  const contracts = await prisma.hybridContract.findMany({
    where: {
      venueId: { in: ids },
      grants: { some: activeGrantWhere(now) },
      publication: { definition: BASIC_PLAN_DEFINITION_WHERE },
    },
    select: { venueId: true, publication: { select: { definition: true } } },
    take: ids.length * 2,
  })
  for (const contract of contracts) {
    const cap = (contract.publication.definition as { seatCap?: number | null }).seatCap ?? null
    if (!caps.has(contract.venueId)) {
      caps.set(contract.venueId, cap)
      continue
    }
    const previous = caps.get(contract.venueId)!
    logger.warn('🪑 Two Plan Básico contracts cover the same venue; the most permissive seat cap wins', { venueId: contract.venueId })
    caps.set(contract.venueId, previous === null || cap === null ? null : Math.max(previous, cap))
  }
  return caps
}

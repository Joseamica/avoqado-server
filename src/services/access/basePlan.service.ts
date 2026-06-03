import prisma from '@/utils/prismaClient'

/** Paid plan tier codes that grant a blanket premium unlock. Phase 1: PLAN_PRO. */
export const PAID_PLAN_TIER_CODES = ['PLAN_PRO'] as const

/**
 * True when the venue currently has an entitled base plan: an active, non-
 * suspended PLAN_PRO VenueFeature whose trial (endDate) is null or in the
 * future. This is the binary "paid or trialing" gate that unlocks all premium
 * features (the blanket grant). When false, premium locks and the venue falls
 * back to the basic set.
 */
export async function venueHasActiveBasePlan(venueId: string): Promise<boolean> {
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
    select: { active: true, suspendedAt: true, endDate: true },
  })
  if (!vf || !vf.active || vf.suspendedAt) return false
  if (vf.endDate && vf.endDate < new Date()) return false // trial expired unpaid
  return true
}

/**
 * Audit fixture: org "Avoqado Plan Tiers" with 3 clean venues at known tiers (Free / Pro / Premium)
 * so plan-tier gating can be audited without grandfathered à-la-carte grants muddying the picture.
 *
 *   tiers-free    → planTier null (FREE), no base-plan feature
 *   tiers-pro     → planTier PRO,     active PLAN_PRO VenueFeature (DB-only, no Stripe sub)
 *   tiers-premium → planTier PREMIUM, active PLAN_PREMIUM VenueFeature (DB-only)
 *
 * owner@owner.com (OWNER) + superadmin@superadmin.com (SUPERADMIN) are assigned to all 3 so you can
 * log in as a NON-superadmin owner and see the gating actually apply.
 *
 * Idempotent (upsert by slug / unique keys). Run:
 *   npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-tiers-audit.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'
import { PlanTier, StaffRole } from '@prisma/client'

const FEATURE_PLAN_PRO = 'cmpx7b6l700009k1ttad47w19'
const FEATURE_PLAN_PREMIUM = 'cmq5li4u500009ker2k49v1w1'
const STAFF_OWNER = 'cmpe64ykh00199k92lgo67j5y'
const STAFF_SUPERADMIN = 'cmpe64y9m00169k92icypj42x'

type Spec = { slug: string; name: string; tier: PlanTier | null; feature: string | null; price: number }

const VENUES: Spec[] = [
  { slug: 'tiers-free', name: 'Tiers Free', tier: null, feature: null, price: 0 },
  { slug: 'tiers-pro', name: 'Tiers Pro', tier: PlanTier.PRO, feature: FEATURE_PLAN_PRO, price: 999 },
  { slug: 'tiers-premium', name: 'Tiers Premium', tier: PlanTier.PREMIUM, feature: FEATURE_PLAN_PREMIUM, price: 1699 },
]

async function main() {
  // 1. Organization (idempotent by name)
  let org = await prisma.organization.findFirst({ where: { name: 'Avoqado Plan Tiers' } })
  if (!org) {
    org = await prisma.organization.create({
      data: { name: 'Avoqado Plan Tiers', email: 'plantiers@avoqado.test', phone: '+520000000000' },
    })
    logger.info(`Created org "Avoqado Plan Tiers" (${org.id})`)
  } else {
    logger.info(`Reusing org "Avoqado Plan Tiers" (${org.id})`)
  }

  for (const v of VENUES) {
    // status ACTIVE + kycStatus VERIFIED so the venue is fully operational (no onboarding/KYC redirects).
    const venue = await prisma.venue.upsert({
      where: { slug: v.slug },
      update: { name: v.name, organizationId: org.id, planTier: v.tier, status: 'ACTIVE', kycStatus: 'VERIFIED' },
      create: { slug: v.slug, name: v.name, organizationId: org.id, planTier: v.tier, status: 'ACTIVE', kycStatus: 'VERIFIED' },
      select: { id: true },
    })

    // staff: owner (OWNER) + superadmin (SUPERADMIN), idempotent on @@unique([staffId, venueId])
    for (const [staffId, role] of [
      [STAFF_OWNER, StaffRole.OWNER],
      [STAFF_SUPERADMIN, StaffRole.SUPERADMIN],
    ] as const) {
      await prisma.staffVenue.upsert({
        where: { staffId_venueId: { staffId, venueId: venue.id } },
        update: { role, active: true },
        create: { staffId, venueId: venue.id, role, active: true },
      })
    }

    // base-plan feature for Pro/Premium (active, no trial, DB-only — no Stripe sub)
    if (v.feature) {
      await prisma.venueFeature.upsert({
        where: { venueId_featureId: { venueId: venue.id, featureId: v.feature } },
        update: { active: true, monthlyPrice: v.price, endDate: null, suspendedAt: null },
        create: { venueId: venue.id, featureId: v.feature, active: true, monthlyPrice: v.price },
      })
    }

    logger.info(`✅ ${v.name} (${v.slug}) → tier=${v.tier ?? 'FREE'}${v.feature ? ' + base-plan feature' : ''}`)
  }

  logger.info('✅ Audit fixture ready. Log in as owner@owner.com / owner and switch to Tiers Free / Pro / Premium.')
  process.exit(0)
}

main().catch(err => {
  logger.error('seed-plan-tiers-audit failed:', err)
  process.exit(1)
})

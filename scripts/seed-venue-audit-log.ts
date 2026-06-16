/**
 * Seed: VENUE_AUDIT_LOG feature (bundled in Plan Pro — no Stripe price).
 *
 * Registers VENUE_AUDIT_LOG as a known Feature row for dashboard listing and
 * tier-gating. Access gating works via the base-plan blanket grant
 * (checkFeatureAccess) even without a VenueFeature row, so this seed is
 * hygiene-only — it does NOT grant the feature to any venue.
 *
 * Idempotent (upsert). Safe to re-run.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-venue-audit-log.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  const feature = await prisma.feature.upsert({
    where: { code: 'VENUE_AUDIT_LOG' },
    update: { active: true },
    create: {
      code: 'VENUE_AUDIT_LOG',
      name: 'Bitácora de auditoría',
      description:
        'Historial de actividad por sucursal: quién hizo qué y cuándo (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info(`✅ Seeded Feature ${feature.code} ${feature.id}`)
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

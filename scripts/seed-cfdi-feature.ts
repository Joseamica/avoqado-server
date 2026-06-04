/**
 * Seed: CFDI feature (bundled in Plan Pro — no Stripe price).
 *
 * Registers CFDI as a known Feature row for dashboard listing and white-label filtering.
 * Access gating works via the base-plan blanket grant (checkFeatureAccess) even without a
 * VenueFeature row, so this seed is hygiene-only — it does NOT grant the feature to any venue.
 *
 * Idempotent (upsert). Safe to re-run.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-cfdi-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'CFDI' },
    update: { active: true },
    create: {
      code: 'CFDI',
      name: 'Facturación CFDI 4.0',
      description: 'Emisión de facturas CFDI 4.0 (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Seeded CFDI feature')
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

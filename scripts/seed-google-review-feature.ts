/**
 * Seed: Google Review Redirect feature (bundled in Plan Pro — no Stripe price).
 *
 * Registers GOOGLE_REVIEW_REDIRECT as a known Feature row for dashboard listing and
 * per-venue granting. Access gating works via the base-plan blanket grant even without
 * a VenueFeature row, so this seed is hygiene-only — it does NOT grant the feature to any venue.
 *
 * Idempotent (upsert). Safe to re-run.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-google-review-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'GOOGLE_REVIEW_REDIRECT' },
    update: { active: true },
    create: {
      code: 'GOOGLE_REVIEW_REDIRECT',
      name: 'Reseñas y redirección a Google',
      description: 'Calificación con estrellas en el recibo digital; las de 5★ se canalizan a Google Reviews (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Seeded GOOGLE_REVIEW_REDIRECT feature')
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

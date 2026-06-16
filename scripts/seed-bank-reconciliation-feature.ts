/**
 * Seed: BANK_RECONCILIATION feature (bundled in Plan Pro — no Stripe price).
 *
 * Registra la conciliación bancaria como Feature para listado en dashboard y gating.
 * NO se agrega a PREMIUM_ONLY_CODES → `venueHasFeatureAccess` lo concede a PRO y PREMIUM.
 * Idempotente (upsert). Safe to re-run.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-bank-reconciliation-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'BANK_RECONCILIATION' },
    update: { active: true },
    create: {
      code: 'BANK_RECONCILIATION',
      name: 'Conciliación bancaria con IA',
      description: 'Sube tu estado de cuenta y concilia automáticamente contra lo que Avoqado depositó (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Seeded BANK_RECONCILIATION feature')
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

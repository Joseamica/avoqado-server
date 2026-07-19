/**
 * Seed: DELIVERY_CHANNELS feature (PREMIUM — decisión founder 2026-07-18).
 * Hygiene-only: registra el Feature row; el gating funciona por blanket grant PREMIUM
 * + PREMIUM_ONLY_CODES. Idempotente. Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-delivery-channels-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'DELIVERY_CHANNELS' },
    update: { active: true },
    create: {
      code: 'DELIVERY_CHANNELS',
      name: 'Delivery (Uber Eats, Rappi, DiDi)',
      description: 'Pedidos de plataformas de delivery directo en tu POS y cocina (vía Deliverect)',
      category: 'INTEGRATIONS',
      monthlyPrice: 0, // se cobra vía tier PREMIUM, no como add-on suelto
      active: true,
    },
  })
  logger.info('✅ Seeded DELIVERY_CHANNELS feature')
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

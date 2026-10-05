/**
 * Seed: función AGGREGATOR_PASSES (pases TotalPass y Wellhub). Plan Pro, suelta $199 MXN/mes.
 *
 * Sólo crea la fila Feature; el gating real (Pro + suelta, catálogo de planes) es del Plan 2.
 * Idempotente (upsert). Se puede volver a correr.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-aggregator-passes-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'AGGREGATOR_PASSES' },
    update: { active: true },
    create: {
      code: 'AGGREGATOR_PASSES',
      name: 'Pases TotalPass y Wellhub',
      description: 'Recibe reservas y check-ins de socios de TotalPass sin capturar a mano. Wellhub, muy pronto.',
      category: 'INTEGRATIONS',
      monthlyPrice: 199,
      active: true,
    },
  })
  logger.info('✅ Feature AGGREGATOR_PASSES lista')
}

main()
  .catch(e => {
    logger.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

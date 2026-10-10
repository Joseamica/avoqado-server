/**
 * Seed: función SHOPIFY_INTEGRATION (conector Shopify). Premium por regla; en la Fase 1 NO se vende.
 *
 * Sólo crea la fila Feature, para que superadmin pueda dar CORTESÍAS (VenueFeature con fecha de fin) a la tienda piloto.
 * 🔴 `monthlyPrice: 0` a propósito: la sincronía con Stripe crea su precio con este monto y el paywall sólo anuncia
 * «suelta a $X» cuando el precio es mayor que 0 (`useFeaturePrice` del dashboard). Los $299 entran en la Fase 5, por
 * superadmin «Precios» y el catálogo de funciones (índice v2 §8). Idempotente (upsert).
 *
 * Run (al desplegar, no en esta tarea):
 *   npx ts-node -r tsconfig-paths/register scripts/seed-shopify-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'SHOPIFY_INTEGRATION' },
    update: { active: true },
    create: {
      code: 'SHOPIFY_INTEGRATION',
      name: 'Conector Shopify',
      description: 'Catálogo y stock compartidos entre tu tienda Shopify y tu sucursal (piloto).',
      category: 'INTEGRATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Feature SHOPIFY_INTEGRATION lista')
}

main()
  .catch(e => {
    logger.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

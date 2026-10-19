/**
 * Fila Feature de PRODUCT_VARIANTS (variantes de producto). Idempotente; se corre al desplegar.
 *
 * Precio suelto en 0 a propósito: no se vende suelta, va en el plan (Pro y Premium). El id lo genera Prisma (cuid v1).
 *
 * Run (TS_NODE_TRANSPILE_ONLY=true hace falta: sin él ts-node se queda sin memoria al tipar el cliente de Prisma):
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/seed-product-variants-feature.ts
 *
 * Escribe en la base que diga el `DATABASE_URL` del `.env`. Antes de correrlo, imprime sólo el NOMBRE de la base, nunca la URL
 * completa: `node -r dotenv/config -e "console.log(new URL(process.env.DATABASE_URL).pathname)"`. Contra `av-db-25` o producción
 * sólo con el «sí» explícito del founder.
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'PRODUCT_VARIANTS' },
    update: { active: true },
    create: {
      code: 'PRODUCT_VARIANTS',
      name: 'Variantes de producto',
      description: 'Tallas, colores o presentaciones de un producto, con su SKU, código y stock por variante.',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Feature PRODUCT_VARIANTS lista')
}

main()
  .catch(e => {
    logger.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

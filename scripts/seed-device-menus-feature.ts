/**
 * Fila Feature de DEVICE_MENUS (menú de cada aparato). Idempotente; se corre al publicar (Parte E del plan «Menú del aparato»).
 *
 * Precio suelto en 0 a propósito: no se vende suelta, va incluida en el plan (Pro y Premium; founder, 30-oct). El id lo genera
 * Prisma (cuid v1). Si la fila ya existe sólo la deja activa: nunca pisa su precio, su nombre ni nada de Stripe.
 *
 * Run (TS_NODE_TRANSPILE_ONLY=true hace falta: sin él ts-node se queda sin memoria al tipar el cliente de Prisma):
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/seed-device-menus-feature.ts
 *
 * Escribe en la base que diga el `DATABASE_URL` del `.env`. Antes de correrlo, imprime sólo el NOMBRE de la base, nunca la URL
 * completa: `node -r dotenv/config -e "console.log(new URL(process.env.DATABASE_URL).pathname)"`. Contra `av-db-25` o producción
 * sólo con el «sí» explícito del founder.
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'DEVICE_MENUS' },
    update: { active: true },
    create: {
      code: 'DEVICE_MENUS',
      name: 'Menú de cada aparato',
      description: 'Elige qué menús muestra cada aparato; la búsqueda y el escáner siguen encontrando todo.',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Feature DEVICE_MENUS lista')
}

main()
  .catch(e => {
    logger.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

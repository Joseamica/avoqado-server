/**
 * Crea (o recrea) los negocios demo: uno por giro, con su usuario compartido. Lógica y explicación en
 * `src/services/demo/negociosDemo.service.ts`; el job `negocios-demo-reinicio` los reinicia cada noche.
 *
 *   NEGOCIOS_DEMO_PASSWORD=… npx tsx scripts/seed-demo-venues.ts                     # los 6 giros
 *   NEGOCIOS_DEMO_PASSWORD=… npx tsx scripts/seed-demo-venues.ts --venue restaurante  # uno
 *
 * Usa la base de DATABASE_URL. En producción sólo con el «sí, en prod» del founder.
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'
import { GIROS_DEMO, sembrarNegociosDemo } from '../src/services/demo/negociosDemo.service'

async function main() {
  const args = process.argv.slice(2)
  const soloClave = args.includes('--venue') ? args[args.indexOf('--venue') + 1] : undefined
  const db = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? 'desconocida'
  logger.info(`🌱 Negocios demo → base ${db}`)
  const { ok, fallas } = await sembrarNegociosDemo({ soloClave })
  logger.info('════════ RESUMEN ════════')
  for (const r of ok) logger.info(`✅ ${r.name} → ${r.venueId} · ${r.historyOrders} ventas · ${r.journalEntries} pólizas`)
  for (const g of GIROS_DEMO.filter(g => !soloClave || g.clave === soloClave)) logger.info(`👤 ${g.nombre}: ${g.usuario}`)
  if (fallas.length) {
    logger.error(`❌ No se sembraron: ${fallas.join(', ')}`)
    process.exitCode = 1
  }
}

main()
  .catch(err => {
    logger.error('❌ La semilla de negocios demo falló:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

/**
 * Pago al personal entra a PRO y PREMIUM (fase 3, decisión D3). Se corre una vez DESPUÉS de desplegar el Bloque C, y otra
 * vez después de republicar en superadmin cada oferta de plan que este script liste: los contratos comerciales vivos
 * conservan SERVICE_PAY en su periodo pagado y en sus renovaciones. Idempotente.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/service-pay-en-planes-comerciales.ts           # sólo dice a qué base
 *   npx ts-node -r tsconfig-paths/register scripts/service-pay-en-planes-comerciales.ts --apply   # escribe
 */
import prisma from '../src/utils/prismaClient'
import { addServicePayToLivePlanContracts } from '../src/services/launchCampaigns/hybridPlanCatchUp'

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '')
  console.log(`Base: ${url.host}${url.pathname}`)
  if (!process.argv.includes('--apply')) return console.log('Sin --apply no se escribe nada.')
  const r = await addServicePayToLivePlanContracts()
  console.log(JSON.stringify(r, null, 2))
  if (r.staleCampaigns.length) {
    console.log('Republica en superadmin estas ofertas de plan («Publicar» y luego «Activar») y vuelve a correr este script.')
    process.exitCode = 2
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

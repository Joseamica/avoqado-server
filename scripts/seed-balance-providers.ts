/**
 * One-time seed script: create the BalanceProvider catalog row(s).
 * Idempotent (upsert by `code`) — safe to run again.
 *
 * Usage: npx tsx -r tsconfig-paths/register scripts/seed-balance-providers.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const provider = await prisma.balanceProvider.upsert({
    where: { code: 'EXTERNAL_BANK' },
    update: {},
    create: {
      code: 'EXTERNAL_BANK',
      name: 'Proveedor bancario externo',
      active: true,
    },
  })

  console.log(`BalanceProvider: ${provider.name} (${provider.id})`)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

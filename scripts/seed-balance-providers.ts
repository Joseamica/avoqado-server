/**
 * One-time seed script: create the FinancialProvider catalog row(s).
 * Idempotent (upsert by `code`) — safe to run again.
 *
 * Usage: npx tsx -r tsconfig-paths/register scripts/seed-balance-providers.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const provider = await prisma.financialProvider.upsert({
    where: { code: 'EXTERNAL_BANK' },
    update: {},
    create: { code: 'EXTERNAL_BANK', name: 'Proveedor bancario externo', active: true, connectionType: 'DIRECT_CREDENTIAL' },
  })

  console.log(`FinancialProvider: ${provider.name} (${provider.id})`)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

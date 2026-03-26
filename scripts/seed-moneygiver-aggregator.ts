/**
 * One-time seed script: Create the Moneygiver aggregator and link existing merchant accounts.
 *
 * Usage: npx ts-node -r tsconfig-paths/register scripts/seed-moneygiver-aggregator.ts
 *
 * DELETE AFTER: One-time migration script
 * Created: 2026-03-25
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding Moneygiver aggregator...\n')

  // 1. Create or find the Moneygiver aggregator
  const aggregator = await prisma.aggregator.upsert({
    where: { name: 'Moneygiver' },
    update: {},
    create: {
      name: 'Moneygiver',
      baseFees: {
        DEBIT: 0.025,
        CREDIT: 0.025,
        AMEX: 0.033,
        INTERNATIONAL: 0.033,
        OTHER: 0.025,
      },
      ivaRate: 0.16,
      active: true,
    },
  })

  console.log(`Aggregator: ${aggregator.name} (${aggregator.id})`)

  // 2. Link existing Moneygiver merchant accounts
  const result = await prisma.merchantAccount.updateMany({
    where: {
      displayName: { contains: 'moneygiver', mode: 'insensitive' },
      aggregatorId: null,
    },
    data: { aggregatorId: aggregator.id },
  })

  console.log(`Linked ${result.count} merchant accounts to ${aggregator.name}`)

  // 3. Show linked accounts
  const linked = await prisma.merchantAccount.findMany({
    where: { aggregatorId: aggregator.id },
    select: { id: true, displayName: true, externalMerchantId: true },
  })

  for (const ma of linked) {
    console.log(`   -> ${ma.displayName} (${ma.externalMerchantId})`)
  }

  console.log('\nDone! Aggregator seeded and merchant accounts linked.')
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

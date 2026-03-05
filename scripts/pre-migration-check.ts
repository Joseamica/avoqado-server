/**
 * Pre-Migration Safety Check
 *
 * Run this BEFORE deploying migrations to catch potential issues.
 * Usage: npx ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface TableCheck {
  table: string
  description: string
  query: () => Promise<number>
  maxAllowed: number
}

async function main() {
  console.log('🔍 Pre-Migration Safety Check\n')

  // Define tables that should be empty or have specific constraints before migration
  const checks: TableCheck[] = [
    {
      table: 'Customer',
      description: 'Customers without venueId (will block NOT NULL migrations)',
      query: async () => {
        const result = await prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*) as count FROM "Customer" WHERE "venueId" IS NULL
        `
        return Number(result[0].count)
      },
      maxAllowed: 0,
    },
    {
      table: 'Customer',
      description: 'Total seed/test customers (may need cleanup)',
      query: async () => {
        const result = await prisma.$queryRaw<[{ count: bigint }]>`
          SELECT COUNT(*) as count FROM "Customer"
        `
        return Number(result[0].count)
      },
      maxAllowed: 50000, // Production databases have real imported customers
    },
    // Add more checks as needed for future migrations
  ]

  let hasErrors = false
  let hasWarnings = false

  for (const check of checks) {
    try {
      const count = await check.query()
      const status = count > check.maxAllowed ? '❌' : count > 0 ? '⚠️' : '✅'

      if (count > check.maxAllowed) {
        hasErrors = true
        console.log(`${status} ${check.table}: ${check.description}`)
        console.log(`   Found: ${count} (max allowed: ${check.maxAllowed})`)
        console.log(`   Action: Clean up before migration\n`)
      } else if (count > 0) {
        hasWarnings = true
        console.log(`${status} ${check.table}: ${check.description}`)
        console.log(`   Found: ${count} (within limits)\n`)
      } else {
        console.log(`${status} ${check.table}: ${check.description} - OK\n`)
      }
    } catch (error) {
      // Table might not exist yet, which is fine
      console.log(`⏭️  ${check.table}: Skipped (table may not exist yet)\n`)
    }
  }

  // Check for pending migrations
  console.log('📋 Migration Status:')
  try {
    const migrations = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      ORDER BY started_at DESC
      LIMIT 5
    `

    const failed = migrations.filter(m => m.finished_at === null)
    if (failed.length > 0) {
      hasErrors = true
      console.log('❌ Failed migrations found:')
      failed.forEach(m => console.log(`   - ${m.migration_name}`))
      console.log('   Action: Resolve with `prisma migrate resolve` or delete from _prisma_migrations\n')
    } else {
      console.log('✅ No failed migrations\n')
    }
  } catch {
    console.log('⏭️  Migration table not found (fresh database)\n')
  }

  // Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  if (hasErrors) {
    console.log('❌ BLOCKED: Fix errors above before deploying')
    process.exit(1)
  } else if (hasWarnings) {
    console.log('⚠️  WARNINGS: Review items above, but deployment can proceed')
    process.exit(0)
  } else {
    console.log('✅ ALL CLEAR: Safe to deploy migrations')
    process.exit(0)
  }
}

main()
  .catch(e => {
    console.error('Error running pre-migration check:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

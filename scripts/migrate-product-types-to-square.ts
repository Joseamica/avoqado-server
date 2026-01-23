/**
 * Migration Script: Convert Legacy Product Types to Square-Aligned Types
 *
 * This script migrates existing products from legacy types to the new Square-aligned types:
 * - FOOD → FOOD_AND_BEV (isAlcoholic: false)
 * - BEVERAGE → FOOD_AND_BEV (isAlcoholic: false)
 * - ALCOHOL → FOOD_AND_BEV (isAlcoholic: true)
 * - RETAIL → REGULAR
 * - SERVICE → SERVICE (no change)
 * - OTHER → OTHER (no change)
 *
 * Run with: npx ts-node scripts/migrate-product-types-to-square.ts
 *
 * Options:
 *   --dry-run    Preview changes without applying them
 *   --venue=ID   Only migrate products for a specific venue
 */

import { PrismaClient, ProductType } from '@prisma/client'

const prisma = new PrismaClient()

interface MigrationStats {
  food: number
  beverage: number
  alcohol: number
  retail: number
  skipped: number
  errors: number
}

async function migrateProductTypes(dryRun: boolean = false, venueId?: string) {
  console.log('╔════════════════════════════════════════════════════════════════╗')
  console.log('║  Product Types Migration: Legacy → Square-Aligned              ║')
  console.log('╚════════════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`Mode: ${dryRun ? '🔍 DRY RUN (no changes will be made)' : '🚀 LIVE MIGRATION'}`)
  if (venueId) {
    console.log(`Venue filter: ${venueId}`)
  }
  console.log('')

  const stats: MigrationStats = {
    food: 0,
    beverage: 0,
    alcohol: 0,
    retail: 0,
    skipped: 0,
    errors: 0,
  }

  const whereClause = venueId ? { venueId } : {}

  // Get counts before migration
  const countsByType = await prisma.product.groupBy({
    by: ['type'],
    where: whereClause,
    _count: true,
  })

  console.log('Current product counts by type:')
  countsByType.forEach(item => {
    console.log(`  ${item.type}: ${item._count}`)
  })
  console.log('')

  // 1. Migrate FOOD → FOOD_AND_BEV
  console.log('─────────────────────────────────────────────────────────────────')
  console.log('Step 1: FOOD → FOOD_AND_BEV (isAlcoholic: false)')
  try {
    const foodProducts = await prisma.product.findMany({
      where: { ...whereClause, type: 'FOOD' as ProductType },
      select: { id: true, name: true, venueId: true },
    })

    stats.food = foodProducts.length
    console.log(`  Found ${foodProducts.length} products to migrate`)

    if (!dryRun && foodProducts.length > 0) {
      await prisma.product.updateMany({
        where: { ...whereClause, type: 'FOOD' as ProductType },
        data: {
          type: 'FOOD_AND_BEV' as ProductType,
          isAlcoholic: false,
        },
      })
      console.log(`  ✅ Migrated ${foodProducts.length} FOOD products`)
    }
  } catch (error) {
    console.error(`  ❌ Error migrating FOOD products:`, error)
    stats.errors++
  }

  // 2. Migrate BEVERAGE → FOOD_AND_BEV
  console.log('')
  console.log('Step 2: BEVERAGE → FOOD_AND_BEV (isAlcoholic: false)')
  try {
    const beverageProducts = await prisma.product.findMany({
      where: { ...whereClause, type: 'BEVERAGE' as ProductType },
      select: { id: true, name: true, venueId: true },
    })

    stats.beverage = beverageProducts.length
    console.log(`  Found ${beverageProducts.length} products to migrate`)

    if (!dryRun && beverageProducts.length > 0) {
      await prisma.product.updateMany({
        where: { ...whereClause, type: 'BEVERAGE' as ProductType },
        data: {
          type: 'FOOD_AND_BEV' as ProductType,
          isAlcoholic: false,
        },
      })
      console.log(`  ✅ Migrated ${beverageProducts.length} BEVERAGE products`)
    }
  } catch (error) {
    console.error(`  ❌ Error migrating BEVERAGE products:`, error)
    stats.errors++
  }

  // 3. Migrate ALCOHOL → FOOD_AND_BEV + isAlcoholic: true
  console.log('')
  console.log('Step 3: ALCOHOL → FOOD_AND_BEV (isAlcoholic: true)')
  try {
    const alcoholProducts = await prisma.product.findMany({
      where: { ...whereClause, type: 'ALCOHOL' as ProductType },
      select: { id: true, name: true, venueId: true },
    })

    stats.alcohol = alcoholProducts.length
    console.log(`  Found ${alcoholProducts.length} products to migrate`)

    if (!dryRun && alcoholProducts.length > 0) {
      await prisma.product.updateMany({
        where: { ...whereClause, type: 'ALCOHOL' as ProductType },
        data: {
          type: 'FOOD_AND_BEV' as ProductType,
          isAlcoholic: true,
        },
      })
      console.log(`  ✅ Migrated ${alcoholProducts.length} ALCOHOL products (marked as alcoholic)`)
    }
  } catch (error) {
    console.error(`  ❌ Error migrating ALCOHOL products:`, error)
    stats.errors++
  }

  // 4. Migrate RETAIL → REGULAR
  console.log('')
  console.log('Step 4: RETAIL → REGULAR')
  try {
    const retailProducts = await prisma.product.findMany({
      where: { ...whereClause, type: 'RETAIL' as ProductType },
      select: { id: true, name: true, venueId: true },
    })

    stats.retail = retailProducts.length
    console.log(`  Found ${retailProducts.length} products to migrate`)

    if (!dryRun && retailProducts.length > 0) {
      await prisma.product.updateMany({
        where: { ...whereClause, type: 'RETAIL' as ProductType },
        data: {
          type: 'REGULAR' as ProductType,
        },
      })
      console.log(`  ✅ Migrated ${retailProducts.length} RETAIL products`)
    }
  } catch (error) {
    console.error(`  ❌ Error migrating RETAIL products:`, error)
    stats.errors++
  }

  // Print summary
  console.log('')
  console.log('═════════════════════════════════════════════════════════════════')
  console.log('                        MIGRATION SUMMARY')
  console.log('═════════════════════════════════════════════════════════════════')
  console.log('')
  console.log('Products migrated:')
  console.log(`  FOOD → FOOD_AND_BEV:     ${stats.food}`)
  console.log(`  BEVERAGE → FOOD_AND_BEV: ${stats.beverage}`)
  console.log(`  ALCOHOL → FOOD_AND_BEV:  ${stats.alcohol} (marked as alcoholic)`)
  console.log(`  RETAIL → REGULAR:        ${stats.retail}`)
  console.log('')
  console.log(`Total migrated: ${stats.food + stats.beverage + stats.alcohol + stats.retail}`)
  console.log(`Errors: ${stats.errors}`)
  console.log('')

  if (dryRun) {
    console.log('⚠️  DRY RUN COMPLETE - No changes were made')
    console.log('   Run without --dry-run to apply changes')
  } else {
    console.log('✅ MIGRATION COMPLETE')

    // Verify final counts
    const finalCounts = await prisma.product.groupBy({
      by: ['type'],
      where: whereClause,
      _count: true,
    })

    console.log('')
    console.log('Final product counts by type:')
    finalCounts.forEach(item => {
      console.log(`  ${item.type}: ${item._count}`)
    })
  }

  return stats
}

// Parse command line arguments
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const venueArg = args.find(arg => arg.startsWith('--venue='))
const venueId = venueArg ? venueArg.split('=')[1] : undefined

// Run migration
migrateProductTypes(dryRun, venueId)
  .then(() => {
    process.exit(0)
  })
  .catch(error => {
    console.error('Migration failed:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

/**
 * Phase 2 of inventory recovery: normalize RawMaterial.costPerUnit so it's
 * truly per-RM-unit. Many costs were entered as "per KG" but stored against an
 * RM whose unit is GRAM — multiplying gives 1000× answers in recipes.
 *
 * Heuristic for "needs ÷1000":
 *   unit=GRAM       and costPerUnit > 1   → cost was per-KG
 *   unit=MILLILITER and costPerUnit > 1   → cost was per-LITER
 * Real foods cost < $1/g and < $1/ml. Above that is virtually always a unit
 * confusion.
 *
 * This script fixes:
 *   1. RawMaterial.costPerUnit and avgCostPerUnit (÷1000)
 *   2. Active batches whose costPerUnit equals the (still-buggy) RM value —
 *      those batches were created with the same misinterpretation.
 *      Already-normalized batches (whose cost differs by exactly 1000×) are
 *      detected and left alone.
 *   3. Recipe.totalCost + RecipeLine.costPerServing recomputed end-to-end with
 *      post-fix unit conversion.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx scripts/recover-cost-per-unit.ts --dry-run
 *   DATABASE_URL="..." npx tsx scripts/recover-cost-per-unit.ts --execute
 */

import { PrismaClient, Unit, BatchStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { areUnitsCompatible, convertUnit } from '../src/utils/unitConversion'

const prisma = new PrismaClient()
const DEFAULT_VENUE_ID = 'cmisvi38o001fhr2828ygmxi2'

interface RmFix {
  id: string
  name: string
  unit: Unit
  oldCostPerUnit: Decimal
  newCostPerUnit: Decimal
  oldAvgCostPerUnit: Decimal
  newAvgCostPerUnit: Decimal
}

interface BatchFix {
  batchId: string
  batchNumber: string
  rmName: string
  oldCost: Decimal
  newCost: Decimal
}

interface RecipeFix {
  recipeId: string
  productName: string
  oldTotal: Decimal
  newTotal: Decimal
  lines: Array<{ lineId: string; ingredient: string; oldCost: Decimal; newCost: Decimal }>
}

function shouldNormalize(unit: Unit, costPerUnit: Decimal): boolean {
  const c = costPerUnit.toNumber()
  if (unit === Unit.GRAM && c > 1) return true
  if (unit === Unit.MILLILITER && c > 1) return true
  return false
}

async function planRmFixes(venueId: string): Promise<RmFix[]> {
  const rms = await prisma.rawMaterial.findMany({
    where: { venueId, active: true, deletedAt: null },
  })
  return rms
    .filter(rm => shouldNormalize(rm.unit, rm.costPerUnit))
    .map(rm => ({
      id: rm.id,
      name: rm.name,
      unit: rm.unit,
      oldCostPerUnit: rm.costPerUnit,
      newCostPerUnit: rm.costPerUnit.div(1000),
      oldAvgCostPerUnit: rm.avgCostPerUnit,
      newAvgCostPerUnit: rm.avgCostPerUnit.gt(1) ? rm.avgCostPerUnit.div(1000) : rm.avgCostPerUnit,
    }))
}

async function planBatchFixes(rmFixes: RmFix[]): Promise<BatchFix[]> {
  const fixes: BatchFix[] = []
  for (const rmFix of rmFixes) {
    const batches = await prisma.stockBatch.findMany({
      where: { rawMaterialId: rmFix.id, status: BatchStatus.ACTIVE },
    })
    for (const b of batches) {
      // A batch is "already normalized" if its cost matches the new (÷1000)
      // value, otherwise it shares the buggy original.
      const matchesBuggy = b.costPerUnit.equals(rmFix.oldCostPerUnit)
      const matchesAlreadyFixed = b.costPerUnit.equals(rmFix.newCostPerUnit)
      if (matchesBuggy && !matchesAlreadyFixed) {
        fixes.push({
          batchId: b.id,
          batchNumber: b.batchNumber,
          rmName: rmFix.name,
          oldCost: b.costPerUnit,
          newCost: b.costPerUnit.div(1000),
        })
      }
    }
  }
  return fixes
}

async function planRecipeFixes(venueId: string, rmFixIds: Set<string>): Promise<RecipeFix[]> {
  const recipes = await prisma.recipe.findMany({
    where: { product: { venueId } },
    include: {
      product: { select: { name: true } },
      lines: { include: { rawMaterial: { select: { id: true, name: true, unit: true, costPerUnit: true } } } },
    },
  })

  const fixes: RecipeFix[] = []
  for (const recipe of recipes) {
    // Only touch recipes that include at least one of the fixed RMs.
    const touchesAffectedRm = recipe.lines.some(l => rmFixIds.has(l.rawMaterialId))
    if (!touchesAffectedRm) continue

    let newTotal = new Decimal(0)
    const lineUpdates: RecipeFix['lines'] = []

    for (const line of recipe.lines) {
      const rm = line.rawMaterial
      // Use the POST-FIX cost: if this RM is in the fix set, divide by 1000.
      const effectiveCost = rmFixIds.has(rm.id) ? rm.costPerUnit.div(1000) : rm.costPerUnit
      let qtyInRm: Decimal
      if (line.unit === rm.unit) {
        qtyInRm = line.quantity
      } else if (areUnitsCompatible(line.unit, rm.unit)) {
        qtyInRm = convertUnit(line.quantity, line.unit, rm.unit)
      } else {
        continue // schema validation prevents this going forward
      }
      const newCost = qtyInRm.mul(effectiveCost).div(recipe.portionYield)
      newTotal = newTotal.add(newCost)
      const oldCost = line.costPerServing ?? new Decimal(0)
      if (!newCost.equals(oldCost)) {
        lineUpdates.push({ lineId: line.id, ingredient: rm.name, oldCost, newCost })
      }
    }

    if (!newTotal.equals(recipe.totalCost) || lineUpdates.length > 0) {
      fixes.push({
        recipeId: recipe.id,
        productName: recipe.product.name,
        oldTotal: recipe.totalCost,
        newTotal,
        lines: lineUpdates,
      })
    }
  }
  return fixes
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = !args.includes('--execute')
  const venueArg = args.find(a => a.startsWith('--venue-id='))
  const venueId = venueArg ? venueArg.split('=')[1] : DEFAULT_VENUE_ID

  console.log(`\n=== costPerUnit Recovery (${dryRun ? 'DRY-RUN' : 'EXECUTE'}) — venue ${venueId} ===\n`)

  const rmFixes = await planRmFixes(venueId)
  console.log(`PHASE 1: ${rmFixes.length} RawMaterial(s) to normalize (÷1000)`)
  for (const f of rmFixes) {
    console.log(
      `  • ${f.name} (${f.unit}): cost ${f.oldCostPerUnit}→${f.newCostPerUnit}, avg ${f.oldAvgCostPerUnit}→${f.newAvgCostPerUnit}`,
    )
  }

  const batchFixes = await planBatchFixes(rmFixes)
  console.log(`\nPHASE 2: ${batchFixes.length} batch(es) to normalize`)
  for (const f of batchFixes) {
    console.log(`  • ${f.rmName} batch ${f.batchNumber}: ${f.oldCost}→${f.newCost}`)
  }

  const rmFixIds = new Set(rmFixes.map(r => r.id))
  const recipeFixes = await planRecipeFixes(venueId, rmFixIds)
  console.log(`\nPHASE 3: ${recipeFixes.length} recipe(s) to recompute`)
  for (const r of recipeFixes) {
    console.log(`  • ${r.productName}: total ${r.oldTotal}→${r.newTotal}`)
    for (const l of r.lines) {
      console.log(`      ↳ ${l.ingredient}: ${l.oldCost}→${l.newCost}`)
    }
  }

  if (dryRun) {
    console.log('\n✅ DRY-RUN COMPLETE — no changes made. Re-run with --execute to apply.')
    return
  }

  console.log('\n🔒 Applying transaction...')
  await prisma.$transaction(
    async tx => {
      for (const f of rmFixes) {
        await tx.rawMaterial.update({
          where: { id: f.id },
          data: { costPerUnit: f.newCostPerUnit, avgCostPerUnit: f.newAvgCostPerUnit },
        })
      }
      for (const f of batchFixes) {
        await tx.stockBatch.update({ where: { id: f.batchId }, data: { costPerUnit: f.newCost } })
      }
      for (const r of recipeFixes) {
        for (const l of r.lines) {
          await tx.recipeLine.update({ where: { id: l.lineId }, data: { costPerServing: l.newCost } })
        }
        await tx.recipe.update({ where: { id: r.recipeId }, data: { totalCost: r.newTotal } })
      }
    },
    { isolationLevel: 'Serializable', timeout: 60000 },
  )
  console.log('✅ Recovery complete.')
}

main()
  .catch(e => {
    console.error('\n❌', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

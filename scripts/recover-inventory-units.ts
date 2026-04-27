/**
 * Recovery script for the unit-conversion inventory bug.
 *
 * Three things go wrong in this codebase if recipes/modifiers and raw materials
 * are stored in different units (e.g. "0.062 KG of protein stored in GRAM"):
 *   1. RawMaterial.currentStock is updated with the raw recipe number, not the
 *      unit-converted equivalent → 1000× divergence.
 *   2. StockBatches were sometimes created in a different unit than the
 *      RawMaterial that owns them, so SUM(batch.remaining) ≠ currentStock.
 *   3. Some RawMaterials have currentStock > 0 but zero ACTIVE batches, which
 *      causes deductStockFIFO to throw "no active batches" — silent payment-
 *      time deduction failures.
 *
 * The deduction code is now fixed (rawMaterial.service.ts +
 * fifoBatch.service.ts). This script repairs the data already affected.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx scripts/recover-inventory-units.ts --dry-run
 *   DATABASE_URL="..." npx tsx scripts/recover-inventory-units.ts --execute
 *
 * Optional: --venue-id=<id>  → restrict to a single venue (defaults to Mindform).
 */

import { PrismaClient, BatchStatus, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { areUnitsCompatible, convertUnit } from '../src/utils/unitConversion'

const prisma = new PrismaClient()

const DEFAULT_VENUE_ID = 'cmisvi38o001fhr2828ygmxi2' // Mindform

interface BackfillPlan {
  rawMaterialId: string
  name: string
  unit: Unit
  currentStock: Decimal
  costPerUnit: Decimal
}

interface BatchNormalizePlan {
  batchId: string
  rawMaterialName: string
  fromUnit: Unit
  toUnit: Unit
  initialBefore: Decimal
  initialAfter: Decimal
  remainingBefore: Decimal
  remainingAfter: Decimal
  costPerUnitBefore: Decimal
  costPerUnitAfter: Decimal
}

interface RecomputePlan {
  rawMaterialId: string
  name: string
  unit: Unit
  before: Decimal
  after: Decimal
  delta: Decimal
}

async function findBackfillNeeded(venueId: string): Promise<BackfillPlan[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; unit: Unit; currentStock: number; costPerUnit: number }>>`
    SELECT rm.id, rm.name, rm.unit, rm."currentStock"::float AS "currentStock", rm."costPerUnit"::float AS "costPerUnit"
    FROM "RawMaterial" rm
    LEFT JOIN "StockBatch" sb ON sb."rawMaterialId" = rm.id AND sb.status = 'ACTIVE' AND sb."remainingQuantity" > 0
    WHERE rm."venueId" = ${venueId}
      AND rm.active = true
      AND rm."deletedAt" IS NULL
      AND rm."currentStock" > 0
    GROUP BY rm.id
    HAVING COUNT(sb.id) = 0
  `
  return rows.map(r => ({
    rawMaterialId: r.id,
    name: r.name,
    unit: r.unit,
    currentStock: new Decimal(r.currentStock),
    costPerUnit: new Decimal(r.costPerUnit),
  }))
}

async function findBatchUnitMismatches(venueId: string): Promise<BatchNormalizePlan[]> {
  const batches = await prisma.stockBatch.findMany({
    where: { venueId, status: BatchStatus.ACTIVE },
    include: { rawMaterial: { select: { name: true, unit: true } } },
  })
  const plans: BatchNormalizePlan[] = []
  for (const b of batches) {
    if (b.unit === b.rawMaterial.unit) continue
    if (!areUnitsCompatible(b.unit, b.rawMaterial.unit)) {
      console.warn(
        `⚠️  Skipping batch ${b.batchNumber} (${b.rawMaterial.name}): unit ${b.unit} incompatible with RM unit ${b.rawMaterial.unit}`,
      )
      continue
    }
    const initialAfter = convertUnit(b.initialQuantity, b.unit, b.rawMaterial.unit)
    const remainingAfter = convertUnit(b.remainingQuantity, b.unit, b.rawMaterial.unit)
    // costPerUnit conversion: per-batch-unit → per-RM-unit. If 1 KG = 1000 g,
    // and the cost was "$10 per KG", the cost per gram is $10/1000.
    const costPerUnitAfter = b.costPerUnit.mul(b.initialQuantity).div(initialAfter)
    plans.push({
      batchId: b.id,
      rawMaterialName: b.rawMaterial.name,
      fromUnit: b.unit,
      toUnit: b.rawMaterial.unit,
      initialBefore: b.initialQuantity,
      initialAfter,
      remainingBefore: b.remainingQuantity,
      remainingAfter,
      costPerUnitBefore: b.costPerUnit,
      costPerUnitAfter,
    })
  }
  return plans
}

/**
 * Compute the post-recovery currentStock for each RM. In dry-run we need to
 * simulate phases 1 and 2 in-memory so the reported drift matches what will
 * actually exist after --execute (otherwise we'd report "Café Espresso → 0"
 * because the backfill batch hasn't been written yet).
 */
async function findCurrentStockDrift(
  venueId: string,
  pendingBackfills: BackfillPlan[] = [],
  pendingNormalizes: BatchNormalizePlan[] = [],
): Promise<RecomputePlan[]> {
  const rms = await prisma.rawMaterial.findMany({
    where: { venueId, active: true, deletedAt: null },
    include: {
      batches: { where: { status: BatchStatus.ACTIVE } },
    },
  })
  const backfillByRm = new Map(pendingBackfills.map(p => [p.rawMaterialId, p]))
  const normalizeByBatch = new Map(pendingNormalizes.map(p => [p.batchId, p]))

  const plans: RecomputePlan[] = []
  for (const rm of rms) {
    let after = new Decimal(0)
    for (const b of rm.batches) {
      const sim = normalizeByBatch.get(b.id)
      const remaining = sim ? sim.remainingAfter : b.remainingQuantity
      const unit = sim ? sim.toUnit : b.unit
      if (unit === rm.unit) {
        after = after.add(remaining)
      } else if (areUnitsCompatible(unit, rm.unit)) {
        after = after.add(convertUnit(remaining, unit, rm.unit))
      }
    }
    const backfill = backfillByRm.get(rm.id)
    if (backfill) {
      after = after.add(backfill.currentStock)
    }
    if (!after.equals(rm.currentStock)) {
      plans.push({
        rawMaterialId: rm.id,
        name: rm.name,
        unit: rm.unit,
        before: rm.currentStock,
        after,
        delta: after.sub(rm.currentStock),
      })
    }
  }
  return plans
}

async function generateBatchNumber(venueId: string, rawMaterialId: string): Promise<string> {
  const today = new Date()
  const datePrefix = `RECOVER-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  const last = await prisma.stockBatch.findFirst({
    where: { venueId, rawMaterialId, batchNumber: { startsWith: datePrefix } },
    orderBy: { batchNumber: 'desc' },
  })
  if (!last) return `${datePrefix}-001`
  const seq = parseInt(last.batchNumber.split('-')[2])
  return `${datePrefix}-${String(seq + 1).padStart(3, '0')}`
}

async function executeBackfill(plans: BackfillPlan[], venueId: string): Promise<void> {
  for (const p of plans) {
    const batchNumber = await generateBatchNumber(venueId, p.rawMaterialId)
    await prisma.stockBatch.create({
      data: {
        venueId,
        rawMaterialId: p.rawMaterialId,
        batchNumber,
        initialQuantity: p.currentStock,
        remainingQuantity: p.currentStock,
        unit: p.unit,
        costPerUnit: p.costPerUnit,
        receivedDate: new Date(),
        status: BatchStatus.ACTIVE,
      },
    })
    console.log(`  ✓ Created batch ${batchNumber} for "${p.name}" (${p.currentStock.toString()} ${p.unit})`)
  }
}

async function executeBatchNormalize(plans: BatchNormalizePlan[]): Promise<void> {
  for (const p of plans) {
    await prisma.stockBatch.update({
      where: { id: p.batchId },
      data: {
        initialQuantity: p.initialAfter,
        remainingQuantity: p.remainingAfter,
        unit: p.toUnit,
        costPerUnit: p.costPerUnitAfter,
      },
    })
    console.log(
      `  ✓ Normalized batch ${p.batchId.slice(0, 12)}... "${p.rawMaterialName}": ${p.fromUnit}→${p.toUnit}, remaining ${p.remainingBefore.toString()}→${p.remainingAfter.toString()}`,
    )
  }
}

async function executeRecompute(plans: RecomputePlan[]): Promise<void> {
  for (const p of plans) {
    await prisma.rawMaterial.update({
      where: { id: p.rawMaterialId },
      data: { currentStock: p.after },
    })
    const sign = p.delta.gte(0) ? '+' : ''
    console.log(`  ✓ "${p.name}": ${p.before.toString()} → ${p.after.toString()} ${p.unit} (${sign}${p.delta.toString()})`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = !args.includes('--execute')
  const venueArg = args.find(a => a.startsWith('--venue-id='))
  const venueId = venueArg ? venueArg.split('=')[1] : DEFAULT_VENUE_ID

  console.log(`\n=== Inventory Recovery (${dryRun ? 'DRY-RUN' : 'EXECUTE'}) — venue ${venueId} ===\n`)

  // PHASE 1: discovery
  const backfills = await findBackfillNeeded(venueId)
  const batchMismatches = await findBatchUnitMismatches(venueId)
  console.log(`Found ${backfills.length} RM(s) with stock but no batches`)
  console.log(`Found ${batchMismatches.length} batch(es) whose unit ≠ RM unit`)

  console.log('\n--- PHASE 1: Backfill missing batches ---')
  for (const p of backfills) {
    console.log(
      `  • "${p.name}" (${p.rawMaterialId}) — create batch ${p.currentStock.toString()} ${p.unit}, $${p.costPerUnit.toString()}/${p.unit}`,
    )
  }

  console.log('\n--- PHASE 2: Normalize batch units ---')
  for (const p of batchMismatches) {
    console.log(
      `  • Batch ${p.batchId.slice(0, 12)}... "${p.rawMaterialName}": ${p.fromUnit}→${p.toUnit}, remaining ${p.remainingBefore}→${p.remainingAfter}, costPerUnit ${p.costPerUnitBefore}→${p.costPerUnitAfter}`,
    )
  }

  if (!dryRun) {
    console.log('\n🔒 Applying PHASE 1 + PHASE 2...')
    await executeBackfill(backfills, venueId)
    await executeBatchNormalize(batchMismatches)
  }

  // PHASE 3: recompute currentStock. In dry-run, simulate phases 1+2 in memory
  // so the reported drift matches the post-execute state.
  console.log('\n--- PHASE 3: Recompute RawMaterial.currentStock from active batches ---')
  const drift = dryRun ? await findCurrentStockDrift(venueId, backfills, batchMismatches) : await findCurrentStockDrift(venueId)
  console.log(`Found ${drift.length} RM(s) with currentStock ≠ SUM(active batches)`)
  for (const p of drift) {
    const sign = p.delta.gte(0) ? '+' : ''
    console.log(`  • "${p.name}": ${p.before.toString()} → ${p.after.toString()} ${p.unit} (${sign}${p.delta.toString()})`)
  }

  if (!dryRun) {
    await executeRecompute(drift)
    const finalDrift = await findCurrentStockDrift(venueId)
    if (finalDrift.length !== 0) {
      throw new Error(`Verification failed: ${finalDrift.length} RM(s) still drifting after recompute`)
    }
    console.log('\n✅ Recovery complete. All active batches sum equals RawMaterial.currentStock.')
  } else {
    console.log('\n✅ DRY-RUN COMPLETE — no changes made. Re-run with --execute to apply.')
  }
}

main()
  .catch(err => {
    console.error('\n❌ ERROR:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

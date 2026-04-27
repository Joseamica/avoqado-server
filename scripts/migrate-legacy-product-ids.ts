/**
 * Migrate legacy Product/RawMaterial IDs to standard cuid v1 format.
 *
 * Why: ~11% of products and some raw materials in production have IDs that
 * don't match z.cuid() validation (e.g. "rb44l0fgk30kp0soskrlys5c", "prod_ad_*").
 * The schema was already loosened to accept them, but normalizing makes future
 * manual recipe inserts and tooling consistent.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx scripts/migrate-legacy-product-ids.ts --dry-run
 *   DATABASE_URL="..." npx tsx scripts/migrate-legacy-product-ids.ts --execute
 *
 * Safety:
 *   - --dry-run: only SELECT queries, prints proposed mapping. Zero risk.
 *   - --execute: wraps all updates in a single Serializable transaction.
 *     Rollbacks automatically on any error. Run during low-traffic window.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Standard cuid v1 format: c + 24 lowercase alphanumerics = 25 chars total
const CUID_V1 = /^c[a-z0-9]{24}$/

// Minimal cuid v1 generator (no new deps). Produces 25-char IDs matching CUID_V1.
let counter = Math.floor(Math.random() * 1e4)
function cuid(): string {
  const timestamp = Date.now().toString(36).padStart(8, '0').slice(-8)
  const ctr = (counter++ % 0xffffff).toString(36).padStart(4, '0').slice(-4)
  const pid = (process.pid % 0xffff).toString(36).padStart(4, '0').slice(-4)
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, '0').slice(-8)
  const id = 'c' + (timestamp + ctr + pid + rand).slice(0, 24)
  if (!CUID_V1.test(id)) throw new Error(`Generated bad cuid: ${id}`)
  return id
}

interface Mapping {
  oldId: string
  newId: string
  name: string
  venueId: string
  refs: Record<string, number>
}

const PRODUCT_REF_TABLES = [
  { table: 'Inventory', column: 'productId' },
  { table: 'Recipe', column: 'productId' },
  { table: 'OrderItem', column: 'productId' },
  { table: 'PaymentLink', column: 'productId' },
  { table: 'CreditItemBalance', column: 'productId' },
  { table: 'CreditPackItem', column: 'productId' },
  { table: 'CommissionMilestone', column: 'productId' },
  { table: 'ClassSession', column: 'productId' },
] as const

const RAW_MATERIAL_REF_TABLES = [
  { table: 'RecipeLine', column: 'rawMaterialId' },
  { table: 'StockBatch', column: 'rawMaterialId' },
  { table: 'RawMaterialMovement', column: 'rawMaterialId' },
  { table: 'LowStockAlert', column: 'rawMaterialId' },
  { table: 'Modifier', column: 'rawMaterialId' },
  { table: 'PurchaseOrderItem', column: 'rawMaterialId' },
  { table: 'SupplierPricing', column: 'rawMaterialId' },
] as const

async function buildMappings(
  legacyRows: { id: string; name: string; venueId: string }[],
  refTables: ReadonlyArray<{ table: string; column: string }>,
): Promise<Mapping[]> {
  const mappings: Mapping[] = []
  for (const row of legacyRows) {
    const refs: Record<string, number> = {}
    for (const { table, column } of refTables) {
      const result = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM "${table}" WHERE "${column}" = $1`,
        row.id,
      )
      refs[table] = Number(result[0].count)
    }
    mappings.push({ oldId: row.id, newId: cuid(), name: row.name, venueId: row.venueId, refs })
  }
  return mappings
}

function summarizeRefs(refs: Record<string, number>): string {
  const nonZero = Object.entries(refs).filter(([, n]) => n > 0)
  if (nonZero.length === 0) return '(no references)'
  return nonZero.map(([t, n]) => `${t}=${n}`).join(', ')
}

async function executeMigration(productMaps: Mapping[], rawMaterialMaps: Mapping[]): Promise<void> {
  console.log('\n🔒 Opening Serializable transaction...')
  // All Product.id and RawMaterial.id FKs are declared ON UPDATE CASCADE in the
  // schema, so updating the parent row propagates the new id to every referencing
  // table atomically inside this transaction. No manual ref updates needed.
  await prisma.$transaction(
    async tx => {
      for (const m of productMaps) {
        await tx.$executeRawUnsafe(`UPDATE "Product" SET "id" = $1 WHERE "id" = $2`, m.newId, m.oldId)
        const cascaded = Object.values(m.refs).reduce((a, b) => a + b, 0)
        console.log(`  ✓ Product ${m.oldId} → ${m.newId} (${m.name})${cascaded > 0 ? ` [${cascaded} FK rows cascaded]` : ''}`)
      }
      for (const m of rawMaterialMaps) {
        await tx.$executeRawUnsafe(`UPDATE "RawMaterial" SET "id" = $1 WHERE "id" = $2`, m.newId, m.oldId)
        const cascaded = Object.values(m.refs).reduce((a, b) => a + b, 0)
        console.log(`  ✓ RawMaterial ${m.oldId} → ${m.newId} (${m.name})${cascaded > 0 ? ` [${cascaded} FK rows cascaded]` : ''}`)
      }
    },
    { isolationLevel: 'Serializable', timeout: 60000 },
  )
  console.log('🔓 Transaction committed.')
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = !args.includes('--execute')
  const mode = dryRun ? 'DRY-RUN' : 'EXECUTE'

  console.log(`\n=== Legacy ID Migration (${mode}) ===\n`)

  const legacyProducts = await prisma.$queryRaw<{ id: string; name: string; venueId: string }[]>`
    SELECT id, name, "venueId" FROM "Product" WHERE id !~ '^c[a-z0-9]{24}$' ORDER BY name
  `
  const legacyRawMaterials = await prisma.$queryRaw<{ id: string; name: string; venueId: string }[]>`
    SELECT id, name, "venueId" FROM "RawMaterial" WHERE id !~ '^c[a-z0-9]{24}$' ORDER BY name
  `

  console.log(`Found ${legacyProducts.length} legacy Products and ${legacyRawMaterials.length} legacy RawMaterials\n`)

  const productMaps = await buildMappings(legacyProducts, PRODUCT_REF_TABLES)
  const rawMaterialMaps = await buildMappings(legacyRawMaterials, RAW_MATERIAL_REF_TABLES)

  console.log('=== PRODUCT mappings ===')
  let totalProductRefs = 0
  for (const m of productMaps) {
    const refSum = Object.values(m.refs).reduce((a, b) => a + b, 0)
    totalProductRefs += refSum
    console.log(`  ${m.oldId} → ${m.newId}`)
    console.log(`    name: ${m.name}`)
    console.log(`    refs: ${summarizeRefs(m.refs)}`)
  }

  console.log('\n=== RAW MATERIAL mappings ===')
  let totalRawMaterialRefs = 0
  for (const m of rawMaterialMaps) {
    const refSum = Object.values(m.refs).reduce((a, b) => a + b, 0)
    totalRawMaterialRefs += refSum
    console.log(`  ${m.oldId} → ${m.newId}`)
    console.log(`    name: ${m.name}`)
    console.log(`    refs: ${summarizeRefs(m.refs)}`)
  }

  const totalUpdates = productMaps.length + rawMaterialMaps.length + totalProductRefs + totalRawMaterialRefs

  console.log('\n=== SUMMARY ===')
  console.log(`  Products to rename:        ${productMaps.length}`)
  console.log(`  Product FK refs to update: ${totalProductRefs}`)
  console.log(`  RawMats to rename:         ${rawMaterialMaps.length}`)
  console.log(`  RawMat FK refs to update:  ${totalRawMaterialRefs}`)
  console.log(`  TOTAL row updates:         ${totalUpdates}`)

  if (dryRun) {
    console.log('\n✅ DRY-RUN COMPLETE — no changes made to the database.')
    console.log('   Re-run with --execute to apply.')
    return
  }

  console.log('\n⚠️  EXECUTE mode — proceeding in 5 seconds. Ctrl+C to abort.')
  await new Promise(r => setTimeout(r, 5000))
  await executeMigration(productMaps, rawMaterialMaps)
  console.log('\n✅ Migration complete.')

  // Verification
  const remainingProducts = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "Product" WHERE id !~ '^c[a-z0-9]{24}$'
  `
  const remainingRawMaterials = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "RawMaterial" WHERE id !~ '^c[a-z0-9]{24}$'
  `
  console.log(`\nPost-migration verification:`)
  console.log(`  Remaining legacy Products:    ${remainingProducts[0].count}`)
  console.log(`  Remaining legacy RawMaterials: ${remainingRawMaterials[0].count}`)
  if (remainingProducts[0].count !== 0n || remainingRawMaterials[0].count !== 0n) {
    throw new Error('Verification failed: legacy IDs still present')
  }
}

main()
  .catch(err => {
    console.error('\n❌ ERROR:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

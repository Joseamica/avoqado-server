/**
 * Mindform: Loyverse → Avoqado Migration Script
 *
 * Creates categories, raw materials, products, suppliers, and discounts
 * for Mindform venue (cmisvi38o001fhr2828ygmxi2).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-loyverse-mindform.ts             # DRY RUN (default)
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-loyverse-mindform.ts --execute    # Actually create
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-loyverse-mindform.ts --rollback   # Undo migration
 *
 * Rollback reads the manifest file and deletes all created entities in reverse order.
 * DELETE THIS SCRIPT after successful migration (per testing policy).
 */

import { Prisma, ProductType, Unit, UnitType, RawMaterialCategory, DiscountType, DiscountScope } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'
import prisma from '../src/utils/prismaClient'
import { generateSlug } from '../src/utils/slugify'
import * as fs from 'fs'
import * as path from 'path'

// ─── Constants ──────────────────────────────────────────────────────────────────

const VENUE_ID = 'cmisvi38o001fhr2828ygmxi2'
const MIGRATION_TAG = 'loyverse-mindform-2026-03'
const MANIFEST_PATH = path.join(__dirname, 'migration-manifest-mindform.json')
const TAX_RATE = new Prisma.Decimal('0.16')

// ─── Manifest ───────────────────────────────────────────────────────────────────

interface ManifestEntry {
  id: string
  name: string
  sku?: string
}

interface MigrationManifest {
  venueId: string
  migrationTag: string
  executedAt: string
  phases: {
    categories: ManifestEntry[]
    rawMaterials: ManifestEntry[]
    products: ManifestEntry[]
    suppliers: ManifestEntry[]
    discounts: ManifestEntry[]
  }
}

function loadManifest(): MigrationManifest | null {
  if (!fs.existsSync(MANIFEST_PATH)) return null
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
}

function saveManifest(manifest: MigrationManifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

function createEmptyManifest(): MigrationManifest {
  return {
    venueId: VENUE_ID,
    migrationTag: MIGRATION_TAG,
    executedAt: new Date().toISOString(),
    phases: {
      categories: [],
      rawMaterials: [],
      products: [],
      suppliers: [],
      discounts: [],
    },
  }
}

// ─── Phase 1: Categories ────────────────────────────────────────────────────────

const NEW_CATEGORIES = [
  { name: 'Healthy Wifey', description: 'Ensaladas y paninis saludables' },
  { name: 'Iyashi y Cryo', description: 'Tratamientos wellness (crioterapia, Iyashi Dôme)' },
  { name: 'Colaboraciones', description: 'Productos en colaboración (reservado)' },
]

async function phase1Categories(dryRun: boolean, manifest: MigrationManifest) {
  console.log('\n══════════════════════════════════════════')
  console.log('  PHASE 1: Categories (3 new)')
  console.log('══════════════════════════════════════════')

  for (const cat of NEW_CATEGORIES) {
    const slug = generateSlug(cat.name)
    const existing = await prisma.menuCategory.findUnique({
      where: { venueId_slug: { venueId: VENUE_ID, slug } },
      select: { id: true },
    })

    if (existing) {
      console.log(`  ⏭️  SKIP "${cat.name}" — already exists (id: ${existing.id})`)
      continue
    }

    if (dryRun) {
      console.log(`  🔍 WOULD CREATE category: "${cat.name}" (slug: ${slug})`)
      continue
    }

    const created = await prisma.menuCategory.create({
      data: {
        venueId: VENUE_ID,
        name: cat.name,
        slug,
        description: cat.description,
        originSystem: 'AVOQADO',
        externalId: `loyverse-migration-${slug}`,
      },
      select: { id: true },
    })
    manifest.phases.categories.push({ id: created.id, name: cat.name })
    console.log(`  ✅ CREATED category: "${cat.name}" (id: ${created.id})`)
  }
}

// ─── Phase 2: Raw Materials ─────────────────────────────────────────────────────

const NEW_RAW_MATERIALS: {
  name: string
  unit: Unit
  unitType: UnitType
  category: RawMaterialCategory
  costPerUnit: string
}[] = [
  { name: 'Agua de Coco', unit: 'LITER', unitType: 'VOLUME', category: 'BEVERAGES', costPerUnit: '50.98' },
  { name: 'Colágeno', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'OTHER', costPerUnit: '1450.00' },
  { name: 'Cúrcuma', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'SPICES', costPerUnit: '111.51' },
  { name: 'Espirulina', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'OTHER', costPerUnit: '324.00' },
  { name: 'Frambuesa Congelada', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'FRUITS', costPerUnit: '136.00' },
  { name: 'Helado Café Scoop', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'OTHER', costPerUnit: '250.00' },
  { name: 'Jugo de Naranja', unit: 'LITER', unitType: 'VOLUME', category: 'BEVERAGES', costPerUnit: '95.67' },
  { name: 'Monk Fruit', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'SPICES', costPerUnit: '433.91' },
  { name: 'Piña', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'FRUITS', costPerUnit: '234.32' },
  { name: 'Proteína Easyfit', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'OTHER', costPerUnit: '665.00' },
  { name: 'Proteína Sesen', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'OTHER', costPerUnit: '1300.00' },
  { name: 'Jengibre', unit: 'KILOGRAM', unitType: 'WEIGHT', category: 'SPICES', costPerUnit: '3.20' },
]

async function phase2RawMaterials(dryRun: boolean, manifest: MigrationManifest) {
  console.log('\n══════════════════════════════════════════')
  console.log('  PHASE 2: Raw Materials (12 new)')
  console.log('══════════════════════════════════════════')

  for (const rm of NEW_RAW_MATERIALS) {
    const sku = `RM-${generateSlug(rm.name)}`
    const existing = await prisma.rawMaterial.findUnique({
      where: { venueId_sku: { venueId: VENUE_ID, sku } },
      select: { id: true },
    })

    if (existing) {
      console.log(`  ⏭️  SKIP "${rm.name}" — already exists (id: ${existing.id})`)
      continue
    }

    if (dryRun) {
      console.log(`  🔍 WOULD CREATE raw material: "${rm.name}" (sku: ${sku}, cost: $${rm.costPerUnit}/${rm.unit})`)
      continue
    }

    const created = await prisma.rawMaterial.create({
      data: {
        venueId: VENUE_ID,
        name: rm.name,
        sku,
        unit: rm.unit,
        unitType: rm.unitType,
        category: rm.category,
        costPerUnit: new Prisma.Decimal(rm.costPerUnit),
        avgCostPerUnit: new Prisma.Decimal(rm.costPerUnit),
        currentStock: new Prisma.Decimal('0'),
        minimumStock: new Prisma.Decimal('1'),
        reorderPoint: new Prisma.Decimal('2'),
      },
      select: { id: true },
    })
    manifest.phases.rawMaterials.push({ id: created.id, name: rm.name, sku })
    console.log(`  ✅ CREATED raw material: "${rm.name}" (id: ${created.id})`)
  }
}

// ─── Phase 3: Products ──────────────────────────────────────────────────────────

interface ProductDef {
  name: string
  sku: string
  price: string
  type: ProductType
  categoryName: string
  trackInventory?: boolean
  inventoryMethod?: 'QUANTITY' | 'RECIPE'
  description?: string
  cost?: string
}

const NEW_PRODUCTS: ProductDef[] = [
  // 3A: Healthy Wifey
  {
    name: 'Ensalada César',
    sku: '10324',
    price: '235',
    type: 'FOOD_AND_BEV',
    categoryName: 'Healthy Wifey',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },
  {
    name: 'Ensalada Good Gut',
    sku: '10320',
    price: '250',
    type: 'FOOD_AND_BEV',
    categoryName: 'Healthy Wifey',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },
  {
    name: 'Panini Búffalo',
    sku: '10321',
    price: '135',
    type: 'FOOD_AND_BEV',
    categoryName: 'Healthy Wifey',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },

  // 3B: Iyashi y Cryo
  {
    name: 'Mindform Method',
    sku: '10319',
    price: '13460',
    type: 'APPOINTMENTS_SERVICE',
    categoryName: 'Iyashi y Cryo',
    description: 'Premium package',
  },
  {
    name: 'Synergy Dose',
    sku: '10318',
    price: '9900',
    type: 'APPOINTMENTS_SERVICE',
    categoryName: 'Iyashi y Cryo',
    description: 'Treatment combo',
  },
  {
    name: 'Mindform Annual Pass',
    sku: '10317',
    price: '2950',
    type: 'APPOINTMENTS_SERVICE',
    categoryName: 'Iyashi y Cryo',
    description: 'Annual membership',
  },

  // 3C: Sesiones
  { name: 'Clase Wellhub', sku: '10089', price: '0', type: 'SERVICE', categoryName: 'Sesiones', description: 'Price set at point of sale' },
  {
    name: 'Especial Clases Privadas',
    sku: '10326',
    price: '15000',
    type: 'SERVICE',
    categoryName: 'Sesiones',
    description: 'Premium private classes',
  },

  // 3D: Store
  {
    name: 'Doradita Keto Cacao',
    sku: '10223',
    price: '145',
    type: 'RETAIL',
    categoryName: 'Store',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },
  {
    name: 'Jicama 60 grs Ranchero',
    sku: '10084',
    price: '75',
    type: 'RETAIL',
    categoryName: 'Store',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },
  {
    name: 'Botella Agua 1L',
    sku: '10315',
    price: '45',
    type: 'RETAIL',
    categoryName: 'Store',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
  },

  // 3E: Merch
  { name: 'Calcetines largos verdes', sku: '10325', price: '320', type: 'REGULAR', categoryName: 'Merch' },

  // 3F: Promociones
  { name: 'Lagree 40off', sku: '10313', price: '0', type: 'SERVICE', categoryName: 'Promociones', description: 'Promotional placeholder' },
  { name: 'Propina', sku: '10221', price: '0', type: 'DONATION', categoryName: 'Promociones', description: 'Tip jar' },

  // 3G: Shake Bar
  {
    name: 'Cacao Strength Glow Latte Leche Coco',
    sku: '10332',
    price: '92',
    type: 'FOOD_AND_BEV',
    categoryName: 'Shake Bar',
    trackInventory: true,
    inventoryMethod: 'RECIPE',
  },

  // 3H: Reclassify
  { name: 'Traje de Baño', sku: '10314', price: '2400', type: 'REGULAR', categoryName: 'Merch' },

  // 3I: Gift Cards
  {
    name: 'Gift Card Navidad $2,500',
    sku: '10310',
    price: '2500',
    type: 'REGULAR',
    categoryName: 'Store',
    description: 'Gift card denomination $2,500',
  },
  {
    name: 'Gift Card Navidad $3,300',
    sku: '10309',
    price: '3300',
    type: 'REGULAR',
    categoryName: 'Store',
    description: 'Gift card denomination $3,300',
  },
]

async function phase3Products(dryRun: boolean, manifest: MigrationManifest, categoryMap: Map<string, string>) {
  console.log('\n══════════════════════════════════════════')
  console.log('  PHASE 3: Products (18 new)')
  console.log('══════════════════════════════════════════')

  for (const prod of NEW_PRODUCTS) {
    // Check existing by SKU (explicit select to avoid columns not yet in prod)
    const existing = await prisma.product.findUnique({
      where: { venueId_sku: { venueId: VENUE_ID, sku: prod.sku } },
      select: { id: true },
    })

    if (existing) {
      console.log(`  ⏭️  SKIP "${prod.name}" (SKU ${prod.sku}) — already exists (id: ${existing.id})`)
      continue
    }

    // Resolve category
    const categoryId = categoryMap.get(prod.categoryName)
    if (!categoryId) {
      console.log(`  ❌ ERROR "${prod.name}" — category "${prod.categoryName}" not found! Skipping.`)
      continue
    }

    if (dryRun) {
      console.log(
        `  🔍 WOULD CREATE product: "${prod.name}" (SKU ${prod.sku}, $${prod.price}, type: ${prod.type}, category: ${prod.categoryName})`,
      )
      continue
    }

    // Raw SQL to avoid schema drift (allowCreditRedemption/requireCreditForBooking not in prod yet)
    const productId = createId()
    const externalData = JSON.stringify({ loyverseMigration: true, migrationTag: MIGRATION_TAG })
    const invMethod = prod.inventoryMethod ?? null

    await prisma.$executeRaw`
      INSERT INTO "Product" (
        "id", "venueId", "name", "sku", "price", "taxRate", "type", "categoryId",
        "description", "trackInventory", "inventoryMethod", "active", "originSystem",
        "externalData", "displayOrder", "featured", "isDemo", "syncStatus", "createdAt", "updatedAt"
      ) VALUES (
        ${productId}, ${VENUE_ID}, ${prod.name}, ${prod.sku},
        ${new Prisma.Decimal(prod.price)}, ${TAX_RATE},
        ${prod.type}::"ProductType", ${categoryId},
        ${prod.description ?? null}, ${prod.trackInventory ?? false},
        ${invMethod}::"InventoryMethod",
        true, 'AVOQADO'::"OriginSystem",
        ${externalData}::jsonb, 0, false, false, 'NOT_REQUIRED'::"SyncStatus",
        NOW(), NOW()
      )`

    const created = { id: productId }

    // Create Inventory record if product tracks stock
    if (prod.trackInventory) {
      const invId = createId()
      await prisma.$executeRaw`
        INSERT INTO "Inventory" ("id", "productId", "venueId", "currentStock", "reservedStock", "minimumStock", "isDemo", "updatedAt")
        VALUES (${invId}, ${productId}, ${VENUE_ID}, 0, 0, 0, false, NOW())`
    }

    manifest.phases.products.push({ id: created.id, name: prod.name, sku: prod.sku })
    console.log(`  ✅ CREATED product: "${prod.name}" (id: ${created.id}, SKU ${prod.sku})`)
  }
}

// ─── Phase 4: Suppliers ─────────────────────────────────────────────────────────

const NEW_SUPPLIERS: {
  name: string
  contactName?: string
  phone?: string
  address?: string
  notes?: string
}[] = [
  { name: 'COSTCO', contactName: 'Costco', phone: '555950 0400', address: 'COSTCO Wholesale', notes: 'General supplies' },
  { name: 'CUPVASMX', contactName: 'Cristian Gomez', phone: '5532747373', notes: 'Vaso supplier' },
  { name: 'Eduardo/Mindform Corporate', contactName: 'Mindform Corporate', phone: '5537024020', notes: 'Maintenance' },
  { name: 'HABITS', notes: 'Protein supplier' },
  { name: 'LUA', notes: 'Snack bars/granola' },
  { name: 'NILONG', contactName: 'Peter L', phone: '8617859139886', notes: 'International supplier' },
  { name: 'SUPER', notes: 'Supermarket' },
  { name: 'Sarai Spreads', phone: '5527612714', notes: 'Nut butters' },
  { name: 'CARE LAB DIVAS', contactName: 'Luna', phone: '5568954177', notes: 'Collagen drinks' },
]

async function phase4Suppliers(dryRun: boolean, manifest: MigrationManifest) {
  console.log('\n══════════════════════════════════════════')
  console.log('  PHASE 4: Suppliers (9 new)')
  console.log('══════════════════════════════════════════')

  for (const sup of NEW_SUPPLIERS) {
    const existing = await prisma.supplier.findUnique({
      where: { venueId_name: { venueId: VENUE_ID, name: sup.name } },
      select: { id: true },
    })

    if (existing) {
      console.log(`  ⏭️  SKIP "${sup.name}" — already exists (id: ${existing.id})`)
      continue
    }

    if (dryRun) {
      console.log(`  🔍 WOULD CREATE supplier: "${sup.name}"${sup.contactName ? ` (contact: ${sup.contactName})` : ''}`)
      continue
    }

    const created = await prisma.supplier.create({
      data: {
        venueId: VENUE_ID,
        name: sup.name,
        contactName: sup.contactName ?? null,
        phone: sup.phone ?? null,
        address: sup.address ?? null,
        notes: sup.notes ?? null,
        country: 'MX',
      },
      select: { id: true },
    })
    manifest.phases.suppliers.push({ id: created.id, name: sup.name })
    console.log(`  ✅ CREATED supplier: "${sup.name}" (id: ${created.id})`)
  }
}

// ─── Phase 5: Discounts ─────────────────────────────────────────────────────────

const NEW_DISCOUNTS: {
  name: string
  type: DiscountType
  value: string
  notes?: string
  timeFrom?: string
  timeUntil?: string
}[] = [
  { name: '25% Off Cryo e Iyashi 12:30-16:00', type: 'PERCENTAGE', value: '25', timeFrom: '12:30', timeUntil: '16:00' },
  { name: 'Lagree 40% off', type: 'PERCENTAGE', value: '40' },
  { name: 'Giss', type: 'PERCENTAGE', value: '5.5' },
  { name: 'HOODIE', type: 'PERCENTAGE', value: '24.99' },
  { name: 'Shakes Coaches & STAFF', type: 'PERCENTAGE', value: '27.27', notes: 'Restricted to staff' },
  { name: 'Cortesia', type: 'PERCENTAGE', value: '100', notes: 'Unrestricted (100% off)' },
  { name: '15% off', type: 'PERCENTAGE', value: '15' },
  { name: 'Descuento Wellhub Cryo', type: 'PERCENTAGE', value: '20' },
  { name: '10 OFF Shakes Cumpleaños', type: 'PERCENTAGE', value: '10', notes: 'Restricted access' },
]

async function phase5Discounts(dryRun: boolean, manifest: MigrationManifest) {
  console.log('\n══════════════════════════════════════════')
  console.log('  PHASE 5: Discounts (9 new)')
  console.log('══════════════════════════════════════════')

  for (const disc of NEW_DISCOUNTS) {
    // Check by name (no unique constraint, but prevent duplicates)
    const existing = await prisma.discount.findFirst({
      where: { venueId: VENUE_ID, name: disc.name },
      select: { id: true },
    })

    if (existing) {
      console.log(`  ⏭️  SKIP "${disc.name}" — already exists (id: ${existing.id})`)
      continue
    }

    if (dryRun) {
      console.log(
        `  🔍 WOULD CREATE discount: "${disc.name}" (${disc.type} ${disc.value}%${disc.timeFrom ? `, ${disc.timeFrom}-${disc.timeUntil}` : ''})`,
      )
      continue
    }

    const created = await prisma.discount.create({
      data: {
        venueId: VENUE_ID,
        name: disc.name,
        type: disc.type,
        value: new Prisma.Decimal(disc.value),
        scope: 'ORDER',
        description: disc.notes ?? null,
        timeFrom: disc.timeFrom ?? null,
        timeUntil: disc.timeUntil ?? null,
        active: true,
        applyBeforeTax: true,
        modifyTaxBasis: true,
      },
      select: { id: true },
    })
    manifest.phases.discounts.push({ id: created.id, name: disc.name })
    console.log(`  ✅ CREATED discount: "${disc.name}" (id: ${created.id})`)
  }
}

// ─── Rollback ───────────────────────────────────────────────────────────────────

async function rollback() {
  console.log('\n🔄 ROLLBACK MODE — Undoing migration...\n')

  const manifest = loadManifest()
  if (!manifest) {
    console.log('❌ No manifest file found at:', MANIFEST_PATH)
    console.log('   Cannot rollback without a manifest. Was the migration executed?')
    return
  }

  console.log(`📄 Manifest loaded (executed: ${manifest.executedAt})`)
  console.log(`   Venue: ${manifest.venueId}`)
  console.log(`   Tag: ${manifest.migrationTag}`)

  // Count what needs to be rolled back
  const counts = {
    discounts: manifest.phases.discounts.length,
    suppliers: manifest.phases.suppliers.length,
    products: manifest.phases.products.length,
    rawMaterials: manifest.phases.rawMaterials.length,
    categories: manifest.phases.categories.length,
  }
  console.log(`\n   Entities to rollback:`)
  console.log(`     Discounts: ${counts.discounts}`)
  console.log(`     Suppliers: ${counts.suppliers}`)
  console.log(`     Products: ${counts.products} (+ their Inventory records)`)
  console.log(`     Raw Materials: ${counts.rawMaterials}`)
  console.log(`     Categories: ${counts.categories}`)

  // ── Step 1: Delete Discounts ──────────────────────────────────────────────
  if (counts.discounts > 0) {
    console.log('\n── Rolling back Discounts...')
    for (const disc of manifest.phases.discounts) {
      try {
        // Check for dependent records (OrderDiscount)
        const deps = await prisma.orderDiscount.count({ where: { discountId: disc.id } })
        if (deps > 0) {
          console.log(`  ⚠️  SKIP "${disc.name}" — has ${deps} order references (cannot safely delete)`)
          continue
        }
        await prisma.discount.delete({ where: { id: disc.id }, select: { id: true } })
        console.log(`  🗑️  DELETED discount: "${disc.name}"`)
      } catch (e: any) {
        console.log(`  ⚠️  SKIP "${disc.name}" — ${e.code === 'P2025' ? 'not found (already deleted?)' : e.message}`)
      }
    }
  }

  // ── Step 2: Delete Suppliers ──────────────────────────────────────────────
  if (counts.suppliers > 0) {
    console.log('\n── Rolling back Suppliers...')
    for (const sup of manifest.phases.suppliers) {
      try {
        const deps = await prisma.purchaseOrder.count({ where: { supplierId: sup.id } })
        if (deps > 0) {
          console.log(`  ⚠️  SKIP "${sup.name}" — has ${deps} purchase orders (cannot safely delete)`)
          continue
        }
        await prisma.supplier.delete({ where: { id: sup.id }, select: { id: true } })
        console.log(`  🗑️  DELETED supplier: "${sup.name}"`)
      } catch (e: any) {
        console.log(`  ⚠️  SKIP "${sup.name}" — ${e.code === 'P2025' ? 'not found' : e.message}`)
      }
    }
  }

  // ── Step 3: Delete Products (Inventory + InventoryMovement cascade automatically) ──
  if (counts.products > 0) {
    console.log('\n── Rolling back Products...')
    for (const prod of manifest.phases.products) {
      try {
        // Check for order items (means product was used in orders — DO NOT delete)
        const orderDeps = await prisma.orderItem.count({ where: { productId: prod.id } })
        if (orderDeps > 0) {
          console.log(`  ⚠️  SKIP "${prod.name}" — has ${orderDeps} order items (cannot safely delete)`)
          continue
        }

        // Inventory + InventoryMovement are CASCADE-deleted from Product (raw SQL to avoid schema drift)
        await prisma.$executeRaw`DELETE FROM "Product" WHERE "id" = ${prod.id}`
        console.log(`  🗑️  DELETED product: "${prod.name}" (SKU: ${prod.sku})`)
      } catch (e: any) {
        console.log(`  ⚠️  SKIP "${prod.name}" — ${e.code === 'P2025' ? 'not found' : e.message}`)
      }
    }
  }

  // ── Step 4: Delete Raw Materials ──────────────────────────────────────────
  if (counts.rawMaterials > 0) {
    console.log('\n── Rolling back Raw Materials...')
    for (const rm of manifest.phases.rawMaterials) {
      try {
        const deps = await prisma.recipeLine.count({ where: { rawMaterialId: rm.id } })
        if (deps > 0) {
          console.log(`  ⚠️  SKIP "${rm.name}" — has ${deps} recipe lines (cannot safely delete)`)
          continue
        }
        await prisma.rawMaterial.delete({ where: { id: rm.id }, select: { id: true } })
        console.log(`  🗑️  DELETED raw material: "${rm.name}"`)
      } catch (e: any) {
        console.log(`  ⚠️  SKIP "${rm.name}" — ${e.code === 'P2025' ? 'not found' : e.message}`)
      }
    }
  }

  // ── Step 5: Delete Categories ─────────────────────────────────────────────
  if (counts.categories > 0) {
    console.log('\n── Rolling back Categories...')
    for (const cat of manifest.phases.categories) {
      try {
        const deps = await prisma.product.count({ where: { categoryId: cat.id, deletedAt: null } })
        if (deps > 0) {
          console.log(`  ⚠️  SKIP "${cat.name}" — has ${deps} products (cannot safely delete)`)
          continue
        }
        await prisma.menuCategory.delete({ where: { id: cat.id }, select: { id: true } })
        console.log(`  🗑️  DELETED category: "${cat.name}"`)
      } catch (e: any) {
        console.log(`  ⚠️  SKIP "${cat.name}" — ${e.code === 'P2025' ? 'not found' : e.message}`)
      }
    }
  }

  // Rename manifest to mark it as rolled back
  const rolledBackPath = MANIFEST_PATH.replace('.json', `.rolled-back-${Date.now()}.json`)
  fs.renameSync(MANIFEST_PATH, rolledBackPath)
  console.log(`\n✅ Rollback complete. Manifest archived: ${path.basename(rolledBackPath)}`)
}

// ─── Category Map Builder ───────────────────────────────────────────────────────

async function buildCategoryMap(): Promise<Map<string, string>> {
  const allCategories = await prisma.menuCategory.findMany({
    where: { venueId: VENUE_ID, active: true },
    select: { id: true, name: true },
  })

  const map = new Map<string, string>()
  for (const cat of allCategories) {
    map.set(cat.name, cat.id)
    // Also store lowercase version for fuzzy matching
    map.set(cat.name.toLowerCase(), cat.id)
  }
  return map
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2] || '--dry-run'

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  Mindform: Loyverse → Avoqado Migration                 ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log(
    `  Mode: ${mode === '--execute' ? '🚀 EXECUTE (writing to DB)' : mode === '--rollback' ? '🔄 ROLLBACK' : '🔍 DRY RUN (read-only)'}`,
  )
  console.log(`  Venue: ${VENUE_ID}`)
  console.log(`  Tag: ${MIGRATION_TAG}`)

  // Handle rollback
  if (mode === '--rollback') {
    await rollback()
    return
  }

  const dryRun = mode !== '--execute'

  // ── Verify venue exists ───────────────────────────────────────────────────
  const venue = await prisma.venue.findUnique({
    where: { id: VENUE_ID },
    select: { id: true, name: true, slug: true },
  })

  if (!venue) {
    console.error(`\n❌ Venue ${VENUE_ID} not found!`)
    process.exit(1)
  }
  console.log(`\n  Venue found: "${venue.name}" (slug: ${venue.slug})`)

  // ── Pre-flight counts ─────────────────────────────────────────────────────
  const [catCount, prodCount, rmCount, supCount, discCount] = await Promise.all([
    prisma.menuCategory.count({ where: { venueId: VENUE_ID, active: true } }),
    prisma.product.count({ where: { venueId: VENUE_ID, deletedAt: null } }),
    prisma.rawMaterial.count({ where: { venueId: VENUE_ID, active: true } }),
    prisma.supplier.count({ where: { venueId: VENUE_ID, active: true } }),
    prisma.discount.count({ where: { venueId: VENUE_ID, active: true } }),
  ])

  console.log('\n  Current counts:')
  console.log(`    Categories:    ${catCount}  → expected after: ${catCount + 3}`)
  console.log(`    Products:      ${prodCount}  → expected after: ${prodCount + 18}`)
  console.log(`    Raw Materials: ${rmCount}  → expected after: ${rmCount + 12}`)
  console.log(`    Suppliers:     ${supCount}  → expected after: ${supCount + 9}`)
  console.log(`    Discounts:     ${discCount}  → expected after: ${discCount + 9}`)

  // Check for existing manifest (prevent double-execute)
  if (!dryRun) {
    const existingManifest = loadManifest()
    if (existingManifest) {
      console.log(`\n⚠️  Manifest already exists (from ${existingManifest.executedAt}).`)
      console.log('   Run --rollback first, or delete the manifest to re-execute.')
      process.exit(1)
    }
  }

  // Initialize manifest
  const manifest = createEmptyManifest()

  try {
    // ── Phase 1: Categories ──────────────────────────────────────────────────
    await phase1Categories(dryRun, manifest)

    // ── Build category map (includes newly created categories) ───────────────
    const categoryMap = await buildCategoryMap()

    // Verify all needed categories exist
    const neededCategories = Array.from(new Set(NEW_PRODUCTS.map(p => p.categoryName)))
    const missing = neededCategories.filter(name => !categoryMap.has(name) && !categoryMap.has(name.toLowerCase()))
    if (missing.length > 0) {
      console.log(`\n❌ Missing categories: ${missing.join(', ')}`)
      console.log('   These categories must exist in Avoqado before products can be created.')
      if (!dryRun) process.exit(1)
    }

    // Build a resolved map (case-insensitive)
    const resolvedCategoryMap = new Map<string, string>()
    for (const name of neededCategories) {
      const id = categoryMap.get(name) || categoryMap.get(name.toLowerCase())
      if (id) resolvedCategoryMap.set(name, id)
    }

    // ── Phase 2: Raw Materials ───────────────────────────────────────────────
    await phase2RawMaterials(dryRun, manifest)

    // ── Phase 3: Products ────────────────────────────────────────────────────
    await phase3Products(dryRun, manifest, resolvedCategoryMap)

    // ── Phase 4: Suppliers ───────────────────────────────────────────────────
    await phase4Suppliers(dryRun, manifest)

    // ── Phase 5: Discounts ───────────────────────────────────────────────────
    await phase5Discounts(dryRun, manifest)

    // ── Save manifest ────────────────────────────────────────────────────────
    if (!dryRun) {
      saveManifest(manifest)
      console.log(`\n📄 Manifest saved: ${MANIFEST_PATH}`)
      console.log('   Use --rollback to undo this migration if needed.')
    }

    // ── Post-flight counts ───────────────────────────────────────────────────
    if (!dryRun) {
      const [newCat, newProd, newRm, newSup, newDisc] = await Promise.all([
        prisma.menuCategory.count({ where: { venueId: VENUE_ID, active: true } }),
        prisma.product.count({ where: { venueId: VENUE_ID, deletedAt: null } }),
        prisma.rawMaterial.count({ where: { venueId: VENUE_ID, active: true } }),
        prisma.supplier.count({ where: { venueId: VENUE_ID, active: true } }),
        prisma.discount.count({ where: { venueId: VENUE_ID, active: true } }),
      ])

      console.log('\n  Final counts:')
      console.log(`    Categories:    ${catCount} → ${newCat} (${newCat - catCount >= 0 ? '+' : ''}${newCat - catCount})`)
      console.log(`    Products:      ${prodCount} → ${newProd} (${newProd - prodCount >= 0 ? '+' : ''}${newProd - prodCount})`)
      console.log(`    Raw Materials: ${rmCount} → ${newRm} (${newRm - rmCount >= 0 ? '+' : ''}${newRm - rmCount})`)
      console.log(`    Suppliers:     ${supCount} → ${newSup} (${newSup - supCount >= 0 ? '+' : ''}${newSup - supCount})`)
      console.log(`    Discounts:     ${discCount} → ${newDisc} (${newDisc - discCount >= 0 ? '+' : ''}${newDisc - discCount})`)
    }

    console.log('\n══════════════════════════════════════════')
    console.log(dryRun ? '  DRY RUN COMPLETE — No changes made.' : '  MIGRATION COMPLETE')
    console.log('══════════════════════════════════════════\n')
  } catch (error) {
    console.error('\n❌ MIGRATION FAILED:', error)

    // If we were executing, save partial manifest for rollback
    if (!dryRun) {
      const partialPath = MANIFEST_PATH.replace('.json', '.partial.json')
      fs.writeFileSync(partialPath, JSON.stringify(manifest, null, 2))
      console.log(`\n⚠️  Partial manifest saved: ${partialPath}`)
      console.log('   Rename to migration-manifest-mindform.json and run --rollback to undo partial changes.')
    }
    process.exit(1)
  }
}

main()
  .catch(e => {
    console.error('❌ Fatal:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

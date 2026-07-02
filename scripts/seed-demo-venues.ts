/**
 * Seed Demo Venues — "one charge fires everything" pitch
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Creates 3 fully-loaded DEMO venues, typed to the active ICP (retail +
 * appointment-services), THROUGH THE REAL SERVICE LAYER so the
 * "cobro explota todo" demo runs end-to-end:
 *
 *   1. 🛍️  Lunaria Boutique  — RETAIL_STORE (Roma Norte, CDMX)
 *   2. 💇  Studio Bloom       — SALON        (Condesa, CDMX)
 *   3. 🩺  Dermédica          — CLINIC       (Polanco, CDMX) — híbrido
 *
 * Strategy (per spec specs/2026-06-30-demo-venues-seed.md):
 *   • create the venue via createVenueFromOnboarding(onboardingType:'DEMO')
 *     (auto-runs the café seeder), then wipe the café data with cleanDemoData,
 *     then seed MY type-aware data.
 *   • prefer real services; use prisma.* directly only where no service exists
 *     (inventory stock, ecommerce merchant, venueModule, reservation,
 *     fiscalEmisor, history orders).
 *
 * Idempotent: find demo org/venues by stable slug/name; on re-run wipe + reseed,
 * never duplicate. Safe to run repeatedly.
 *
 * Run:
 *   npx tsx scripts/seed-demo-venues.ts
 *   npx tsx scripts/seed-demo-venues.ts --venue lunaria   (single venue)
 *
 * Targets the DB in DATABASE_URL (.env → av-db-25 locally).
 */

import {
  BusinessType,
  VenueType,
  ProductType,
  PaymentMethod,
  OrderType,
  OrderStatus,
  PaymentStatus,
  CommissionRecipient,
  CommissionTrigger,
  CommissionCalcType,
  ReservationStatus,
  DepositStatus,
  BatchStatus,
  RawMaterialCategory,
  Unit,
  UnitType,
  Prisma,
} from '@prisma/client'
import { addDays, subDays, subHours } from 'date-fns'

import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

import { createVenueFromOnboarding } from '../src/services/onboarding/venueCreation.service'
import { cleanDemoData } from '../src/services/onboarding/demoCleanup.service'
import { seedBaseChart } from '../src/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings, getMappings } from '../src/services/fiscal/accountMapping.service'
import { generatePoliciesForVenue } from '../src/services/fiscal/autoPosting.service'
import { saveVenueFeatures } from '../src/services/dashboard/feature.service'
import { createProduct } from '../src/services/dashboard/product.dashboard.service'
import { createCommissionConfig } from '../src/services/dashboard/commission/commission-config.service'
import { createTiersBatch } from '../src/services/dashboard/commission/commission-tier.service'
import { createPaymentLink } from '../src/services/dashboard/paymentLink.service'
import { encryptProviderKey } from '../src/services/fiscal/fiscalKey.service'

// ════════════════════════════════════════════════════════════════════════════
// Stable identity keys (idempotency anchors)
// ════════════════════════════════════════════════════════════════════════════

const DEMO_ORG_SLUG = 'avoqado-demos'
const DEMO_ORG_NAME = 'Avoqado Demos'
const DEMO_OWNER_EMAIL = 'demos@avoqado.io'

// ════════════════════════════════════════════════════════════════════════════
// Venue blueprints (EXACT data from the spec)
// ════════════════════════════════════════════════════════════════════════════

type RegularProduct = { name: string; sku: string; price: number; stock: number; description?: string }
type ServiceProduct = { name: string; sku: string; price: number; durationMinutes: number; description?: string }
type Consumable = {
  name: string
  sku: string
  unit: Unit
  unitType: UnitType
  currentStock: number
  costPerUnit: number
  expiresInDays: number
  lote: string
}

interface VenueBlueprint {
  key: string
  name: string
  type: VenueType
  businessType: BusinessType
  city: string
  state: string
  zipCode: string
  address: string
  staffName: { first: string; last: string }
  staffRole: 'vendedor' | 'especialista'
  /** Decimal rate, e.g. 0.04 = 4%. */
  commissionRate: number
  /** Optional tier: rate over `tierThreshold` MXN/month. */
  tier?: { threshold: number; rate: number }
  loyalty: { pointsPerDollar: number; pointsPerVisit: number; minPointsRedeem: number }
  regulars: RegularProduct[]
  services: ServiceProduct[]
  consumables: Consumable[]
  /** Demo RFC so the chart-of-accounts (póliza) seeds without depending on Facturapi. */
  rfc: string
  legalName: string
  /** Whether to seed a future appointment (SALON + CLINIC). */
  seedReservation: boolean
  /** History order count target over the last 14 days. */
  historyOrders: number
  /** Payment-link title (branded). */
  paymentLinkTitle: string
}

const BLUEPRINTS: VenueBlueprint[] = [
  // ─── 1. Lunaria Boutique — RETAIL_STORE ────────────────────────────────────
  {
    key: 'lunaria',
    name: 'Lunaria Boutique',
    type: VenueType.RETAIL_STORE,
    businessType: BusinessType.RETAIL_STORE,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '06700',
    address: 'Av. Álvaro Obregón 145, Roma Norte',
    staffName: { first: 'Paola', last: 'Ríos' },
    staffRole: 'vendedor',
    commissionRate: 0.04,
    tier: { threshold: 20000, rate: 0.05 },
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 }, // 1 pto por $10
    regulars: [
      { name: 'Blusa de lino', sku: 'LUN-BLU-001', price: 590, stock: 24 },
      { name: 'Jeans mom fit', sku: 'LUN-JEA-002', price: 890, stock: 18 },
      { name: 'Vestido midi', sku: 'LUN-VES-003', price: 1290, stock: 12 },
      { name: 'Bolsa de piel', sku: 'LUN-BOL-004', price: 1850, stock: 8 },
      { name: 'Aretes de plata', sku: 'LUN-ARE-005', price: 450, stock: 30 },
    ],
    services: [],
    consumables: [],
    rfc: 'LBO250630AB1',
    legalName: 'Lunaria Boutique SA de CV',
    seedReservation: false,
    historyOrders: 40,
    paymentLinkTitle: 'Lunaria Boutique — Pago en tienda',
  },

  // ─── 2. Studio Bloom — SALON ───────────────────────────────────────────────
  {
    key: 'bloom',
    name: 'Studio Bloom',
    type: VenueType.SALON,
    businessType: BusinessType.OTHER,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '06140',
    address: 'Av. Tamaulipas 66, Condesa',
    staffName: { first: 'Mariana', last: 'Cano' },
    staffRole: 'especialista',
    commissionRate: 0.3, // 30% por servicio
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [{ name: 'Shampoo profesional', sku: 'BLO-SHA-001', price: 320, stock: 15 }],
    services: [
      { name: 'Corte y peinado', sku: 'BLO-COR-001', price: 450, durationMinutes: 45 },
      { name: 'Tinte completo', sku: 'BLO-TIN-002', price: 1200, durationMinutes: 120 },
      { name: 'Manicure en gel', sku: 'BLO-MAN-003', price: 350, durationMinutes: 60 },
      { name: 'Facial hidratante', sku: 'BLO-FAC-004', price: 800, durationMinutes: 60 },
      { name: 'Depilación con cera', sku: 'BLO-DEP-005', price: 400, durationMinutes: 30 },
    ],
    consumables: [],
    rfc: 'SBL250630CD2',
    legalName: 'Studio Bloom SA de CV',
    seedReservation: true,
    historyOrders: 30,
    paymentLinkTitle: 'Studio Bloom — Pago de servicio',
  },

  // ─── 3. Dermédica — CLINIC (híbrido) ───────────────────────────────────────
  {
    key: 'dermedica',
    name: 'Dermédica',
    type: VenueType.CLINIC,
    businessType: BusinessType.OTHER,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '11560',
    address: 'Av. Presidente Masaryk 220, Polanco',
    staffName: { first: 'Elena', last: 'Ruiz' },
    staffRole: 'especialista',
    commissionRate: 0.15, // "comisión por servicio" — sin tasa explícita en spec; 15% razonable
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [
      { name: 'Protector solar SPF50', sku: 'DER-SPF-001', price: 620, stock: 20 },
      { name: 'Crema retinol 0.3%', sku: 'DER-RET-002', price: 980, stock: 14 },
      { name: 'Limpiador facial', sku: 'DER-LIM-003', price: 540, stock: 18 },
    ],
    services: [
      { name: 'Consulta dermatológica', sku: 'DER-CON-001', price: 900, durationMinutes: 30 },
      { name: 'Limpieza facial profunda', sku: 'DER-LFP-002', price: 1200, durationMinutes: 60 },
      { name: 'Aplicación de toxina botulínica', sku: 'DER-TOX-003', price: 6500, durationMinutes: 45 },
      { name: 'Peeling químico', sku: 'DER-PEE-004', price: 2500, durationMinutes: 45 },
    ],
    consumables: [
      {
        name: 'Vial de toxina botulínica',
        sku: 'DER-RM-TOX',
        unit: Unit.UNIT,
        unitType: UnitType.COUNT,
        currentStock: 6,
        costPerUnit: 3200,
        expiresInDays: 180,
        lote: 'TOX-LOTE-A1',
      },
      {
        name: 'Jeringa de ácido hialurónico',
        sku: 'DER-RM-AH',
        unit: Unit.UNIT,
        unitType: UnitType.COUNT,
        currentStock: 10,
        costPerUnit: 1800,
        expiresInDays: 365,
        lote: 'AH-LOTE-B2',
      },
    ],
    rfc: 'DER250630EF3',
    legalName: 'Dermédica SA de CV',
    seedReservation: true,
    historyOrders: 25,
    paymentLinkTitle: 'Dermédica — Pago de consulta',
  },
]

// ════════════════════════════════════════════════════════════════════════════
// Prerequisites: ONE shared Organization "Avoqado Demos" + owner Staff
// ────────────────────────────────────────────────────────────────────────────
// Non-destructive: find-or-create by slug; never delete/recreate. The 3 demo
// venues live under this single org (stable IDs). The chart of accounts is
// scoped on (organizationId, rfc) and EACH venue has its OWN rfc, so the org
// holds 3 distinct 88-account charts (one per rfc) — that is correct, NOT
// duplication. We do not collapse them.
// ════════════════════════════════════════════════════════════════════════════

async function ensureDemoOrgAndOwner(): Promise<{ organizationId: string; ownerStaffId: string }> {
  // Organization (stable by slug — never recreated).
  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: {
      name: DEMO_ORG_NAME,
      slug: DEMO_ORG_SLUG,
      email: 'demos@avoqado.io',
      phone: '5500000000',
      type: BusinessType.OTHER,
    },
  })

  // Owner Staff (stable by globally-unique email).
  const owner = await prisma.staff.upsert({
    where: { email: DEMO_OWNER_EMAIL },
    update: {},
    create: {
      email: DEMO_OWNER_EMAIL,
      firstName: 'Avoqado',
      lastName: 'Demos',
      phone: '5500000000',
      active: true,
      emailVerified: true,
    },
  })

  // Membership (stable by composite unique).
  await prisma.staffOrganization.upsert({
    where: { staffId_organizationId: { staffId: owner.id, organizationId: org.id } },
    update: { isActive: true },
    create: {
      staffId: owner.id,
      organizationId: org.id,
      role: 'OWNER',
      isActive: true,
      isPrimary: true,
    },
  })

  logger.info(`✅ Shared org "${DEMO_ORG_NAME}" (${org.id}) + owner ${DEMO_OWNER_EMAIL} (${owner.id}) ready`)
  return { organizationId: org.id, ownerStaffId: owner.id }
}

// ════════════════════════════════════════════════════════════════════════════
// Venue lifecycle: find-or-create, then wipe café data
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns a bare venue (seeded CHILDREN wiped) ready for type-aware reseeding.
 * NON-DESTRUCTIVE to the venue record: finds the existing demo venue by
 * (name, shared org) and REUSES it (same ID); only creates one if it does not
 * exist yet. Never deletes/recreates the venue.
 */
async function ensureBareVenue(bp: VenueBlueprint, organizationId: string, ownerStaffId: string): Promise<string> {
  const existing = await prisma.venue.findFirst({
    where: { name: bp.name, organizationId },
    select: { id: true },
  })

  let venueId: string

  if (existing) {
    venueId = existing.id
    logger.info(`♻️  Reusing existing demo venue "${bp.name}" (${venueId}) — wiping seeded children for reseed`)
  } else {
    logger.info(`🏗️  Creating venue "${bp.name}" via onboarding (DEMO)…`)
    const result = await createVenueFromOnboarding({
      organizationId,
      userId: ownerStaffId,
      onboardingType: 'DEMO',
      businessInfo: {
        name: bp.name,
        type: bp.businessType,
        venueType: bp.type,
        timezone: 'America/Mexico_City',
        address: bp.address,
        city: bp.city,
        state: bp.state,
        country: 'MX',
        zipCode: bp.zipCode,
        phone: '5500000000',
        email: `${bp.key}@avoqado.io`,
      },
    })
    venueId = result.venue.id
    logger.info(`   → venue ${venueId} created (café data seeded: ${result.demoDataSeeded})`)
  }

  // 1) Wipe MY previously-seeded data in FK-safe order. This must run BEFORE
  //    cleanDemoData: my products are created via createProduct() and are NOT
  //    flagged isDemo, while my categories ARE isDemo. cleanDemoData deletes
  //    isDemo categories but leaves non-demo products → FK violation on reseed.
  //    Doing a full ordered wipe of my artifacts first removes that hazard.
  await wipeSeededData(venueId)

  // 2) Mop up any café/demo leftovers (only relevant on the very first run, when
  //    createVenueFromOnboarding seeded the café). On reused venues this is a
  //    no-op since wipeSeededData already cleared everything venue-scoped.
  const cleanup = await cleanDemoData(venueId)
  logger.info(
    `   🧹 cleanDemoData: ${cleanup.deletedProducts} products, ${cleanup.deletedOrders} orders, ` +
      `${cleanup.deletedRawMaterials} raw materials, ${cleanup.deletedCustomers} customers`,
  )

  // Re-pin venue fiscal RFC (used by chart-of-accounts scope) + ensure TRIAL/active.
  await prisma.venue.update({
    where: { id: venueId },
    data: { rfc: bp.rfc },
  })

  return venueId
}

/**
 * Comprehensive, FK-safe wipe of everything this script seeds for a venue.
 * Deletes by venueId (not by isDemo) so it clears BOTH my data and any café
 * leftovers. Order matters — children before parents.
 */
async function wipeSeededData(venueId: string): Promise<void> {
  // --- Auto-posted pólizas from a prior run (JournalLine cascades). Must clear
  //     these so reseeding history doesn't ACCUMULATE stale journal entries
  //     (their sourceId pointed at payments we're about to delete). The ledger
  //     accounts + mappings are org-scoped, insert-if-absent, and intentionally
  //     preserved — only the per-venue journal entries get rebuilt each run. ---
  await prisma.journalEntry.deleteMany({ where: { venueId } })

  // --- Payments & orders (children → parents) ---
  await prisma.payment.deleteMany({ where: { venueId } })
  const orders = await prisma.order.findMany({ where: { venueId }, select: { id: true } })
  const orderIds = orders.map(o => o.id)
  if (orderIds.length > 0) {
    await prisma.orderCustomer.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
    await prisma.order.deleteMany({ where: { venueId } })
  }

  // --- Reservations (must precede products: Reservation.productId FK) ---
  await prisma.reservation.deleteMany({ where: { venueId } })

  // --- Payment links (+ nested items/attributions cascade) ---
  await prisma.paymentLink.deleteMany({ where: { venueId } })

  // --- Inventory & raw-material stock (children → parents) ---
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId } })
  await prisma.stockBatch.deleteMany({ where: { venueId } })
  await prisma.rawMaterial.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })

  // --- Products (must precede categories: Product.categoryId FK) ---
  await prisma.product.deleteMany({ where: { venueId } })

  // --- Menu structure ---
  const categories = await prisma.menuCategory.findMany({ where: { venueId }, select: { id: true } })
  const categoryIds = categories.map(c => c.id)
  if (categoryIds.length > 0) {
    await prisma.menuCategoryAssignment.deleteMany({ where: { categoryId: { in: categoryIds } } })
  }
  const menus = await prisma.menu.findMany({ where: { venueId }, select: { id: true } })
  if (menus.length > 0) {
    await prisma.menuCategoryAssignment.deleteMany({ where: { menuId: { in: menus.map(m => m.id) } } })
  }
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.menu.deleteMany({ where: { venueId } })

  // --- Customers ---
  await prisma.customer.deleteMany({ where: { venueId } })

  // --- Commission tiers → configs ---
  const configs = await prisma.commissionConfig.findMany({ where: { venueId }, select: { id: true } })
  const configIds = configs.map(c => c.id)
  if (configIds.length > 0) {
    await prisma.commissionTier.deleteMany({ where: { configId: { in: configIds } } })
    await prisma.commissionConfig.deleteMany({ where: { venueId } })
  }

  // --- MerchantFiscalConfig: clear before deleting its merchant. Recreated each
  //     run (the EcommerceMerchant is recreated, so the link must be rebuilt). ---
  const venueEmisors = await prisma.fiscalEmisor.findMany({ where: { venueId }, select: { id: true } })
  if (venueEmisors.length > 0) {
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId: { in: venueEmisors.map(e => e.id) } } })
  }

  // --- Ecommerce merchants (recreated per run). Deleting sets Payment.
  //     ecommerceMerchantId → null (SetNull); harmless for already-stamped CFDIs. ---
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })

  // --- Modules / features / loyalty ---
  await prisma.venueModule.deleteMany({ where: { venueId } })
  await prisma.venueFeature.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })

  // NOTE: FiscalEmisor is intentionally PRESERVED across runs. Stamped Cfdi rows
  // reference it via onDelete: Restrict, so deleting it would (a) fail once a
  // sandbox CFDI exists and (b) destroy the demo factura examples. seedFiscalEmisor
  // upserts it instead (idempotent by (venueId, rfc)).
}

// ════════════════════════════════════════════════════════════════════════════
// Features + modules
// ════════════════════════════════════════════════════════════════════════════

/** Enable CFDI, INVENTORY_TRACKING, LOYALTY_PROGRAM as VenueFeatures (by code→id). */
async function enableFeatures(venueId: string): Promise<void> {
  const codes = ['CFDI', 'INVENTORY_TRACKING', 'LOYALTY_PROGRAM']
  const features = await prisma.feature.findMany({ where: { code: { in: codes }, active: true }, select: { id: true, code: true } })
  if (features.length === 0) {
    logger.warn(`   ⚠️ No matching Feature rows for ${codes.join(', ')} — skipping feature enable`)
    return
  }
  await saveVenueFeatures(
    venueId,
    features.map(f => f.id),
  )
  logger.info(`   ✅ Features enabled: ${features.map(f => f.code).join(', ')}`)
}

/** Enable the COMMISSIONS module (it's a Module, not a Feature, in this DB). */
async function enableCommissionsModule(venueId: string, ownerStaffId: string): Promise<void> {
  const module = await prisma.module.findUnique({ where: { code: 'COMMISSIONS' }, select: { id: true } })
  if (!module) {
    logger.warn('   ⚠️ COMMISSIONS module not found — skipping module enable')
    return
  }
  await prisma.venueModule.upsert({
    where: { venueId_moduleId: { venueId, moduleId: module.id } },
    update: { enabled: true },
    create: { venueId, moduleId: module.id, enabled: true, enabledBy: ownerStaffId },
  })
  logger.info('   ✅ COMMISSIONS module enabled')
}

// ════════════════════════════════════════════════════════════════════════════
// Catalog: category + products (REGULAR with stock) + services (APPOINTMENTS)
// ════════════════════════════════════════════════════════════════════════════

interface SeededProduct {
  id: string
  name: string
  price: number
  type: ProductType
}

async function seedCatalog(bp: VenueBlueprint, venueId: string): Promise<SeededProduct[]> {
  const seeded: SeededProduct[] = []

  // --- Category for retail products ---
  if (bp.regulars.length > 0) {
    const catName = bp.type === VenueType.RETAIL_STORE ? 'Catálogo' : 'Productos'
    const productCat = await prisma.menuCategory.create({
      data: { venueId, name: catName, slug: `${bp.key}-productos`, active: true, displayOrder: 1, isDemo: true },
    })

    for (const p of bp.regulars) {
      const product = await createProduct(venueId, {
        name: p.name,
        description: p.description,
        price: p.price,
        type: ProductType.REGULAR,
        sku: p.sku,
        categoryId: productCat.id,
      })

      // Turn on quantity inventory tracking + create the stock row (mirrors the
      // café seeder's seedProductInventory pattern).
      await prisma.product.update({
        where: { id: product.id },
        data: { inventoryMethod: 'QUANTITY', unit: Unit.UNIT },
      })
      await prisma.inventory.create({
        data: {
          venueId,
          productId: product.id,
          currentStock: p.stock,
          minimumStock: Math.max(2, Math.floor(p.stock * 0.2)),
          maximumStock: Math.ceil(p.stock * 1.5),
          reservedStock: 0,
          isDemo: true,
        },
      })

      seeded.push({ id: product.id, name: product.name, price: p.price, type: ProductType.REGULAR })
    }
    logger.info(`   ✅ ${bp.regulars.length} REGULAR products + inventory`)
  }

  // --- Category for services ---
  if (bp.services.length > 0) {
    const svcCat = await prisma.menuCategory.create({
      data: { venueId, name: 'Servicios', slug: `${bp.key}-servicios`, active: true, displayOrder: 2, isDemo: true },
    })

    for (const s of bp.services) {
      const product = await createProduct(venueId, {
        name: s.name,
        description: s.description,
        price: s.price,
        type: ProductType.APPOINTMENTS_SERVICE,
        sku: s.sku,
        categoryId: svcCat.id,
        durationMinutes: s.durationMinutes,
        duration: s.durationMinutes,
      })
      seeded.push({ id: product.id, name: product.name, price: s.price, type: ProductType.APPOINTMENTS_SERVICE })
    }
    logger.info(`   ✅ ${bp.services.length} APPOINTMENTS_SERVICE products`)
  }

  return seeded
}

// ════════════════════════════════════════════════════════════════════════════
// Consumables (RawMaterial + StockBatch with lote + caducidad)
// ════════════════════════════════════════════════════════════════════════════

async function seedConsumables(bp: VenueBlueprint, venueId: string): Promise<void> {
  if (bp.consumables.length === 0) return

  for (const c of bp.consumables) {
    const rm = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: c.name,
        sku: c.sku,
        category: RawMaterialCategory.OTHER,
        currentStock: c.currentStock,
        unit: c.unit,
        unitType: c.unitType,
        minimumStock: 2,
        reorderPoint: 3,
        costPerUnit: c.costPerUnit,
        avgCostPerUnit: c.costPerUnit,
        isDemo: true,
      },
    })

    const batch = await prisma.stockBatch.create({
      data: {
        venueId,
        rawMaterialId: rm.id,
        batchNumber: c.lote,
        initialQuantity: c.currentStock,
        remainingQuantity: c.currentStock,
        unit: c.unit,
        costPerUnit: c.costPerUnit,
        receivedDate: new Date(),
        expirationDate: addDays(new Date(), c.expiresInDays),
        status: BatchStatus.ACTIVE,
      },
    })

    await prisma.rawMaterialMovement.create({
      data: {
        venueId,
        rawMaterialId: rm.id,
        batchId: batch.id,
        type: 'ADJUSTMENT',
        quantity: c.currentStock,
        unit: c.unit,
        previousStock: 0,
        newStock: c.currentStock,
        costImpact: c.costPerUnit * c.currentStock,
        reason: 'Stock inicial — Demo venue',
        reference: `DEMO-${bp.key}`,
      },
    })
  }
  logger.info(`   ✅ ${bp.consumables.length} consumibles (RawMaterial + lote + caducidad)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Staff (vendedor/especialista) — beyond the org owner
// ════════════════════════════════════════════════════════════════════════════

async function ensureVenueStaff(bp: VenueBlueprint, venueId: string): Promise<string> {
  const email = `${bp.staffName.first}.${bp.staffName.last}.${bp.key}@avoqado.io`.toLowerCase().replace(/\s+/g, '')

  const staff = await prisma.staff.upsert({
    where: { email },
    update: {},
    create: {
      email,
      firstName: bp.staffName.first,
      lastName: bp.staffName.last,
      active: true,
      emailVerified: true,
    },
  })

  // Attach to venue (StaffVenue). CASHIER = "Payment access only" — the right
  // operational role for a salesperson/specialist who takes payments in the demo.
  await prisma.staffVenue.upsert({
    where: { staffId_venueId: { staffId: staff.id, venueId } },
    update: { active: true },
    create: { staffId: staff.id, venueId, role: 'CASHIER', active: true },
  })

  logger.info(`   ✅ Staff ${bp.staffName.first} ${bp.staffName.last} (${bp.staffRole}) → ${staff.id}`)
  return staff.id
}

// ════════════════════════════════════════════════════════════════════════════
// Commission config (+ tiers for the retail 4%/5% case)
// ════════════════════════════════════════════════════════════════════════════

async function seedCommission(bp: VenueBlueprint, venueId: string, ownerStaffId: string): Promise<void> {
  if (bp.tier) {
    // TIERED: base rate up to threshold, higher rate above it.
    const config = await createCommissionConfig(
      venueId,
      {
        name: `Comisión ${bp.staffRole} (escalonada)`,
        description: `${bp.commissionRate * 100}% base, ${bp.tier.rate * 100}% al pasar $${bp.tier.threshold.toLocaleString('es-MX')}/mes`,
        recipient: CommissionRecipient.SERVER,
        trigger: CommissionTrigger.PER_PAYMENT,
        calcType: CommissionCalcType.TIERED,
        defaultRate: bp.commissionRate,
        priority: 10,
      },
      ownerStaffId,
    )

    await createTiersBatch(config.id, venueId, [
      { tierLevel: 1, name: 'Base', minThreshold: 0, maxThreshold: bp.tier.threshold, rate: bp.commissionRate },
      { tierLevel: 2, name: 'Meta superada', minThreshold: bp.tier.threshold, maxThreshold: null, rate: bp.tier.rate },
    ])
    logger.info(`   ✅ Comisión TIERED ${bp.commissionRate * 100}%/${bp.tier.rate * 100}% (umbral $${bp.tier.threshold})`)
  } else {
    // Flat percentage per service/payment.
    await createCommissionConfig(
      venueId,
      {
        name: `Comisión ${bp.staffRole}`,
        description: `${bp.commissionRate * 100}% por servicio`,
        recipient: CommissionRecipient.SERVER,
        trigger: CommissionTrigger.PER_PAYMENT,
        calcType: CommissionCalcType.PERCENTAGE,
        defaultRate: bp.commissionRate,
        priority: 10,
      },
      ownerStaffId,
    )
    logger.info(`   ✅ Comisión PERCENTAGE ${bp.commissionRate * 100}%`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Loyalty config
// ════════════════════════════════════════════════════════════════════════════

async function seedLoyalty(bp: VenueBlueprint, venueId: string): Promise<void> {
  await prisma.loyaltyConfig.create({
    data: {
      venueId,
      pointsPerDollar: bp.loyalty.pointsPerDollar,
      pointsPerVisit: bp.loyalty.pointsPerVisit,
      redemptionRate: 0.01, // 100 pts = $1
      minPointsRedeem: bp.loyalty.minPointsRedeem,
      pointsExpireDays: 365,
      active: true,
      isDemo: true,
    },
  })
  logger.info(`   ✅ Lealtad: ${bp.loyalty.pointsPerDollar} pto/$, recompensa a ${bp.loyalty.minPointsRedeem} pts`)
}

// ════════════════════════════════════════════════════════════════════════════
// Ecommerce merchant (Blumon, chargeable) — required by createPaymentLink
// ════════════════════════════════════════════════════════════════════════════

async function ensureChargeableMerchant(bp: VenueBlueprint, venueId: string): Promise<string> {
  // Reuse the Blumon PaymentProvider the café seeder created (find-or-create).
  let blumon = await prisma.paymentProvider.findFirst({ where: { code: 'BLUMON' } })
  if (!blumon) {
    blumon = await prisma.paymentProvider.create({
      data: {
        code: 'BLUMON',
        name: 'Blumon PAX Payment Solutions',
        type: 'PAYMENT_PROCESSOR',
        countryCode: ['MX'],
        active: true,
      },
    })
  }

  const shortId = venueId.substring(0, 8)
  // isEcommerceMerchantChargeable() treats Blumon as chargeable iff
  // providerCredentials.accessToken is a non-empty string.
  const merchant = await prisma.ecommerceMerchant.create({
    data: {
      venueId,
      channelName: 'Web Principal',
      businessName: bp.legalName,
      contactEmail: `pay.${bp.key}.${shortId}@avoqado.io`,
      publicKey: `pk_demo_${bp.key}_${shortId}`,
      secretKeyHash: `demo_secret_hash_${bp.key}_${shortId}`,
      providerId: blumon.id,
      providerCredentials: {
        accessToken: `demo_blumon_token_${shortId}`,
        blumonMerchantId: `blumon_demo_${shortId}`,
        blumonPosId: '999',
        environment: 'SANDBOX',
      },
      providerMerchantId: `blumon_demo_${bp.key}_${shortId}`,
      active: true,
      sandboxMode: true,
      chargesEnabled: true,
    },
  })
  logger.info('   ✅ EcommerceMerchant (Blumon SANDBOX, chargeable) ready')
  return merchant.id
}

// ════════════════════════════════════════════════════════════════════════════
// Payment link (branded, attributed to the venue's salesperson/specialist)
// ════════════════════════════════════════════════════════════════════════════

async function seedPaymentLink(
  bp: VenueBlueprint,
  venueId: string,
  staffId: string,
  attributedStaffId: string,
  products: SeededProduct[],
): Promise<void> {
  // Build an ITEM link off the first 1-2 real products so the demo shows a real
  // basket + inventory deduction. Fall back to an OPEN PAYMENT link if no
  // suitable product exists.
  const linkableRegular = products.find(p => p.type === ProductType.REGULAR)

  if (linkableRegular) {
    await createPaymentLink(
      venueId,
      {
        title: bp.paymentLinkTitle,
        description: 'Pago demo — dispara recibo, factura, comisión, puntos, póliza y reporte.',
        purpose: 'ITEM',
        amountType: 'FIXED',
        isReusable: true,
        items: [{ productId: linkableRegular.id, quantity: 1 }],
        attributedStaffIds: [attributedStaffId],
      },
      staffId,
    )
    logger.info(`   ✅ Payment link (ITEM: ${linkableRegular.name}) attributed to staff`)
  } else {
    await createPaymentLink(
      venueId,
      {
        title: bp.paymentLinkTitle,
        description: 'Pago demo de servicio.',
        purpose: 'PAYMENT',
        amountType: 'OPEN',
        isReusable: true,
        attributedStaffIds: [attributedStaffId],
      },
      staffId,
    )
    logger.info('   ✅ Payment link (OPEN PAYMENT) attributed to staff')
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Future reservation (SALON + CLINIC) — deposit-required + assigned staff
// ════════════════════════════════════════════════════════════════════════════

async function seedReservation(
  bp: VenueBlueprint,
  venueId: string,
  staffId: string,
  customerId: string,
  products: SeededProduct[],
): Promise<void> {
  if (!bp.seedReservation) return

  const service = products.find(p => p.type === ProductType.APPOINTMENTS_SERVICE)
  if (!service) {
    logger.warn('   ⚠️ No service product to attach reservation to — skipping reservation')
    return
  }

  const startsAt = addDays(new Date(), 2)
  startsAt.setHours(11, 0, 0, 0)
  const durationMin = bp.services.find(s => s.name === service.name)?.durationMinutes ?? 60
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000)

  const code = `RES-${bp.key.substring(0, 3).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`

  await prisma.reservation.create({
    data: {
      venueId,
      confirmationCode: code,
      status: ReservationStatus.CONFIRMED,
      startsAt,
      endsAt,
      duration: durationMin,
      customerId,
      partySize: 1,
      productId: service.id,
      assignedStaffId: staffId,
      createdById: staffId,
      // No-show deposit: requested but unpaid (demo shows "depósito no-show").
      depositAmount: new Prisma.Decimal(100),
      depositStatus: DepositStatus.PENDING,
      specialRequests: 'Recordatorio por WhatsApp 24h antes. Política de depósito por no-show.',
      confirmedAt: new Date(),
    },
  })
  logger.info(`   ✅ Reservación futura (${service.name}, depósito $100 no-show, recordatorio WA)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Customers (realistic) for loyalty + order history
// ════════════════════════════════════════════════════════════════════════════

const CUSTOMER_POOL: Record<string, Array<{ first: string; last: string; phone: string; points: number }>> = {
  lunaria: [
    { first: 'Valeria', last: 'Mendoza', phone: '5551110001', points: 320 },
    { first: 'Regina', last: 'Castillo', phone: '5551110002', points: 180 },
    { first: 'Daniela', last: 'Ortega', phone: '5551110003', points: 95 },
    { first: 'Sofía', last: 'Beltrán', phone: '5551110004', points: 540 },
    { first: 'Camila', last: 'Navarro', phone: '5551110005', points: 60 },
  ],
  bloom: [
    { first: 'Andrea', last: 'Fuentes', phone: '5552220001', points: 210 },
    { first: 'Paulina', last: 'Reyes', phone: '5552220002', points: 130 },
    { first: 'Ximena', last: 'Lozano', phone: '5552220003', points: 75 },
    { first: 'Mariana', last: 'Solís', phone: '5552220004', points: 400 },
  ],
  dermedica: [
    { first: 'Isabel', last: 'Carranza', phone: '5553330001', points: 260 },
    { first: 'Renata', last: 'Aguilar', phone: '5553330002', points: 150 },
    { first: 'Lucía', last: 'Domínguez', phone: '5553330003', points: 90 },
    { first: 'Fernanda', last: 'Salas', phone: '5553330004', points: 480 },
  ],
}

async function seedCustomers(bp: VenueBlueprint, venueId: string): Promise<Array<{ id: string; name: string; phone: string }>> {
  const pool = CUSTOMER_POOL[bp.key] ?? []
  const created: Array<{ id: string; name: string; phone: string }> = []
  const now = new Date()

  for (const c of pool) {
    const cust = await prisma.customer.create({
      data: {
        venueId,
        firstName: c.first,
        lastName: c.last,
        phone: c.phone,
        loyaltyPoints: c.points,
        totalVisits: Math.max(1, Math.round(c.points / 50)),
        firstVisitAt: subDays(now, 60),
        lastVisitAt: subDays(now, Math.floor(Math.random() * 7)),
        marketingConsent: true,
        active: true,
      },
    })
    created.push({ id: cust.id, name: `${c.first} ${c.last}`, phone: c.phone })
  }
  logger.info(`   ✅ ${created.length} clientes con puntos de lealtad`)
  return created
}

// ════════════════════════════════════════════════════════════════════════════
// Order + payment history (~25-40 paid orders over last 14 days)
// ════════════════════════════════════════════════════════════════════════════

async function seedHistory(
  bp: VenueBlueprint,
  venueId: string,
  products: SeededProduct[],
  customers: Array<{ id: string; name: string; phone: string }>,
  staffId: string,
  ecommerceMerchantId: string,
): Promise<void> {
  if (products.length === 0) {
    logger.warn('   ⚠️ No products — skipping history')
    return
  }
  const now = new Date()
  const TAX = 0.16
  let cardOrdersLinked = 0

  for (let i = 0; i < bp.historyOrders; i++) {
    const daysAgo = Math.floor(Math.random() * 14)
    const hoursAgo = Math.floor(Math.random() * 10)
    const orderDate = subHours(subDays(now, daysAgo), hoursAgo)

    // 1-3 line items from the real catalog.
    const numItems = Math.floor(Math.random() * 3) + 1
    const lineItems: Array<{ product: SeededProduct; quantity: number }> = []
    let subtotal = 0
    for (let j = 0; j < numItems; j++) {
      const product = products[Math.floor(Math.random() * products.length)]
      const quantity = Math.floor(Math.random() * 2) + 1
      lineItems.push({ product, quantity })
      subtotal += product.price * quantity
    }
    const taxAmount = +(subtotal * TAX).toFixed(2)
    const total = +(subtotal + taxAmount).toFixed(2)

    const hasCustomer = Math.random() < 0.7 && customers.length > 0
    const customer = hasCustomer ? customers[Math.floor(Math.random() * customers.length)] : null

    const order = await prisma.order.create({
      data: {
        venueId,
        customerId: customer?.id,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
        orderNumber: `${bp.key.toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
        type: OrderType.MANUAL_ENTRY,
        status: OrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.PAID,
        subtotal,
        taxAmount,
        total,
        createdById: staffId,
        servedById: staffId,
        createdAt: orderDate,
        completedAt: orderDate,
      },
    })

    for (const { product, quantity } of lineItems) {
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          taxAmount: +(product.price * quantity * TAX).toFixed(2),
          total: +(product.price * quantity * (1 + TAX)).toFixed(2),
        },
      })
    }

    if (customer) {
      await prisma.orderCustomer.create({
        data: { orderId: order.id, customerId: customer.id, isPrimary: true, addedAt: orderDate },
      })
    }

    // Payment method mix: 55% card, 15% debit, 30% cash.
    const r = Math.random()
    const method = r < 0.55 ? PaymentMethod.CREDIT_CARD : r < 0.7 ? PaymentMethod.DEBIT_CARD : PaymentMethod.CASH
    const tipAmount = Math.random() < 0.25 ? Math.round(total * 0.1) : 0

    // Card/debit payments route through the EcommerceMerchant channel (so the
    // order is CFDI-invoiceable: loadOrderForCfdi resolves the emisor via the
    // payment's merchant → MerchantFiscalConfig). Cash stays merchant-less.
    const isCard = method !== PaymentMethod.CASH
    if (isCard) cardOrdersLinked++

    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: total,
        tipAmount,
        method,
        ecommerceMerchantId: isCard ? ecommerceMerchantId : undefined,
        status: 'COMPLETED',
        feePercentage: 0.025,
        feeAmount: +((total + tipAmount) * 0.025).toFixed(2),
        netAmount: +((total + tipAmount) * 0.975).toFixed(2),
        processedById: staffId,
        createdAt: orderDate,
      },
    })
  }
  logger.info(`   ✅ ${bp.historyOrders} órdenes pagadas (últimos 14 días) — ${cardOrdersLinked} con merchant (CFDI-facturables)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Chart of accounts + account mappings (póliza explosion)
//   - Scoped on (organizationId, rfc). The 3 demo venues share ONE org but each
//     has its OWN rfc, so the org holds 3 distinct 88-account charts (one per
//     rfc) — correct, NOT duplication. We seed/guard per (org, rfc).
//   - needs venue.rfc (set in ensureBareVenue).
//   - mappings (movementType → ledger account) are REQUIRED by the auto-posting
//     engine; without them generatePoliciesForVenue posts nothing.
//   - seedBaseChart + seedDefaultMappings are both insert-if-absent (idempotent
//     per (org, rfc)) — re-running does NOT re-triplicate. We add an explicit
//     guard so a fully-seeded scope skips the redundant transaction.
// ════════════════════════════════════════════════════════════════════════════

const BASE_CHART_SIZE = 88 // accounts per (org, rfc) once seeded

async function seedChartAndMappings(venueId: string, organizationId: string, rfc: string, ownerStaffId: string): Promise<void> {
  try {
    const existingAccounts = await prisma.ledgerAccount.count({ where: { organizationId, rfc } })

    if (existingAccounts >= BASE_CHART_SIZE) {
      logger.info(`   ✅ Catálogo contable ya sembrado (${existingAccounts} cuentas para rfc ${rfc}) — guard, no re-seed`)
    } else {
      const chart = await seedBaseChart(venueId, { staffId: ownerStaffId })
      logger.info(`   ✅ Catálogo contable (${chart.accounts.length} cuentas, sector auto por giro)`)
    }

    // Idempotent: insert-if-absent, never overwrites a user-changed mapping.
    await seedDefaultMappings(venueId, { staffId: ownerStaffId })

    // Verify the engine will find every required mapping (no missing → pólizas can post).
    const map = await getMappings(venueId)
    const mappedCount = map.mappings.filter(m => m.account).length
    const unmapped = map.mappings.filter(m => !m.account).map(m => m.movementType)
    logger.info(
      `   ✅ Mapeos contables: ${mappedCount}/${map.mappings.length} asignados` +
        (unmapped.length > 0 ? ` (sin cuenta: ${unmapped.join(', ')})` : ''),
    )
  } catch (err) {
    logger.error(`   ❌ Chart/mappings failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Auto-post pólizas for the seeded history (so Contabilidad isn't empty)
// ════════════════════════════════════════════════════════════════════════════

async function seedPolicies(venueId: string, ownerStaffId: string): Promise<number> {
  // No period → posts ALL eligible COMPLETED payments (covers the full 14-day
  // window regardless of month boundaries). Idempotent via per-payment keys.
  const result = await generatePoliciesForVenue(venueId, { actorStaffId: ownerStaffId })

  if (result.needsFiscalSetup) {
    logger.warn('   ⚠️ Pólizas: needsFiscalSetup=true (venue sin RFC) — no se generaron')
    return 0
  }
  if (result.missingMappings.length > 0) {
    logger.warn(`   ⚠️ Pólizas: faltan mapeos requeridos (${result.missingMappings.join(', ')}) — no se generaron`)
    return 0
  }
  logger.info(
    `   ✅ Pólizas generadas: ${result.posted} nuevas, ${result.alreadyPosted} ya existían ` +
      `(candidatos: ${result.candidates}, omitidos: ${result.skipped})`,
  )
  return result.posted + result.alreadyPosted
}

// ════════════════════════════════════════════════════════════════════════════
// CFDI emisor + MerchantFiscalConfig (OPTIONAL — only if Facturapi test key set)
//   - FiscalEmisor: the venue's SAT identity + Facturapi key (encrypted).
//   - MerchantFiscalConfig: gates issuance. issueCfdiForOrder loads
//     facturacionEnabled from the order payment's merchant → MerchantFiscalConfig
//     → fiscalEmisor. Without this row + facturacionEnabled=true, stamping throws
//     "Facturación no habilitada para este comercio". We link it to the venue's
//     EcommerceMerchant (the branded payment-link channel).
// ════════════════════════════════════════════════════════════════════════════

async function seedFiscalEmisor(bp: VenueBlueprint, venueId: string, ecommerceMerchantId: string): Promise<boolean> {
  const facturapiKey = process.env.FACTURAPI_TEST_KEY
  if (!facturapiKey) {
    logger.info('   ℹ️ FACTURAPI_TEST_KEY not set → skipping FiscalEmisor (CFDI stamping disabled; other 5 explosions unaffected)')
    return false
  }

  let providerKeyEnc: string
  try {
    providerKeyEnc = encryptProviderKey(facturapiKey)
  } catch (err) {
    logger.warn(
      `   ⚠️ Could not encrypt Facturapi key (is FISCAL_PROVIDER_KEY set?): ${err instanceof Error ? err.message : String(err)} → skipping FiscalEmisor`,
    )
    return false
  }

  // FiscalEmisor is PRESERVED across runs (stamped CFDIs Restrict it), so UPSERT
  // by (venueId, rfc) — never wiped/recreated. csdStatus=ACTIVE: validateBeforeStamp
  // HARD-BLOCKS unless the emisor's CSD is ACTIVE (cfdiValidation.ts:24). In
  // Facturapi TEST mode the PAC supplies a built-in test CSD, so ACTIVE is correct
  // for sandbox stamping.
  const emisor = await prisma.fiscalEmisor.upsert({
    where: { venueId_rfc: { venueId, rfc: bp.rfc } },
    update: {
      legalName: bp.legalName,
      regimenFiscal: '601',
      lugarExpedicion: bp.zipCode,
      serie: 'F',
      provider: 'FACTURAPI',
      providerKeyEnc,
      csdStatus: 'ACTIVE',
      defaultUsoCfdi: 'G03',
    },
    create: {
      venueId,
      rfc: bp.rfc,
      legalName: bp.legalName,
      regimenFiscal: '601', // General de Ley Personas Morales
      lugarExpedicion: bp.zipCode, // fiscal CP — must be a valid SAT c_CodigoPostal
      serie: 'F',
      provider: 'FACTURAPI',
      providerKeyEnc,
      csdStatus: 'ACTIVE',
      defaultUsoCfdi: 'G03',
    },
  })

  // Fiscally enable the EcommerceMerchant (the payment-link channel) so the
  // order's payment resolves facturacionEnabled=true. Cascades with the merchant
  // (was cleared in wipeSeededData), so create fresh. Unique on ecommerceMerchantId.
  await prisma.merchantFiscalConfig.create({
    data: {
      ecommerceMerchantId,
      fiscalEmisorId: emisor.id,
      facturacionEnabled: true,
      autofacturaEnabled: true,
      includeInGlobal: true,
    },
  })

  logger.info('   ✅ FiscalEmisor + MerchantFiscalConfig (facturacionEnabled=true) — CFDI puede timbrar en sandbox')
  return true
}

// ════════════════════════════════════════════════════════════════════════════
// Per-venue orchestration
// ════════════════════════════════════════════════════════════════════════════

interface VenueReport {
  name: string
  venueId: string
  orgName: string
  organizationId: string
  products: number
  services: number
  inventory: number
  consumables: number
  commission: string
  loyalty: boolean
  reservation: boolean
  paymentLink: boolean
  historyOrders: number
  ledgerAccounts: number
  accountMappings: number
  journalEntries: number
  cfdiEmisor: boolean
}

async function seedVenue(bp: VenueBlueprint, organizationId: string, ownerStaffId: string): Promise<VenueReport> {
  logger.info('')
  logger.info(`════════════ ${bp.name} (${bp.type}) ════════════`)

  // Reuse the existing venue under the shared org (same ID) — never recreate.
  const venueId = await ensureBareVenue(bp, organizationId, ownerStaffId)

  // Features + module
  await enableFeatures(venueId)
  await enableCommissionsModule(venueId, ownerStaffId)

  // Staff (salesperson/specialist) for attribution + commission
  const venueStaffId = await ensureVenueStaff(bp, venueId)

  // Catalog
  const products = await seedCatalog(bp, venueId)
  await seedConsumables(bp, venueId)

  // Commission + loyalty
  await seedCommission(bp, venueId, ownerStaffId)
  await seedLoyalty(bp, venueId)

  // Chart of accounts + mappings (póliza prerequisites). Scoped (org, rfc);
  // bp.rfc was pinned onto the venue in ensureBareVenue.
  await seedChartAndMappings(venueId, organizationId, bp.rfc, ownerStaffId)

  // Cobro channel: chargeable EcommerceMerchant. Created BEFORE history so card
  // payments can route through it (→ CFDI-invoiceable) and the payment link can
  // bind to it.
  const ecommerceMerchantId = await ensureChargeableMerchant(bp, venueId)

  // Customers + history (card payments linked to the merchant)
  const customers = await seedCustomers(bp, venueId)
  await seedHistory(bp, venueId, products, customers, venueStaffId, ecommerceMerchantId)

  // Pólizas: auto-post the history so Contabilidad is populated (not empty).
  await seedPolicies(venueId, ownerStaffId)

  // Branded payment link
  await seedPaymentLink(bp, venueId, ownerStaffId, venueStaffId, products)

  // Reservation (SALON + CLINIC)
  await seedReservation(bp, venueId, venueStaffId, customers[0]?.id ?? '', products)

  // CFDI (optional): emisor + MerchantFiscalConfig linking the merchant fiscally.
  const cfdiEmisor = await seedFiscalEmisor(bp, venueId, ecommerceMerchantId)

  // Final fiscal counts (shared org, this venue's rfc) for the report.
  const [ledgerAccounts, accountMappings, journalEntries] = await Promise.all([
    prisma.ledgerAccount.count({ where: { organizationId, rfc: bp.rfc } }),
    prisma.accountMapping.count({ where: { organizationId, rfc: bp.rfc, ledgerAccountId: { not: null } } }),
    prisma.journalEntry.count({ where: { organizationId, rfc: bp.rfc } }),
  ])

  return {
    name: bp.name,
    venueId,
    orgName: DEMO_ORG_NAME,
    organizationId,
    products: bp.regulars.length,
    services: bp.services.length,
    inventory: bp.regulars.length,
    consumables: bp.consumables.length,
    commission: bp.tier ? `TIERED ${bp.commissionRate * 100}%/${bp.tier.rate * 100}%` : `${bp.commissionRate * 100}%`,
    loyalty: true,
    reservation: bp.seedReservation,
    paymentLink: true,
    historyOrders: bp.historyOrders,
    ledgerAccounts,
    accountMappings,
    journalEntries,
    cfdiEmisor,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2)
  const venueFilter = args.includes('--venue') ? args[args.indexOf('--venue') + 1] : null

  const dbUrl = process.env.DATABASE_URL ?? ''
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? 'unknown'
  logger.info(`🌱 Seeding demo venues → DB: ${dbName}`)
  if (!dbName.includes('av-db-25')) {
    logger.warn(`⚠️ DATABASE_URL does not point at av-db-25 (got "${dbName}"). Continuing anyway.`)
  }

  const blueprints = venueFilter ? BLUEPRINTS.filter(b => b.key === venueFilter) : BLUEPRINTS
  if (blueprints.length === 0) {
    logger.error(`No blueprint matches --venue ${venueFilter}. Valid: ${BLUEPRINTS.map(b => b.key).join(', ')}`)
    process.exit(1)
  }

  const { organizationId, ownerStaffId } = await ensureDemoOrgAndOwner()

  const reports: VenueReport[] = []
  for (const bp of blueprints) {
    reports.push(await seedVenue(bp, organizationId, ownerStaffId))
  }

  // ── Summary ──
  logger.info('')
  logger.info('════════════════════════ RESUMEN ════════════════════════')
  logger.info(`DB: ${dbName}  |  Org compartida: ${DEMO_ORG_NAME} (${organizationId})`)
  for (const r of reports) {
    logger.info('')
    logger.info(`🏠 ${r.name}  →  ${r.venueId}`)
    logger.info(`   org:                 ${r.orgName} (${r.organizationId})`)
    logger.info(`   productos REGULAR:   ${r.products}   (inventario: ${r.inventory})`)
    logger.info(`   servicios:           ${r.services}`)
    logger.info(`   consumibles (lote):  ${r.consumables}`)
    logger.info(`   comisión:            ${r.commission}`)
    logger.info(`   lealtad:             ${r.loyalty ? 'sí' : 'no'}`)
    logger.info(`   reservación:         ${r.reservation ? 'sí (depósito no-show)' : 'no'}`)
    logger.info(`   payment link:        ${r.paymentLink ? 'sí (con marca)' : 'no'}`)
    logger.info(`   historial:           ${r.historyOrders} órdenes / 14 días`)
    logger.info(`   contabilidad:        ${r.ledgerAccounts} cuentas · ${r.accountMappings} mapeos · ${r.journalEntries} pólizas`)
    logger.info(`   CFDI emisor:         ${r.cfdiEmisor ? 'SÍ (Facturapi)' : 'no (sin FACTURAPI_TEST_KEY)'}`)
  }
  logger.info('')
  logger.info('✅ Seed completo. Idempotente — re-correr no duplica.')
}

main()
  .catch(err => {
    logger.error('❌ Seed failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

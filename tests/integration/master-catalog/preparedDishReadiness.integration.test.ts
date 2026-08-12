/**
 * Real PostgreSQL proof that one corporate PREPARED_DISH can diverge safely by
 * Venue while readiness remains a read-only view over each local Recipe.
 */
import {
  BusinessType,
  CatalogIdentifierStatus,
  CatalogIdentifierType,
  CatalogIepsMode,
  CatalogItemKind,
  CatalogItemPriceKind,
  CatalogItemStatus,
  CatalogReferenceStatus,
  CatalogVenueBindingStatus,
  ProductType,
  Unit,
  UnitType,
  type PrismaClient,
} from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.unmock('@/utils/prismaClient')

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-readiness-org-${fixtureKey}`
const staffId = `h1a-readiness-staff-${fixtureKey}`
const brandId = `h1a-readiness-brand-${fixtureKey}`
const manufacturerId = `h1a-readiness-manufacturer-${fixtureKey}`
const familyRootId = `h1a-readiness-family-root-${fixtureKey}`
const familyLeafId = `h1a-readiness-family-leaf-${fixtureKey}`
const catalogItemId = `h1a-readiness-item-${fixtureKey}`

let prisma: PrismaClient | null = null
let evaluatePreparedDishBinding: typeof import('@/services/master-catalog/catalogRecipeCost.service').evaluatePreparedDishBinding
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false
let venueA: { id: string; categoryId: string; productId: string; bindingId: string; rawMaterialId: string }
let venueB: { id: string; categoryId: string; productId: string; bindingId: string; rawMaterialId: string }

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declaredTestUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: Every destructive setup/cleanup is pinned independently to the H1
  // disposable database so a bypassed wrapper cannot reach dev or production.
  for (const candidate of [effective, declaredTestUrl]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(declaredTestUrl.toString()).toBe(effective.toString())
}

function db(): PrismaClient {
  if (!disposableDatabaseVerified || !prisma) throw new Error('H1 disposable database was not verified')
  return prisma
}

async function createVenueProduct(suffix: string) {
  const client = db()
  const venue = await client.venue.create({
    data: {
      name: `Readiness venue ${suffix}`,
      slug: `h1a-readiness-${fixtureKey}-${suffix}`.toLowerCase(),
      organizationId,
      address: 'test',
      city: 'test',
      country: 'MX',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      type: BusinessType.RESTAURANT,
    },
  })
  const category = await client.menuCategory.create({
    data: { venueId: venue.id, name: `Readiness ${suffix}`, slug: `readiness-${suffix}-${fixtureKey}`.toLowerCase() },
  })
  const product = await client.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      sku: `READY-${fixtureKey}-${suffix}`,
      name: `Prepared ${suffix}`,
      type: ProductType.FOOD_AND_BEV,
      price: new Decimal('150.00'),
      cost: new Decimal('62.50'),
      taxRate: new Decimal('0.1600'),
      prepTime: 10,
      active: true,
      createdById: staffId,
    },
  })
  const rawMaterial = await client.rawMaterial.create({
    data: {
      venueId: venue.id,
      name: `Ingredient ${suffix}`,
      sku: `RAW-${fixtureKey}-${suffix}`,
      category: 'OTHER',
      currentStock: new Decimal('1000'),
      minimumStock: new Decimal('0'),
      reorderPoint: new Decimal('0'),
      costPerUnit: new Decimal('0.5000'),
      avgCostPerUnit: new Decimal('0.5000'),
      unit: Unit.GRAM,
      unitType: UnitType.WEIGHT,
    },
  })
  const binding = await client.catalogVenueBinding.create({
    data: {
      organizationId,
      catalogItemId,
      venueId: venue.id,
      productId: product.id,
      status: CatalogVenueBindingStatus.LINKED,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  return { id: venue.id, categoryId: category.id, productId: product.id, bindingId: binding.id, rawMaterialId: rawMaterial.id }
}

async function createRecipe(target: typeof venueA, totalCost: string): Promise<void> {
  const client = db()
  await client.recipe.create({
    data: {
      productId: target.productId,
      portionYield: 8,
      prepTime: 10,
      totalCost: new Decimal(totalCost),
      lines: {
        create: {
          rawMaterialId: target.rawMaterialId,
          quantity: new Decimal('1.000'),
          unit: Unit.KILOGRAM,
          costPerServing: new Decimal('62.5000'),
          displayOrder: 0,
        },
      },
    },
  })
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  // WHY: Dynamic imports happen only after URL verification, before which no
  // Prisma client or service is allowed to establish a connection.
  prisma = (await import('@/utils/prismaClient')).default
  ;({ evaluatePreparedDishBinding } = await import('@/services/master-catalog/catalogRecipeCost.service'))
  const client = db()

  await client.organization.create({
    data: {
      id: organizationId,
      name: `H1A readiness ${fixtureKey}`,
      email: `h1a-readiness-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureRowsMayExist = true
  await client.staff.create({
    data: { id: staffId, email: `h1a-readiness-actor-${fixtureKey}@example.test`, firstName: 'H1A', lastName: 'Readiness' },
  })
  await client.catalogBrand.create({
    data: {
      id: brandId,
      organizationId,
      name: 'Readiness brand',
      normalizedName: `READINESS-BRAND-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogManufacturer.create({
    data: {
      id: manufacturerId,
      organizationId,
      name: 'Readiness manufacturer',
      normalizedName: `READINESS-MANUFACTURER-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyRootId,
      organizationId,
      name: 'Prepared food',
      normalizedName: `PREPARED-ROOT-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyLeafId,
      organizationId,
      parentId: familyRootId,
      name: 'Prepared dish',
      normalizedName: `PREPARED-LEAF-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })

  // WHY: Nested children satisfy the deferred complete-aggregate constraints
  // in the same commit; readiness never fabricates missing corporate baseline.
  await client.catalogItem.create({
    data: {
      id: catalogItemId,
      organizationId,
      sku: `PREPARED-${fixtureKey}`,
      normalizedSku: `PREPARED-${fixtureKey}`,
      kind: CatalogItemKind.PREPARED_DISH,
      name: 'Corporate prepared dish',
      description: 'Complete authoritative test item.',
      imageUrl: 'https://cdn.example.test/prepared.jpg',
      brandId,
      manufacturerId,
      familyId: familyLeafId,
      presentationLabel: 'Porción',
      unit: Unit.PIECE,
      taxRate: new Decimal('0.1600'),
      satProductKey: '90101501',
      satUnitKey: 'E48',
      objetoImp: '02',
      productType: ProductType.FOOD_AND_BEV,
      iepsMode: CatalogIepsMode.NONE,
      status: CatalogItemStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
      businessTypes: { create: { businessType: BusinessType.RESTAURANT } },
      identifiers: {
        create: {
          code: `PREPARED-${fixtureKey}`,
          normalizedCode: `PREPARED-${fixtureKey}`,
          type: CatalogIdentifierType.CORPORATE_SKU,
          status: CatalogIdentifierStatus.ACTIVE,
          createdById: staffId,
        },
      },
      prices: {
        create: [
          {
            kind: CatalogItemPriceKind.SALE_PRICE,
            amount: new Decimal('150.00'),
            currency: 'MXN',
            active: true,
            createdById: staffId,
            updatedById: staffId,
          },
          {
            kind: CatalogItemPriceKind.PURCHASE_COST,
            amount: new Decimal('62.50'),
            currency: 'MXN',
            active: true,
            createdById: staffId,
            updatedById: staffId,
          },
        ],
      },
    },
  })

  venueA = await createVenueProduct('a')
  venueB = await createVenueProduct('b')
  await createRecipe(venueA, '62.5000')
})

afterAll(async () => {
  if (!disposableDatabaseVerified || !prisma) return
  assertDisposableH1Database()
  if (!fixtureRowsMayExist) return prisma.$disconnect()
  // WHY: Cleanup follows restrictive provenance/FK order and targets only this
  // unique tenant, preserving every other concurrent test fixture.
  await prisma.catalogVenueBinding.deleteMany({ where: { organizationId } })
  await prisma.product.deleteMany({ where: { venueId: { in: [venueA?.id, venueB?.id].filter(Boolean) as string[] } } })
  await prisma.rawMaterial.deleteMany({ where: { venueId: { in: [venueA?.id, venueB?.id].filter(Boolean) as string[] } } })
  await prisma.catalogItem.deleteMany({ where: { organizationId } })
  await prisma.catalogFamily.deleteMany({ where: { id: familyLeafId, organizationId } })
  await prisma.catalogFamily.deleteMany({ where: { id: familyRootId, organizationId } })
  await prisma.catalogBrand.deleteMany({ where: { id: brandId, organizationId } })
  await prisma.catalogManufacturer.deleteMany({ where: { id: manufacturerId, organizationId } })
  await prisma.venue.deleteMany({ where: { organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.$disconnect()
})

describe('prepared-dish readiness — real tenant-scoped reads', () => {
  it('returns complete and missing-recipe states independently for two Venue bindings', async () => {
    const client = db()
    const ready = await client.$transaction(tx =>
      evaluatePreparedDishBinding(tx, { organizationId, venueId: venueA.id, productId: venueA.productId }),
    )
    const missing = await client.$transaction(tx =>
      evaluatePreparedDishBinding(tx, { organizationId, venueId: venueB.id, productId: venueB.productId }),
    )

    expect(ready).toEqual(
      expect.objectContaining({
        state: 'READY',
        findings: [],
        costs: { batchCost: '500.0000', costPerPortion: '62.5000', storedCostPerPortion: '62.5000' },
      }),
    )
    expect(ready.dependencies.recipeUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(ready.dependencies.recipeLineHash).toMatch(/^[a-f0-9]{64}$/)
    expect(missing.state).toBe('INVALID')
    expect(missing.findings.map(finding => finding.code)).toEqual(['MISSING_RECIPE'])
  })

  it('fails closed without hashing a corrupt cross-Venue RawMaterial reference', async () => {
    const client = db()
    const recipe = await client.recipe.findUniqueOrThrow({ where: { productId: venueA.productId }, include: { lines: true } })
    const line = recipe.lines[0]
    await client.recipeLine.update({ where: { id: line.id }, data: { rawMaterialId: venueB.rawMaterialId } })

    try {
      const result = await client.$transaction(tx =>
        evaluatePreparedDishBinding(tx, { organizationId, venueId: venueA.id, productId: venueA.productId }),
      )

      // WHY: Foreign ingredient cost/lifecycle fields are never returned in a
      // dependency hash or cost oracle even when legacy data bypassed scoping.
      expect(result.state).toBe('INVALID')
      expect(result.findings).toEqual([expect.objectContaining({ code: 'INVALID_RECIPE_LINE', reason: 'RAW_MATERIAL_VENUE_MISMATCH' })])
      expect(result.dependencies).toEqual(expect.objectContaining({ recipeId: null, recipeLineHash: null }))
      expect(result.costs).toBeUndefined()
    } finally {
      await client.recipeLine.update({ where: { id: line.id }, data: { rawMaterialId: venueA.rawMaterialId } })
    }
  })

  it('detects stale per-portion cost and performs zero Product/Recipe/PricingPolicy writes', async () => {
    const client = db()
    await createRecipe(venueB, '500.0000')
    const before = await Promise.all([
      client.product.findUnique({ where: { id: venueB.productId } }),
      client.recipe.findUnique({ where: { productId: venueB.productId }, include: { lines: true } }),
      client.pricingPolicy.findUnique({ where: { productId: venueB.productId } }),
    ])

    const result = await client.$transaction(tx =>
      evaluatePreparedDishBinding(tx, { organizationId, venueId: venueB.id, productId: venueB.productId }),
    )
    const after = await Promise.all([
      client.product.findUnique({ where: { id: venueB.productId } }),
      client.recipe.findUnique({ where: { productId: venueB.productId }, include: { lines: true } }),
      client.pricingPolicy.findUnique({ where: { productId: venueB.productId } }),
    ])

    expect(result.state).toBe('STALE')
    expect(result.findings.map(finding => finding.code)).toEqual(['RECIPE_COST_STALE'])
    expect(after).toEqual(before)
  })

  it('fails tenant-safe for non-LINKED/retired provenance and cross-organization lookup', async () => {
    const client = db()
    await client.catalogVenueBinding.update({ where: { id: venueA.bindingId }, data: { status: CatalogVenueBindingStatus.PENDING } })
    await expect(
      client.$transaction(tx => evaluatePreparedDishBinding(tx, { organizationId, venueId: venueA.id, productId: venueA.productId })),
    ).rejects.toMatchObject({ statusCode: 404 })
    await client.catalogVenueBinding.update({ where: { id: venueA.bindingId }, data: { status: CatalogVenueBindingStatus.LINKED } })

    await expect(
      client.$transaction(tx =>
        evaluatePreparedDishBinding(tx, { organizationId: 'another-organization', venueId: venueA.id, productId: venueA.productId }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

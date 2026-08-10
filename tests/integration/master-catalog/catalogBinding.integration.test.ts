/**
 * Prepared PostgreSQL proof for Task 8 binding atomicity and Product isolation.
 * Run only through the disposable H1 wrapper named in the Task 8 report.
 */
import type { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'node:crypto'
import type { CatalogCommandContext } from '@/types/master-catalog'
import {
  assertDisposableH1Database,
  createCatalogBindingWriterHarness,
  type CatalogBindingWriterHarness,
} from './catalogBindingIntegrationHarness'

jest.unmock('@/utils/prismaClient')
jest.setTimeout(60_000)

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-binding-org-${fixtureKey}`
const foreignOrganizationId = `h1a-binding-foreign-org-${fixtureKey}`
const staffId = `h1a-binding-staff-${fixtureKey}`
const missingStaffId = `h1a-binding-missing-staff-${fixtureKey}`
const brandId = `h1a-binding-brand-${fixtureKey}`
const manufacturerId = `h1a-binding-manufacturer-${fixtureKey}`
const familyRootId = `h1a-binding-family-root-${fixtureKey}`
const familyLeafId = `h1a-binding-family-leaf-${fixtureKey}`
const catalogItemId = `h1a-binding-item-${fixtureKey}`
const corporateSku = `H1A-BIND-${fixtureKey}`.toUpperCase()

interface VenueFixture {
  id: string
  categoryId: string
  productId: string | null
}

let prisma: PrismaClient | null = null
let writerHarness: CatalogBindingWriterHarness | null = null
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false
let linkVenue: VenueFixture
let createVenue: VenueFixture
let rollbackVenue: VenueFixture
let concurrentVenue: VenueFixture
let foreignVenue: VenueFixture
let createBindingService: typeof import('@/services/master-catalog/catalogBinding.service').createCatalogBindingService
let acquireCatalogMutationLock: typeof import('@/services/master-catalog/catalogMutationLock.service').acquireCatalogMutationLock
let writeCatalogAudit: typeof import('@/services/master-catalog/catalogAudit.service').writeCatalogAudit
let evaluatePreparedDishBinding: typeof import('@/services/master-catalog/catalogRecipeCost.service').evaluatePreparedDishBinding

const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
}

function db(): PrismaClient {
  if (!disposableDatabaseVerified || !prisma) throw new Error('H1 disposable database was not verified')
  return prisma
}

function bindingService(auditWriter = writeCatalogAudit, client = db()) {
  return createBindingService({
    prisma: client,
    assertLiveAccessTx: async () => undefined,
    acquireMutationLockTx: acquireCatalogMutationLock,
    writeCatalogAudit: auditWriter,
    evaluatePreparedDishBinding,
    now: () => new Date(),
    randomToken: () => randomBytes(32).toString('base64url'),
    randomAttemptId: () => randomUUID(),
  })
}

async function createVenueFixture(suffix: string, organization = organizationId, withProduct = false): Promise<VenueFixture> {
  const client = db()
  const venue = await client.venue.create({
    data: {
      name: `Binding ${suffix}`,
      slug: `h1a-binding-${fixtureKey}-${suffix}`.toLowerCase(),
      organizationId: organization,
      address: 'test',
      city: 'test',
      country: 'MX',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      type: 'RESTAURANT',
    },
  })
  const category = await client.menuCategory.create({
    data: { venueId: venue.id, name: `Binding ${suffix}`, slug: `binding-${fixtureKey}-${suffix}`.toLowerCase(), availableDays: [] },
  })
  if (!withProduct) return { id: venue.id, categoryId: category.id, productId: null }
  const product = await client.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      sku: corporateSku,
      gtin: `GTIN-${fixtureKey}`,
      name: 'Local preserved',
      description: 'Operational description',
      type: 'REGULAR',
      price: '31.25',
      cost: '14.75',
      taxRate: '0.0800',
      tags: ['legacy'],
      allergens: ['nuts'],
      active: false,
      createdById: staffId,
      inventory: { create: { venueId: venue.id, currentStock: '9.500' } },
      recipe: { create: { portionYield: 1, prepTime: 5, totalCost: '14.7500' } },
    },
  })
  const modifierGroup = await client.modifierGroup.create({ data: { venueId: venue.id, name: `Legacy ${fixtureKey}` } })
  await client.productModifierGroup.create({ data: { productId: product.id, groupId: modifierGroup.id } })
  return { id: venue.id, categoryId: category.id, productId: product.id }
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  prisma = (await import('@/utils/prismaClient')).default
  ;({ createCatalogBindingService: createBindingService } = await import('@/services/master-catalog/catalogBinding.service'))
  ;({ acquireCatalogMutationLock } = await import('@/services/master-catalog/catalogMutationLock.service'))
  ;({ writeCatalogAudit } = await import('@/services/master-catalog/catalogAudit.service'))
  ;({ evaluatePreparedDishBinding } = await import('@/services/master-catalog/catalogRecipeCost.service'))
  writerHarness = await createCatalogBindingWriterHarness({ organizationId, fixtureKey, acquireCatalogMutationLock })
  const client = db()

  await client.organization.create({
    data: { id: organizationId, name: `H1A binding ${fixtureKey}`, email: `binding-${fixtureKey}@example.test`, phone: '5500000000' },
  })
  fixtureRowsMayExist = true
  await client.organization.create({
    data: {
      id: foreignOrganizationId,
      name: `H1A binding foreign ${fixtureKey}`,
      email: `binding-foreign-${fixtureKey}@example.test`,
      phone: '5500000001',
    },
  })
  await client.staff.create({
    data: { id: staffId, email: `binding-actor-${fixtureKey}@example.test`, firstName: 'H1A', lastName: 'Binding' },
  })
  await client.catalogBrand.create({
    data: {
      id: brandId,
      organizationId,
      name: 'Binding brand',
      normalizedName: `BINDING-BRAND-${fixtureKey}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogManufacturer.create({
    data: {
      id: manufacturerId,
      organizationId,
      name: 'Binding manufacturer',
      normalizedName: `BINDING-MANUFACTURER-${fixtureKey}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyRootId,
      organizationId,
      name: 'Binding root',
      normalizedName: `BINDING-ROOT-${fixtureKey}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyLeafId,
      organizationId,
      parentId: familyRootId,
      name: 'Binding leaf',
      normalizedName: `BINDING-LEAF-${fixtureKey}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogItem.create({
    data: {
      id: catalogItemId,
      organizationId,
      sku: corporateSku,
      normalizedSku: corporateSku,
      kind: 'RETAIL_PRODUCT',
      name: 'Corporate retail item',
      description: 'Authoritative description',
      imageUrl: 'https://cdn.example.test/binding.jpg',
      brandId,
      manufacturerId,
      familyId: familyLeafId,
      presentationLabel: 'Piece',
      unit: 'PIECE',
      taxRate: '0.1600',
      satProductKey: '50192100',
      satUnitKey: 'H87',
      objetoImp: '02',
      productType: 'REGULAR',
      iepsMode: 'NONE',
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
      businessTypes: { create: { businessType: 'RESTAURANT' } },
      identifiers: {
        create: {
          code: corporateSku,
          normalizedCode: corporateSku,
          type: 'CORPORATE_SKU',
          status: 'ACTIVE',
          createdById: staffId,
        },
      },
      prices: {
        create: [
          {
            kind: 'SALE_PRICE',
            amount: '20.00',
            currency: 'MXN',
            active: true,
            createdById: staffId,
            updatedById: staffId,
          },
          {
            kind: 'PURCHASE_COST',
            amount: '12.50',
            currency: 'MXN',
            active: true,
            createdById: staffId,
            updatedById: staffId,
          },
        ],
      },
    },
  })
  linkVenue = await createVenueFixture('link', organizationId, true)
  createVenue = await createVenueFixture('create')
  rollbackVenue = await createVenueFixture('rollback')
  concurrentVenue = await createVenueFixture('concurrent')
  foreignVenue = await createVenueFixture('foreign', foreignOrganizationId)
})

afterAll(async () => {
  if (!disposableDatabaseVerified || !prisma) return
  assertDisposableH1Database()
  const client = prisma
  try {
    if (!fixtureRowsMayExist) return
    await client.activityLog.deleteMany({ where: { organizationId } })
    await client.catalogIdempotencyRecord.deleteMany({ where: { organizationId } })
    await client.catalogBindingBatch.deleteMany({ where: { organizationId } })
    await client.catalogVenueBinding.deleteMany({ where: { organizationId } })
    await client.product.deleteMany({ where: { venueId: { in: [linkVenue.id, createVenue.id, rollbackVenue.id, concurrentVenue.id] } } })
    await client.catalogItem.deleteMany({ where: { organizationId } })
    await client.catalogFamily.deleteMany({ where: { id: familyLeafId, organizationId } })
    await client.catalogFamily.deleteMany({ where: { id: familyRootId, organizationId } })
    await client.catalogBrand.deleteMany({ where: { id: brandId, organizationId } })
    await client.catalogManufacturer.deleteMany({ where: { id: manufacturerId, organizationId } })
    await client.venue.deleteMany({ where: { organizationId: { in: [organizationId, foreignOrganizationId] } } })
    await client.organization.deleteMany({ where: { id: { in: [organizationId, foreignOrganizationId] } } })
    await client.staff.deleteMany({ where: { id: staffId } })
  } finally {
    await Promise.all([client.$disconnect(), writerHarness?.disconnect()])
  }
})

describe('catalog binding — real PostgreSQL transaction', () => {
  it('LINK preserves every Product field and operational relation while adding unpublished provenance once', async () => {
    const client = db()
    const service = bindingService()
    const before = await client.product.findUniqueOrThrow({ where: { id: linkVenue.productId as string } })
    const relationCounts = await Promise.all([
      client.inventory.count({ where: { productId: before.id } }),
      client.recipe.count({ where: { productId: before.id } }),
      client.productModifierGroup.count({ where: { productId: before.id } }),
    ])
    const preview = await service.preview(context, {
      lines: [{ catalogItemId, venueId: linkVenue.id, decision: { decision: 'LINK', productId: before.id } }],
    })
    const confirmation = {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true as const,
      idempotencyKey: `binding-link-${fixtureKey}`,
    }
    const result = await service.confirm(context, confirmation)
    await expect(service.confirm(context, confirmation)).resolves.toEqual(result)

    await expect(client.product.findUniqueOrThrow({ where: { id: before.id } })).resolves.toEqual(before)
    await expect(
      Promise.all([
        client.inventory.count({ where: { productId: before.id } }),
        client.recipe.count({ where: { productId: before.id } }),
        client.productModifierGroup.count({ where: { productId: before.id } }),
      ]),
    ).resolves.toEqual(relationCounts)
    await expect(
      client.catalogVenueBinding.findFirstOrThrow({ where: { organizationId, catalogItemId, venueId: linkVenue.id } }),
    ).resolves.toEqual(
      expect.objectContaining({
        productId: before.id,
        lastPublishedCatalogRevision: null,
        lastPublishedManagedSnapshot: null,
        managedHashVersion: null,
        lastPublishedManagedHash: null,
      }),
    )
    await expect(client.activityLog.count({ where: { organizationId, action: 'CATALOG_BINDING_APPLIED' } })).resolves.toBe(1)
  })

  it('CREATE materializes one inactive Decimal Product, managed snapshot, and zero operational relations', async () => {
    const client = db()
    const service = bindingService()
    const preview = await service.preview(context, {
      lines: [
        {
          catalogItemId,
          venueId: createVenue.id,
          decision: {
            decision: 'CREATE',
            create: { categoryId: createVenue.categoryId, localSku: ` local-${fixtureKey} `, initialPrice: '20.00' },
          },
        },
      ],
    })
    const result = await service.confirm(context, {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true,
      idempotencyKey: `binding-create-${fixtureKey}`,
    })
    const productId = result.lines[0]?.productId as string
    const product = await client.product.findUniqueOrThrow({ where: { id: productId } })
    const provenance = await client.product.findUniqueOrThrow({ where: { id: productId }, select: { createdById: true } })

    expect(product).toEqual(
      expect.objectContaining({
        id: productId,
        venueId: createVenue.id,
        categoryId: createVenue.categoryId,
        sku: `LOCAL-${fixtureKey}`.toUpperCase(),
        gtin: null,
        active: false,
        tags: [],
        allergens: [],
      }),
    )
    expect(provenance).toEqual({ createdById: staffId })
    expect(product.price.toFixed(2)).toBe('20.00')
    expect(product.cost?.toFixed(2)).toBe('12.50')
    await expect(
      Promise.all([
        client.inventory.count({ where: { productId } }),
        client.recipe.count({ where: { productId } }),
        client.productModifierGroup.count({ where: { productId } }),
      ]),
    ).resolves.toEqual([0, 0, 0])
    await expect(
      client.catalogVenueBinding.findFirstOrThrow({ where: { organizationId, catalogItemId, venueId: createVenue.id } }),
    ).resolves.toEqual(
      expect.objectContaining({
        productId,
        lastPublishedCatalogRevision: 1,
        managedHashVersion: 1,
        lastPublishedManagedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
  })

  it('rolls back Product, binding, line transition and idempotency when the real audit FK fails', async () => {
    const client = db()
    const preview = await bindingService().preview(context, {
      lines: [
        {
          catalogItemId,
          venueId: rollbackVenue.id,
          decision: {
            decision: 'CREATE',
            create: { categoryId: rollbackVenue.categoryId, localSku: `ROLLBACK-${fixtureKey}`, initialPrice: '20.00' },
          },
        },
      ],
    })
    const invalidAuditService = bindingService((tx, input) =>
      writeCatalogAudit(tx, { ...input, actor: { type: 'HUMAN', staffId: missingStaffId, impersonating: false } }),
    )

    await expect(
      invalidAuditService.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: `binding-rollback-${fixtureKey}`,
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
    await expect(client.product.count({ where: { venueId: rollbackVenue.id } })).resolves.toBe(0)
    await expect(client.catalogVenueBinding.count({ where: { organizationId, venueId: rollbackVenue.id } })).resolves.toBe(0)
    await expect(
      client.catalogIdempotencyRecord.count({
        where: { organizationId, operation: 'CATALOG_BINDING', idempotencyKey: `binding-rollback-${fixtureKey}` },
      }),
    ).resolves.toBe(0)
    await expect(client.catalogBindingBatch.findUniqueOrThrow({ where: { id: preview.bindingBatchId as string } })).resolves.toEqual(
      expect.objectContaining({ state: 'PREVIEWED' }),
    )
  })

  it('returns one stable APPLIED result for concurrent confirms and tenant-safely hides a foreign Venue', async () => {
    const client = db()
    const service = bindingService()
    await expect(
      service.preview(context, { lines: [{ catalogItemId, venueId: foreignVenue.id, decision: { decision: 'SKIP' } }] }),
    ).rejects.toMatchObject({ statusCode: 404 })
    const preview = await service.preview(context, {
      lines: [
        {
          catalogItemId,
          venueId: concurrentVenue.id,
          decision: {
            decision: 'CREATE',
            create: { categoryId: concurrentVenue.categoryId, localSku: `CONCURRENT-${fixtureKey}`, initialPrice: '20.00' },
          },
        },
      ],
    })
    const confirmation = {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true as const,
      idempotencyKey: `binding-concurrent-${fixtureKey}`,
    }
    if (!writerHarness) throw new Error('Task 8 writer harness was not initialized')
    const firstService = bindingService(writeCatalogAudit, writerHarness.writerOne)
    const secondService = bindingService(writeCatalogAudit, writerHarness.writerTwo)
    const [first, second] = await writerHarness.runBehindMutationLock(() => [
      firstService.confirm(context, confirmation),
      secondService.confirm(context, confirmation),
    ])

    expect(second).toEqual(first)
    await expect(client.product.count({ where: { venueId: concurrentVenue.id } })).resolves.toBe(1)
    await expect(client.catalogVenueBinding.count({ where: { organizationId, venueId: concurrentVenue.id } })).resolves.toBe(1)
    await expect(
      client.activityLog.count({ where: { organizationId, action: 'CATALOG_BINDING_APPLIED', entityId: preview.bindingBatchId } }),
    ).resolves.toBe(1)
  })
})

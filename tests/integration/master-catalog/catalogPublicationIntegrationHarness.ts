import type { PrismaClient } from '@prisma/client'

const DISPOSABLE_DATABASE = '/avoqado_h1a_test_20260808'

export interface CatalogPublicationFixture {
  key: string
  organizationId: string
  staffId: string
  venueId: string
  categoryId: string
  productId: string
  catalogItemId: string
  bindingId: string
}

export interface CatalogPublicationIntegrationHarness {
  primary: PrismaClient
  writerOne: PrismaClient
  writerTwo: PrismaClient
  blocker: PrismaClient
  observer: PrismaClient
  names: { writerOne: string; writerTwo: string; blocker: string; observer: string }
  waitForLockWaiter(applicationName: string, kind: 'advisory' | 'row'): Promise<void>
  disconnect(): Promise<void>
}

export function assertDisposableCatalogPublicationDatabase(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const disposable = (candidate: URL): boolean =>
    ['localhost', '127.0.0.1'].includes(candidate.hostname) && candidate.pathname === DISPOSABLE_DATABASE

  // WHY: No runtime Prisma import or destructive cleanup is permitted until
  // both aliases identify the exact disposable H1 database byte-for-byte.
  if (!disposable(effective) || !disposable(declared) || effective.toString() !== declared.toString()) {
    throw new Error('Task 9 integration requires the exact disposable local H1 database')
  }
}

function applicationDatabaseUrl(applicationName: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  url.searchParams.set('application_name', applicationName)
  return url.toString()
}

export async function createCatalogPublicationIntegrationHarness(suite: string): Promise<CatalogPublicationIntegrationHarness> {
  assertDisposableCatalogPublicationDatabase()
  const { PrismaClient: PrismaClientConstructor } = await import('@prisma/client')
  const key = `${suite}-${process.pid}-${Date.now()}`
  const names = {
    writerOne: `h1a-pub-writer-a-${key}`,
    writerTwo: `h1a-pub-writer-b-${key}`,
    blocker: `h1a-pub-blocker-${key}`,
    observer: `h1a-pub-observer-${key}`,
  }
  const primary = new PrismaClientConstructor({
    datasources: { db: { url: applicationDatabaseUrl(`h1a-pub-primary-${key}`) } },
  })
  const writerOne = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(names.writerOne) } } })
  const writerTwo = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(names.writerTwo) } } })
  const blocker = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(names.blocker) } } })
  const observer = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(names.observer) } } })

  return {
    primary,
    writerOne,
    writerTwo,
    blocker,
    observer,
    names,
    async waitForLockWaiter(applicationName, kind) {
      const deadline = Date.now() + 5_000
      let observed: Array<{ waitEvent: string | null; query: string }> = []
      while (Date.now() < deadline) {
        observed = await observer.$queryRawUnsafe<Array<{ waitEvent: string | null; query: string }>>(
          `SELECT wait_event AS "waitEvent", query FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = $1
             AND wait_event_type = 'Lock'`,
          applicationName,
        )
        if (observed.some(row => (kind === 'advisory' ? row.waitEvent === 'advisory' : row.waitEvent !== 'advisory'))) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Timed out waiting for ${kind} lock: ${JSON.stringify(observed)}`)
    },
    async disconnect() {
      await Promise.all([
        primary.$disconnect(),
        writerOne.$disconnect(),
        writerTwo.$disconnect(),
        blocker.$disconnect(),
        observer.$disconnect(),
      ])
    },
  }
}

export async function createCatalogPublicationFixture(client: PrismaClient, suite: string): Promise<CatalogPublicationFixture> {
  const key = `${suite}-${process.pid}-${Date.now()}`
  const organizationId = `h1a-pub-org-${key}`
  const staffId = `h1a-pub-staff-${key}`
  const catalogItemId = `h1a-pub-item-${key}`
  const sku = `H1A-PUB-${key}`.toUpperCase()
  const module = await client.module.findUniqueOrThrow({ where: { code: 'MASTER_CATALOG' }, select: { id: true } })

  await client.organization.create({
    data: { id: organizationId, name: `H1A publication ${key}`, email: `${key}@example.test`, phone: '5500000000' },
  })
  await client.staff.create({
    data: { id: staffId, email: `actor-${key}@example.test`, firstName: 'H1A', lastName: 'Publication' },
  })
  await client.staffOrganization.create({
    data: { staffId, organizationId, role: 'OWNER', isActive: true, isPrimary: true },
  })
  await client.organizationModule.create({
    data: {
      organizationId,
      moduleId: module.id,
      enabled: true,
      enabledBy: staffId,
      config: {
        schemaVersion: 1,
        catalogCoreEnabled: true,
        identifiersEnabled: false,
        regionalPricingEnabled: false,
        governanceMode: 'ADVISORY',
      },
    },
  })
  await client.organizationEntitlement.create({
    data: {
      organizationId,
      featureCode: 'MASTER_CATALOG',
      status: 'ACTIVE',
      source: 'CONTRACT',
      startsAt: new Date(Date.now() - 60_000),
      endsAt: null,
      grantedById: staffId,
      reason: 'Task 9 disposable integration fixture',
    },
  })
  const venue = await client.venue.create({
    data: {
      organizationId,
      name: `Publication venue ${key}`,
      slug: `h1a-publication-${key}`.toLowerCase(),
      type: 'RESTAURANT',
      operationalRole: 'STORE',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
    },
  })
  await client.catalogVenueRollout.create({
    data: {
      organizationId,
      venueId: venue.id,
      governanceState: 'READY_TO_ENFORCE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  const category = await client.menuCategory.create({
    data: { venueId: venue.id, name: 'Publication', slug: `publication-${key}`.toLowerCase() },
  })
  const product = await client.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      sku,
      name: 'Local name',
      description: 'Local description',
      imageUrl: 'https://cdn.example.test/local.jpg',
      type: 'REGULAR',
      price: '20.00',
      cost: '11.00',
      taxRate: '0.0800',
      satProductKey: '50192100',
      satUnitKey: 'H87',
      objetoImp: '02',
      unit: 'PIECE',
      active: false,
      createdById: staffId,
    },
  })
  const brandId = `h1a-pub-brand-${key}`
  const manufacturerId = `h1a-pub-maker-${key}`
  const familyRootId = `h1a-pub-family-root-${key}`
  const familyLeafId = `h1a-pub-family-leaf-${key}`
  await client.catalogBrand.create({
    data: {
      id: brandId,
      organizationId,
      name: 'Brand',
      normalizedName: `BRAND-${key}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogManufacturer.create({
    data: {
      id: manufacturerId,
      organizationId,
      name: 'Maker',
      normalizedName: `MAKER-${key}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyRootId,
      organizationId,
      name: 'Root',
      normalizedName: `ROOT-${key}`,
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
      name: 'Leaf',
      normalizedName: `LEAF-${key}`,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogItem.create({
    data: {
      id: catalogItemId,
      organizationId,
      sku,
      normalizedSku: sku,
      kind: 'RETAIL_PRODUCT',
      name: 'Corporate name',
      description: 'Corporate description',
      imageUrl: 'https://cdn.example.test/corporate.jpg',
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
        create: { code: sku, normalizedCode: sku, type: 'CORPORATE_SKU', status: 'ACTIVE', createdById: staffId },
      },
      prices: {
        create: [
          { kind: 'SALE_PRICE', amount: '25.00', currency: 'MXN', active: true, createdById: staffId, updatedById: staffId },
          { kind: 'PURCHASE_COST', amount: '12.00', currency: 'MXN', active: true, createdById: staffId, updatedById: staffId },
        ],
      },
    },
  })
  const binding = await client.catalogVenueBinding.create({
    data: {
      organizationId,
      catalogItemId,
      venueId: venue.id,
      productId: product.id,
      status: 'LINKED',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  return {
    key,
    organizationId,
    staffId,
    venueId: venue.id,
    categoryId: category.id,
    productId: product.id,
    catalogItemId,
    bindingId: binding.id,
  }
}

export async function cleanupCatalogPublicationFixture(client: PrismaClient, fixture: CatalogPublicationFixture | null): Promise<void> {
  if (!fixture) return
  assertDisposableCatalogPublicationDatabase()
  // WHY: Every delete is tenant- or ID-scoped and occurs only after the guard;
  // Venue cascades operational rows before organization-owned catalog rows.
  await client.activityLog.deleteMany({ where: { organizationId: fixture.organizationId } })
  await client.venue.deleteMany({ where: { id: fixture.venueId, organizationId: fixture.organizationId } })
  await client.organization.deleteMany({ where: { id: fixture.organizationId } })
  await client.staff.deleteMany({ where: { id: fixture.staffId } })
}

/**
 * SQL-direct H1A integrity tests.
 *
 * Service-layer tenant checks are necessary but insufficient: every repeated
 * organizationId/venueId boundary below must also be defended by a composite
 * foreign key so a script or future writer cannot assemble a cross-tenant row.
 */
import { Prisma } from '@prisma/client'
import { Client, type DatabaseError } from 'pg'
import { createHash } from 'node:crypto'
import prisma from '@/utils/prismaClient'

type TenantFixture = {
  organizationId: string
  venueId: string
  categoryId: string
  productId: string
}

let client: Client
let tenantA: TenantFixture
let tenantB: TenantFixture
let staffId: string
let fixtureKey: string
let catalogItemAId: string
let catalogItemBId: string

function dbError(error: unknown): DatabaseError {
  return error as DatabaseError
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function expectDatabaseConstraint(
  operation: () => Promise<unknown>,
  expectedCode: '23502' | '23503' | '23505' | '23514',
): Promise<DatabaseError> {
  try {
    await operation()
  } catch (error) {
    expect(dbError(error).code).toBe(expectedCode)
    return dbError(error)
  }
  throw new Error(`Expected PostgreSQL constraint error ${expectedCode}, but the write succeeded`)
}

async function createTenant(label: string): Promise<TenantFixture> {
  const organization = await prisma.organization.create({
    data: {
      name: `H1A tenant ${label} ${fixtureKey}`,
      email: `h1a-tenant-${label}-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  const venue = await prisma.venue.create({
    data: {
      organizationId: organization.id,
      name: `H1A venue ${label} ${fixtureKey}`,
      slug: `h1a-tenant-${label}-${fixtureKey}`,
    },
  })
  const category = await prisma.menuCategory.create({
    data: {
      venueId: venue.id,
      name: `H1A category ${label}`,
      slug: `h1a-category-${label}-${fixtureKey}`,
      availableDays: [],
    },
  })
  const product = await prisma.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      sku: `H1A-TENANT-${label}-${fixtureKey}`,
      name: `H1A product ${label}`,
      price: new Prisma.Decimal('10.00'),
      tags: [],
      allergens: [],
    },
  })
  return {
    organizationId: organization.id,
    venueId: venue.id,
    categoryId: category.id,
    productId: product.id,
  }
}

/**
 * The exact-one trigger is deferred, so a legitimate writer can insert the
 * authoritative item and its CORPORATE_SKU projection in either order inside
 * one transaction while still being unable to commit an incomplete pair.
 */
async function insertCatalogItem(input: { id: string; organizationId: string; sku: string; normalizedSku: string }): Promise<void> {
  const brandId = `${input.id}-brand`
  const manufacturerId = `${input.id}-manufacturer`
  const familyId = `${input.id}-family`
  await client.query('BEGIN')
  try {
    // Baseline catalog items reference complete, tenant-owned classification
    // rows; staging is the only place allowed to hold incomplete input.
    await client.query(
      `INSERT INTO "CatalogBrand"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [brandId, input.organizationId, `BRAND-${input.normalizedSku}`, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogManufacturer"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [manufacturerId, input.organizationId, `MANUFACTURER-${input.normalizedSku}`, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogFamily"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [familyId, input.organizationId, `FAMILY-${input.normalizedSku}`, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogItem"
        ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
         "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
         "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'RETAIL_PRODUCT', $3, 'Complete baseline item', 'https://example.test/item.png',
               $5, $6, $7, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $8, $8, CURRENT_TIMESTAMP)`,
      [input.id, input.organizationId, input.sku, input.normalizedSku, brandId, manufacturerId, familyId, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogIdentifier"
        ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, 'CORPORATE_SKU', 'ACTIVE', $5, CURRENT_TIMESTAMP)`,
      [`${input.id}-identifier`, input.organizationId, input.id, input.normalizedSku, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogItemBusinessType"
        ("id", "organizationId", "catalogItemId", "businessType")
       VALUES ($1, $2, $3, 'RETAIL_STORE')`,
      [`${input.id}-business-type`, input.organizationId, input.id],
    )
    for (const [kind, amount] of [
      ['SALE_PRICE', '10.00'],
      ['PURCHASE_COST', '6.00'],
    ] as const) {
      await client.query(
        `INSERT INTO "CatalogItemPrice"
          ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "active", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, $4, 'ORGANIZATION', $5, 'MXN', true, $6, $6, CURRENT_TIMESTAMP)`,
        [`${input.id}-${kind}`, input.organizationId, input.id, kind, amount, staffId],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

describe('H1A master-catalog tenant and state constraints', () => {
  beforeAll(async () => {
    fixtureKey = `${process.pid}-${Date.now()}`
    tenantA = await createTenant('a')
    tenantB = await createTenant('b')
    const staff = await prisma.staff.create({
      data: {
        email: `h1a-tenant-actor-${fixtureKey}@example.test`,
        firstName: 'H1A',
        lastName: 'Actor',
      },
    })
    staffId = staff.id

    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()

    catalogItemAId = `h1a-tenant-item-a-${fixtureKey}`
    catalogItemBId = `h1a-tenant-item-b-${fixtureKey}`
    await insertCatalogItem({
      id: catalogItemAId,
      organizationId: tenantA.organizationId,
      sku: `CORP-A-${fixtureKey}`,
      normalizedSku: `CORP-A-${fixtureKey}`,
    })
    await insertCatalogItem({
      id: catalogItemBId,
      organizationId: tenantB.organizationId,
      sku: `CORP-B-${fixtureKey}`,
      normalizedSku: `CORP-B-${fixtureKey}`,
    })
  })

  afterAll(async () => {
    if (client) await client.end()
    await prisma.$disconnect()
  })

  it('rejects a CatalogItem whose organization does not exist', async () => {
    const expectedConstraint = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'CatalogItem_organizationId_fkey'
       ) AS exists`,
    )
    expect(expectedConstraint.rows[0]?.exists).toBe(true)

    const error = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogItem"
            ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
             "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
             "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, 'ORPHAN', 'ORPHAN', 'RETAIL_PRODUCT', 'Orphan', 'Orphan', 'https://example.test/orphan.png',
                   $3, $4, $5, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $6, $6, CURRENT_TIMESTAMP)`,
          [
            `h1a-orphan-${fixtureKey}`,
            `missing-org-${fixtureKey}`,
            `${catalogItemAId}-brand`,
            `${catalogItemAId}-manufacturer`,
            `${catalogItemAId}-family`,
            staffId,
          ],
        ),
      '23503',
    )
    expect(error.constraint).toBeDefined()
  })

  it('rejects binding organization, venue, and Product combinations from different tenants', async () => {
    const wrongItemOrg = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogVenueBinding"
            ("id", "organizationId", "catalogItemId", "venueId", "status", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $5, CURRENT_TIMESTAMP)`,
          [`h1a-binding-wrong-item-${fixtureKey}`, tenantB.organizationId, catalogItemAId, tenantB.venueId, staffId],
        ),
      '23503',
    )
    expect(wrongItemOrg.constraint).toBe('CatalogVenueBinding_catalogItem_tenant_fkey')

    const wrongVenueOrg = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogVenueBinding"
            ("id", "organizationId", "catalogItemId", "venueId", "status", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $5, CURRENT_TIMESTAMP)`,
          [`h1a-binding-wrong-venue-${fixtureKey}`, tenantA.organizationId, catalogItemAId, tenantB.venueId, staffId],
        ),
      '23503',
    )
    expect(wrongVenueOrg.constraint).toBe('CatalogVenueBinding_venue_tenant_fkey')

    const wrongProductVenue = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogVenueBinding"
            ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
          [`h1a-binding-wrong-product-${fixtureKey}`, tenantA.organizationId, catalogItemAId, tenantA.venueId, tenantB.productId, staffId],
        ),
      '23503',
    )
    expect(wrongProductVenue.constraint).toBe('CatalogVenueBinding_product_venue_fkey')
  })

  it('rejects CatalogIdentifier and organization-price rows paired with another tenant item', async () => {
    const identifierError = await expectDatabaseConstraint(
      () =>
        client.query(
          `UPDATE "CatalogIdentifier"
              SET "organizationId" = $1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = $2`,
          [tenantB.organizationId, `${catalogItemAId}-identifier`],
        ),
      '23503',
    )
    expect(identifierError.constraint).toBe('CatalogIdentifier_catalogItem_tenant_fkey')

    const priceError = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogItemPrice"
            ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, 'SALE_PRICE', 'ORGANIZATION', 10.00, 'CROSS', $4, $4, CURRENT_TIMESTAMP)`,
          [`h1a-cross-price-${fixtureKey}`, tenantB.organizationId, catalogItemAId, staffId],
        ),
      '23503',
    )
    expect(priceError.constraint).toBe('CatalogItemPrice_catalogItem_tenant_fkey')
  })

  it('keeps organization prices unique per currency while allowing multi-currency defaults', async () => {
    const values = ['CAD', 'USD'] as const
    for (const currency of values) {
      await client.query(
        `INSERT INTO "CatalogItemPrice"
          ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, 'SALE_PRICE', 'ORGANIZATION', 10.00, $4, $5, $5, CURRENT_TIMESTAMP)`,
        [`h1a-price-${currency}-${fixtureKey}`, tenantA.organizationId, catalogItemAId, currency, staffId],
      )
    }

    const duplicate = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogItemPrice"
            ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, 'SALE_PRICE', 'ORGANIZATION', 12.00, 'CAD', $4, $4, CURRENT_TIMESTAMP)`,
          [`h1a-price-duplicate-${fixtureKey}`, tenantA.organizationId, catalogItemAId, staffId],
        ),
      '23505',
    )
    expect(duplicate.constraint).toBe('CatalogItemPrice_org_item_kind_scope_currency_key')
  })

  it('allows version history but only one active import alias mapping per organization', async () => {
    await client.query(
      `INSERT INTO "CatalogProductTypeMapping"
        ("id", "organizationId", "catalogProductType", "productType", "mappingVersion", "active", "createdById", "updatedAt")
       VALUES ($1, $2, 'PRODUCTO', 'REGULAR', 1, true, $3, CURRENT_TIMESTAMP)`,
      [`h1a-type-map-v1-${fixtureKey}`, tenantA.organizationId, staffId],
    )
    await expect(
      client.query(
        `INSERT INTO "CatalogProductTypeMapping"
          ("id", "organizationId", "catalogProductType", "productType", "mappingVersion", "active", "createdById", "updatedAt")
         VALUES ($1, $2, 'PRODUCTO', 'REGULAR', 2, false, $3, CURRENT_TIMESTAMP)`,
        [`h1a-type-map-v2-inactive-${fixtureKey}`, tenantA.organizationId, staffId],
      ),
    ).resolves.toBeDefined()

    const duplicateActive = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogProductTypeMapping"
            ("id", "organizationId", "catalogProductType", "productType", "mappingVersion", "active", "createdById", "updatedAt")
           VALUES ($1, $2, 'PRODUCTO', 'FOOD_AND_BEV', 3, true, $3, CURRENT_TIMESTAMP)`,
          [`h1a-type-map-v3-active-${fixtureKey}`, tenantA.organizationId, staffId],
        ),
      '23505',
    )
    expect(duplicateActive.constraint).toBe('CatalogProductTypeMapping_one_active_alias_key')
  })

  it('versions validation profiles but permits only one active row per null-safe scope', async () => {
    await client.query(
      `INSERT INTO "CatalogValidationProfile"
        ("id", "organizationId", "name", "profileVersion", "active", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, 'Retail baseline', 1, true, $3, $3, CURRENT_TIMESTAMP)`,
      [`h1a-profile-v1-${fixtureKey}`, tenantA.organizationId, staffId],
    )
    await expect(
      client.query(
        `INSERT INTO "CatalogValidationProfile"
          ("id", "organizationId", "name", "profileVersion", "active", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, 'Retail baseline', 2, false, $3, $3, CURRENT_TIMESTAMP)`,
        [`h1a-profile-v2-inactive-${fixtureKey}`, tenantA.organizationId, staffId],
      ),
    ).resolves.toBeDefined()

    const duplicateActive = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogValidationProfile"
            ("id", "organizationId", "name", "profileVersion", "active", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, 'Retail baseline', 3, true, $3, $3, CURRENT_TIMESTAMP)`,
          [`h1a-profile-v3-active-${fixtureKey}`, tenantA.organizationId, staffId],
        ),
      '23505',
    )
    expect(duplicateActive.constraint).toBe('CatalogValidationProfile_one_active_scope_key')

    const version = await client.query<{ rulesSchemaVersion: number }>(
      `SELECT "rulesSchemaVersion" FROM "CatalogValidationProfile" WHERE "id" = $1`,
      [`h1a-profile-v1-${fixtureKey}`],
    )
    expect(version.rows[0]?.rulesSchemaVersion).toBe(1)
  })

  it('rejects import, binding, and publication lines attached to another organization batch', async () => {
    const importBatchId = `h1a-import-batch-${fixtureKey}`
    const bindingBatchId = `h1a-binding-batch-${fixtureKey}`
    const publicationBatchId = `h1a-publication-batch-${fixtureKey}`
    const publicationBindingId = `h1a-publication-binding-${fixtureKey}`
    const previewExpiresAt = new Date(Date.now() + 60_000)

    for (const [table, id] of [
      ['CatalogImportBatch', importBatchId],
      ['CatalogBindingBatch', bindingBatchId],
    ] as const) {
      await client.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
           "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'PREVIEWED', 1, $3, 1, $4, $5, $6, '{}'::jsonb, 'HUMAN', $7, CURRENT_TIMESTAMP)`,
        [id, tenantA.organizationId, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`), previewExpiresAt, staffId],
      )
    }
    await client.query(
      `INSERT INTO "CatalogPublicationBatch"
        ("id", "organizationId", "operation", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
         "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'CATALOG_PUBLICATION', 'PREVIEWED', 1, $3, 1, $4, $5, $6, '{}'::jsonb, 'HUMAN', $7, CURRENT_TIMESTAMP)`,
      [
        publicationBatchId,
        tenantA.organizationId,
        sha256(`request-${publicationBatchId}`),
        sha256(`target-${publicationBatchId}`),
        sha256(`token-${publicationBatchId}`),
        previewExpiresAt,
        staffId,
      ],
    )
    await client.query(
      `INSERT INTO "CatalogVenueBinding"
        ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
      [publicationBindingId, tenantB.organizationId, catalogItemBId, tenantB.venueId, tenantB.productId, staffId],
    )

    const importError = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogImportLine"
            ("id", "organizationId", "batchId", "sourceSheet", "sourceRow", "status", "payload", "updatedAt")
           VALUES ($1, $2, $3, 'Items', 2, 'READY', '{}'::jsonb, CURRENT_TIMESTAMP)`,
          [`h1a-cross-import-line-${fixtureKey}`, tenantB.organizationId, importBatchId],
        ),
      '23503',
    )
    expect(importError.constraint).toBe('CatalogImportLine_batch_tenant_fkey')

    const bindingError = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogBindingLine"
            ("id", "organizationId", "batchId", "catalogItemId", "venueId", "status", "proposal", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'READY', 'LINK', CURRENT_TIMESTAMP)`,
          [`h1a-cross-binding-line-${fixtureKey}`, tenantB.organizationId, bindingBatchId, catalogItemBId, tenantB.venueId],
        ),
      '23503',
    )
    expect(bindingError.constraint).toBe('CatalogBindingLine_batch_tenant_fkey')

    const publicationError = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogPublicationLine"
            ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
             "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash", "sourceCatalogRevision", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['name'], 1, 'PUBLICATION', 1, $8, 1, CURRENT_TIMESTAMP)`,
          [
            `h1a-cross-publication-line-${fixtureKey}`,
            tenantB.organizationId,
            publicationBatchId,
            publicationBindingId,
            catalogItemBId,
            tenantB.venueId,
            tenantB.productId,
            sha256(`canonical-${fixtureKey}`),
          ],
        ),
      '23503',
    )
    expect(publicationError.constraint).toBe('CatalogPublicationLine_batch_tenant_fkey')
  })

  it('rejects publication provenance assembled from a different same-venue binding target', async () => {
    const secondItemId = `h1a-tenant-item-a-second-${fixtureKey}`
    const secondProductId = `h1a-tenant-product-a-second-${fixtureKey}`
    const bindingId = `h1a-publication-target-binding-${fixtureKey}`
    const batchId = `h1a-publication-target-batch-${fixtureKey}`
    await insertCatalogItem({
      id: secondItemId,
      organizationId: tenantA.organizationId,
      sku: `CORP-A-SECOND-${fixtureKey}`,
      normalizedSku: `CORP-A-SECOND-${fixtureKey}`,
    })
    await client.query(
      `INSERT INTO "Product"
        ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
       VALUES ($1, $2, $3, $1, 'Second same-venue target', 11.00, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [secondProductId, tenantA.venueId, tenantA.categoryId],
    )
    await client.query(
      `INSERT INTO "CatalogVenueBinding"
        ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
      [bindingId, tenantA.organizationId, catalogItemAId, tenantA.venueId, tenantA.productId, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogPublicationBatch"
        ("id", "organizationId", "operation", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
         "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'CATALOG_PUBLICATION', 'PREVIEWED', 1, $3, 1, $4, $5,
               CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb, 'HUMAN', $6, CURRENT_TIMESTAMP)`,
      [batchId, tenantA.organizationId, sha256(`request-${batchId}`), sha256(`target-${batchId}`), sha256(`token-${batchId}`), staffId],
    )

    // Each individual tenant FK is valid here; only the binding-target tuple
    // proves that this exact catalog item and Product belong to this binding.
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO "CatalogPublicationLine"
          ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
           "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash", "sourceCatalogRevision", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY[]::text[], 1, 'PUBLICATION', 1, $8, 1, CURRENT_TIMESTAMP)`,
        [
          `h1a-publication-wrong-target-${fixtureKey}`,
          tenantA.organizationId,
          batchId,
          bindingId,
          secondItemId,
          tenantA.venueId,
          secondProductId,
          sha256(`wrong-target-${fixtureKey}`),
        ],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23503',
        constraint: 'CatalogPublicationLine_binding_tenant_fkey',
      })
    } finally {
      await client.query('ROLLBACK')
    }
  })

  it('keeps rollout/readiness defaults off and fences idempotency by organization plus operation', async () => {
    const rolloutId = `h1a-rollout-${fixtureKey}`
    const idempotencyId = `h1a-idempotency-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogVenueRollout"
        ("id", "organizationId", "venueId", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, CURRENT_TIMESTAMP)`,
      [rolloutId, tenantA.organizationId, tenantA.venueId, staffId],
    )
    const rollout = await client.query<{
      registryState: string
      aliasPublicationState: string
      governanceState: string
      identifierRevision: string
    }>(
      `SELECT "registryState", "aliasPublicationState", "governanceState", "identifierRevision"::text
         FROM "CatalogVenueRollout" WHERE "id" = $1`,
      [rolloutId],
    )
    expect(rollout.rows[0]).toEqual({
      registryState: 'NOT_STARTED',
      aliasPublicationState: 'DISABLED',
      governanceState: 'NOT_STARTED',
      identifierRevision: '0',
    })

    await client.query(
      `INSERT INTO "CatalogIdempotencyRecord"
        ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "requestHashVersion", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'CATALOG_IMPORT', 'same-key', $3, 1, 'HUMAN', $4, CURRENT_TIMESTAMP)`,
      [idempotencyId, tenantA.organizationId, sha256('hash-a'), staffId],
    )
    const duplicate = await expectDatabaseConstraint(
      () =>
        client.query(
          `INSERT INTO "CatalogIdempotencyRecord"
            ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "requestHashVersion", "actorType", "staffId", "updatedAt")
           VALUES ($1, $2, 'CATALOG_IMPORT', 'same-key', $3, 1, 'HUMAN', $4, CURRENT_TIMESTAMP)`,
          [`${idempotencyId}-duplicate`, tenantA.organizationId, sha256('hash-a'), staffId],
        ),
      '23505',
    )
    expect(duplicate.constraint).toBe('CatalogIdempotencyRecord_organizationId_operation_idemp_key')

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "requestHashVersion", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_PUBLICATION', 'same-key', $3, 1, 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`${idempotencyId}-other-op`, tenantA.organizationId, sha256('hash-b'), staffId],
      ),
    ).resolves.toBeDefined()
  })

  it('stores validation-profile previews on the generic idempotency spine using only a token hash', async () => {
    const previewId = `h1a-profile-preview-${fixtureKey}`
    const previewExpiresAt = new Date(Date.now() + 60_000)
    await client.query(
      `INSERT INTO "CatalogIdempotencyRecord"
        ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "requestHashVersion", "state",
         "resourceType", "targetHash", "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'VALIDATION_PROFILE_CHANGE', 'profile-key', $3, 1, 'PREVIEWED',
               'CatalogValidationProfile', $4, $5, $6, '{}'::jsonb, 'HUMAN', $7, CURRENT_TIMESTAMP)`,
      [
        previewId,
        tenantA.organizationId,
        sha256('profile-request-hash'),
        sha256('profile-target-hash'),
        sha256('profile-token'),
        previewExpiresAt,
        staffId,
      ],
    )

    const stored = await client.query<{
      id: string
      resourceType: string
      targetHash: string
      previewTokenHash: string
    }>(
      `SELECT "id", "resourceType", "targetHash", "previewTokenHash"
         FROM "CatalogIdempotencyRecord" WHERE "id" = $1`,
      [previewId],
    )
    expect(stored.rows[0]).toEqual({
      id: previewId,
      resourceType: 'CatalogValidationProfile',
      targetHash: sha256('profile-target-hash'),
      previewTokenHash: sha256('profile-token'),
    })

    const rawTokenColumns = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'CatalogIdempotencyRecord'
          AND column_name IN ('previewToken', 'rawPreviewToken')`,
    )
    expect(rawTokenColumns.rows).toEqual([])
  })

  it('allows unclassified legacy ActivityLog actors and rejects invalid classified HUMAN/SERVICE pairs', async () => {
    await expect(
      client.query(
        `INSERT INTO "ActivityLog" ("id", "organizationId", "action", "actorType")
         VALUES ($1, $2, 'H1A_LEGACY_UNCLASSIFIED', NULL)`,
        [`h1a-activity-legacy-${fixtureKey}`, tenantA.organizationId],
      ),
    ).resolves.toBeDefined()

    await expect(
      client.query(
        `INSERT INTO "ActivityLog" ("id", "organizationId", "action", "actorType", "staffId", "actorStaffId")
         VALUES ($1, $2, 'H1A_HUMAN', 'HUMAN', $3, $3)`,
        [`h1a-activity-human-${fixtureKey}`, tenantA.organizationId, staffId],
      ),
    ).resolves.toBeDefined()

    await expect(
      client.query(
        `INSERT INTO "ActivityLog" ("id", "organizationId", "action", "actorType", "servicePrincipalId")
         VALUES ($1, $2, 'H1A_SERVICE', 'SERVICE', 'catalog-publication-worker')`,
        [`h1a-activity-service-${fixtureKey}`, tenantA.organizationId],
      ),
    ).resolves.toBeDefined()

    await expect(
      client.query(
        `INSERT INTO "ActivityLog"
          ("id", "organizationId", "venueId", "action", "actorType", "servicePrincipalId")
         VALUES ($1, $2, $3, 'H1A_CROSS_TENANT_VENUE', 'SERVICE', 'catalog-publication-worker')`,
        [`h1a-activity-cross-venue-${fixtureKey}`, tenantA.organizationId, tenantB.venueId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ActivityLog_venue_organization_check' })

    for (const [idSuffix, actorType, legacyStaffId, durableStaffId, servicePrincipalId] of [
      ['human-without-staff', 'HUMAN', null, null, null],
      ['human-without-durable-staff', 'HUMAN', staffId, null, null],
      ['human-with-service', 'HUMAN', staffId, staffId, 'unexpected-service'],
      ['service-without-principal', 'SERVICE', null, null, null],
      ['service-with-whitespace-principal', 'SERVICE', null, null, '\t\n'],
      ['service-with-staff', 'SERVICE', staffId, staffId, 'catalog-publication-worker'],
    ] as const) {
      const error = await expectDatabaseConstraint(
        () =>
          client.query(
            `INSERT INTO "ActivityLog"
              ("id", "organizationId", "action", "actorType", "staffId", "actorStaffId", "servicePrincipalId")
             VALUES ($1, $2, 'H1A_INVALID_ACTOR', $3, $4, $5, $6)`,
            [
              `h1a-activity-${idSuffix}-${fixtureKey}`,
              tenantA.organizationId,
              actorType,
              legacyStaffId,
              durableStaffId,
              servicePrincipalId,
            ],
          ),
        '23514',
      )
      expect(error.constraint).toBe('ActivityLog_actor_identity_check')
    }
  })

  it('retains classified audit after its validated Venue is deleted', async () => {
    const venueId = `h1a-audit-retention-venue-${fixtureKey}`
    const logId = `h1a-audit-retention-log-${fixtureKey}`
    await client.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'Audit retention venue', $3, CURRENT_TIMESTAMP)`,
      [venueId, tenantA.organizationId, `h1a-audit-retention-${fixtureKey}`],
    )
    await client.query(
      `INSERT INTO "ActivityLog"
        ("id", "organizationId", "venueId", "action", "actorType", "staffId", "actorStaffId")
       VALUES ($1, $2, $3, 'H1A_AUDIT_RETENTION', 'HUMAN', $4, $4)`,
      [logId, tenantA.organizationId, venueId, staffId],
    )
    await client.query(`DELETE FROM "Venue" WHERE id = $1`, [venueId])

    const retained = await client.query<{ organizationId: string; venueId: string }>(
      `SELECT "organizationId", "venueId" FROM "ActivityLog" WHERE id = $1`,
      [logId],
    )
    expect(retained.rows).toEqual([{ organizationId: tenantA.organizationId, venueId }])
  })
})

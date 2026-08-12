/**
 * Database-level contract for the CORPORATE_SKU projection.
 *
 * The projection is written beside CatalogItem inside one transaction, so the
 * invariant must be deferred until commit. A normal unique index alone cannot
 * detect a missing projection or a status/value divergence.
 */
import { Client, type DatabaseError } from 'pg'
import prisma from '@/utils/prismaClient'

let client: Client
let organizationId: string
let staffId: string
let fixtureKey: string
let brandId: string
let manufacturerId: string
let familyId: string

type ProjectionInput = {
  itemId: string
  sku: string
  normalizedSku: string
  itemStatus: 'ACTIVE' | 'RETIRED'
  identifier?: {
    code: string
    normalizedCode: string
    status: 'ACTIVE' | 'RETIRED'
  }
  baseline?: 'COMPLETE' | 'NONE' | 'SPLIT_CURRENCY'
}

async function commitProjection(input: ProjectionInput): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO "CatalogItem"
        ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
         "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
         "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, 'RETAIL_PRODUCT', $3, 'Complete projection fixture', 'https://example.test/item.png',
               $5, $6, $7, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', $8, $9, $9, CURRENT_TIMESTAMP)`,
      [input.itemId, organizationId, input.sku, input.normalizedSku, brandId, manufacturerId, familyId, input.itemStatus, staffId],
    )
    if (input.identifier) {
      await client.query(
        `INSERT INTO "CatalogIdentifier"
          ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'CORPORATE_SKU', $6, $7, CURRENT_TIMESTAMP)`,
        [
          `${input.itemId}-identifier`,
          organizationId,
          input.itemId,
          input.identifier.code,
          input.identifier.normalizedCode,
          input.identifier.status,
          staffId,
        ],
      )
    }
    if (input.baseline !== 'NONE') {
      await client.query(
        `INSERT INTO "CatalogItemBusinessType"
          ("id", "organizationId", "catalogItemId", "businessType")
         VALUES ($1, $2, $3, 'RETAIL_STORE')`,
        [`${input.itemId}-business-type`, organizationId, input.itemId],
      )
      const purchaseCurrency = input.baseline === 'SPLIT_CURRENCY' ? 'USD' : 'MXN'
      for (const [kind, currency, amount] of [
        ['SALE_PRICE', 'MXN', '10.00'],
        ['PURCHASE_COST', purchaseCurrency, '6.00'],
      ] as const) {
        await client.query(
          `INSERT INTO "CatalogItemPrice"
            ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "active", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, $4, 'ORGANIZATION', $5, $6, true, $7, $7, CURRENT_TIMESTAMP)`,
          [`${input.itemId}-${kind}`, organizationId, input.itemId, kind, amount, currency, staffId],
        )
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function expectDeferredProjectionFailure(input: ProjectionInput): Promise<DatabaseError> {
  try {
    await commitProjection(input)
  } catch (error) {
    const databaseError = error as DatabaseError
    expect(databaseError.code).toBe('23514')
    expect(databaseError.constraint).toBe('CatalogItem_corporate_sku_projection_check')
    return databaseError
  }
  throw new Error('Expected the deferred CORPORATE_SKU constraint trigger to reject COMMIT')
}

async function expectDeferredBaselineFailure(input: ProjectionInput, message: string): Promise<void> {
  try {
    await commitProjection(input)
  } catch (error) {
    const databaseError = error as DatabaseError
    expect(databaseError.code).toBe('23514')
    expect(databaseError.constraint).toBe('CatalogItem_relational_baseline_check')
    expect(databaseError.message).toContain(message)
    return
  }

  // A missing trigger in the RED phase must not leave an invalid aggregate in
  // the disposable database and mask later migration behavior.
  await client.query(`DELETE FROM "CatalogItem" WHERE "id" = $1`, [input.itemId])
  throw new Error('Expected the deferred relational baseline trigger to reject COMMIT')
}

async function expectDeferredBaselineMutationFailure(itemId: string, operation: () => Promise<unknown>, message: string): Promise<void> {
  await client.query('BEGIN')
  try {
    await operation()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    const databaseError = error as DatabaseError
    expect(databaseError.code).toBe('23514')
    expect(databaseError.constraint).toBe('CatalogItem_relational_baseline_check')
    expect(databaseError.message).toContain(message)
    return
  }

  await client.query(`DELETE FROM "CatalogItem" WHERE "id" = $1`, [itemId])
  throw new Error('Expected the deferred relational baseline mutation constraint to reject COMMIT')
}

describe('H1A deferred CORPORATE_SKU projection trigger', () => {
  beforeAll(async () => {
    fixtureKey = `${process.pid}-${Date.now()}`
    const organization = await prisma.organization.create({
      data: {
        name: `H1A projection trigger ${fixtureKey}`,
        email: `h1a-projection-${fixtureKey}@example.test`,
        phone: '5500000000',
      },
    })
    organizationId = organization.id
    const staff = await prisma.staff.create({
      data: {
        email: `h1a-projection-actor-${fixtureKey}@example.test`,
        firstName: 'H1A',
        lastName: 'Projection',
      },
    })
    staffId = staff.id

    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()

    brandId = `h1a-projection-brand-${fixtureKey}`
    manufacturerId = `h1a-projection-manufacturer-${fixtureKey}`
    familyId = `h1a-projection-family-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogBrand"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, 'Projection Brand', $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [brandId, organizationId, `PROJECTION-BRAND-${fixtureKey}`, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogManufacturer"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, 'Projection Manufacturer', $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [manufacturerId, organizationId, `PROJECTION-MANUFACTURER-${fixtureKey}`, staffId],
    )
    await client.query(
      `INSERT INTO "CatalogFamily"
        ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, 'Projection Family', $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
      [familyId, organizationId, `PROJECTION-FAMILY-${fixtureKey}`, staffId],
    )
  })

  afterAll(async () => {
    if (client) await client.end()
    await prisma.$disconnect()
  })

  it('installs initially-deferred constraint triggers on both sides of the projection', async () => {
    const result = await client.query<{
      trigger_name: string
      deferrable: boolean
      initially_deferred: boolean
    }>(
      `SELECT tgname AS trigger_name,
              tgdeferrable AS deferrable,
              tginitdeferred AS initially_deferred
         FROM pg_trigger
        WHERE tgname IN (
          'CatalogItem_corporate_sku_projection_trigger',
          'CatalogIdentifier_corporate_sku_projection_trigger'
        )
        ORDER BY tgname`,
    )

    expect(result.rows).toEqual([
      {
        trigger_name: 'CatalogIdentifier_corporate_sku_projection_trigger',
        deferrable: true,
        initially_deferred: true,
      },
      {
        trigger_name: 'CatalogItem_corporate_sku_projection_trigger',
        deferrable: true,
        initially_deferred: true,
      },
    ])
  })

  it('installs initially-deferred baseline triggers on item, business type, and price writes', async () => {
    const result = await client.query<{
      trigger_name: string
      deferrable: boolean
      initially_deferred: boolean
    }>(
      `SELECT tgname AS trigger_name,
              tgdeferrable AS deferrable,
              tginitdeferred AS initially_deferred
         FROM pg_trigger
        WHERE tgname IN (
          'CatalogItem_relational_baseline_trigger',
          'CatalogItemBusinessType_relational_baseline_trigger',
          'CatalogItemPrice_relational_baseline_trigger'
        )
        ORDER BY tgname`,
    )

    expect(result.rows).toEqual([
      {
        trigger_name: 'CatalogItemBusinessType_relational_baseline_trigger',
        deferrable: true,
        initially_deferred: true,
      },
      {
        trigger_name: 'CatalogItemPrice_relational_baseline_trigger',
        deferrable: true,
        initially_deferred: true,
      },
      {
        trigger_name: 'CatalogItem_relational_baseline_trigger',
        deferrable: true,
        initially_deferred: true,
      },
    ])
  })

  it('rejects an item with only its corporate SKU and no relational baseline', async () => {
    const itemId = `h1a-no-relational-baseline-${fixtureKey}`
    await expectDeferredBaselineFailure(
      {
        itemId,
        sku: `NO-BASELINE-${fixtureKey}`,
        normalizedSku: `NO-BASELINE-${fixtureKey}`,
        itemStatus: 'ACTIVE',
        identifier: {
          code: `NO-BASELINE-${fixtureKey}`,
          normalizedCode: `NO-BASELINE-${fixtureKey}`,
          status: 'ACTIVE',
        },
        baseline: 'NONE',
      },
      'at least one CatalogItemBusinessType',
    )
  })

  it('rejects SALE_PRICE and PURCHASE_COST that are active only in different currencies', async () => {
    const itemId = `h1a-split-currency-${fixtureKey}`
    await expectDeferredBaselineFailure(
      {
        itemId,
        sku: `SPLIT-${fixtureKey}`,
        normalizedSku: `SPLIT-${fixtureKey}`,
        itemStatus: 'ACTIVE',
        identifier: {
          code: `SPLIT-${fixtureKey}`,
          normalizedCode: `SPLIT-${fixtureKey}`,
          status: 'ACTIVE',
        },
        baseline: 'SPLIT_CURRENCY',
      },
      'active ORGANIZATION SALE_PRICE and PURCHASE_COST in the same currency',
    )
  })

  it('rejects COMMIT when a CatalogItem has no CORPORATE_SKU projection', async () => {
    const error = await expectDeferredProjectionFailure({
      itemId: `h1a-missing-projection-${fixtureKey}`,
      sku: `MISSING-${fixtureKey}`,
      normalizedSku: `MISSING-${fixtureKey}`,
      itemStatus: 'ACTIVE',
    })
    expect(error.message).toContain('exactly one CORPORATE_SKU')
  })

  it('rejects COMMIT when the normalized projection differs from the item canonical SKU', async () => {
    const error = await expectDeferredProjectionFailure({
      itemId: `h1a-divergent-code-${fixtureKey}`,
      sku: `SKU-${fixtureKey}`,
      normalizedSku: `SKU-${fixtureKey}`,
      itemStatus: 'ACTIVE',
      identifier: {
        code: `OTHER-${fixtureKey}`,
        normalizedCode: `OTHER-${fixtureKey}`,
        status: 'ACTIVE',
      },
    })
    expect(error.message).toContain('normalizedCode must equal CatalogItem.normalizedSku')
  })

  it('rejects COMMIT when ACTIVE/RETIRED state diverges', async () => {
    const error = await expectDeferredProjectionFailure({
      itemId: `h1a-divergent-status-${fixtureKey}`,
      sku: `STATUS-${fixtureKey}`,
      normalizedSku: `STATUS-${fixtureKey}`,
      itemStatus: 'ACTIVE',
      identifier: {
        code: `STATUS-${fixtureKey}`,
        normalizedCode: `STATUS-${fixtureKey}`,
        status: 'RETIRED',
      },
    })
    expect(error.message).toContain('status must mirror CatalogItem.status')
  })

  it('accepts a matching projection plus an active same-currency sale/cost baseline', async () => {
    const itemId = `h1a-valid-projection-${fixtureKey}`
    await expect(
      commitProjection({
        itemId,
        sku: `VALID-${fixtureKey}`,
        normalizedSku: `VALID-${fixtureKey}`,
        itemStatus: 'ACTIVE',
        identifier: {
          code: `VALID-${fixtureKey}`,
          normalizedCode: `VALID-${fixtureKey}`,
          status: 'ACTIVE',
        },
      }),
    ).resolves.toBeUndefined()

    const projection = await client.query(
      `SELECT ci."normalizedSku", identifier."normalizedCode", ci."status" AS item_status,
              identifier."status" AS identifier_status
         FROM "CatalogItem" ci
         JOIN "CatalogIdentifier" identifier ON identifier."catalogItemId" = ci."id"
        WHERE ci."id" = $1`,
      [itemId],
    )
    expect(projection.rows).toEqual([
      {
        normalizedSku: `VALID-${fixtureKey}`,
        normalizedCode: `VALID-${fixtureKey}`,
        item_status: 'ACTIVE',
        identifier_status: 'ACTIVE',
      },
    ])
  })

  it('rejects deletion of the last business type from an existing item', async () => {
    const itemId = `h1a-delete-business-type-${fixtureKey}`
    const code = `DELETE-TYPE-${fixtureKey}`
    await commitProjection({
      itemId,
      sku: code,
      normalizedSku: code,
      itemStatus: 'ACTIVE',
      identifier: { code, normalizedCode: code, status: 'ACTIVE' },
    })

    await expectDeferredBaselineMutationFailure(
      itemId,
      () => client.query(`DELETE FROM "CatalogItemBusinessType" WHERE "catalogItemId" = $1`, [itemId]),
      'at least one CatalogItemBusinessType',
    )
  })

  it('rejects retirement of the last active same-currency sale/cost pair', async () => {
    const itemId = `h1a-retire-price-pair-${fixtureKey}`
    const code = `RETIRE-PAIR-${fixtureKey}`
    await commitProjection({
      itemId,
      sku: code,
      normalizedSku: code,
      itemStatus: 'ACTIVE',
      identifier: { code, normalizedCode: code, status: 'ACTIVE' },
    })

    await expectDeferredBaselineMutationFailure(
      itemId,
      () => client.query(`UPDATE "CatalogItemPrice" SET "active" = false WHERE "catalogItemId" = $1`, [itemId]),
      'active ORGANIZATION SALE_PRICE and PURCHASE_COST in the same currency',
    )
  })

  it('keeps a RETIRED corporate code reserved and permits only one projection per item', async () => {
    const retiredItemId = `h1a-retired-projection-${fixtureKey}`
    const retiredCode = `RETIRED-${fixtureKey}`
    await commitProjection({
      itemId: retiredItemId,
      sku: retiredCode,
      normalizedSku: retiredCode,
      itemStatus: 'RETIRED',
      identifier: { code: retiredCode, normalizedCode: retiredCode, status: 'RETIRED' },
    })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdentifier"
          ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
         VALUES ($1, $2, $3, $4, $4, 'CORPORATE_SKU', 'RETIRED', $5, CURRENT_TIMESTAMP)`,
        [`${retiredItemId}-second`, organizationId, retiredItemId, `SECOND-${fixtureKey}`, staffId],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'CatalogIdentifier_one_corporate_sku_per_item_key',
    })

    const otherItemId = `h1a-retired-reservation-${fixtureKey}`
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO "CatalogItem"
          ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
           "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
           "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, $3, 'RETAIL_PRODUCT', $3, 'Complete projection fixture', 'https://example.test/item.png',
                 $4, $5, $6, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $7, $7, CURRENT_TIMESTAMP)`,
        [otherItemId, organizationId, `OTHER-${fixtureKey}`, brandId, manufacturerId, familyId, staffId],
      )
      await expect(
        client.query(
          `INSERT INTO "CatalogIdentifier"
            ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
           VALUES ($1, $2, $3, $4, $4, 'CORPORATE_SKU', 'ACTIVE', $5, CURRENT_TIMESTAMP)`,
          [`${otherItemId}-identifier`, organizationId, otherItemId, retiredCode, staffId],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'CatalogIdentifier_organizationId_normalizedCode_key',
      })
    } finally {
      await client.query('ROLLBACK')
    }
  })
})

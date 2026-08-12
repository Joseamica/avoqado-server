import { Client, type DatabaseError } from 'pg'
import { createHash } from 'node:crypto'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let setupClient: Client
let organizationId: string
let staffId: string
let checkerStaffId: string
let fixtureKey: string

function databaseError(error: unknown): DatabaseError {
  return error as DatabaseError
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function createCompleteItem(itemId: string, options: { businessTypes?: string[]; currencies?: string[] } = {}): Promise<void> {
  const businessTypes = options.businessTypes ?? ['RETAIL_STORE']
  const currencies = options.currencies ?? ['MXN']
  const code = `CONC-${itemId}`
  const brandId = `${itemId}-brand`
  const manufacturerId = `${itemId}-manufacturer`
  const familyId = `${itemId}-family`

  await setupClient.query('BEGIN')
  try {
    for (const [table, id, label] of [
      ['CatalogBrand', brandId, 'BRAND'],
      ['CatalogManufacturer', manufacturerId, 'MANUFACTURER'],
      ['CatalogFamily', familyId, 'FAMILY'],
    ] as const) {
      await setupClient.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, $3, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
        [id, organizationId, `${label}-${itemId}`, staffId],
      )
    }
    await setupClient.query(
      `INSERT INTO "CatalogItem"
        ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
         "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
         "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $3, 'RETAIL_PRODUCT', $3, 'Concurrent invariant fixture', 'https://example.test/concurrent.png',
               $4, $5, $6, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $7, $7, CURRENT_TIMESTAMP)`,
      [itemId, organizationId, code, brandId, manufacturerId, familyId, staffId],
    )
    await setupClient.query(
      `INSERT INTO "CatalogIdentifier"
        ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, 'CORPORATE_SKU', 'ACTIVE', $5, CURRENT_TIMESTAMP)`,
      [`${itemId}-identifier`, organizationId, itemId, code, staffId],
    )
    for (const [index, businessType] of businessTypes.entries()) {
      await setupClient.query(
        `INSERT INTO "CatalogItemBusinessType" ("id", "organizationId", "catalogItemId", "businessType")
         VALUES ($1, $2, $3, $4::"BusinessType")`,
        [`${itemId}-business-${index}`, organizationId, itemId, businessType],
      )
    }
    for (const currency of currencies) {
      for (const [kind, amount] of [
        ['SALE_PRICE', '10.00'],
        ['PURCHASE_COST', '6.00'],
      ] as const) {
        await setupClient.query(
          `INSERT INTO "CatalogItemPrice"
            ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "active", "createdById", "updatedById", "updatedAt")
           VALUES ($1, $2, $3, $4::"CatalogItemPriceKind", 'ORGANIZATION', $5, $6, true, $7, $7, CURRENT_TIMESTAMP)`,
          [`${itemId}-${currency}-${kind}`, organizationId, itemId, kind, amount, currency, staffId],
        )
      }
    }
    await setupClient.query('COMMIT')
  } catch (error) {
    await setupClient.query('ROLLBACK')
    throw error
  }
}

async function twoClients(): Promise<[Client, Client]> {
  const first = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const second = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await Promise.all([first.connect(), second.connect()])
  return [first, second]
}

async function createPublicationDecisionFixture(suffix: string): Promise<{
  lineId: string
  decisionId: string
}> {
  const itemId = `h1a-decision-${suffix}-item-${fixtureKey}`
  const venueId = `h1a-decision-${suffix}-venue-${fixtureKey}`
  const categoryId = `h1a-decision-${suffix}-category-${fixtureKey}`
  const productId = `h1a-decision-${suffix}-product-${fixtureKey}`
  const bindingId = `h1a-decision-${suffix}-binding-${fixtureKey}`
  const batchId = `h1a-decision-${suffix}-batch-${fixtureKey}`
  const lineId = `h1a-decision-${suffix}-line-${fixtureKey}`
  const decisionId = `h1a-decision-${suffix}-decision-${fixtureKey}`

  await setupClient.query(
    `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
     VALUES ($1, $2, 'Decision race venue', $3, CURRENT_TIMESTAMP)`,
    [venueId, organizationId, `h1a-decision-${suffix}-${fixtureKey}`],
  )
  await setupClient.query(
    `INSERT INTO "MenuCategory" ("id", "venueId", "name", "slug", "availableDays", "updatedAt")
     VALUES ($1, $2, 'Decision race', $3, ARRAY[]::text[], CURRENT_TIMESTAMP)`,
    [categoryId, venueId, `h1a-decision-${suffix}-category-${fixtureKey}`],
  )
  await setupClient.query(
    `INSERT INTO "Product"
      ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
     VALUES ($1, $2, $3, $1, 'Decision race', 10.00, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)`,
    [productId, venueId, categoryId],
  )
  await createCompleteItem(itemId)
  await setupClient.query(
    `INSERT INTO "CatalogVenueBinding"
      ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
    [bindingId, organizationId, itemId, venueId, productId, staffId],
  )
  await setupClient.query(
    `INSERT INTO "CatalogPublicationBatch"
      ("id", "organizationId", "operation", "state", "schemaVersion", "requestHash", "requestHashVersion",
       "targetHash", "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
     VALUES ($1, $2, 'CATALOG_PUBLICATION', 'PREVIEWED', 1, $3, 1, $4, $5,
             CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb, 'HUMAN', $6, CURRENT_TIMESTAMP)`,
    [batchId, organizationId, sha256(`request-${batchId}`), sha256(`target-${batchId}`), sha256(`token-${batchId}`), staffId],
  )
  await setupClient.query(
    `INSERT INTO "CatalogPublicationLine"
      ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
       "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
       "sourceCatalogRevision", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['name'], 1, 'PUBLICATION', 1, $8, 1, CURRENT_TIMESTAMP)`,
    [lineId, organizationId, batchId, bindingId, itemId, venueId, productId, sha256(`canonical-${lineId}`)],
  )
  await setupClient.query(
    `INSERT INTO "CatalogPublicationFieldDecision"
      ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
     VALUES ($1, $2, $3, $4, 'name', 'PUBLISH_CORPORATE', '"old"'::jsonb, '"new"'::jsonb, '"new"'::jsonb, CURRENT_TIMESTAMP)`,
    [decisionId, organizationId, lineId, bindingId],
  )

  return { lineId, decisionId }
}

async function createBulkItems(prefix: string, count: number): Promise<string[]> {
  const itemIds = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
  await setupClient.query('BEGIN')
  try {
    for (const [table, suffix, label] of [
      ['CatalogBrand', 'brand', 'BULK-BRAND'],
      ['CatalogManufacturer', 'manufacturer', 'BULK-MANUFACTURER'],
      ['CatalogFamily', 'family', 'BULK-FAMILY'],
    ] as const) {
      await setupClient.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
         SELECT $1 || '-' || g || '-${suffix}', $2, $3 || '-' || g, $3 || '-' || g, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP
           FROM generate_series(1, $5) AS g`,
        [prefix, organizationId, label, staffId, count],
      )
    }
    await setupClient.query(
      `INSERT INTO "CatalogItem"
        ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
         "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
         "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
       SELECT $1 || '-' || g, $2, 'BULK-' || $1 || '-' || g, 'BULK-' || $1 || '-' || g,
              'RETAIL_PRODUCT', 'Bulk item ' || g, 'Bulk invariant fixture', 'https://example.test/bulk.png',
              $1 || '-' || g || '-brand', $1 || '-' || g || '-manufacturer', $1 || '-' || g || '-family',
              '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $3, $3, CURRENT_TIMESTAMP
         FROM generate_series(1, $4) AS g`,
      [prefix, organizationId, staffId, count],
    )
    await setupClient.query(
      `INSERT INTO "CatalogIdentifier"
        ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
       SELECT $1 || '-' || g || '-identifier', $2, $1 || '-' || g, 'BULK-' || $1 || '-' || g,
              'BULK-' || $1 || '-' || g, 'CORPORATE_SKU', 'ACTIVE', $3, CURRENT_TIMESTAMP
         FROM generate_series(1, $4) AS g`,
      [prefix, organizationId, staffId, count],
    )
    await setupClient.query(
      `INSERT INTO "CatalogItemBusinessType" ("id", "organizationId", "catalogItemId", "businessType")
       SELECT $1 || '-' || g || '-business', $2, $1 || '-' || g, 'RETAIL_STORE'
         FROM generate_series(1, $3) AS g`,
      [prefix, organizationId, count],
    )
    await setupClient.query(
      `INSERT INTO "CatalogItemPrice"
        ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "active", "createdById", "updatedById", "updatedAt")
       SELECT $1 || '-' || g || '-' || value.kind, $2, $1 || '-' || g, value.kind::"CatalogItemPriceKind",
              'ORGANIZATION', value.amount, 'MXN', true, $3, $3, CURRENT_TIMESTAMP
         FROM generate_series(1, $4) AS g
        CROSS JOIN (VALUES ('SALE_PRICE', 10.00), ('PURCHASE_COST', 6.00)) AS value(kind, amount)`,
      [prefix, organizationId, staffId, count],
    )
    await setupClient.query('COMMIT')
    return itemIds
  } catch (error) {
    await setupClient.query('ROLLBACK')
    throw error
  }
}

/**
 * The first child mutation owns the parent version row. A second mutation must
 * remain blocked until the first transaction commits; only then may it run its
 * deferred aggregate check against the newly committed child set.
 */
async function expectReadCommittedDeleteSerialization(
  firstDelete: { sql: string; params: unknown[] },
  secondDelete: { sql: string; params: unknown[] },
): Promise<void> {
  const [first, second] = await twoClients()
  try {
    await Promise.all([first.query('BEGIN'), second.query('BEGIN')])
    await first.query(firstDelete.sql, firstDelete.params)

    let secondSettled = false
    const secondMutation = second.query(secondDelete.sql, secondDelete.params).finally(() => {
      secondSettled = true
    })
    await delay(75)
    expect(secondSettled).toBe(false)

    await first.query('COMMIT')
    await secondMutation
    await expect(second.query('COMMIT')).rejects.toMatchObject({
      code: '23514',
      constraint: 'CatalogItem_relational_baseline_check',
    })
  } finally {
    await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')])
    await Promise.all([first.end(), second.end()])
  }
}

describe('H1A aggregate invariant concurrency', () => {
  beforeAll(async () => {
    fixtureKey = `${process.pid}-${Date.now()}`
    setupClient = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await setupClient.connect()
    const organization = await setupClient.query<{ id: string }>(
      `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
       VALUES ($1, $2, $3, '5500000000', CURRENT_TIMESTAMP) RETURNING id`,
      [`h1a-concurrency-org-${fixtureKey}`, `H1A concurrency ${fixtureKey}`, `h1a-concurrency-${fixtureKey}@example.test`],
    )
    organizationId = organization.rows[0].id
    const staff = await setupClient.query<{ id: string }>(
      `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
       VALUES ($1, $2, 'H1A', 'Concurrency', CURRENT_TIMESTAMP) RETURNING id`,
      [`h1a-concurrency-staff-${fixtureKey}`, `h1a-concurrency-staff-${fixtureKey}@example.test`],
    )
    staffId = staff.rows[0].id
    const checker = await setupClient.query<{ id: string }>(
      `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
       VALUES ($1, $2, 'H1A', 'Concurrency checker', CURRENT_TIMESTAMP) RETURNING id`,
      [`h1a-concurrency-checker-${fixtureKey}`, `h1a-concurrency-checker-${fixtureKey}@example.test`],
    )
    checkerStaffId = checker.rows[0].id
  })

  afterAll(async () => {
    if (setupClient) {
      try {
        await setupClient.query(`DELETE FROM "Venue" WHERE "organizationId" = $1`, [organizationId])
        await setupClient.query(`DELETE FROM "Organization" WHERE "id" = $1`, [organizationId])
        await setupClient.query(`DELETE FROM "Staff" WHERE "id" = ANY($1::text[])`, [[staffId, checkerStaffId]])
      } finally {
        await setupClient.end()
      }
    }
  })

  it('installs the parent version and immediate child serialization triggers', async () => {
    const column = await setupClient.query<{ column_default: string; data_type: string }>(`
      SELECT column_default, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'CatalogItem' AND column_name = 'invariantVersion'
    `)
    expect(column.rows).toEqual([{ column_default: '0', data_type: 'bigint' }])

    const triggers = await setupClient.query<{ name: string; deferred: boolean; statement: boolean }>(`
      SELECT tgname AS name, tgdeferrable AS deferred, (tgtype & 1) = 0 AS statement
        FROM pg_trigger
       WHERE tgname IN (
         'CatalogIdentifier_invariant_version_insert_trigger',
         'CatalogIdentifier_invariant_version_update_trigger',
         'CatalogIdentifier_invariant_version_delete_trigger',
         'CatalogItemBusinessType_invariant_version_insert_trigger',
         'CatalogItemBusinessType_invariant_version_update_trigger',
         'CatalogItemBusinessType_invariant_version_delete_trigger',
         'CatalogItemPrice_invariant_version_insert_trigger',
         'CatalogItemPrice_invariant_version_update_trigger',
         'CatalogItemPrice_invariant_version_delete_trigger'
       )
       ORDER BY tgname
    `)
    expect(triggers.rows).toEqual(
      ['CatalogIdentifier', 'CatalogItemBusinessType', 'CatalogItemPrice'].flatMap(table =>
        ['delete', 'insert', 'update'].map(event => ({
          name: `${table}_invariant_version_${event}_trigger`,
          deferred: false,
          statement: true,
        })),
      ),
    )

    const decisionColumn = await setupClient.query<{ column_default: string; data_type: string }>(`
      SELECT column_default, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'CatalogPublicationLine'
         AND column_name = 'decisionInvariantVersion'
    `)
    expect(decisionColumn.rows).toEqual([{ column_default: '0', data_type: 'bigint' }])

    const decisionTrigger = await setupClient.query<{ name: string; deferred: boolean; statement: boolean }>(`
      SELECT tgname AS name, tgdeferrable AS deferred, (tgtype & 1) = 0 AS statement
        FROM pg_trigger
       WHERE tgname IN (
         'CatalogPublicationDecision_invariant_version_insert_trigger',
         'CatalogPublicationDecision_invariant_version_update_trigger',
         'CatalogPublicationDecision_invariant_version_delete_trigger'
       )
       ORDER BY tgname
    `)
    expect(decisionTrigger.rows).toEqual(
      ['delete', 'insert', 'update'].map(event => ({
        name: `CatalogPublicationDecision_invariant_version_${event}_trigger`,
        deferred: false,
        statement: true,
      })),
    )
  })

  it('serializes REPEATABLE READ APPLIED against a concurrent field-decision delete', async () => {
    const itemId = `h1a-decision-race-item-${fixtureKey}`
    const venueId = `h1a-decision-race-venue-${fixtureKey}`
    const categoryId = `h1a-decision-race-category-${fixtureKey}`
    const productId = `h1a-decision-race-product-${fixtureKey}`
    const bindingId = `h1a-decision-race-binding-${fixtureKey}`
    const batchId = `h1a-decision-race-batch-${fixtureKey}`
    const lineId = `h1a-decision-race-line-${fixtureKey}`
    const decisionId = `h1a-decision-race-decision-${fixtureKey}`

    await setupClient.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'Decision race venue', $3, CURRENT_TIMESTAMP)`,
      [venueId, organizationId, `h1a-decision-race-${fixtureKey}`],
    )
    await setupClient.query(
      `INSERT INTO "MenuCategory" ("id", "venueId", "name", "slug", "availableDays", "updatedAt")
       VALUES ($1, $2, 'Decision race', $3, ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [categoryId, venueId, `h1a-decision-race-category-${fixtureKey}`],
    )
    await setupClient.query(
      `INSERT INTO "Product"
        ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
       VALUES ($1, $2, $3, $1, 'Decision race', 10.00, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [productId, venueId, categoryId],
    )
    await createCompleteItem(itemId)
    await setupClient.query(
      `INSERT INTO "CatalogVenueBinding"
        ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
      [bindingId, organizationId, itemId, venueId, productId, staffId],
    )
    await setupClient.query(
      `INSERT INTO "CatalogPublicationBatch"
        ("id", "organizationId", "operation", "state", "schemaVersion", "requestHash", "requestHashVersion",
         "targetHash", "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'CATALOG_PUBLICATION', 'PREVIEWED', 1, $3, 1, $4, $5,
               CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb, 'HUMAN', $6, CURRENT_TIMESTAMP)`,
      [batchId, organizationId, sha256(`request-${batchId}`), sha256(`target-${batchId}`), sha256(`token-${batchId}`), staffId],
    )
    await setupClient.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
         "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['name'], 1, 'PUBLICATION', 1, $8, 1, CURRENT_TIMESTAMP)`,
      [lineId, organizationId, batchId, bindingId, itemId, venueId, productId, sha256(`canonical-${lineId}`)],
    )
    await setupClient.query(
      `INSERT INTO "CatalogPublicationFieldDecision"
        ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
       VALUES ($1, $2, $3, $4, 'name', 'PUBLISH_CORPORATE', '"old"'::jsonb, '"new"'::jsonb, '"new"'::jsonb, CURRENT_TIMESTAMP)`,
      [decisionId, organizationId, lineId, bindingId],
    )

    const [applier, decisionWriter] = await twoClients()
    try {
      await Promise.all([
        applier.query('BEGIN ISOLATION LEVEL REPEATABLE READ'),
        decisionWriter.query('BEGIN ISOLATION LEVEL REPEATABLE READ'),
      ])
      await applier.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [lineId])
      let deleteSettled = false
      const decisionDelete = decisionWriter
        .query(`DELETE FROM "CatalogPublicationFieldDecision" WHERE id = $1`, [decisionId])
        .then(() => null, databaseError)
        .finally(() => {
          deleteSettled = true
        })
      await delay(75)
      expect(deleteSettled).toBe(false)

      await applier.query('COMMIT')
      expect(await decisionDelete).toMatchObject({ code: '40001' })
    } finally {
      await Promise.allSettled([applier.query('ROLLBACK'), decisionWriter.query('ROLLBACK')])
      await Promise.all([applier.end(), decisionWriter.end()])
    }

    const durable = await setupClient.query<{ status: string; decisions: number }>(
      `SELECT line.status, COUNT(decision.id)::int AS decisions
         FROM "CatalogPublicationLine" line
         LEFT JOIN "CatalogPublicationFieldDecision" decision ON decision."lineId" = line.id
        WHERE line.id = $1
        GROUP BY line.status`,
      [lineId],
    )
    expect(durable.rows).toEqual([{ status: 'APPLIED', decisions: 1 }])
  })

  it('rechecks an APPLIED transition after a READ COMMITTED decision writer commits first', async () => {
    const { lineId, decisionId } = await createPublicationDecisionFixture('read-committed-writer-first')
    const [decisionWriter, applier] = await twoClients()
    try {
      await Promise.all([decisionWriter.query('BEGIN'), applier.query('BEGIN')])
      await decisionWriter.query(`DELETE FROM "CatalogPublicationFieldDecision" WHERE id = $1`, [decisionId])

      let applySettled = false
      const apply = applier.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [lineId]).finally(() => {
        applySettled = true
      })
      await delay(75)
      expect(applySettled).toBe(false)

      await decisionWriter.query('COMMIT')
      await apply
      await expect(applier.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogPublicationLine_applied_decisions_check',
      })
    } finally {
      await Promise.allSettled([decisionWriter.query('ROLLBACK'), applier.query('ROLLBACK')])
      await Promise.all([decisionWriter.end(), applier.end()])
    }

    const durable = await setupClient.query<{ status: string; decisions: number }>(
      `SELECT line.status, COUNT(decision.id)::int AS decisions
         FROM "CatalogPublicationLine" line
         LEFT JOIN "CatalogPublicationFieldDecision" decision ON decision."lineId" = line.id
        WHERE line.id = $1
        GROUP BY line.status`,
      [lineId],
    )
    expect(durable.rows).toEqual([{ status: 'READY', decisions: 0 }])
  })

  it('serializes REQUESTED and APPROVED override partial-unique races', async () => {
    const itemId = `h1a-override-race-item-${fixtureKey}`
    const venueId = `h1a-override-race-venue-${fixtureKey}`
    const categoryId = `h1a-override-race-category-${fixtureKey}`
    const productId = `h1a-override-race-product-${fixtureKey}`
    const bindingId = `h1a-override-race-binding-${fixtureKey}`
    await setupClient.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'Override race venue', $3, CURRENT_TIMESTAMP)`,
      [venueId, organizationId, `h1a-override-race-${fixtureKey}`],
    )
    await setupClient.query(
      `INSERT INTO "MenuCategory" ("id", "venueId", "name", "slug", "availableDays", "updatedAt")
       VALUES ($1, $2, 'Override race', $3, ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [categoryId, venueId, `h1a-override-race-category-${fixtureKey}`],
    )
    await setupClient.query(
      `INSERT INTO "Product"
        ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
       VALUES ($1, $2, $3, $1, 'Override race', 10.00, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [productId, venueId, categoryId],
    )
    await createCompleteItem(itemId)
    await setupClient.query(
      `INSERT INTO "CatalogVenueBinding"
        ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
      [bindingId, organizationId, itemId, venueId, productId, staffId],
    )

    const batchIds = Array.from({ length: 4 }, (_, index) => `h1a-override-race-batch-${index}-${fixtureKey}`)
    for (const batchId of batchIds) {
      await setupClient.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "state", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_OVERRIDE_REQUEST', $1, $3, 'NOT_STARTED', 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [batchId, organizationId, sha256(`request-${batchId}`), staffId],
      )
    }

    const [firstRequester, secondRequester] = await twoClients()
    try {
      await Promise.all([firstRequester.query('BEGIN'), secondRequester.query('BEGIN')])
      await firstRequester.query(
        `INSERT INTO "CatalogVenueOverride"
          ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
           "requestBatchId", "requestedById", "requestedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'description', '"first"'::jsonb, 'First request', 'REQUESTED', $5, $6,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`h1a-override-race-requested-a-${fixtureKey}`, organizationId, bindingId, venueId, batchIds[0], staffId],
      )
      let requestSettled = false
      const competingRequest = secondRequester
        .query(
          `INSERT INTO "CatalogVenueOverride"
            ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
             "requestBatchId", "requestedById", "requestedAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'description', '"second"'::jsonb, 'Second request', 'REQUESTED', $5, $6,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [`h1a-override-race-requested-b-${fixtureKey}`, organizationId, bindingId, venueId, batchIds[1], staffId],
        )
        .finally(() => {
          requestSettled = true
        })
      await delay(75)
      expect(requestSettled).toBe(false)
      await firstRequester.query('COMMIT')
      await expect(competingRequest).rejects.toMatchObject({
        code: '23505',
        constraint: 'CatalogVenueOverride_one_requested_field_key',
      })
    } finally {
      await Promise.allSettled([firstRequester.query('ROLLBACK'), secondRequester.query('ROLLBACK')])
      await Promise.all([firstRequester.end(), secondRequester.end()])
    }

    const approvalIds = [`h1a-override-race-approved-a-${fixtureKey}`, `h1a-override-race-approved-b-${fixtureKey}`]
    for (const approvalId of approvalIds) {
      await setupClient.query(
        `INSERT INTO "CatalogVenueOverride"
          ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'name', '"local"'::jsonb, 'Detected approval race', 'DETECTED', CURRENT_TIMESTAMP)`,
        [approvalId, organizationId, bindingId, venueId],
      )
    }

    const [firstApprover, secondApprover] = await twoClients()
    try {
      await Promise.all([firstApprover.query('BEGIN'), secondApprover.query('BEGIN')])
      await firstApprover.query(
        `UPDATE "CatalogVenueOverride"
            SET status = 'REQUESTED', "requestBatchId" = $2, "requestedById" = $3,
                "requestedAt" = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [approvalIds[0], batchIds[2], staffId],
      )
      await firstApprover.query(
        `UPDATE "CatalogVenueOverride"
            SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [approvalIds[0], checkerStaffId],
      )
      let requestTransitionSettled = false
      const competingRequestTransition = secondApprover
        .query(
          `UPDATE "CatalogVenueOverride"
              SET status = 'REQUESTED', "requestBatchId" = $2, "requestedById" = $3,
                  "requestedAt" = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [approvalIds[1], batchIds[3], staffId],
        )
        .finally(() => {
          requestTransitionSettled = true
        })
      await delay(75)
      expect(requestTransitionSettled).toBe(false)
      await firstApprover.query('COMMIT')
      await competingRequestTransition
      await expect(
        secondApprover.query(
          `UPDATE "CatalogVenueOverride"
              SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [approvalIds[1], checkerStaffId],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'CatalogVenueOverride_one_approved_field_key',
      })
    } finally {
      await Promise.allSettled([firstApprover.query('ROLLBACK'), secondApprover.query('ROLLBACK')])
      await Promise.all([firstApprover.end(), secondApprover.end()])
    }
  })

  it('serializes concurrent removal of the last two business types in READ COMMITTED', async () => {
    const itemId = `h1a-concurrency-business-${fixtureKey}`
    await createCompleteItem(itemId, { businessTypes: ['RETAIL_STORE', 'CONVENIENCE_STORE'] })

    await expectReadCommittedDeleteSerialization(
      { sql: `DELETE FROM "CatalogItemBusinessType" WHERE "id" = $1`, params: [`${itemId}-business-0`] },
      { sql: `DELETE FROM "CatalogItemBusinessType" WHERE "id" = $1`, params: [`${itemId}-business-1`] },
    )

    const remaining = await setupClient.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "CatalogItemBusinessType" WHERE "catalogItemId" = $1`,
      [itemId],
    )
    expect(remaining.rows[0].count).toBe(1)
  })

  it('locks overlapping bulk aggregates in global ID order without a deadlock', async () => {
    const firstItemId = `h1a-concurrency-order-a-${fixtureKey}`
    const secondItemId = `h1a-concurrency-order-b-${fixtureKey}`
    await createCompleteItem(firstItemId, { businessTypes: ['RETAIL_STORE', 'CONVENIENCE_STORE'] })
    await createCompleteItem(secondItemId, { businessTypes: ['RETAIL_STORE', 'CONVENIENCE_STORE'] })

    // Reinsert the second writer's disjoint child rows in B,A heap order. The
    // old row trigger could then take parent locks as A,B vs B,A and deadlock;
    // statement transition tables collect both parents before locking A,B.
    await setupClient.query('BEGIN')
    await setupClient.query(
      `DELETE FROM "CatalogItemBusinessType"
        WHERE id = ANY($1::text[])`,
      [[`${firstItemId}-business-1`, `${secondItemId}-business-1`]],
    )
    for (const itemId of [secondItemId, firstItemId]) {
      await setupClient.query(
        `INSERT INTO "CatalogItemBusinessType" ("id", "organizationId", "catalogItemId", "businessType")
         VALUES ($1, $2, $3, 'CONVENIENCE_STORE')`,
        [`${itemId}-business-1`, organizationId, itemId],
      )
    }
    await setupClient.query('COMMIT')

    const [firstWriter, secondWriter] = await twoClients()
    const firstBarrier = 810000000 + process.pid * 2
    const secondBarrier = firstBarrier + 1
    try {
      await setupClient.query('SELECT pg_advisory_lock($1), pg_advisory_lock($2)', [firstBarrier, secondBarrier])
      await Promise.all([firstWriter.query('BEGIN'), secondWriter.query('BEGIN')])
      for (const writer of [firstWriter, secondWriter]) {
        await writer.query(`SET LOCAL deadlock_timeout = '100ms'`)
        await writer.query('SET LOCAL enable_bitmapscan = off')
        await writer.query('SET LOCAL enable_indexscan = off')
      }

      const firstMutation = firstWriter
        .query(
          `UPDATE "CatalogItemBusinessType" child
              SET "businessType" = CASE
                    WHEN child."catalogItemId" = $2
                    THEN (SELECT child."businessType" FROM pg_advisory_lock($3))
                    ELSE child."businessType"
                  END
            WHERE child.id = ANY($1::text[])`,
          [[`${firstItemId}-business-0`, `${secondItemId}-business-0`], secondItemId, firstBarrier],
        )
        .then(
          () => ({ writer: 'first' as const, error: null }),
          error => ({ writer: 'first' as const, error: databaseError(error) }),
        )
      const secondMutation = secondWriter
        .query(
          `UPDATE "CatalogItemBusinessType" child
              SET "businessType" = CASE
                    WHEN child."catalogItemId" = $2
                    THEN (SELECT child."businessType" FROM pg_advisory_lock($3))
                    ELSE child."businessType"
                  END
            WHERE child.id = ANY($1::text[])`,
          [[`${firstItemId}-business-1`, `${secondItemId}-business-1`], firstItemId, secondBarrier],
        )
        .then(
          () => ({ writer: 'second' as const, error: null }),
          error => ({ writer: 'second' as const, error: databaseError(error) }),
        )

      await delay(75)
      await setupClient.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($2)', [firstBarrier, secondBarrier])
      const firstSettled = await Promise.race([firstMutation, secondMutation])
      expect(firstSettled.error).toBeNull()
      await (firstSettled.writer === 'first' ? firstWriter : secondWriter).query('COMMIT')
      const secondSettled = await (firstSettled.writer === 'first' ? secondMutation : firstMutation)
      expect(secondSettled.error).toBeNull()
      await (secondSettled.writer === 'first' ? firstWriter : secondWriter).query('COMMIT')
    } finally {
      await setupClient.query('SELECT pg_advisory_unlock($1), pg_advisory_unlock($2)', [firstBarrier, secondBarrier])
      await Promise.allSettled([firstWriter.query('ROLLBACK'), secondWriter.query('ROLLBACK')])
      await Promise.all([firstWriter.end(), secondWriter.end()])
    }

    const complete = await setupClient.query<{ catalogItemId: string; count: number }>(
      `SELECT "catalogItemId", COUNT(*)::int AS count
         FROM "CatalogItemBusinessType"
        WHERE "catalogItemId" = ANY($1::text[])
        GROUP BY "catalogItemId"
        ORDER BY "catalogItemId"`,
      [[firstItemId, secondItemId]],
    )
    expect(complete.rows).toEqual([
      { catalogItemId: firstItemId, count: 2 },
      { catalogItemId: secondItemId, count: 2 },
    ])
  })

  it('serializes concurrent removal of the last two same-currency price pairs', async () => {
    const itemId = `h1a-concurrency-price-${fixtureKey}`
    await createCompleteItem(itemId, { currencies: ['MXN', 'USD'] })

    await expectReadCommittedDeleteSerialization(
      { sql: `DELETE FROM "CatalogItemPrice" WHERE "catalogItemId" = $1 AND "currency" = 'MXN'`, params: [itemId] },
      { sql: `DELETE FROM "CatalogItemPrice" WHERE "catalogItemId" = $1 AND "currency" = 'USD'`, params: [itemId] },
    )

    const pairs = await setupClient.query<{ currency: string }>(
      `SELECT currency FROM "CatalogItemPrice" WHERE "catalogItemId" = $1 AND active GROUP BY currency HAVING COUNT(*) = 2`,
      [itemId],
    )
    expect(pairs.rows).toHaveLength(1)
  })

  it('turns the second REPEATABLE READ child writer into a serialization failure', async () => {
    const itemId = `h1a-concurrency-repeatable-${fixtureKey}`
    await createCompleteItem(itemId, { businessTypes: ['RETAIL_STORE', 'CONVENIENCE_STORE'] })
    const [first, second] = await twoClients()
    try {
      await Promise.all([first.query('BEGIN ISOLATION LEVEL REPEATABLE READ'), second.query('BEGIN ISOLATION LEVEL REPEATABLE READ')])
      await first.query(`DELETE FROM "CatalogItemBusinessType" WHERE "id" = $1`, [`${itemId}-business-0`])
      // Attach the rejection branch before the writer blocks so Node never
      // reports the expected 40001 as an unhandled promise between assertions.
      const secondMutation = second
        .query(`DELETE FROM "CatalogItemBusinessType" WHERE "id" = $1`, [`${itemId}-business-1`])
        .then(() => null, databaseError)
      await delay(75)
      await first.query('COMMIT')
      expect(await secondMutation).toMatchObject({ code: '40001' })
    } finally {
      await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')])
      await Promise.all([first.end(), second.end()])
    }
  })

  it('serializes corporate-SKU removal against a direct CatalogItem rewrite', async () => {
    const itemId = `h1a-concurrency-sku-${fixtureKey}`
    await createCompleteItem(itemId)
    const [first, second] = await twoClients()
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')])
      await first.query(`DELETE FROM "CatalogIdentifier" WHERE "catalogItemId" = $1`, [itemId])
      let rewriteSettled = false
      const rewrite = second
        .query(`UPDATE "CatalogItem" SET "normalizedSku" = "normalizedSku" || '-NEW' WHERE "id" = $1`, [itemId])
        .finally(() => {
          rewriteSettled = true
        })
      await delay(75)
      expect(rewriteSettled).toBe(false)

      await expect(first.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogItem_corporate_sku_projection_check',
      })
      await rewrite
      await expect(second.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogItem_corporate_sku_projection_check',
      })
    } finally {
      await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')])
      await Promise.all([first.end(), second.end()])
    }

    const projection = await setupClient.query<{ item_code: string; identifier_code: string }>(
      `SELECT item."normalizedSku" AS item_code, identifier."normalizedCode" AS identifier_code
         FROM "CatalogItem" item JOIN "CatalogIdentifier" identifier ON identifier."catalogItemId" = item.id
        WHERE item.id = $1`,
      [itemId],
    )
    expect(projection.rows[0].item_code).toBe(projection.rows[0].identifier_code)
  })

  it('locks a classified ActivityLog venue against a concurrent Venue delete', async () => {
    const venueId = `h1a-activity-race-venue-${fixtureKey}`
    await setupClient.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'Activity race venue', $3, CURRENT_TIMESTAMP)`,
      [venueId, organizationId, `h1a-activity-race-${fixtureKey}`],
    )
    const [deleter, writer] = await twoClients()
    try {
      await Promise.all([deleter.query('BEGIN'), writer.query('BEGIN')])
      await deleter.query(`DELETE FROM "Venue" WHERE id = $1`, [venueId])
      let insertSettled = false
      const insert = writer
        .query(
          `INSERT INTO "ActivityLog"
            ("id", "organizationId", "venueId", "action", "actorType", "staffId", "actorStaffId")
           VALUES ($1, $2, $3, 'H1A_ACTIVITY_VENUE_RACE', 'HUMAN', $4, $4)`,
          [`h1a-activity-race-${fixtureKey}`, organizationId, venueId, staffId],
        )
        .finally(() => {
          insertSettled = true
        })
      // Attach the rejection matcher in the SAME tick `insert` is created — not
      // after the `delay(75)` / `deleter.query('COMMIT')` awaits below. `.finally()`
      // above observes the ORIGINAL query promise, but `insert` itself (the promise
      // `.finally()` returns) still has no handler until `.rejects` attaches to it.
      // `deleter.query('COMMIT')` releases the trigger's `FOR KEY SHARE` lock on a
      // DIFFERENT pg connection than `insert`'s; whether Node observes "COMMIT
      // resolved" before or after "insert's blocked trigger unblocked and rejected"
      // is a genuine, unordered race between two independent socket callbacks. If
      // `insert` rejects before this file reaches a `.rejects` call, jest-circus's
      // unhandled-rejection detector fails the test with the raw trigger error —
      // even though the assertion below would otherwise have passed. Same pattern
      // (and same underlying race) as `rejectionAssertion` in
      // liveDemoCleanupConcurrency.integration.test.ts, and as `insertionAssertion`
      // in staffProvenanceDeletionConcurrency.integration.test.ts:113.
      const insertRejection = expect(insert).rejects.toMatchObject({
        code: '23514',
        constraint: 'ActivityLog_venue_organization_check',
      })
      await delay(75)
      expect(insertSettled).toBe(false)

      await deleter.query('COMMIT')
      await insertRejection
    } finally {
      await Promise.allSettled([deleter.query('ROLLBACK'), writer.query('ROLLBACK')])
      await Promise.all([deleter.end(), writer.end()])
    }
  })

  it('keeps parent deletion legal and baseline lookups index-backed for bulk assembly', async () => {
    const bulkStartedAt = Date.now()
    const itemIds = await createBulkItems(`h1a-concurrency-bulk-${fixtureKey}`, 250)
    const bulkDurationMs = Date.now() - bulkStartedAt
    console.info(`H1A bulk invariant assembly: ${itemIds.length} aggregates in ${bulkDurationMs}ms`)

    const plan = await setupClient.query<{ 'QUERY PLAN': Array<Record<string, unknown>> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT 1 FROM "CatalogItemPrice"
        WHERE "catalogItemId" = $1 AND "organizationId" = $2
          AND scope = 'ORGANIZATION' AND active AND kind IN ('SALE_PRICE', 'PURCHASE_COST')
        GROUP BY currency
       HAVING BOOL_OR(kind = 'SALE_PRICE') AND BOOL_OR(kind = 'PURCHASE_COST')`,
      [itemIds[0], organizationId],
    )
    const serializedPlan = JSON.stringify(plan.rows)
    expect(serializedPlan).toContain('Index Scan')
    expect(serializedPlan).not.toContain('Seq Scan')

    const leadingIndex = await setupClient.query<{ definition: string }>(`
      SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid
       WHERE pg_class.relname = 'CatalogItemPrice_item_org_active_kind_currency_idx'
    `)
    expect(leadingIndex.rows[0]?.definition).toContain('("catalogItemId", "organizationId", active, kind, currency)')

    const disposableOrg = `h1a-concurrency-cascade-org-${fixtureKey}`
    const disposableStaff = `h1a-concurrency-cascade-staff-${fixtureKey}`
    await setupClient.query(
      `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt") VALUES ($1, $1, $2, '5500000000', CURRENT_TIMESTAMP)`,
      [disposableOrg, `${disposableOrg}@example.test`],
    )
    await setupClient.query(
      `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt") VALUES ($1, $2, 'Cascade', 'Actor', CURRENT_TIMESTAMP)`,
      [disposableStaff, `${disposableStaff}@example.test`],
    )
    const originalOrg = organizationId
    const originalStaff = staffId
    organizationId = disposableOrg
    staffId = disposableStaff
    const disposableItem = `h1a-concurrency-cascade-item-${fixtureKey}`
    try {
      await createCompleteItem(disposableItem)
      await expect(setupClient.query(`DELETE FROM "Organization" WHERE id = $1`, [disposableOrg])).resolves.toBeDefined()
    } finally {
      organizationId = originalOrg
      staffId = originalStaff
      await setupClient.query(`DELETE FROM "Staff" WHERE id = $1`, [disposableStaff])
    }
  })
})

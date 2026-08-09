import { Client, type DatabaseError } from 'pg'
import { createHash } from 'node:crypto'

let client: Client
let fixtureKey: string
let organizationId: string
let venueId: string
let categoryId: string
let protectedProductId: string
let unprotectedProductId: string
let catalogItemId: string
let bindingId: string
let makerId: string
let checkerId: string
let approvedOverrideId: string
let publicationBatchId: string
let publicationLineId: string

const asDatabaseError = (error: unknown) => error as DatabaseError
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function insertCompleteCatalogItem(): Promise<void> {
  const brandId = `${catalogItemId}-brand`
  const manufacturerId = `${catalogItemId}-manufacturer`
  const familyId = `${catalogItemId}-family`
  const code = `LIFECYCLE-${fixtureKey}`
  await client.query('BEGIN')
  try {
    for (const [table, id, label] of [
      ['CatalogBrand', brandId, 'Lifecycle brand'],
      ['CatalogManufacturer', manufacturerId, 'Lifecycle manufacturer'],
      ['CatalogFamily', familyId, 'Lifecycle family'],
    ] as const) {
      await client.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "name", "normalizedName", "status", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, $1, 'ACTIVE', $4, $4, CURRENT_TIMESTAMP)`,
        [id, organizationId, label, makerId],
      )
    }
    await client.query(
      `INSERT INTO "CatalogItem"
        ("id", "organizationId", "sku", "normalizedSku", "kind", "name", "description", "imageUrl",
         "brandId", "manufacturerId", "familyId", "presentationLabel", "unit", "taxRate", "satProductKey",
         "satUnitKey", "objetoImp", "productType", "iepsMode", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $3, 'RETAIL_PRODUCT', 'Lifecycle item', 'Complete lifecycle item', 'https://example.test/lifecycle.png',
               $4, $5, $6, '1 piece', 'PIECE', 0.1600, '50161500', 'H87', '02', 'REGULAR', 'NONE', 'ACTIVE', $7, $7, CURRENT_TIMESTAMP)`,
      [catalogItemId, organizationId, code, brandId, manufacturerId, familyId, makerId],
    )
    await client.query(
      `INSERT INTO "CatalogIdentifier"
        ("id", "organizationId", "catalogItemId", "code", "normalizedCode", "type", "status", "createdById", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, 'CORPORATE_SKU', 'ACTIVE', $5, CURRENT_TIMESTAMP)`,
      [`${catalogItemId}-identifier`, organizationId, catalogItemId, code, makerId],
    )
    await client.query(
      `INSERT INTO "CatalogItemBusinessType" ("id", "organizationId", "catalogItemId", "businessType")
       VALUES ($1, $2, $3, 'RETAIL_STORE')`,
      [`${catalogItemId}-business`, organizationId, catalogItemId],
    )
    for (const [kind, amount] of [
      ['SALE_PRICE', '10.00'],
      ['PURCHASE_COST', '6.00'],
    ] as const) {
      await client.query(
        `INSERT INTO "CatalogItemPrice"
          ("id", "organizationId", "catalogItemId", "kind", "scope", "amount", "currency", "active", "createdById", "updatedById", "updatedAt")
         VALUES ($1, $2, $3, $4, 'ORGANIZATION', $5, 'MXN', true, $6, $6, CURRENT_TIMESTAMP)`,
        [`${catalogItemId}-${kind}`, organizationId, catalogItemId, kind, amount, makerId],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function insertIdempotencyRecord(id: string, operation: string, ownerOrganizationId = organizationId): Promise<void> {
  await client.query(
    `INSERT INTO "CatalogIdempotencyRecord"
      ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "requestHashVersion",
       "state", "actorType", "staffId", "updatedAt")
     VALUES ($1, $2, $3, $1, $4, 1, 'NOT_STARTED', 'HUMAN', $5, CURRENT_TIMESTAMP)`,
    [id, ownerOrganizationId, operation, sha256(`request-${id}`), makerId],
  )
}

async function insertPublicationBatch(id: string): Promise<void> {
  await client.query(
    `INSERT INTO "CatalogPublicationBatch"
      ("id", "organizationId", "operation", "state", "schemaVersion", "requestHash", "requestHashVersion",
       "targetHash", "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
     VALUES ($1, $2, 'CATALOG_PUBLICATION', 'PREVIEWED', 1, $3, 1, $4, $5,
             CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb, 'HUMAN', $6, CURRENT_TIMESTAMP)`,
    [id, organizationId, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`), makerId],
  )
}

describe('H1A deletion and lifecycle invariants', () => {
  beforeAll(async () => {
    fixtureKey = `${process.pid}-${Date.now()}`
    organizationId = `h1a-lifecycle-org-${fixtureKey}`
    venueId = `h1a-lifecycle-venue-${fixtureKey}`
    categoryId = `h1a-lifecycle-category-${fixtureKey}`
    protectedProductId = `h1a-lifecycle-protected-${fixtureKey}`
    unprotectedProductId = `h1a-lifecycle-unprotected-${fixtureKey}`
    catalogItemId = `h1a-lifecycle-item-${fixtureKey}`
    bindingId = `h1a-lifecycle-binding-${fixtureKey}`
    makerId = `h1a-lifecycle-maker-${fixtureKey}`
    checkerId = `h1a-lifecycle-checker-${fixtureKey}`

    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query(
      `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
       VALUES ($1, $2, $3, '5500000000', CURRENT_TIMESTAMP)`,
      [organizationId, `H1A lifecycle ${fixtureKey}`, `h1a-lifecycle-${fixtureKey}@example.test`],
    )
    for (const [id, role] of [
      [makerId, 'maker'],
      [checkerId, 'checker'],
    ] as const) {
      await client.query(
        `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
         VALUES ($1, $2, 'H1A', $3, CURRENT_TIMESTAMP)`,
        [id, `h1a-lifecycle-${role}-${fixtureKey}@example.test`, role],
      )
    }
    await client.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'H1A lifecycle venue', $3, CURRENT_TIMESTAMP)`,
      [venueId, organizationId, `h1a-lifecycle-${fixtureKey}`],
    )
    await client.query(
      `INSERT INTO "MenuCategory" ("id", "venueId", "name", "slug", "availableDays", "updatedAt")
       VALUES ($1, $2, 'Lifecycle category', $3, ARRAY[]::text[], CURRENT_TIMESTAMP)`,
      [categoryId, venueId, `h1a-lifecycle-category-${fixtureKey}`],
    )
    for (const productId of [protectedProductId, unprotectedProductId]) {
      await client.query(
        `INSERT INTO "Product"
          ("id", "venueId", "categoryId", "sku", "name", "price", "tags", "allergens", "updatedAt")
         VALUES ($1, $2, $3, $1, $1, 10.00, ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP)`,
        [productId, venueId, categoryId],
      )
    }
    await insertCompleteCatalogItem()
    await client.query(
      `INSERT INTO "CatalogVenueBinding"
        ("id", "organizationId", "catalogItemId", "venueId", "productId", "status", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'LINKED', $6, $6, CURRENT_TIMESTAMP)`,
      [bindingId, organizationId, catalogItemId, venueId, protectedProductId, makerId],
    )
    await client.query(
      `INSERT INTO "CatalogVenueEventSequence" ("id", "organizationId", "venueId", "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [`h1a-lifecycle-sequence-${fixtureKey}`, organizationId, venueId],
    )
  })

  afterAll(async () => {
    if (!client) return
    try {
      // Venue owns the intentional purge path for venue-scoped history;
      // individual binding deletes remain protected once provenance exists.
      await client.query(`DELETE FROM "Venue" WHERE "organizationId" = $1`, [organizationId])
      await client.query(`DELETE FROM "CatalogItem" WHERE "organizationId" = $1`, [organizationId])
      await client.query(`DELETE FROM "Organization" WHERE "id" = $1`, [organizationId])
      await client.query(`DELETE FROM "Staff" WHERE "id" = ANY($1::text[])`, [[makerId, checkerId]])
    } finally {
      await client.end()
    }
  })

  it('installs CASCADE venue edges and deferred NO ACTION Product provenance edges', async () => {
    const constraints = await client.query<{
      conname: string
      delete_action: string
      deferrable: boolean
      deferred: boolean
    }>(`
      SELECT conname, confdeltype AS delete_action, condeferrable AS deferrable, condeferred AS deferred
        FROM pg_constraint
       WHERE conname IN (
         'CatalogVenueBinding_venue_tenant_fkey',
         'CatalogVenueBinding_product_venue_fkey',
         'CatalogBindingLine_venueId_organizationId_fkey',
         'CatalogBindingLine_productId_venueId_fkey',
         'CatalogPublicationLine_binding_tenant_fkey',
         'CatalogPublicationLine_venueId_organizationId_fkey',
         'CatalogPublicationLine_productId_venueId_fkey',
         'CatalogPublicationOutbox_venueId_organizationId_fkey',
         'CatalogVenueOverride_bindingId_organizationId_fkey',
         'CatalogVenueOverride_venueId_organizationId_fkey'
       )
       ORDER BY conname
    `)

    expect(constraints.rows).toEqual([
      { conname: 'CatalogBindingLine_productId_venueId_fkey', delete_action: 'a', deferrable: true, deferred: true },
      { conname: 'CatalogBindingLine_venueId_organizationId_fkey', delete_action: 'c', deferrable: false, deferred: false },
      { conname: 'CatalogPublicationLine_binding_tenant_fkey', delete_action: 'a', deferrable: true, deferred: true },
      { conname: 'CatalogPublicationLine_productId_venueId_fkey', delete_action: 'a', deferrable: true, deferred: true },
      { conname: 'CatalogPublicationLine_venueId_organizationId_fkey', delete_action: 'c', deferrable: false, deferred: false },
      { conname: 'CatalogPublicationOutbox_venueId_organizationId_fkey', delete_action: 'c', deferrable: false, deferred: false },
      { conname: 'CatalogVenueBinding_product_venue_fkey', delete_action: 'a', deferrable: true, deferred: true },
      { conname: 'CatalogVenueBinding_venue_tenant_fkey', delete_action: 'c', deferrable: false, deferred: false },
      { conname: 'CatalogVenueOverride_bindingId_organizationId_fkey', delete_action: 'a', deferrable: true, deferred: true },
      { conname: 'CatalogVenueOverride_venueId_organizationId_fkey', delete_action: 'c', deferrable: false, deferred: false },
    ])

    const lineageIndexes = await client.query<{ name: string; definition: string }>(`
      SELECT index_rel.relname AS name, pg_get_indexdef(pg_index.indexrelid) AS definition
        FROM pg_index
        JOIN pg_class index_rel ON index_rel.oid = pg_index.indexrelid
       WHERE index_rel.relname IN (
         'CatalogPublicationLine_supersedes_tenant_binding_idx',
         'CatalogPublicationLine_reverses_tenant_binding_idx'
       )
       ORDER BY index_rel.relname
    `)
    // RI triggers query READY as well as APPLIED lines, so their self-FKs need
    // full child-side indexes; partial applied-slot uniques cannot serve them.
    expect(lineageIndexes.rows).toEqual([
      {
        name: 'CatalogPublicationLine_reverses_tenant_binding_idx',
        definition:
          'CREATE INDEX "CatalogPublicationLine_reverses_tenant_binding_idx" ON public."CatalogPublicationLine" USING btree ("reversesLineId", "organizationId", "bindingId")',
      },
      {
        name: 'CatalogPublicationLine_supersedes_tenant_binding_idx',
        definition:
          'CREATE INDEX "CatalogPublicationLine_supersedes_tenant_binding_idx" ON public."CatalogPublicationLine" USING btree ("supersedesLineId", "organizationId", "bindingId")',
      },
    ])
  })

  it('enforces the governance fence as NULL-to-value write-once with exact replay', async () => {
    const governanceVenue = `h1a-governance-venue-${fixtureKey}`
    await client.query(
      `INSERT INTO "Venue" ("id", "organizationId", "name", "slug", "updatedAt")
       VALUES ($1, $2, 'Governance venue', $3, CURRENT_TIMESTAMP)`,
      [governanceVenue, organizationId, `h1a-governance-${fixtureKey}`],
    )
    const first = new Date('2026-08-08T12:00:00.000Z')

    await expect(
      client.query(`UPDATE "Venue" SET "catalogGovernanceEnforcedAt" = NULL WHERE id = $1`, [governanceVenue]),
    ).resolves.toBeDefined()
    await expect(
      client.query(`UPDATE "Venue" SET "catalogGovernanceEnforcedAt" = $2 WHERE id = $1`, [governanceVenue, first]),
    ).resolves.toBeDefined()
    await expect(
      client.query(`UPDATE "Venue" SET "catalogGovernanceEnforcedAt" = $2 WHERE id = $1`, [governanceVenue, first]),
    ).resolves.toBeDefined()

    for (const invalid of [new Date('2026-08-08T12:00:01.000Z'), new Date('2026-08-08T11:59:59.000Z'), null]) {
      await expect(
        client.query(`UPDATE "Venue" SET "catalogGovernanceEnforcedAt" = $2 WHERE id = $1`, [governanceVenue, invalid]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'Venue_catalogGovernanceEnforcedAt_write_once_check',
      })
    }
  })

  it('retains classified H1 actors but lets legacy-only Staff hard-delete and null the old FK', async () => {
    const legacyStaff = `h1a-legacy-delete-staff-${fixtureKey}`
    const durableStaff = `h1a-durable-delete-staff-${fixtureKey}`
    for (const [id, label] of [
      [legacyStaff, 'legacy'],
      [durableStaff, 'durable'],
    ] as const) {
      await client.query(
        `INSERT INTO "Staff" ("id", "email", "firstName", "lastName", "updatedAt")
         VALUES ($1, $2, 'H1A', $3, CURRENT_TIMESTAMP)`,
        [id, `h1a-${label}-delete-${fixtureKey}@example.test`, label],
      )
    }
    const legacyLog = `h1a-legacy-delete-log-${fixtureKey}`
    await client.query(`INSERT INTO "ActivityLog" ("id", "staffId", "action") VALUES ($1, $2, 'LEGACY_UNCLASSIFIED')`, [
      legacyLog,
      legacyStaff,
    ])
    await client.query(`DELETE FROM "Staff" WHERE id = $1`, [legacyStaff])
    const nulled = await client.query<{ staffId: string | null }>(`SELECT "staffId" FROM "ActivityLog" WHERE id = $1`, [legacyLog])
    expect(nulled.rows).toEqual([{ staffId: null }])

    const durableLog = `h1a-durable-delete-log-${fixtureKey}`
    await client.query(
      `INSERT INTO "ActivityLog"
        ("id", "organizationId", "action", "actorType", "staffId", "actorStaffId")
       VALUES ($1, $2, 'H1A_DURABLE_HUMAN', 'HUMAN', $3, $3)`,
      [durableLog, organizationId, durableStaff],
    )
    await expect(client.query(`DELETE FROM "Staff" WHERE id = $1`, [durableStaff])).rejects.toMatchObject({
      code: '23503',
      constraint: 'ActivityLog_actorStaffId_fkey',
    })
    await expect(client.query(`UPDATE "ActivityLog" SET "actorType" = NULL WHERE id = $1`, [durableLog])).rejects.toMatchObject({
      code: '23514',
      constraint: 'ActivityLog_classified_actor_immutable_check',
    })
    await client.query(`DELETE FROM "ActivityLog" WHERE id = $1`, [durableLog])
    await client.query(`DELETE FROM "Staff" WHERE id = $1`, [durableStaff])
  })

  it('restricts Organization deletion for any populated audit attribution but preserves the pre-H1 null path', async () => {
    const attributedOrganizationId = `h1a-durable-org-delete-${fixtureKey}`
    const legacyOrganizationId = `h1a-legacy-org-delete-${fixtureKey}`
    for (const [id, label] of [
      [attributedOrganizationId, 'durable'],
      [legacyOrganizationId, 'legacy'],
    ] as const) {
      await client.query(
        `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
         VALUES ($1, $2, $3, '5500000000', CURRENT_TIMESTAMP)`,
        [id, `H1A ${label} organization delete`, `h1a-${label}-org-delete-${fixtureKey}@example.test`],
      )
    }

    const durableLogId = `h1a-durable-org-log-${fixtureKey}`
    const legacyLogId = `h1a-legacy-org-log-${fixtureKey}`
    await client.query(
      `INSERT INTO "ActivityLog" ("id", "organizationId", "action")
       VALUES ($1, $2, 'H1A_DURABLE_ORGANIZATION_ATTRIBUTION')`,
      [durableLogId, attributedOrganizationId],
    )
    await client.query(`INSERT INTO "ActivityLog" ("id", "action") VALUES ($1, 'LEGACY_UNCLASSIFIED_ORGANIZATION')`, [legacyLogId])

    await expect(client.query(`DELETE FROM "Organization" WHERE id = $1`, [attributedOrganizationId])).rejects.toMatchObject({
      code: '23503',
      constraint: 'ActivityLog_organizationId_fkey',
    })
    await expect(client.query(`UPDATE "ActivityLog" SET "organizationId" = NULL WHERE id = $1`, [durableLogId])).rejects.toMatchObject({
      code: '23514',
      constraint: 'ActivityLog_organization_immutable_check',
    })
    await expect(client.query(`DELETE FROM "Organization" WHERE id = $1`, [legacyOrganizationId])).resolves.toBeDefined()
    const legacyLog = await client.query<{ organizationId: string | null }>(`SELECT "organizationId" FROM "ActivityLog" WHERE id = $1`, [
      legacyLogId,
    ])
    expect(legacyLog.rows).toEqual([{ organizationId: null }])

    await client.query(`DELETE FROM "ActivityLog" WHERE id = ANY($1::text[])`, [[durableLogId, legacyLogId]])
    await client.query(`DELETE FROM "Organization" WHERE id = $1`, [attributedOrganizationId])
  })

  it('links override requests to the right operation and enforces ordered maker-checker lifecycle', async () => {
    const requestBatchId = `h1a-override-request-${fixtureKey}`
    const wrongOperationBatchId = `h1a-override-wrong-operation-${fixtureKey}`
    const replacementBatchId = `h1a-override-replacement-${fixtureKey}`
    const secondReplacementBatchId = `h1a-override-second-replacement-${fixtureKey}`
    await insertIdempotencyRecord(requestBatchId, 'CATALOG_OVERRIDE_REQUEST')
    await insertIdempotencyRecord(wrongOperationBatchId, 'CATALOG_IMPORT')
    await insertIdempotencyRecord(replacementBatchId, 'CATALOG_OVERRIDE_REQUEST')
    await insertIdempotencyRecord(secondReplacementBatchId, 'CATALOG_OVERRIDE_REQUEST')

    const foreignOrganizationId = `h1a-override-foreign-org-${fixtureKey}`
    const foreignBatchId = `h1a-override-foreign-batch-${fixtureKey}`
    await client.query(
      `INSERT INTO "Organization" ("id", "name", "email", "phone", "updatedAt")
       VALUES ($1, $1, $2, '5500000000', CURRENT_TIMESTAMP)`,
      [foreignOrganizationId, `${foreignOrganizationId}@example.test`],
    )
    await insertIdempotencyRecord(foreignBatchId, 'CATALOG_OVERRIDE_REQUEST', foreignOrganizationId)
    await expect(
      client.query(
        `INSERT INTO "CatalogVenueOverride"
          ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
           "requestBatchId", "requestedById", "requestedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'name', '"cross-tenant"'::jsonb, 'Cross tenant', 'REQUESTED', $5, $6,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`h1a-override-cross-tenant-${fixtureKey}`, organizationId, bindingId, venueId, foreignBatchId, makerId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'CatalogVenueOverride_request_batch_tenant_fkey',
    })
    await client.query(`DELETE FROM "Organization" WHERE id = $1`, [foreignOrganizationId])

    const detectedOverrideId = `h1a-override-detected-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', 'null'::jsonb, 'Detected local drift', 'DETECTED', CURRENT_TIMESTAMP)`,
      [detectedOverrideId, organizationId, bindingId, venueId],
    )
    await expect(
      client.query(
        `UPDATE "CatalogVenueOverride"
            SET status = 'REQUESTED', "requestBatchId" = $2, "requestedById" = $3
          WHERE id = $1`,
        [detectedOverrideId, requestBatchId, makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogVenueOverride_lifecycle_check' })

    const wrongOperation = await client
      .query(
        `INSERT INTO "CatalogVenueOverride"
          ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
           "requestBatchId", "requestedById", "requestedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'description', 'null'::jsonb, 'Captured JSON null', 'REQUESTED', $5, $6,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`h1a-override-wrong-op-${fixtureKey}`, organizationId, bindingId, venueId, wrongOperationBatchId, makerId],
      )
      .then(() => null, asDatabaseError)
    expect(wrongOperation).toMatchObject({
      code: '23514',
      constraint: 'CatalogVenueOverride_request_operation_check',
    })

    approvedOverrideId = `h1a-override-approved-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
         "requestBatchId", "requestedById", "requestedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', 'null'::jsonb, 'Keep local description', 'REQUESTED', $5, $6,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [approvedOverrideId, organizationId, bindingId, venueId, requestBatchId, makerId],
    )

    await expect(
      client.query(
        `INSERT INTO "CatalogVenueOverride"
          ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
           "requestBatchId", "requestedById", "requestedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'description', '"duplicate"'::jsonb, 'Duplicate', 'REQUESTED', $5, $6,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`h1a-override-duplicate-${fixtureKey}`, organizationId, bindingId, venueId, requestBatchId, makerId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'CatalogVenueOverride_one_requested_field_key' })

    await expect(
      client.query(
        `UPDATE "CatalogVenueOverride"
            SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [approvedOverrideId, makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogVenueOverride_lifecycle_check' })
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [approvedOverrideId, checkerId],
    )

    const replacementId = `h1a-override-approved-replacement-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
         "requestBatchId", "requestedById", "requestedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', '"new local"'::jsonb, 'Replacement', 'REQUESTED', $5, $6,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [replacementId, organizationId, bindingId, venueId, replacementBatchId, makerId],
    )
    await expect(
      client.query(
        `UPDATE "CatalogVenueOverride"
            SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [replacementId, checkerId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'CatalogVenueOverride_one_approved_field_key' })

    // Partial unique indexes are immediate, while the supersession target is
    // checked at COMMIT: lock, link/retire old approval, then approve replacement.
    await client.query('BEGIN')
    await client.query(`SELECT id FROM "CatalogVenueBinding" WHERE id = $1 FOR UPDATE`, [bindingId])
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'SUPERSEDED', "supersededByOverrideId" = $2, "supersededAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [approvedOverrideId, replacementId],
    )
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [replacementId, checkerId],
    )
    await client.query('COMMIT')

    const secondReplacementId = `h1a-override-second-approved-replacement-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
         "requestBatchId", "requestedById", "requestedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', '"newest local"'::jsonb, 'Second replacement', 'REQUESTED', $5, $6,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [secondReplacementId, organizationId, bindingId, venueId, secondReplacementBatchId, makerId],
    )
    await client.query('BEGIN')
    await client.query(`SELECT id FROM "CatalogVenueBinding" WHERE id = $1 FOR UPDATE`, [bindingId])
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'SUPERSEDED', "supersededByOverrideId" = $2, "supersededAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [replacementId, secondReplacementId],
    )
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [secondReplacementId, checkerId],
    )
    await client.query('COMMIT')
    approvedOverrideId = secondReplacementId

    await expect(
      client.query(`UPDATE "CatalogVenueOverride" SET "supersededByOverrideId" = $2 WHERE id = $1`, [
        `h1a-override-approved-${fixtureKey}`,
        secondReplacementId,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogVenueOverride_transition_check' })

    const states = await client.query<{ id: string; status: string; local_is_json_null: boolean }>(
      `SELECT id, status, "localValue" = 'null'::jsonb AS local_is_json_null
         FROM "CatalogVenueOverride" WHERE id = ANY($1::text[]) ORDER BY id`,
      [[`h1a-override-approved-${fixtureKey}`, replacementId, secondReplacementId]],
    )
    expect(states.rows).toEqual([
      { id: `h1a-override-approved-${fixtureKey}`, status: 'SUPERSEDED', local_is_json_null: true },
      { id: replacementId, status: 'SUPERSEDED', local_is_json_null: false },
      { id: secondReplacementId, status: 'APPROVED', local_is_json_null: false },
    ])
  })

  it('stores mixed field decisions and enforces exact APPLIED field provenance', async () => {
    publicationBatchId = `h1a-publication-batch-${fixtureKey}`
    publicationLineId = `h1a-publication-line-${fixtureKey}`
    await insertPublicationBatch(publicationBatchId)
    await client.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
         "before", "after", "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['name','description'], 1, 'PUBLICATION',
               1, $8, '{}'::jsonb, '{}'::jsonb, 1, CURRENT_TIMESTAMP)`,
      [
        publicationLineId,
        organizationId,
        publicationBatchId,
        bindingId,
        catalogItemId,
        venueId,
        protectedProductId,
        sha256(`canonical-${publicationLineId}`),
      ],
    )
    await client.query(
      `INSERT INTO "CatalogPublicationFieldDecision"
        ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
       VALUES ($1, $2, $3, $4, 'name', 'PUBLISH_CORPORATE', '"Old"'::jsonb, '"New"'::jsonb, '"New"'::jsonb, CURRENT_TIMESTAMP)`,
      [`${publicationLineId}-name`, organizationId, publicationLineId, bindingId],
    )
    await client.query(
      `INSERT INTO "CatalogPublicationFieldDecision"
        ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after",
         "overrideId", "reason", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', 'APPROVE_LOCAL_OVERRIDE', '"Local"'::jsonb, '"Corporate"'::jsonb,
               '"Local"'::jsonb, $5, 'Approved local value', CURRENT_TIMESTAMP)`,
      [`${publicationLineId}-description`, organizationId, publicationLineId, bindingId, approvedOverrideId],
    )
    await expect(
      client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [publicationLineId]),
    ).resolves.toBeDefined()

    const wrongFieldLine = `h1a-publication-wrong-field-${fixtureKey}`
    const wrongFieldBatch = `h1a-publication-wrong-field-batch-${fixtureKey}`
    await insertPublicationBatch(wrongFieldBatch)
    await client.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash", "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['price'], 1, 'PUBLICATION', 1, $8, 1, CURRENT_TIMESTAMP)`,
      [wrongFieldLine, organizationId, wrongFieldBatch, bindingId, catalogItemId, venueId, protectedProductId, sha256(wrongFieldLine)],
    )
    await expect(
      client.query(
        `INSERT INTO "CatalogPublicationFieldDecision"
          ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
         VALUES ($1, $2, $3, $4, E'\\t\\n', 'PUBLISH_CORPORATE', '"old"'::jsonb, '"new"'::jsonb,
                 '"new"'::jsonb, CURRENT_TIMESTAMP)`,
        [`${wrongFieldLine}-whitespace`, organizationId, wrongFieldLine, bindingId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationFieldDecision_nonempty_field_check' })
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO "CatalogPublicationFieldDecision"
          ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after",
           "overrideId", "reason", "updatedAt")
         VALUES ($1, $2, $3, $4, 'price', 'APPROVE_LOCAL_OVERRIDE', '10'::jsonb, '12'::jsonb, '10'::jsonb,
                 $5, 'Wrong-field provenance', CURRENT_TIMESTAMP)`,
        [`${wrongFieldLine}-price`, organizationId, wrongFieldLine, bindingId, approvedOverrideId],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogPublicationFieldDecision_approved_override_check',
      })
    } finally {
      await client.query('ROLLBACK')
    }

    for (const [label, fieldMask] of [
      ['missing', ['name', 'description']],
      ['duplicate', ['name', 'name']],
    ] as const) {
      const invalidBatchId = `h1a-publication-${label}-mask-batch-${fixtureKey}`
      const invalidLineId = `h1a-publication-${label}-mask-line-${fixtureKey}`
      await insertPublicationBatch(invalidBatchId)
      await client.query(
        `INSERT INTO "CatalogPublicationLine"
          ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
           "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
           "sourceCatalogRevision", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8::text[], 1, 'PUBLICATION', 1, $9, 1, CURRENT_TIMESTAMP)`,
        [
          invalidLineId,
          organizationId,
          invalidBatchId,
          bindingId,
          catalogItemId,
          venueId,
          protectedProductId,
          fieldMask,
          sha256(`canonical-${invalidLineId}`),
        ],
      )
      await client.query(
        `INSERT INTO "CatalogPublicationFieldDecision"
          ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
         VALUES ($1, $2, $3, $4, 'name', 'PUBLISH_CORPORATE', '"Old"'::jsonb, '"New"'::jsonb,
                 '"New"'::jsonb, CURRENT_TIMESTAMP)`,
        [`${invalidLineId}-name`, organizationId, invalidLineId, bindingId],
      )
      await expect(
        client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [invalidLineId]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogPublicationLine_applied_decisions_check',
      })
    }

    const emptyBatchId = `h1a-publication-empty-mask-batch-${fixtureKey}`
    const emptyLineId = `h1a-publication-empty-mask-line-${fixtureKey}`
    await insertPublicationBatch(emptyBatchId)
    await client.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
         "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY[]::text[], 1, 'PUBLICATION', 1, $8, 1,
               CURRENT_TIMESTAMP)`,
      [
        emptyLineId,
        organizationId,
        emptyBatchId,
        bindingId,
        catalogItemId,
        venueId,
        protectedProductId,
        sha256(`canonical-${emptyLineId}`),
      ],
    )
    await expect(client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [emptyLineId])).rejects.toMatchObject(
      {
        code: '23514',
        constraint: 'CatalogPublicationLine_applied_decisions_check',
      },
    )

    await client.query(
      `INSERT INTO "CatalogPublicationOutbox"
        ("id", "organizationId", "batchId", "venueId", "venueSequence", "eventKind", "payload", "dedupeKey", "updatedAt")
       VALUES ($1, $2, $3, $4, 1, 'CATALOG_PUBLICATION_APPLIED', '{}'::jsonb, $1, CURRENT_TIMESTAMP)`,
      [`h1a-publication-outbox-${fixtureKey}`, organizationId, publicationBatchId, venueId],
    )
  })

  it('rejects SQL NULL for Prisma-required catalog arrays', async () => {
    const profileId = `h1a-array-profile-${fixtureKey}`
    const batchId = `h1a-array-batch-${fixtureKey}`
    const lineId = `h1a-array-line-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogValidationProfile"
        ("id", "organizationId", "name", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $1, $3, $3, CURRENT_TIMESTAMP)`,
      [profileId, organizationId, makerId],
    )
    await insertPublicationBatch(batchId)
    await client.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
         "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY[]::text[], 1, 'PUBLICATION', 1, $8, 1,
               CURRENT_TIMESTAMP)`,
      [lineId, organizationId, batchId, bindingId, catalogItemId, venueId, protectedProductId, sha256(`canonical-${lineId}`)],
    )

    for (const [table, id, column] of [
      ['CatalogValidationProfile', profileId, 'requiredFields'],
      ['CatalogVenueBinding', bindingId, 'managedFieldMask'],
      ['CatalogPublicationLine', lineId, 'fieldMask'],
    ] as const) {
      await expect(client.query(`UPDATE "${table}" SET "${column}" = NULL WHERE id = $1`, [id])).rejects.toMatchObject({
        code: '23502',
        column,
      })
    }
  })

  it('keeps historical applied provenance but rejects a new decision against a superseded override', async () => {
    const replacementBatchId = `h1a-override-post-publication-batch-${fixtureKey}`
    const replacementId = `h1a-override-post-publication-${fixtureKey}`
    await insertIdempotencyRecord(replacementBatchId, 'CATALOG_OVERRIDE_REQUEST')
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
         "requestBatchId", "requestedById", "requestedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'description', '"post-publication local"'::jsonb, 'Replace after publication',
               'REQUESTED', $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [replacementId, organizationId, bindingId, venueId, replacementBatchId, makerId],
    )
    await client.query('BEGIN')
    await client.query(`SELECT id FROM "CatalogVenueBinding" WHERE id = $1 FOR UPDATE`, [bindingId])
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'SUPERSEDED', "supersededByOverrideId" = $2, "supersededAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [approvedOverrideId, replacementId],
    )
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'APPROVED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [replacementId, checkerId],
    )
    await client.query('COMMIT')

    const historical = await client.query<{ status: string; overrideId: string }>(
      `SELECT line.status, decision."overrideId"
         FROM "CatalogPublicationLine" line
         JOIN "CatalogPublicationFieldDecision" decision ON decision."lineId" = line.id
        WHERE line.id = $1 AND decision.field = 'description'`,
      [publicationLineId],
    )
    expect(historical.rows).toEqual([{ status: 'APPLIED', overrideId: approvedOverrideId }])

    const staleLineId = `h1a-publication-stale-override-${fixtureKey}`
    await insertPublicationBatch(`${staleLineId}-batch`)
    await client.query(
      `INSERT INTO "CatalogPublicationLine"
        ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
         "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
         "sourceCatalogRevision", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['description'], 1, 'PUBLICATION', 1, $8, 1,
               CURRENT_TIMESTAMP)`,
      [
        staleLineId,
        organizationId,
        `${staleLineId}-batch`,
        bindingId,
        catalogItemId,
        venueId,
        protectedProductId,
        sha256(`canonical-${staleLineId}`),
      ],
    )
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO "CatalogPublicationFieldDecision"
          ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after",
           "overrideId", "updatedAt")
         VALUES ($1, $2, $3, $4, 'description', 'APPROVE_LOCAL_OVERRIDE', '"old"'::jsonb, '"corporate"'::jsonb,
                 '"old"'::jsonb, $5, CURRENT_TIMESTAMP)`,
        [`${staleLineId}-description`, organizationId, staleLineId, bindingId, approvedOverrideId],
      )
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogPublicationFieldDecision_approved_override_check',
      })
    } finally {
      await client.query('ROLLBACK')
    }
    approvedOverrideId = replacementId
  })

  it('lets READY retries coexist but reserves applied supersession and reversal slots once', async () => {
    const insertLine = async (
      id: string,
      batchId: string,
      changeKind: 'PUBLICATION' | 'REVERSION',
      lineage: { supersedesLineId?: string; reversesLineId?: string },
    ): Promise<void> => {
      await insertPublicationBatch(batchId)
      await client.query(
        `INSERT INTO "CatalogPublicationLine"
          ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
           "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
           "sourceCatalogRevision", "supersedesLineId", "reversesLineId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY['name']::text[], 1, $8, 1, $9, 1, $10, $11,
                 CURRENT_TIMESTAMP)`,
        [
          id,
          organizationId,
          batchId,
          bindingId,
          catalogItemId,
          venueId,
          protectedProductId,
          changeKind,
          sha256(`canonical-${id}`),
          lineage.supersedesLineId ?? null,
          lineage.reversesLineId ?? null,
        ],
      )
      await client.query(
        `INSERT INTO "CatalogPublicationFieldDecision"
          ("id", "organizationId", "lineId", "bindingId", "field", "decision", "before", "proposed", "after", "updatedAt")
         VALUES ($1, $2, $3, $4, 'name', 'PUBLISH_CORPORATE', '"old"'::jsonb, '"new"'::jsonb,
                 '"new"'::jsonb, CURRENT_TIMESTAMP)`,
        [`${id}-name`, organizationId, id, bindingId],
      )
    }

    const successor = `h1a-publication-successor-${fixtureKey}`
    const successorRetry = `h1a-publication-successor-retry-${fixtureKey}`
    await insertLine(successor, `${successor}-batch`, 'PUBLICATION', { supersedesLineId: publicationLineId })
    await insertLine(successorRetry, `${successorRetry}-batch`, 'PUBLICATION', { supersedesLineId: publicationLineId })
    await client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [successor])
    await expect(
      client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [successorRetry]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'CatalogPublicationLine_one_applied_successor_key' })

    const reversal = `h1a-publication-reversal-${fixtureKey}`
    const reversalRetry = `h1a-publication-reversal-retry-${fixtureKey}`
    await insertLine(reversal, `${reversal}-batch`, 'REVERSION', {
      supersedesLineId: successor,
      reversesLineId: publicationLineId,
    })
    await client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [reversal])
    await insertLine(reversalRetry, `${reversalRetry}-batch`, 'REVERSION', {
      supersedesLineId: reversal,
      reversesLineId: publicationLineId,
    })
    await expect(
      client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [reversalRetry]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'CatalogPublicationLine_one_applied_reversal_key' })

    // Each REVERSION converges on the two preceding nodes. This is the graph
    // shape that made path-enumerating recursion exponential; reachability must
    // accept it without duplicating paths and still retain both lineage edges.
    const convergentLines: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const id = `h1a-publication-convergent-${index}-${fixtureKey}`
      if (index === 0) {
        await insertLine(id, `${id}-batch`, 'PUBLICATION', {})
      } else if (index === 1) {
        await insertLine(id, `${id}-batch`, 'PUBLICATION', { supersedesLineId: convergentLines[index - 1] })
      } else {
        await insertLine(id, `${id}-batch`, 'REVERSION', {
          supersedesLineId: convergentLines[index - 1],
          reversesLineId: convergentLines[index - 2],
        })
      }
      await client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = $1`, [id])
      convergentLines.push(id)
    }

    const cyclePublication = `h1a-publication-mixed-cycle-a-${fixtureKey}`
    const cycleReversion = `h1a-publication-mixed-cycle-b-${fixtureKey}`
    await client.query('BEGIN')
    try {
      await insertLine(cyclePublication, `${cyclePublication}-batch`, 'PUBLICATION', {
        supersedesLineId: cycleReversion,
      })
      await insertLine(cycleReversion, `${cycleReversion}-batch`, 'REVERSION', {
        supersedesLineId: convergentLines[convergentLines.length - 1],
        reversesLineId: cyclePublication,
      })
      await client.query(`UPDATE "CatalogPublicationLine" SET status = 'APPLIED' WHERE id = ANY($1::text[])`, [
        [cyclePublication, cycleReversion],
      ])
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: '23514',
        constraint: 'CatalogPublicationLine_lineage_cycle_check',
      })
    } finally {
      await client.query('ROLLBACK')
    }

    const selfLineage = `h1a-publication-self-lineage-${fixtureKey}`
    await insertPublicationBatch(`${selfLineage}-batch`)
    await expect(
      client.query(
        `INSERT INTO "CatalogPublicationLine"
          ("id", "organizationId", "batchId", "bindingId", "catalogItemId", "venueId", "productId", "status",
           "fieldMask", "decisionSchemaVersion", "changeKind", "hashVersion", "canonicalTargetHash",
           "sourceCatalogRevision", "supersedesLineId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', ARRAY[]::text[], 1, 'PUBLICATION', 1, $8, 1, $1,
                 CURRENT_TIMESTAMP)`,
        [
          selfLineage,
          organizationId,
          `${selfLineage}-batch`,
          bindingId,
          catalogItemId,
          venueId,
          protectedProductId,
          sha256(`canonical-${selfLineage}`),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationLine_lineage_shape_check' })
  })

  it.each([
    ['CatalogImportBatch', '', ''],
    ['CatalogBindingBatch', '', ''],
    ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"],
  ] as const)('rejects whitespace-only SERVICE principals on %s', async (table, extraColumns, extraValues) => {
    const id = `h1a-empty-service-${table}-${fixtureKey}`
    await expect(
      client.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
           "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "servicePrincipalId", "updatedAt"${extraColumns})
         VALUES ($1, $2, 'PREVIEWED', 1, $3, 1, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb,
                 'SERVICE', E'\\t\\n', CURRENT_TIMESTAMP${extraValues})`,
        [id, organizationId, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: `${table}_actor_identity_check` })
  })

  it.each([
    ['CatalogImportBatch', '', ''],
    ['CatalogBindingBatch', '', ''],
    ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"],
  ] as const)('rejects JSON-null dependency snapshots on %s', async (table, extraColumns, extraValues) => {
    const id = `h1a-json-null-dependencies-${table}-${fixtureKey}`
    await expect(
      client.query(
        `INSERT INTO "${table}"
          ("id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
           "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt"${extraColumns})
         VALUES ($1, $2, 'PREVIEWED', 1, $3, 1, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', 'null'::jsonb,
                 'HUMAN', $6, CURRENT_TIMESTAMP${extraValues})`,
        [id, organizationId, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: `${table}_preview_snapshot_check` })
  })

  it.each([
    ['CatalogImportBatch', '', ''],
    ['CatalogBindingBatch', '', ''],
    ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"],
  ] as const)('rejects residual leases and impossible terminal evidence on %s', async (table, extraColumns, extraValues) => {
    const commonColumns = `"id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion",
      "targetHash", "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt"`

    for (const [label, state, extraStateColumns, extraStateValues] of [
      [
        'preview-lease',
        'PREVIEWED',
        ', "attemptId", "leaseExpiresAt", "heartbeatAt"',
        ", 'stale-attempt', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP",
      ],
      ['applied-incomplete', 'APPLIED', ', "result", "appliedAt"', ", '{}'::jsonb, CURRENT_TIMESTAMP"],
      [
        'failed-result',
        'FAILED',
        ', "result", "failureCode", "failureMessage", "completedAt"',
        ", '{}'::jsonb, 'IMPORT_FAILED', 'fixture failure', CURRENT_TIMESTAMP",
      ],
      [
        'failed-whitespace-code',
        'FAILED',
        ', "failureCode", "failureMessage", "completedAt"',
        ", E'\\t\\n', 'fixture failure', CURRENT_TIMESTAMP",
      ],
    ] as const) {
      const id = `h1a-${label}-${table}-${fixtureKey}`
      await expect(
        client.query(
          `INSERT INTO "${table}" (${commonColumns}${extraStateColumns}${extraColumns})
           VALUES ($1, $2, $3::"CatalogOperationState", 1, $4, 1, $5, $6,
                   CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb, 'HUMAN', $7,
                   CURRENT_TIMESTAMP${extraStateValues}${extraValues})`,
          [id, organizationId, state, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`), makerId],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: `${table}_state_shape_check` })
    }
  })

  it('rejects malformed hashes and impossible CAS/outbox state shapes', async () => {
    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, 'NOT-A-SHA256', 'HUMAN', $3, CURRENT_TIMESTAMP)`,
        [`h1a-invalid-hash-${fixtureKey}`, organizationId, makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_hash_shape_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "state", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'APPLYING', 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`h1a-invalid-applying-${fixtureKey}`, organizationId, sha256('invalid-applying'), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_state_shape_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "actorType", "servicePrincipalId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'SERVICE', '', CURRENT_TIMESTAMP)`,
        [`h1a-empty-service-principal-${fixtureKey}`, organizationId, sha256('empty-service-principal')],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_actor_identity_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "resourceType", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'CatalogItem', 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`h1a-partial-resource-${fixtureKey}`, organizationId, sha256('partial-resource'), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_resource_reference_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "resourceType", "resourceId",
           "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, E'\\t\\n', E'\\t\\n', 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`h1a-whitespace-resource-${fixtureKey}`, organizationId, sha256('whitespace-resource'), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_resource_reference_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "state", "result", "completedAt",
           "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'APPLIED', 'null'::jsonb, CURRENT_TIMESTAMP,
                 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`h1a-json-null-result-${fixtureKey}`, organizationId, sha256('json-null-result'), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_state_shape_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "state", "targetHash",
           "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'PREVIEWED', $4, $5,
                 CURRENT_TIMESTAMP + INTERVAL '1 hour', 'null'::jsonb, 'HUMAN', $6, CURRENT_TIMESTAMP)`,
        [
          `h1a-json-null-dependencies-${fixtureKey}`,
          organizationId,
          sha256('json-null-dependencies-request'),
          sha256('json-null-dependencies-target'),
          sha256('json-null-dependencies-token'),
          makerId,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_preview_snapshot_check' })

    for (const [table, extraColumns, extraValues] of [
      ['CatalogImportBatch', '', ''],
      ['CatalogBindingBatch', '', ''],
      ['CatalogPublicationBatch', ', "operation"', ", 'CATALOG_PUBLICATION'"],
    ] as const) {
      const id = `h1a-blank-attempt-${table}-${fixtureKey}`
      await expect(
        client.query(
          `INSERT INTO "${table}"
            ("id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
             "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "attemptId", "leaseExpiresAt",
             "heartbeatAt", "updatedAt"${extraColumns})
           VALUES ($1, $2, 'APPLYING', 1, $3, 1, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb,
                   'HUMAN', $6, E'\\t\\n', CURRENT_TIMESTAMP + INTERVAL '30 minutes', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP${extraValues})`,
          [id, organizationId, sha256(`request-${id}`), sha256(`target-${id}`), sha256(`token-${id}`), makerId],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: `${table}_state_shape_check` })
    }

    await expect(
      client.query(
        `INSERT INTO "CatalogIdempotencyRecord"
          ("id", "organizationId", "operation", "idempotencyKey", "requestHash", "state", "result", "actorType", "staffId", "updatedAt")
         VALUES ($1, $2, 'CATALOG_IMPORT', $1, $3, 'APPLIED', '{}'::jsonb, 'HUMAN', $4, CURRENT_TIMESTAMP)`,
        [`h1a-invalid-applied-${fixtureKey}`, organizationId, sha256('invalid-applied'), makerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogIdempotencyRecord_state_shape_check' })

    await expect(
      client.query(
        `UPDATE "CatalogPublicationOutbox"
            SET status = 'DELIVERED', "deliveredAt" = CURRENT_TIMESTAMP,
                "claimedBy" = 'worker', "claimedAt" = CURRENT_TIMESTAMP,
                "claimExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
          WHERE id = $1`,
        [`h1a-publication-outbox-${fixtureKey}`],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationOutbox_state_shape_check' })

    await expect(
      client.query(
        `UPDATE "CatalogPublicationOutbox"
            SET "claimedBy" = E'\\t\\n', "claimedAt" = CURRENT_TIMESTAMP,
                "claimExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
          WHERE id = $1`,
        [`h1a-publication-outbox-${fixtureKey}`],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationOutbox_claim_tuple_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogPublicationOutbox"
          ("id", "organizationId", "batchId", "venueId", "venueSequence", "eventKind", "payload", "dedupeKey", "updatedAt")
         VALUES ($1, $2, $3, $4, 3, E'\\t\\n', '{}'::jsonb, E'\\t\\n', CURRENT_TIMESTAMP)`,
        [`h1a-publication-whitespace-identity-${fixtureKey}`, organizationId, publicationBatchId, venueId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationOutbox_identity_shape_check' })

    await expect(
      client.query(
        `UPDATE "CatalogPublicationOutbox"
            SET status = 'DEAD_LETTER', "lastError" = NULL,
                "claimedBy" = NULL, "claimedAt" = NULL, "claimExpiresAt" = NULL
          WHERE id = $1`,
        [`h1a-publication-outbox-${fixtureKey}`],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationOutbox_state_shape_check' })

    await expect(
      client.query(
        `INSERT INTO "CatalogPublicationOutbox"
          ("id", "organizationId", "batchId", "venueId", "venueSequence", "eventKind", "payload", "dedupeKey", "updatedAt")
         VALUES ($1, $2, $3, $4, 2, 'CATALOG_PUBLICATION_APPLIED', 'null'::jsonb, $1, CURRENT_TIMESTAMP)`,
        [`h1a-publication-null-payload-${fixtureKey}`, organizationId, publicationBatchId, venueId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'CatalogPublicationOutbox_identity_shape_check' })
  })

  it('retains decided overrides and APPLIED publication history unless the Venue is purged', async () => {
    const rejectedBatchId = `h1a-override-rejected-batch-${fixtureKey}`
    const rejectedOverrideId = `h1a-override-rejected-${fixtureKey}`
    await insertIdempotencyRecord(rejectedBatchId, 'CATALOG_OVERRIDE_REQUEST')
    await client.query(
      `INSERT INTO "CatalogVenueOverride"
        ("id", "organizationId", "bindingId", "venueId", "field", "localValue", "reason", "status",
         "requestBatchId", "requestedById", "requestedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'unit', '"piece"'::jsonb, 'Retain the local unit', 'REQUESTED', $5, $6,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [rejectedOverrideId, organizationId, bindingId, venueId, rejectedBatchId, makerId],
    )
    await client.query(
      `UPDATE "CatalogVenueOverride"
          SET status = 'REJECTED', "decidedById" = $2, "decidedAt" = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [rejectedOverrideId, checkerId],
    )

    // These deferred guards distinguish an accidental leaf/history delete from
    // the intentional Venue-owned purge path exercised by the next test.
    for (const [deleteSql, id, constraint] of [
      [`DELETE FROM "CatalogVenueOverride" WHERE id = $1`, rejectedOverrideId, 'CatalogVenueOverride_durable_delete_check'],
      [`DELETE FROM "CatalogPublicationLine" WHERE id = $1`, publicationLineId, 'CatalogPublicationLine_durable_delete_check'],
      [`DELETE FROM "CatalogPublicationBatch" WHERE id = $1`, publicationBatchId, 'CatalogPublicationLine_durable_delete_check'],
    ] as const) {
      await client.query('BEGIN')
      try {
        await client.query(deleteSql, [id])
        await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514', constraint })
      } finally {
        await client.query('ROLLBACK')
      }
    }
  })

  it('allows a legacy Product delete, defers a protected Product failure, and cascades a whole Venue graph', async () => {
    await expect(client.query(`DELETE FROM "Product" WHERE id = $1`, [unprotectedProductId])).resolves.toBeDefined()

    await client.query('BEGIN')
    try {
      await expect(client.query(`DELETE FROM "Product" WHERE id = $1`, [protectedProductId])).resolves.toBeDefined()
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503' })
    } finally {
      await client.query('ROLLBACK')
    }

    const bindingBatchId = `h1a-cascade-binding-batch-${fixtureKey}`
    await client.query(
      `INSERT INTO "CatalogBindingBatch"
        ("id", "organizationId", "state", "schemaVersion", "requestHash", "requestHashVersion", "targetHash",
         "previewTokenHash", "previewExpiresAt", "dependencies", "actorType", "staffId", "updatedAt")
       VALUES ($1, $2, 'PREVIEWED', 1, $3, 1, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour', '{}'::jsonb,
               'HUMAN', $6, CURRENT_TIMESTAMP)`,
      [
        bindingBatchId,
        organizationId,
        sha256(`request-${bindingBatchId}`),
        sha256(`target-${bindingBatchId}`),
        sha256(`token-${bindingBatchId}`),
        makerId,
      ],
    )
    await client.query(
      `INSERT INTO "CatalogBindingLine"
        ("id", "organizationId", "batchId", "catalogItemId", "venueId", "productId", "proposal", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'LINK', CURRENT_TIMESTAMP)`,
      [`h1a-cascade-binding-line-${fixtureKey}`, organizationId, bindingBatchId, catalogItemId, venueId, protectedProductId],
    )
    await client.query(
      `INSERT INTO "CatalogVenueRollout"
        ("id", "organizationId", "venueId", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, $4, $4, CURRENT_TIMESTAMP)`,
      [`h1a-cascade-rollout-${fixtureKey}`, organizationId, venueId, makerId],
    )
    await client.query(
      `INSERT INTO "CatalogVenueClientRequirement"
        ("id", "organizationId", "venueId", "family", "createdById", "updatedById", "updatedAt")
       VALUES ($1, $2, $3, 'ANDROID', $4, $4, CURRENT_TIMESTAMP)`,
      [`h1a-cascade-requirement-${fixtureKey}`, organizationId, venueId, makerId],
    )
    await client.query(
      `INSERT INTO "CatalogClientObservation"
        ("id", "organizationId", "venueId", "deviceId", "family", "appVersion", "capabilities", "lastSeenAt", "source", "updatedAt")
       VALUES ($1, $2, $3, $1, 'ANDROID', '1.0.0', '{}'::jsonb, CURRENT_TIMESTAMP, 'integration-test', CURRENT_TIMESTAMP)`,
      [`h1a-cascade-observation-${fixtureKey}`, organizationId, venueId],
    )
    await client.query(
      `INSERT INTO "CatalogClientReadinessOverride"
        ("id", "organizationId", "venueId", "family", "reason", "expiresAt", "createdById", "updatedAt")
       VALUES ($1, $2, $3, 'ANDROID', 'Cascade fixture', CURRENT_TIMESTAMP + INTERVAL '1 hour', $4, CURRENT_TIMESTAMP)`,
      [`h1a-cascade-readiness-${fixtureKey}`, organizationId, venueId, makerId],
    )

    const graphBefore = await client.query<{ graph_rows: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM "CatalogBindingLine" WHERE "venueId" = $1)
         + (SELECT COUNT(*) FROM "CatalogVenueRollout" WHERE "venueId" = $1)
         + (SELECT COUNT(*) FROM "CatalogVenueClientRequirement" WHERE "venueId" = $1)
         + (SELECT COUNT(*) FROM "CatalogClientObservation" WHERE "venueId" = $1)
         + (SELECT COUNT(*) FROM "CatalogClientReadinessOverride" WHERE "venueId" = $1)
       )::int AS graph_rows`,
      [venueId],
    )
    expect(graphBefore.rows).toEqual([{ graph_rows: 5 }])

    await client.query('BEGIN')
    try {
      await expect(client.query(`DELETE FROM "CatalogVenueBinding" WHERE id = $1`, [bindingId])).resolves.toBeDefined()
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23503' })
    } finally {
      await client.query('ROLLBACK')
    }

    await client.query('BEGIN')
    await client.query(`DELETE FROM "Venue" WHERE id = $1`, [venueId])
    await client.query('COMMIT')

    const remaining = await client.query<{
      bindings: number
      products: number
      sequences: number
      publication_lines: number
      field_decisions: number
      outbox_rows: number
      binding_lines: number
      rollout_rows: number
      requirement_rows: number
      observation_rows: number
      readiness_rows: number
      catalog_items: number
    }>(
      `
      SELECT
        (SELECT COUNT(*)::int FROM "CatalogVenueBinding" WHERE "venueId" = $1) AS bindings,
        (SELECT COUNT(*)::int FROM "Product" WHERE "venueId" = $1) AS products,
        (SELECT COUNT(*)::int FROM "CatalogVenueEventSequence" WHERE "venueId" = $1) AS sequences,
        (SELECT COUNT(*)::int FROM "CatalogPublicationLine" WHERE "venueId" = $1) AS publication_lines,
        (SELECT COUNT(*)::int FROM "CatalogPublicationFieldDecision" WHERE "lineId" = $3) AS field_decisions,
        (SELECT COUNT(*)::int FROM "CatalogPublicationOutbox" WHERE "venueId" = $1) AS outbox_rows,
        (SELECT COUNT(*)::int FROM "CatalogBindingLine" WHERE "venueId" = $1) AS binding_lines,
        (SELECT COUNT(*)::int FROM "CatalogVenueRollout" WHERE "venueId" = $1) AS rollout_rows,
        (SELECT COUNT(*)::int FROM "CatalogVenueClientRequirement" WHERE "venueId" = $1) AS requirement_rows,
        (SELECT COUNT(*)::int FROM "CatalogClientObservation" WHERE "venueId" = $1) AS observation_rows,
        (SELECT COUNT(*)::int FROM "CatalogClientReadinessOverride" WHERE "venueId" = $1) AS readiness_rows,
        (SELECT COUNT(*)::int FROM "CatalogItem" WHERE id = $2) AS catalog_items
    `,
      [venueId, catalogItemId, publicationLineId],
    )
    expect(remaining.rows[0]).toEqual({
      bindings: 0,
      products: 0,
      sequences: 0,
      publication_lines: 0,
      field_decisions: 0,
      outbox_rows: 0,
      binding_lines: 0,
      rollout_rows: 0,
      requirement_rows: 0,
      observation_rows: 0,
      readiness_rows: 0,
      catalog_items: 1,
    })
  })
})

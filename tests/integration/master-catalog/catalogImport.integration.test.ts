/**
 * Real PostgreSQL proof for Task 7 preview/confirm atomicity.
 *
 * Run only through run-with-h1-test-db.cjs. Dynamic runtime imports occur
 * after both environment aliases prove the exact disposable local database.
 */
import type { PrismaClient } from '@prisma/client'
import type { CatalogImportService } from '@/services/master-catalog/catalogImport.types'
import type { CatalogCommandContext, CatalogWorkbookUpload } from '@/types/master-catalog'
import type { ParsedMasterCatalogWorkbook, ParsedWorkbookCell } from '@/workers/masterCatalogXlsx.worker'

const fixtureKey = `${process.pid}-${Date.now()}-import`
const organizationId = `h1a-import-org-${fixtureKey}`
const staffId = `h1a-import-staff-${fixtureKey}`
const brandId = `h1a-import-brand-${fixtureKey}`
const manufacturerId = `h1a-import-manufacturer-${fixtureKey}`
const familyRootId = `h1a-import-family-root-${fixtureKey}`
const familyLeafId = `h1a-import-family-leaf-${fixtureKey}`
const tokenPrefix = `h1a-import-token-${fixtureKey}`

let prisma: PrismaClient | null = null
let writerOnePrisma: PrismaClient | null = null
let writerTwoPrisma: PrismaClient | null = null
let blockerPrisma: PrismaClient | null = null
let observerPrisma: PrismaClient | null = null
let catalogImportFactory: typeof import('@/services/master-catalog/catalogImport.service')
let catalogItems: typeof import('@/services/master-catalog/catalogItem.service')
let catalogReferences: typeof import('@/services/master-catalog/catalogReference.service')
let catalogAudit: typeof import('@/services/master-catalog/catalogAudit.service')
let acquireCatalogMutationLock: typeof import('@/services/master-catalog/catalogMutationLock.service').acquireCatalogMutationLock
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false
let nonce = 0

const writerOneApplicationName = `h1a-import-writer-a-${fixtureKey}`
const writerTwoApplicationName = `h1a-import-writer-b-${fixtureKey}`
const blockerApplicationName = `h1a-import-blocker-${fixtureKey}`
const observerApplicationName = `h1a-import-observer-${fixtureKey}`

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: The test independently repeats the wrapper guard before any Prisma
  // import or cleanup, so a poisoned shell cannot target dev or remote data.
  for (const candidate of [effective, declared]) {
    expect(['localhost', '127.0.0.1']).toContain(candidate.hostname)
    expect(candidate.pathname).toBe('/avoqado_h1a_test_20260808')
  }
  expect(declared.toString()).toBe(effective.toString())
}

function db(): PrismaClient {
  if (!disposableDatabaseVerified || !prisma) throw new Error('H1 disposable database was not verified')
  return prisma
}

function applicationDatabaseUrl(applicationName: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  url.searchParams.set('application_name', applicationName)
  return url.toString()
}

async function waitForCatalogImportAdvisoryWaiters(): Promise<void> {
  const observer = observerPrisma
  if (!observer) throw new Error('H1 catalog-import observer was not initialized')
  const deadline = Date.now() + 4_000
  let lastObserved: Array<{ applicationName: string; pid: number; waitEventType: string | null; waitEvent: string | null }> = []

  // WHY: PostgreSQL's advisory wait state proves both independent production
  // pools reached the exact organization lock; Promise scheduling alone does
  // not prove the confirms overlapped at the concurrency seam.
  while (Date.now() < deadline) {
    lastObserved = await observer.$queryRaw<
      Array<{ applicationName: string; pid: number; waitEventType: string | null; waitEvent: string | null }>
    >`
      SELECT application_name AS "applicationName", pid,
             wait_event_type AS "waitEventType", wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name IN (${writerOneApplicationName}, ${writerTwoApplicationName})
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
    `
    if (new Set(lastObserved.map(row => row.applicationName)).size === 2) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`Timed out waiting for both catalog-import advisory waiters; observed ${JSON.stringify(lastObserved)}`)
}

async function runConfirmsBehindCatalogMutationLock<T, U>(startConfirms: () => [Promise<T>, Promise<U>]): Promise<[T, U]> {
  const blocker = blockerPrisma
  if (!blocker) throw new Error('H1 catalog-import blocker was not initialized')
  let signalLockHeld!: () => void
  let releaseLock!: () => void
  const lockHeld = new Promise<void>(resolve => (signalLockHeld = resolve))
  const release = new Promise<void>(resolve => (releaseLock = resolve))
  const blockerTransaction = blocker.$transaction(
    async tx => {
      await acquireCatalogMutationLock(tx, organizationId)
      signalLockHeld()
      await release
    },
    { timeout: 10_000 },
  )
  await lockHeld
  const confirms = startConfirms()

  try {
    await waitForCatalogImportAdvisoryWaiters()
  } catch (error) {
    releaseLock()
    await blockerTransaction
    await Promise.allSettled(confirms)
    throw error
  }

  releaseLock()
  await blockerTransaction
  return Promise.all(confirms)
}

const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}

const upload: CatalogWorkbookUpload = {
  buffer: Buffer.from('PK\u0003\u0004h1a-import-integration', 'binary'),
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  originalFilename: 'catalog-master-import-v1.xlsx',
}

const text = (value: string): ParsedWorkbookCell => ({ kind: 'TEXT', value })
const number = (value: string): ParsedWorkbookCell => ({ kind: 'NUMBER', value })
const blank = (): ParsedWorkbookCell => ({ kind: 'BLANK', value: '' })

function workbook(sku: string): ParsedMasterCatalogWorkbook {
  const item = {
    operation: text('CREATE'),
    catalog_item_id: blank(),
    expected_revision: blank(),
    corporate_sku: text(sku),
    item_kind: text('RETAIL_PRODUCT'),
    name: text(`Producto ${sku}`),
    description: text('Fixture completo de confirmación atómica.'),
    image_url: text('https://cdn.example.test/h1a-import.png'),
    brand: text('Marca Import H1A'),
    manufacturer: text('Fabricante Import H1A'),
    family: text('Familia Import H1A'),
    subfamily: text('Subfamilia Import H1A'),
    presentation: text('Pieza individual'),
    unit: text('UNIT'),
    product_type: text('REGULAR'),
    iva_rate: number('0.1600'),
    sat_product_key: text('50161509'),
    sat_unit_key: text('H87'),
    objeto_imp: text('02'),
    ieps_mode: text('NONE'),
    ieps_rate: blank(),
    ieps_quota: blank(),
    ieps_quota_unit: blank(),
  }
  return {
    sheetNames: ['Metadata', 'Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'],
    sheets: {
      Metadata: {
        columns: ['key', 'value'],
        rows: [
          { sourceRow: 2, values: { key: text('documentType'), value: text('catalog-master-import') } },
          { sourceRow: 3, values: { key: text('schemaVersion'), value: text('1') } },
          { sourceRow: 4, values: { key: text('organizationId'), value: text(organizationId) } },
          { sourceRow: 5, values: { key: text('timezone'), value: text('America/Mexico_City') } },
        ],
      },
      Items: { columns: Object.keys(item), rows: [{ sourceRow: 2, values: item }] },
      OrganizationValues: {
        columns: ['corporate_sku', 'value_type', 'amount', 'currency', 'expected_rule_revision'],
        rows: [
          {
            sourceRow: 2,
            values: {
              corporate_sku: text(sku),
              value_type: text('SALE_PRICE'),
              amount: number('100.00'),
              currency: text('MXN'),
              expected_rule_revision: blank(),
            },
          },
          {
            sourceRow: 3,
            values: {
              corporate_sku: text(sku),
              value_type: text('PURCHASE_COST'),
              amount: number('50.00'),
              currency: text('MXN'),
              expected_rule_revision: blank(),
            },
          },
        ],
      },
      BusinessTypes: {
        columns: ['corporate_sku', 'business_type'],
        rows: [{ sourceRow: 2, values: { corporate_sku: text(sku), business_type: text('RETAIL_STORE') } }],
      },
      VenueBindingRequests: {
        columns: ['corporate_sku', 'venue_id', 'requested_action', 'product_id', 'local_sku', 'category_id', 'initial_price', 'currency'],
        rows: [],
      },
    },
  }
}

function serviceFor(sku: string, options: { failAudit?: boolean; prisma?: PrismaClient } = {}): CatalogImportService {
  return catalogImportFactory.createCatalogImportService({
    prisma: options.prisma ?? db(),
    parseWorkbook: async () => workbook(sku),
    applyCatalogReferenceProposalsTx: catalogReferences.applyCatalogReferenceProposalsTx,
    applyCatalogItemAggregateTx: catalogItems.applyCatalogItemAggregateTx,
    writeCatalogAudit: options.failAudit
      ? async () => {
          throw new Error('forced import summary audit failure')
        }
      : catalogAudit.writeCatalogAudit,
    // WHY: Task 4/unit API tests own access policy. This suite isolates real
    // import persistence and transaction rollback without duplicating grants.
    assertLiveAccessTx: async () => undefined,
    now: () => new Date(),
    randomToken: () => `${tokenPrefix}-${(nonce += 1)}`,
    randomAttemptId: () => `h1a-import-attempt-${fixtureKey}-${(nonce += 1)}`,
  })
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  // WHY: No module importing the default Prisma client may execute before the
  // disposable URL proof above.
  const { PrismaClient: PrismaClientConstructor } = await import('@prisma/client')
  writerOnePrisma = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(writerOneApplicationName) } } })
  writerTwoPrisma = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(writerTwoApplicationName) } } })
  blockerPrisma = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(blockerApplicationName) } } })
  observerPrisma = new PrismaClientConstructor({ datasources: { db: { url: applicationDatabaseUrl(observerApplicationName) } } })
  prisma = (await import('@/utils/prismaClient')).default
  catalogImportFactory = await import('@/services/master-catalog/catalogImport.service')
  catalogItems = await import('@/services/master-catalog/catalogItem.service')
  catalogReferences = await import('@/services/master-catalog/catalogReference.service')
  catalogAudit = await import('@/services/master-catalog/catalogAudit.service')
  ;({ acquireCatalogMutationLock } = await import('@/services/master-catalog/catalogMutationLock.service'))
  const client = db()
  await client.organization.create({
    data: { id: organizationId, name: `H1A Import ${fixtureKey}`, email: `${fixtureKey}@example.test`, phone: '5500000000' },
  })
  fixtureRowsMayExist = true
  await client.staff.create({ data: { id: staffId, email: `staff-${fixtureKey}@example.test`, firstName: 'H1A', lastName: 'Import' } })
  await client.catalogBrand.create({
    data: {
      id: brandId,
      organizationId,
      name: 'Marca Import H1A',
      normalizedName: 'MARCA IMPORT H1A',
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogManufacturer.create({
    data: {
      id: manufacturerId,
      organizationId,
      name: 'Fabricante Import H1A',
      normalizedName: 'FABRICANTE IMPORT H1A',
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyRootId,
      organizationId,
      name: 'Familia Import H1A',
      normalizedName: 'FAMILIA IMPORT H1A',
      parentId: null,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogFamily.create({
    data: {
      id: familyLeafId,
      organizationId,
      name: 'Subfamilia Import H1A',
      normalizedName: 'SUBFAMILIA IMPORT H1A',
      parentId: familyRootId,
      status: 'ACTIVE',
      createdById: staffId,
      updatedById: staffId,
    },
  })
})

afterAll(async () => {
  try {
    if (!disposableDatabaseVerified || !prisma) return
    assertDisposableH1Database()
    const client = prisma
    if (!fixtureRowsMayExist) return
    await client.activityLog.deleteMany({ where: { organizationId } })
    await client.catalogIdempotencyRecord.deleteMany({ where: { organizationId } })
    await client.catalogImportBatch.deleteMany({ where: { organizationId } })
    await client.catalogItem.deleteMany({ where: { organizationId } })
    await client.catalogFamily.deleteMany({ where: { id: familyLeafId, organizationId } })
    await client.catalogFamily.deleteMany({ where: { id: familyRootId, organizationId } })
    await client.catalogBrand.deleteMany({ where: { id: brandId, organizationId } })
    await client.catalogManufacturer.deleteMany({ where: { id: manufacturerId, organizationId } })
    await client.organization.deleteMany({ where: { id: organizationId } })
    await client.staff.deleteMany({ where: { id: staffId } })
  } finally {
    await Promise.all(
      [prisma, writerOnePrisma, writerTwoPrisma, blockerPrisma, observerPrisma]
        .filter((client): client is PrismaClient => client !== null)
        .map(client => client.$disconnect()),
    )
  }
})

describe('catalog import — real PostgreSQL preview and atomic confirmation', () => {
  it('stages a valid preview without operational item, Product, or binding writes', async () => {
    const sku = `H1A-PREVIEW-${fixtureKey}`
    const preview = await serviceFor(sku).preview(context, upload)

    expect(preview).toMatchObject({ canConfirm: true, previewToken: expect.any(String), errors: [] })
    await expect(db().catalogImportLine.count({ where: { organizationId, batchId: preview.importBatchId } })).resolves.toBe(4)
    await expect(db().catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(0)
    await expect(db().catalogVenueBinding.count({ where: { organizationId } })).resolves.toBe(0)
    await expect(db().product.count({ where: { venue: { organizationId } } })).resolves.toBe(0)
  })

  it('commits item, import authority, and one summary audit once, then replays the exact result', async () => {
    const sku = `H1A-APPLY-${fixtureKey}`
    const service = serviceFor(sku)
    const preview = await service.preview(context, upload)
    if (!preview.previewToken) throw new Error('Expected preview token')
    const confirmInput = {
      importBatchId: preview.importBatchId,
      previewToken: preview.previewToken,
      confirm: true as const,
      idempotencyKey: `key-${sku}`,
    }

    const applied = await service.confirm(context, confirmInput)
    await expect(service.confirm(context, confirmInput)).resolves.toEqual(applied)
    await expect(db().catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(1)
    await expect(
      db().catalogIdempotencyRecord.count({ where: { organizationId, operation: 'CATALOG_IMPORT', idempotencyKey: `key-${sku}` } }),
    ).resolves.toBe(1)
    await expect(
      db().activityLog.count({
        where: { organizationId, entity: 'CatalogImportBatch', entityId: preview.importBatchId, action: 'CATALOG_IMPORT_APPLIED' },
      }),
    ).resolves.toBe(1)
    await expect(
      db().catalogImportLine.count({ where: { batchId: preview.importBatchId, sourceSheet: 'Items', status: 'APPLIED' } }),
    ).resolves.toBe(1)
  })

  it('rolls back item, lease state, idempotency, and audit when the summary audit fails', async () => {
    const sku = `H1A-ROLLBACK-${fixtureKey}`
    const service = serviceFor(sku, { failAudit: true })
    const preview = await service.preview(context, upload)
    if (!preview.previewToken) throw new Error('Expected preview token')

    await expect(
      service.confirm(context, {
        importBatchId: preview.importBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: `key-${sku}`,
      }),
    ).rejects.toThrow('forced import summary audit failure')
    await expect(db().catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(0)
    await expect(db().catalogIdempotencyRecord.count({ where: { organizationId, idempotencyKey: `key-${sku}` } })).resolves.toBe(0)
    await expect(
      db().catalogImportBatch.findUniqueOrThrow({ where: { id: preview.importBatchId }, select: { state: true } }),
    ).resolves.toEqual({ state: 'PREVIEWED' })
    await expect(db().activityLog.count({ where: { organizationId, entityId: preview.importBatchId } })).resolves.toBe(0)
  })

  it('serializes two same-key confirms to one effect and one exact recovered result', async () => {
    const sku = `H1A-RACE-${fixtureKey}`
    const service = serviceFor(sku)
    const preview = await service.preview(context, upload)
    if (!preview.previewToken) throw new Error('Expected preview token')
    const confirmInput = {
      importBatchId: preview.importBatchId,
      previewToken: preview.previewToken,
      confirm: true as const,
      idempotencyKey: `key-${sku}`,
    }

    if (!writerOnePrisma || !writerTwoPrisma) throw new Error('H1 catalog-import writer pools were not initialized')
    const firstService = serviceFor(sku, { prisma: writerOnePrisma })
    const secondService = serviceFor(sku, { prisma: writerTwoPrisma })
    const [first, second] = await runConfirmsBehindCatalogMutationLock(() => [
      firstService.confirm(context, confirmInput),
      secondService.confirm(context, confirmInput),
    ])
    expect(second).toEqual(first)
    await expect(db().catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(1)
    await expect(
      db().catalogIdempotencyRecord.count({ where: { organizationId, operation: 'CATALOG_IMPORT', idempotencyKey: `key-${sku}` } }),
    ).resolves.toBe(1)
    await expect(
      db().activityLog.count({ where: { organizationId, entityId: preview.importBatchId, action: 'CATALOG_IMPORT_APPLIED' } }),
    ).resolves.toBe(1)
  })
})

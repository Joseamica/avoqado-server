/**
 * Real PostgreSQL proof for the complete Task 5 aggregate boundary.
 *
 * The suite uses only fixture-owned IDs in the hardened H1 disposable database.
 * It exercises the public wrappers plus the transaction-bound seams that Task 7
 * composes, including failures that must be observed only at COMMIT.
 */
import {
  BusinessType,
  CatalogIepsMode,
  CatalogItemKind,
  CatalogItemPriceKind,
  CatalogReferenceStatus,
  ProductType,
  Unit,
  type PrismaClient,
} from '@prisma/client'
import type { CatalogCommandContext } from '@/types/master-catalog'
import type { CreateCatalogItemInput, UpdateCatalogItemInput } from '@/services/master-catalog/catalogItem.types'

const fixtureKey = `${process.pid}-${Date.now()}`
const organizationId = `h1a-item-org-${fixtureKey}`
const staffId = `h1a-item-staff-${fixtureKey}`
const missingStaffId = `h1a-item-missing-staff-${fixtureKey}`
const brandId = `h1a-item-brand-${fixtureKey}`
const manufacturerId = `h1a-item-manufacturer-${fixtureKey}`
const familyRootId = `h1a-item-family-root-${fixtureKey}`
const familyLeafId = `h1a-item-family-leaf-${fixtureKey}`

let prisma: PrismaClient | null = null
let catalogItems: typeof import('@/services/master-catalog/catalogItem.service')
let catalogReferences: typeof import('@/services/master-catalog/catalogReference.service')
let disposableDatabaseVerified = false
let fixtureRowsMayExist = false

function assertDisposableH1Database(): void {
  const effective = new URL(process.env.DATABASE_URL ?? '')
  const declaredTestUrl = new URL(process.env.TEST_DATABASE_URL ?? '')
  // WHY: The test and wrapper independently verify both aliases before any
  // connection or cleanup, so bypassing either guard cannot target dev/remote.
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

const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId, impersonating: false },
  orgRole: 'OWNER',
}

function completeInput(sku: string): CreateCatalogItemInput {
  // WHY: Four initial rules leave a second valid currency pair while one MXN
  // row is made inactive, allowing reactivation and omission behavior to be real.
  return {
    sku,
    kind: CatalogItemKind.RETAIL_PRODUCT,
    name: `Café integración ${fixtureKey}`,
    description: 'Ficha corporativa completa creada por el comando real.',
    imageUrl: 'https://cdn.example.test/h1a-item.jpg',
    brandId,
    manufacturerId,
    familyId: familyLeafId,
    presentationLabel: 'Bolsa 1 kg',
    unit: Unit.BAG,
    taxRate: '0.1600',
    satProductKey: '50201706',
    satUnitKey: 'H87',
    objetoImp: '02',
    productType: ProductType.REGULAR,
    iepsMode: CatalogIepsMode.NONE,
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    businessTypes: [BusinessType.RETAIL_STORE],
    organizationValues: [
      { kind: CatalogItemPriceKind.SALE_PRICE, amount: '120.00', currency: 'MXN' },
      { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '80.00', currency: 'MXN' },
      { kind: CatalogItemPriceKind.SALE_PRICE, amount: '7.00', currency: 'USD' },
      { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '5.00', currency: 'USD' },
    ],
  }
}

beforeAll(async () => {
  assertDisposableH1Database()
  disposableDatabaseVerified = true
  // WHY: Dynamic imports happen only after the exact URL guard; Prisma cannot
  // establish a connection before the disposable boundary is proven.
  prisma = (await import('@/utils/prismaClient')).default
  catalogItems = await import('@/services/master-catalog/catalogItem.service')
  catalogReferences = await import('@/services/master-catalog/catalogReference.service')
  const client = db()

  await client.organization.create({
    data: {
      id: organizationId,
      name: `H1A CatalogItem ${fixtureKey}`,
      email: `h1a-item-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureRowsMayExist = true
  await client.staff.create({
    data: {
      id: staffId,
      email: `h1a-item-actor-${fixtureKey}@example.test`,
      firstName: 'H1A',
      lastName: 'Catalog Item',
    },
  })

  // WHY: References are explicit complete fixtures; the item command must
  // validate a same-tenant active brand/manufacturer and active root+leaf.
  await client.catalogBrand.create({
    data: {
      id: brandId,
      organizationId,
      name: 'Marca H1A',
      normalizedName: `MARCA-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  await client.catalogManufacturer.create({
    data: {
      id: manufacturerId,
      organizationId,
      name: 'Fabricante H1A',
      normalizedName: `FABRICANTE-${fixtureKey}`,
      status: CatalogReferenceStatus.ACTIVE,
      createdById: staffId,
      updatedById: staffId,
    },
  })
  for (const family of [
    { id: familyRootId, name: 'Raíz H1A', normalizedName: `RAIZ-${fixtureKey}`, parentId: null },
    { id: familyLeafId, name: 'Hoja H1A', normalizedName: `HOJA-${fixtureKey}`, parentId: familyRootId },
  ]) {
    await client.catalogFamily.create({
      data: {
        ...family,
        organizationId,
        status: CatalogReferenceStatus.ACTIVE,
        createdById: staffId,
        updatedById: staffId,
      },
    })
  }
})

afterAll(async () => {
  if (!disposableDatabaseVerified || !prisma) return
  assertDisposableH1Database()
  const client = prisma
  // WHY: A connection/setup failure cannot have completed fixture creation;
  // skip network cleanup in that state and only release Prisma resources.
  if (!fixtureRowsMayExist) {
    await client.$disconnect()
    return
  }
  // WHY: Delete the aggregate parent first and let its database cascades remove
  // invariant-guarded children; child autocommits would fail deferred checks.
  await client.activityLog.deleteMany({ where: { organizationId } })
  await client.catalogItem.deleteMany({ where: { organizationId } })
  await client.catalogFamily.deleteMany({ where: { id: familyLeafId, organizationId } })
  await client.catalogFamily.deleteMany({ where: { id: familyRootId, organizationId } })
  await client.catalogBrand.deleteMany({ where: { id: brandId, organizationId } })
  await client.catalogManufacturer.deleteMany({ where: { id: manufacturerId, organizationId } })
  await client.organization.deleteMany({ where: { id: organizationId } })
  await client.staff.deleteMany({ where: { id: staffId } })
  await client.$disconnect()
})

describe('CatalogItem complete aggregate — real command and transaction', () => {
  it('commits item, SKU, business type, same-currency values and audit; then preserves price IDs through CAS replacement', async () => {
    const client = db()
    const initialSku = `H1A-COMMIT-${fixtureKey}`
    const input = completeInput(initialSku)
    const created = await catalogItems.createCatalogItem(context, input)

    const persisted = await client.catalogItem.findUniqueOrThrow({
      where: { id: created.detail.id },
      select: {
        id: true,
        revision: true,
        invariantVersion: true,
        businessTypes: { select: { businessType: true } },
        identifiers: { select: { id: true, code: true, normalizedCode: true, status: true } },
        prices: { select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true } },
      },
    })
    expect(persisted.revision).toBe(1)
    expect(persisted.invariantVersion).toBeGreaterThan(0n)
    expect(persisted.businessTypes).toEqual([{ businessType: BusinessType.RETAIL_STORE }])
    expect(persisted.identifiers).toEqual([expect.objectContaining({ code: initialSku, normalizedCode: initialSku, status: 'ACTIVE' })])
    expect(persisted.prices.some(value => value.kind === CatalogItemPriceKind.SALE_PRICE && value.currency === 'MXN' && value.active)).toBe(
      true,
    )
    expect(
      persisted.prices.some(value => value.kind === CatalogItemPriceKind.PURCHASE_COST && value.currency === 'MXN' && value.active),
    ).toBe(true)
    await expect(
      client.activityLog.count({
        where: { organizationId, entity: 'CatalogItem', entityId: persisted.id, action: 'CATALOG_ITEM_CREATED' },
      }),
    ).resolves.toBe(1)

    // WHY: A family used by an aggregate cannot be detached into a root; the
    // rejected reference command must leave item detail safely reportable.
    await expect(
      catalogReferences.updateCatalogFamily(context, {
        referenceId: familyLeafId,
        expectedRevision: 1,
        name: 'Hoja H1A',
        parentId: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_FAMILY_IN_USE' })
    await expect(catalogItems.getCatalogItem(context, persisted.id)).resolves.toMatchObject({
      family: { id: familyLeafId, parent: { id: familyRootId } },
    })

    // WHY: Reference retirement changes no FK, so the service must reject an
    // in-use brand and preserve the ACTIVE baseline visible in item detail.
    await expect(catalogReferences.retireCatalogBrand(context, { referenceId: brandId, expectedRevision: 1 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_REFERENCE_IN_USE',
    })
    await expect(catalogItems.getCatalogItem(context, persisted.id)).resolves.toMatchObject({
      brand: { id: brandId, status: CatalogReferenceStatus.ACTIVE },
    })
    await expect(
      client.catalogBrand.findUniqueOrThrow({ where: { id: brandId }, select: { status: true, revision: true } }),
    ).resolves.toEqual({ status: CatalogReferenceStatus.ACTIVE, revision: 1 })
    await expect(client.activityLog.count({ where: { organizationId, entity: 'CatalogBrand', entityId: brandId } })).resolves.toBe(0)

    const initialByKey = new Map(persisted.prices.map(value => [`${value.kind}:${value.currency}`, value]))
    const purchaseMxn = initialByKey.get(`${CatalogItemPriceKind.PURCHASE_COST}:MXN`)
    const saleUsd = initialByKey.get(`${CatalogItemPriceKind.SALE_PRICE}:USD`)
    if (!purchaseMxn || !saleUsd) throw new Error('Missing organization-value fixture')
    await client.catalogItemPrice.updateMany({
      where: { id: purchaseMxn.id, organizationId, catalogItemId: persisted.id, revision: 1 },
      data: { active: false, revision: { increment: 1 }, updatedById: staffId },
    })
    await client.catalogItemPrice.updateMany({
      where: { id: saleUsd.id, organizationId, catalogItemId: persisted.id, revision: 1 },
      data: { amount: '7.50', revision: { increment: 1 }, updatedById: staffId },
    })
    const afterManualRules = await client.catalogItem.findUniqueOrThrow({
      where: { id: persisted.id },
      select: {
        revision: true,
        invariantVersion: true,
        prices: { select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true } },
      },
    })
    expect(afterManualRules.invariantVersion).toBeGreaterThan(persisted.invariantVersion)

    // WHY: Omission carries its own explicit CAS tombstone. A concurrent USD
    // edit must reject the whole command before item revision or children move.
    await expect(
      catalogItems.updateCatalogItem(context, {
        ...input,
        catalogItemId: persisted.id,
        expectedRevision: 1,
        organizationValues: [
          { kind: CatalogItemPriceKind.SALE_PRICE, amount: '125.00', currency: 'MXN', expectedRuleRevision: 1 },
          { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '82.00', currency: 'MXN', expectedRuleRevision: 2 },
        ],
        organizationValueDeactivations: [
          { kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 1 },
          { kind: CatalogItemPriceKind.PURCHASE_COST, currency: 'USD', expectedRuleRevision: 1 },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_VALUE_REVISION_CONFLICT' })
    await expect(
      client.catalogItem.findUniqueOrThrow({
        where: { id: persisted.id },
        select: {
          revision: true,
          invariantVersion: true,
          prices: { select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true } },
        },
      }),
    ).resolves.toEqual(afterManualRules)

    const renamedSku = `  h1a-renamed-${fixtureKey}  `
    const updateInput: UpdateCatalogItemInput = {
      ...input,
      catalogItemId: persisted.id,
      expectedRevision: 1,
      sku: renamedSku,
      organizationValues: [
        { kind: CatalogItemPriceKind.SALE_PRICE, amount: '125.00', currency: 'MXN', expectedRuleRevision: 1 },
        { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '82.00', currency: 'MXN', expectedRuleRevision: 2 },
      ],
      organizationValueDeactivations: [
        { kind: CatalogItemPriceKind.SALE_PRICE, currency: 'USD', expectedRuleRevision: 2 },
        { kind: CatalogItemPriceKind.PURCHASE_COST, currency: 'USD', expectedRuleRevision: 1 },
      ],
    }
    await catalogItems.updateCatalogItem(context, updateInput)

    const updated = await client.catalogItem.findUniqueOrThrow({
      where: { id: persisted.id },
      select: {
        sku: true,
        normalizedSku: true,
        revision: true,
        invariantVersion: true,
        identifiers: { select: { id: true, code: true, normalizedCode: true, status: true } },
        prices: { select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true } },
      },
    })
    expect(updated).toEqual(expect.objectContaining({ sku: renamedSku, normalizedSku: `H1A-RENAMED-${fixtureKey}`, revision: 2 }))
    expect(updated.invariantVersion).toBeGreaterThan(afterManualRules.invariantVersion)
    expect(updated.identifiers).toEqual([
      {
        id: persisted.identifiers[0].id,
        code: renamedSku,
        normalizedCode: `H1A-RENAMED-${fixtureKey}`,
        status: 'ACTIVE',
      },
    ])
    const updatedByKey = new Map(updated.prices.map(value => [`${value.kind}:${value.currency}`, value]))
    expect(updatedByKey.get(`${CatalogItemPriceKind.SALE_PRICE}:MXN`)).toEqual(
      expect.objectContaining({ id: initialByKey.get(`${CatalogItemPriceKind.SALE_PRICE}:MXN`)?.id, revision: 2, active: true }),
    )
    expect(updatedByKey.get(`${CatalogItemPriceKind.PURCHASE_COST}:MXN`)).toEqual(
      expect.objectContaining({ id: purchaseMxn.id, revision: 3, active: true }),
    )
    expect(updatedByKey.get(`${CatalogItemPriceKind.SALE_PRICE}:USD`)).toEqual(
      expect.objectContaining({ id: saleUsd.id, revision: 3, active: false }),
    )
    expect(updatedByKey.get(`${CatalogItemPriceKind.PURCHASE_COST}:USD`)).toEqual(
      expect.objectContaining({
        id: initialByKey.get(`${CatalogItemPriceKind.PURCHASE_COST}:USD`)?.id,
        revision: 2,
        active: false,
      }),
    )
    await expect(client.activityLog.count({ where: { organizationId, entityId: persisted.id } })).resolves.toBe(2)
    await expect(client.product.count({ where: { sku: { in: [initialSku, renamedSku] } } })).resolves.toBe(0)

    // WHY: A stale rule CAS is checked before item/child mutation, so the
    // failed command cannot advance revision, invariant, projection, or audit.
    const beforeStale = JSON.stringify(updated, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
    await expect(
      catalogItems.updateCatalogItem(context, {
        ...updateInput,
        expectedRevision: 2,
        organizationValues: [
          { kind: CatalogItemPriceKind.SALE_PRICE, amount: '130.00', currency: 'MXN', expectedRuleRevision: 1 },
          { kind: CatalogItemPriceKind.PURCHASE_COST, amount: '83.00', currency: 'MXN', expectedRuleRevision: 3 },
        ],
        organizationValueDeactivations: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_VALUE_REVISION_CONFLICT' })
    const afterStale = await client.catalogItem.findUniqueOrThrow({
      where: { id: persisted.id },
      select: {
        sku: true,
        normalizedSku: true,
        revision: true,
        invariantVersion: true,
        identifiers: { select: { id: true, code: true, normalizedCode: true, status: true } },
        prices: { select: { id: true, kind: true, amount: true, currency: true, revision: true, active: true } },
      },
    })
    expect(JSON.stringify(afterStale, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).toBe(beforeStale)
    await expect(client.activityLog.count({ where: { organizationId, entityId: persisted.id } })).resolves.toBe(2)
  })

  it('rolls the complete aggregate back when the real audit insert fails its actor FK', async () => {
    const client = db()
    const sku = `H1A-AUDIT-ROLLBACK-${fixtureKey}`
    const auditCountBefore = await client.activityLog.count({ where: { organizationId } })
    let actorReads = 0
    const actor = {
      type: 'HUMAN' as const,
      impersonating: false,
      // WHY: The first two reads supply the valid aggregate actor; later reads
      // poison only ActivityLog, producing a genuine FK failure after writes.
      get staffId() {
        actorReads += 1
        return actorReads <= 2 ? staffId : missingStaffId
      },
    }
    const auditFailureContext = { ...context, actor } as CatalogCommandContext

    await expect(catalogItems.createCatalogItem(auditFailureContext, completeInput(sku))).rejects.toMatchObject({ code: 'P2003' })

    await expect(client.catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(0)
    await expect(client.catalogIdentifier.count({ where: { organizationId, normalizedCode: sku } })).resolves.toBe(0)
    await expect(client.activityLog.count({ where: { organizationId } })).resolves.toBe(auditCountBefore)
  })

  it('rolls command state and audit back when deferred baseline validation fails at commit', async () => {
    const client = db()
    const sku = `H1A-BASELINE-ROLLBACK-${fixtureKey}`
    let createdId: string | null = null
    let transactionError: unknown

    try {
      await client.$transaction(async tx => {
        const created = await catalogItems.applyCatalogItemAggregateTx(
          tx,
          context,
          { operation: 'CREATE', input: completeInput(sku) },
          { auditOwnership: { kind: 'DIRECT' } },
        )
        createdId = created.detail.id
        // WHY: Removing the only business type after the real command forces
        // the deferred database invariant to reject the outer COMMIT.
        await tx.catalogItemBusinessType.deleteMany({ where: { organizationId, catalogItemId: createdId } })
      })
    } catch (error) {
      transactionError = error
    }

    expect(transactionError).toBeDefined()
    expect(JSON.stringify(transactionError)).toContain('CatalogItem_relational_baseline_check')
    await expect(client.catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(0)
    await expect(client.activityLog.count({ where: { organizationId, entityId: createdId } })).resolves.toBe(0)
  })

  it('rolls command state and audit back when the SKU projection diverges at commit', async () => {
    const client = db()
    const sku = `H1A-SKU-PROJECTION-${fixtureKey}`
    let createdId: string | null = null
    let transactionError: unknown

    try {
      await client.$transaction(async tx => {
        const created = await catalogItems.applyCatalogItemAggregateTx(
          tx,
          context,
          { operation: 'CREATE', input: completeInput(sku) },
          { auditOwnership: { kind: 'DIRECT' } },
        )
        createdId = created.detail.id
        // WHY: Corrupt only the projection after the real command so the
        // deferred equality trigger, not service validation, rejects COMMIT.
        await tx.catalogIdentifier.updateMany({
          where: { organizationId, catalogItemId: createdId },
          data: { normalizedCode: `${sku}-DIVERGENT` },
        })
      })
    } catch (error) {
      transactionError = error
    }

    expect(transactionError).toBeDefined()
    expect(JSON.stringify(transactionError)).toContain('CatalogItem_corporate_sku_projection_check')
    await expect(client.catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(0)
    await expect(client.activityLog.count({ where: { organizationId, entityId: createdId } })).resolves.toBe(0)
  })

  it('retires the item and corporate identifier while permanently reserving normalized SKU', async () => {
    const client = db()
    const sku = `H1A-RETIRED-${fixtureKey}`
    const created = await catalogItems.createCatalogItem(context, completeInput(sku))

    // WHY: Retirement is a one-way aggregate transition; both rows retain the
    // same normalized key so a later create cannot recycle historical identity.
    const retired = await catalogItems.retireCatalogItem(context, {
      catalogItemId: created.detail.id,
      expectedRevision: 1,
    })
    expect(retired.detail).toMatchObject({ status: 'RETIRED', revision: 2, normalizedSku: sku })
    await expect(
      client.catalogIdentifier.findMany({
        where: { organizationId, catalogItemId: created.detail.id },
        select: { code: true, normalizedCode: true, status: true },
      }),
    ).resolves.toEqual([{ code: sku, normalizedCode: sku, status: 'RETIRED' }])

    await expect(catalogItems.createCatalogItem(context, completeInput(`  ${sku.toLowerCase()}  `))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_VALUE_ALREADY_EXISTS',
    })
    await expect(client.catalogItem.count({ where: { organizationId, normalizedSku: sku } })).resolves.toBe(1)
    await expect(client.catalogIdentifier.count({ where: { organizationId, normalizedCode: sku } })).resolves.toBe(1)
    await expect(client.activityLog.count({ where: { organizationId, entityId: created.detail.id } })).resolves.toBe(2)
  })
})

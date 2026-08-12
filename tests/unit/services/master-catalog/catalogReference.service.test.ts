import { CatalogReferenceStatus } from '@prisma/client'
const mockWriteCatalogAudit = jest.fn()
const mockTransaction = jest.fn()
const mockBrandFindMany = jest.fn()
const mockManufacturerFindMany = jest.fn()
const mockFamilyFindMany = jest.fn()
jest.mock('@/services/master-catalog/catalogAudit.service', () => ({
  writeCatalogAudit: (...args: unknown[]) => mockWriteCatalogAudit(...(args as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [])),
    catalogBrand: { findMany: (...args: unknown[]) => mockBrandFindMany(...(args as [])) },
    catalogManufacturer: { findMany: (...args: unknown[]) => mockManufacturerFindMany(...(args as [])) },
    catalogFamily: { findMany: (...args: unknown[]) => mockFamilyFindMany(...(args as [])) },
  },
}))
import {
  applyCatalogReferenceProposalsTx,
  createCatalogBrand,
  createCatalogFamily,
  createCatalogManufacturer,
  listCatalogReferences,
  retireCatalogBrand,
  retireCatalogFamily,
  retireCatalogManufacturer,
  updateCatalogBrand,
  updateCatalogFamily,
  updateCatalogManufacturer,
} from '@/services/master-catalog/catalogReference.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
const organizationId = 'org-pits'
const actorId = 'staff-owner'
const context: CatalogCommandContext = {
  organizationId,
  actor: { type: 'HUMAN', staffId: actorId, impersonating: false },
  orgRole: 'OWNER',
}

type ReferenceType = 'BRAND' | 'MANUFACTURER' | 'FAMILY'

function row(referenceType: ReferenceType, overrides: Record<string, unknown> = {}) {
  return {
    id: `${referenceType.toLowerCase()}-1`,
    organizationId,
    name: 'Café del Sur',
    normalizedName: 'CAFÉ DEL SUR',
    status: CatalogReferenceStatus.ACTIVE,
    revision: 1,
    createdById: actorId,
    updatedById: actorId,
    parentId: referenceType === 'FAMILY' ? 'family-root' : undefined,
    ...overrides,
  }
}

function delegate(referenceType: ReferenceType) {
  const created = row(referenceType)
  return {
    findFirst: jest.fn().mockResolvedValue(null),
    // WHY: FAMILY retirement queries durable children independently from the
    // lifecycle row, keeping mutation reload mocks deterministic.
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue(created),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
}

function buildTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    catalogBrand: delegate('BRAND'),
    catalogManufacturer: delegate('MANUFACTURER'),
    catalogFamily: delegate('FAMILY'),
    catalogItem: { findFirst: jest.fn().mockResolvedValue(null) },
  }
}

let tx = buildTx()

beforeEach(() => {
  jest.clearAllMocks()
  tx = buildTx()
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
  mockWriteCatalogAudit.mockResolvedValue(undefined)
})

// These tests pin the transaction-bound import seam separately from direct
// wrappers so a later batch cannot accidentally emit one ActivityLog per row.
describe('catalogReference.service proposals', () => {
  it('preserves display bytes while normalizing the comparison key and returns BATCH envelopes without audit writes', async () => {
    const displayName = '  Cafe\u0301   del  Sur  '
    const result = await applyCatalogReferenceProposalsTx(
      tx as never,
      context,
      [{ operation: 'CREATE', referenceType: 'BRAND', name: displayName }],
      { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
    )

    expect(tx.catalogBrand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId,
        name: displayName,
        normalizedName: 'CAFÉ DEL SUR',
        status: CatalogReferenceStatus.ACTIVE,
        revision: 1,
        createdById: actorId,
        updatedById: actorId,
      }),
    })
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.catalogBrand.findFirst.mock.invocationCallOrder[0])
    expect(result.references).toEqual([expect.objectContaining({ id: 'brand-1', reused: false })])
    expect(result.auditEnvelopes).toEqual([
      expect.objectContaining({ action: 'CATALOG_BRAND_CREATED', entityId: 'brand-1', batchId: 'batch-1' }),
    ])
    expect(mockWriteCatalogAudit).not.toHaveBeenCalled()
  })

  it('reuses an active normalized value but never silently revives a retired value', async () => {
    tx.catalogManufacturer.findFirst.mockResolvedValueOnce(row('MANUFACTURER'))
    const reused = await applyCatalogReferenceProposalsTx(
      tx as never,
      context,
      [{ operation: 'CREATE', referenceType: 'MANUFACTURER', name: 'café del sur' }],
      { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
    )
    expect(reused.references[0]).toEqual(expect.objectContaining({ id: 'manufacturer-1', reused: true }))
    expect(tx.catalogManufacturer.create).not.toHaveBeenCalled()

    tx.catalogManufacturer.findFirst.mockResolvedValueOnce(row('MANUFACTURER', { status: CatalogReferenceStatus.RETIRED }))
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'CREATE', referenceType: 'MANUFACTURER', name: 'café del sur' }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_REFERENCE_RETIRED' })
  })

  it('rejects SERVICE and impersonating actors before reading or writing reference rows', async () => {
    for (const actor of [
      { type: 'SERVICE' as const, servicePrincipalId: 'import-worker' },
      { type: 'HUMAN' as const, staffId: actorId, impersonating: true },
    ]) {
      await expect(
        applyCatalogReferenceProposalsTx(
          tx as never,
          { ...context, actor },
          [{ operation: 'CREATE', referenceType: 'BRAND', name: 'Marca' }],
          { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
        ),
      ).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_HUMAN_ACTOR_REQUIRED' })
    }
    expect(tx.catalogBrand.findFirst).not.toHaveBeenCalled()
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it.each([0, 1.5, 2_147_483_647, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN, '1', null])(
    'rejects reference revision %p before lock/read/write',
    async expectedRevision => {
      await expect(
        applyCatalogReferenceProposalsTx(
          tx as never,
          context,
          [
            {
              operation: 'RETIRE',
              referenceType: 'BRAND',
              referenceId: 'brand-1',
              expectedRevision,
            } as never,
          ],
          { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_REVISION_INVALID' })
      expect(tx.$executeRaw).not.toHaveBeenCalled()
      expect(tx.catalogBrand.findFirst).not.toHaveBeenCalled()
    },
  )

  it('requires a same-tenant active root for a child and rejects self/depth-three hierarchies', async () => {
    // CREATE first checks normalized reuse, then resolves the proposed parent.
    tx.catalogFamily.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'family-root', parentId: null })
    await applyCatalogReferenceProposalsTx(
      tx as never,
      context,
      [{ operation: 'CREATE', referenceType: 'FAMILY', name: 'Subfamilia', parentId: 'family-root' }],
      { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
    )
    expect(tx.catalogFamily.findFirst).toHaveBeenCalledWith({
      where: { id: 'family-root', organizationId, status: CatalogReferenceStatus.ACTIVE },
      select: { id: true, parentId: true },
    })
    expect(tx.catalogFamily.create).toHaveBeenCalledWith({ data: expect.objectContaining({ parentId: 'family-root' }) })

    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'CREATE', referenceType: 'FAMILY', name: 'Ajena', parentId: 'foreign-root' }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    tx.catalogFamily.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'family-child', parentId: 'family-root' })
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'CREATE', referenceType: 'FAMILY', name: 'Nivel tres', parentId: 'family-child' }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_FAMILY_HIERARCHY_INVALID' })
    tx.catalogFamily.findFirst.mockResolvedValueOnce(row('FAMILY')).mockResolvedValueOnce(null)
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [
          {
            operation: 'UPDATE',
            referenceType: 'FAMILY',
            referenceId: 'family-1',
            expectedRevision: 1,
            name: 'Misma',
            parentId: 'family-1',
          },
        ],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_FAMILY_HIERARCHY_INVALID' })
  })

  it('does not turn an omitted family parent into a silent relink', async () => {
    tx.catalogFamily.findFirst
      .mockResolvedValueOnce(row('FAMILY'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row('FAMILY', { revision: 2 }))
    await applyCatalogReferenceProposalsTx(
      tx as never,
      context,
      [{ operation: 'UPDATE', referenceType: 'FAMILY', referenceId: 'family-1', expectedRevision: 1, name: 'Nombre nuevo' }],
      { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
    )
    expect(tx.catalogFamily.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'family-1', organizationId, revision: 1 }),
      data: expect.not.objectContaining({ parentId: expect.anything() }),
    })
  })

  it('rejects detaching a leaf used by CatalogItem so existing detail stays reportable', async () => {
    tx.catalogFamily.findFirst.mockResolvedValueOnce(row('FAMILY')).mockResolvedValueOnce(null)
    tx.catalogItem.findFirst.mockResolvedValueOnce({ id: 'catalog-item-1' })

    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [
          {
            operation: 'UPDATE',
            referenceType: 'FAMILY',
            referenceId: 'family-1',
            expectedRevision: 1,
            name: 'Subfamilia reportable',
            parentId: null,
          },
        ],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_FAMILY_IN_USE' })
    expect(tx.catalogFamily.updateMany).not.toHaveBeenCalled()
  })

  it.each(['BRAND', 'MANUFACTURER', 'FAMILY'] as const)(
    'rejects retiring an in-use %s without changing its lifecycle',
    async referenceType => {
      const model =
        referenceType === 'BRAND' ? tx.catalogBrand : referenceType === 'MANUFACTURER' ? tx.catalogManufacturer : tx.catalogFamily
      model.findFirst.mockResolvedValueOnce(row(referenceType))
      tx.catalogItem.findFirst.mockResolvedValueOnce({ id: 'catalog-item-1' })

      // WHY: ACTIVE references are part of every durable item baseline; a
      // status-only retirement must not silently invalidate existing items.
      await expect(
        applyCatalogReferenceProposalsTx(
          tx as never,
          context,
          [{ operation: 'RETIRE', referenceType, referenceId: `${referenceType.toLowerCase()}-1`, expectedRevision: 1 }],
          { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_REFERENCE_IN_USE' })
      expect(model.updateMany).not.toHaveBeenCalled()
    },
  )

  it('rejects retiring a family root that still owns a durable child', async () => {
    tx.catalogFamily.findFirst.mockResolvedValueOnce(row('FAMILY', { id: 'family-root', parentId: null }))
    tx.catalogFamily.count.mockResolvedValueOnce(1)

    // WHY: Child detail requires an ACTIVE parent, so retiring a root with
    // children would corrupt every descendant even when no item uses the root.
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'RETIRE', referenceType: 'FAMILY', referenceId: 'family-root', expectedRevision: 1 }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_FAMILY_HAS_CHILDREN' })
    expect(tx.catalogFamily.updateMany).not.toHaveBeenCalled()
  })

  it('returns tenant-safe 404 and CAS 409 without retrying or relinking', async () => {
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'RETIRE', referenceType: 'BRAND', referenceId: 'foreign-brand', expectedRevision: 1 }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 404 })

    tx.catalogBrand.findFirst.mockResolvedValueOnce(row('BRAND'))
    tx.catalogBrand.updateMany.mockResolvedValueOnce({ count: 0 })
    // WHY: Use a valid-but-stale CAS word so this assertion remains distinct
    // from the malformed revision cases rejected before the mutation lock.
    await expect(
      applyCatalogReferenceProposalsTx(
        tx as never,
        context,
        [{ operation: 'RETIRE', referenceType: 'BRAND', referenceId: 'brand-1', expectedRevision: 2 }],
        { auditOwnership: { kind: 'BATCH', batchId: 'batch-1' } },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_REVISION_CONFLICT' })
  })
})

// Parameterized wrapper coverage proves all three reference tables expose the
// same CREATE/UPDATE/RETIRE lifecycle and that DIRECT owns exactly one audit.
describe('catalogReference.service direct wrappers', () => {
  const cases = [
    {
      type: 'BRAND' as const,
      delegate: () => tx.catalogBrand,
      create: createCatalogBrand,
      update: updateCatalogBrand,
      retire: retireCatalogBrand,
    },
    {
      type: 'MANUFACTURER' as const,
      delegate: () => tx.catalogManufacturer,
      create: createCatalogManufacturer,
      update: updateCatalogManufacturer,
      retire: retireCatalogManufacturer,
    },
    {
      type: 'FAMILY' as const,
      delegate: () => tx.catalogFamily,
      create: createCatalogFamily,
      update: updateCatalogFamily,
      retire: retireCatalogFamily,
    },
  ]

  it('keeps BRAND/CREATE discriminants trusted when runtime input forges another lifecycle', async () => {
    const forgedInput = {
      name: 'Marca segura',
      referenceType: 'FAMILY',
      operation: 'RETIRE',
      referenceId: 'family-1',
      expectedRevision: 1,
    } as { name: string }

    await createCatalogBrand(context, forgedInput)

    expect(tx.catalogBrand.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Marca segura' }) })
    expect(tx.catalogFamily.findFirst).not.toHaveBeenCalled()
    expect(mockWriteCatalogAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'CATALOG_BRAND_CREATED' }))
  })

  it.each(cases)('creates $type in one transaction and one audit', async ({ type, delegate: getDelegate, create }) => {
    await create(context, { name: '  Marca  ' })

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(getDelegate().create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId, createdById: actorId }) })
    expect(mockWriteCatalogAudit).toHaveBeenCalledTimes(1)
    expect(mockWriteCatalogAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: `CATALOG_${type}_CREATED` }))
  })

  it.each(cases)('updates $type with tenant CAS and actor provenance', async ({ type, delegate: getDelegate, update }) => {
    getDelegate()
      .findFirst.mockResolvedValueOnce(row(type))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row(type, { name: 'Nuevo', revision: 2 }))
    await update(context, { referenceId: `${type.toLowerCase()}-1`, expectedRevision: 1, name: 'Nuevo' })

    expect(getDelegate().updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: `${type.toLowerCase()}-1`, organizationId, revision: 1, status: CatalogReferenceStatus.ACTIVE }),
      data: expect.objectContaining({ name: 'Nuevo', updatedById: actorId, revision: { increment: 1 } }),
    })
    expect(mockWriteCatalogAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: `CATALOG_${type}_UPDATED` }))
  })

  it.each(cases)('retires $type one-way with tenant CAS and one audit', async ({ type, delegate: getDelegate, retire }) => {
    getDelegate()
      .findFirst.mockResolvedValueOnce(row(type))
      .mockResolvedValueOnce(row(type, { status: CatalogReferenceStatus.RETIRED, revision: 2 }))
    await retire(context, { referenceId: `${type.toLowerCase()}-1`, expectedRevision: 1 })

    expect(getDelegate().updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: `${type.toLowerCase()}-1`, organizationId, revision: 1, status: CatalogReferenceStatus.ACTIVE }),
      data: expect.objectContaining({ status: CatalogReferenceStatus.RETIRED, updatedById: actorId, revision: { increment: 1 } }),
    })
    expect(mockWriteCatalogAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: `CATALOG_${type}_RETIRED` }))
  })
})

// WHY: Task 10 controllers need one bounded, tenant-safe read contract instead
// of exposing model-specific Prisma rows or reimplementing pagination per route.
describe('catalogReference.service bounded reads', () => {
  const cases = [
    { referenceType: 'BRAND' as const, findMany: mockBrandFindMany },
    { referenceType: 'MANUFACTURER' as const, findMany: mockManufacturerFindMany },
    { referenceType: 'FAMILY' as const, findMany: mockFamilyFindMany },
  ]

  it.each(cases)('queries $referenceType by tenant, status, cursor, and a bounded stable page', async ({ referenceType, findMany }) => {
    const rows = [
      {
        id: `${referenceType.toLowerCase()}-1`,
        name: 'Visible',
        status: CatalogReferenceStatus.RETIRED,
        revision: 4,
        ...(referenceType === 'FAMILY'
          ? { parentId: 'family-root', parent: { id: 'family-root', name: 'Raíz', status: CatalogReferenceStatus.ACTIVE } }
          : {}),
      },
      { id: `${referenceType.toLowerCase()}-2`, name: 'Siguiente', status: CatalogReferenceStatus.RETIRED, revision: 1 },
    ]
    findMany.mockResolvedValueOnce(rows)

    const result = await listCatalogReferences(context, {
      referenceType,
      status: CatalogReferenceStatus.RETIRED,
      cursor: 'cursor-1',
      pageSize: 1,
    })

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId, status: CatalogReferenceStatus.RETIRED, id: { gt: 'cursor-1' } },
      select:
        referenceType === 'FAMILY'
          ? {
              id: true,
              name: true,
              status: true,
              revision: true,
              parentId: true,
              parent: { select: { id: true, name: true, status: true } },
            }
          : { id: true, name: true, status: true, revision: true },
      orderBy: [{ id: 'asc' }],
      take: 2,
    })
    expect(result.items).toEqual([
      referenceType === 'FAMILY'
        ? {
            id: 'family-1',
            name: 'Visible',
            status: CatalogReferenceStatus.RETIRED,
            revision: 4,
            parent: { id: 'family-root', name: 'Raíz', status: CatalogReferenceStatus.ACTIVE },
          }
        : {
            id: `${referenceType.toLowerCase()}-1`,
            name: 'Visible',
            status: CatalogReferenceStatus.RETIRED,
            revision: 4,
          },
    ])
    expect(result.nextCursor).toBe(`${referenceType.toLowerCase()}-1`)
  })

  it('defaults to a bounded all-status page and rejects invalid bounds before a query', async () => {
    mockBrandFindMany.mockResolvedValueOnce([])
    await listCatalogReferences(context, { referenceType: 'BRAND' })

    expect(mockBrandFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId }, take: 51, orderBy: [{ id: 'asc' }] }),
    )
    await expect(listCatalogReferences(context, { referenceType: 'BRAND', pageSize: 101 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CATALOG_PAGE_SIZE_INVALID',
    })
    expect(mockBrandFindMany).toHaveBeenCalledTimes(1)
  })
})

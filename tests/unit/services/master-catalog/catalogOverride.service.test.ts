import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import prisma from '@/utils/prismaClient'
import { writeCatalogAudit } from '@/services/master-catalog/catalogAudit.service'
import {
  confirmCatalogOverrideRequest,
  getCatalogVenueProvenance,
  listCatalogVenueChanges,
  previewCatalogOverrideRequest,
} from '@/services/master-catalog/catalogOverride.service'
import {
  CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
  CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
  type CatalogOverrideRequestLineInput,
  type CatalogVenueContext,
} from '@/types/master-catalog'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
    staffVenue: { findFirst: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    catalogVenueBinding: { findFirst: jest.fn(), findMany: jest.fn() },
    catalogItemPrice: { findFirst: jest.fn() },
    catalogIdempotencyRecord: { create: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    catalogVenueOverride: { create: jest.fn(), findMany: jest.fn() },
  },
}))

jest.mock('@/services/master-catalog/catalogAudit.service', () => ({ writeCatalogAudit: jest.fn() }))

const now = new Date('2026-08-08T12:00:00.000Z')
const context: CatalogVenueContext = {
  organizationId: 'org-1',
  venueId: 'venue-1',
  actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    role: 'MANAGER',
    permissionSetId: 'permission-set-1',
    permissionSet: { venueId: 'venue-1', permissions: ['catalog-venue:read', 'catalog-venue:request-override'] },
    ...overrides,
  }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'binding-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    catalogItemId: 'item-1',
    productId: 'product-1',
    revision: 3,
    status: 'LINKED',
    managedFieldMask: CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
    lastPublishedCatalogRevision: 1,
    lastPublishedManagedSnapshot: { name: 'Anterior' },
    lastPublishedManagedHash: 'a'.repeat(64),
    productUpdatedAtObserved: new Date('2026-08-07T10:00:00.000Z'),
    createdAt: new Date('2026-08-07T09:00:00.000Z'),
    updatedAt: new Date('2026-08-08T10:00:00.000Z'),
    product: {
      id: 'product-1',
      updatedAt: new Date('2026-08-08T10:00:00.000Z'),
      cost: new Prisma.Decimal('7.50'),
      description: 'Descripción local',
      imageUrl: 'https://local.test/image.png',
      name: 'Nombre local',
      objetoImp: '01',
      satProductKey: '50100000',
      satUnitKey: 'H87',
      taxRate: new Prisma.Decimal('0.0800'),
      type: 'REGULAR',
      unit: 'PIECE',
    },
    catalogItem: {
      id: 'item-1',
      kind: 'RETAIL_PRODUCT',
      revision: 9,
      description: 'Descripción corporativa',
      imageUrl: 'https://corporate.test/image.png',
      name: 'Nombre corporativo',
      objetoImp: '02',
      satProductKey: '50200000',
      satUnitKey: 'EA',
      taxRate: new Prisma.Decimal('0.1600'),
      productType: 'FOOD_AND_BEV',
      unit: 'UNIT',
      prices: [{ kind: 'PURCHASE_COST', scope: 'ORGANIZATION', active: true, currency: 'MXN', amount: new Prisma.Decimal('8.00') }],
    },
    venue: { currency: 'MXN' },
    ...overrides,
  }
}

function createdRecord() {
  const data = (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls.at(-1)[0].data
  return { id: 'override-batch-1', ...data, updatedAt: data.createdAt }
}

async function makePreview(requests: CatalogOverrideRequestLineInput[] = [{ field: 'name', reason: 'Nombre local requerido' }]) {
  return previewCatalogOverrideRequest(context, { bindingId: 'binding-1', idempotencyKey: 'override-key-1', requests })
}

describe('catalog venue override requests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(now)
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.$executeRaw as jest.Mock).mockResolvedValue(1)
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(membership())
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(binding())
    ;(prisma.catalogVenueBinding.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.catalogItemPrice.findFirst as jest.Mock).mockResolvedValue({ amount: new Prisma.Decimal('8.00') })
    ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'override-batch-1', ...data }))
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.catalogIdempotencyRecord.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.catalogVenueOverride.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: `override-${data.field}`, ...data }))
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([])
    ;(writeCatalogAudit as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(() => jest.useRealTimers())

  it('rechecks active Staff, StaffVenue and the exact tenant before deriving localValue from Product', async () => {
    const preview = await makePreview()

    expect(prisma.staffVenue.findFirst).toHaveBeenCalledWith({
      where: { staffId: 'staff-1', venueId: 'venue-1', active: true, staff: { active: true }, venue: { organizationId: 'org-1' } },
      select: expect.objectContaining({ role: true, permissionSetId: true }),
    })
    expect(preview.requests).toEqual([
      { bindingId: 'binding-1', field: 'name', reason: 'Nombre local requerido', localValue: 'Nombre local' },
    ])
  })

  it.each([
    ['inactive Staff or membership', null, context, 404],
    ['impersonating mutation', membership(), { ...context, actor: { ...context.actor, impersonating: true } }, 403],
    ['service actor', membership(), { ...context, actor: { type: 'SERVICE', servicePrincipalId: 'job' } }, 403],
  ])('rejects %s without creating a preview', async (_label, liveMembership, venueContext, statusCode) => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(liveMembership)
    await expect(
      previewCatalogOverrideRequest(venueContext as CatalogVenueContext, {
        bindingId: 'binding-1',
        idempotencyKey: 'key',
        requests: [{ field: 'name', reason: 'Motivo' }],
      }),
    ).rejects.toMatchObject({ statusCode })
    expect(prisma.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('honors PermissionSet as an exact replacement and never uses role or StaffVenue permissions as a bypass', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(
      membership({
        role: 'OWNER',
        permissions: ['catalog-venue:request-override'],
        permissionSet: { venueId: 'venue-1', permissions: ['catalog-venue:read'] },
      }),
    )
    await expect(makePreview()).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_VENUE_PERMISSION_DENIED' })
  })

  it('honors the live VenueRolePermission override when no PermissionSet exists', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(membership({ permissionSetId: null, permissionSet: null, role: 'OWNER' }))
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: ['catalog-venue:read'] })
    await expect(makePreview()).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_VENUE_PERMISSION_DENIED' })
    expect(prisma.venueRolePermission.findUnique).toHaveBeenCalledWith({
      where: { venueId_role: { venueId: 'venue-1', role: 'OWNER' } },
      select: { permissions: true },
    })
  })

  it.each([
    ['caller-controlled localValue', [{ field: 'name', reason: 'Motivo', localValue: 'forged' }]],
    [
      'duplicate field',
      [
        { field: 'name', reason: 'Uno' },
        { field: 'name', reason: 'Dos' },
      ],
    ],
    ['foreign field', [{ field: 'price', reason: 'Motivo' }]],
    ['blank reason', [{ field: 'name', reason: '\u2003' }]],
    ['NUL reason', [{ field: 'name', reason: 'No\u0000válido' }]],
    ['lone surrogate reason', [{ field: 'name', reason: 'No\ud800válido' }]],
    ['oversized reason', [{ field: 'name', reason: 'á'.repeat(501) }]],
  ])('rejects %s at the request boundary', async (_label, requests) => {
    await expect(
      previewCatalogOverrideRequest(context, { bindingId: 'binding-1', idempotencyKey: 'key', requests } as any),
    ).rejects.toMatchObject({ statusCode: 422 })
    expect(prisma.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('rejects cost for PREPARED_DISH and a local value equal to corporate', async () => {
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({
        managedFieldMask: CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
        catalogItem: { ...(binding().catalogItem as object), kind: 'PREPARED_DISH' },
      }),
    )
    await expect(makePreview([{ field: 'cost', reason: 'Costo local' }])).rejects.toMatchObject({ statusCode: 422 })
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({ product: { ...(binding().product as object), name: 'Nombre corporativo' } }),
    )
    await expect(makePreview()).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_OVERRIDE_NO_CHANGE' })
  })

  it('stores a SHA-only token, target-field dependencies and one coherent creation instant', async () => {
    const preview = await makePreview()
    const data = (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls[0][0].data
    expect(data).toEqual(
      expect.objectContaining({
        operation: 'CATALOG_OVERRIDE_REQUEST',
        state: 'PREVIEWED',
        actorType: 'HUMAN',
        staffId: 'staff-1',
        createdAt: now,
        previewTokenHash: createHash('sha256').update(preview.previewToken).digest('hex'),
      }),
    )
    expect(data.previewExpiresAt.getTime()).toBeGreaterThan(data.createdAt.getTime())
    expect(JSON.stringify(data)).not.toContain(preview.previewToken)
    expect(data.dependencies).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        bindingId: 'binding-1',
        bindingRevision: 3,
        productId: 'product-1',
        catalogItemId: 'item-1',
        requests: [{ field: 'name', reason: 'Nombre local requerido', localValue: 'Nombre local', corporateValue: 'Nombre corporativo' }],
      }),
    )
    expect(data.dependencies).not.toHaveProperty('productUpdatedAt')
    expect(data.dependencies).not.toHaveProperty('catalogItemRevision')
  })

  it('maps a concurrent idempotency reservation without re-exposing a bearer', async () => {
    ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockRejectedValue({
      code: 'P2002',
      meta: { target: 'CatalogIdempotencyRecord_organizationId_operation_idemp_key' },
    })
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockImplementation(async () => ({
      id: 'winner',
      requestHash: (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls[0][0].data.requestHash,
      state: 'PREVIEWED',
    }))
    await expect(makePreview()).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_OVERRIDE_PREVIEW_TOKEN_NOT_RECOVERABLE' })
  })

  it('confirms only REQUESTED rows, serializes fields, audits, and atomically applies the batch', async () => {
    const preview = await makePreview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(createdRecord())
    const result = await confirmCatalogOverrideRequest(context, {
      requestBatchId: preview.requestBatchId,
      previewToken: preview.previewToken,
      confirm: true,
      idempotencyKey: 'override-key-1',
    })

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1)
    expect(prisma.catalogVenueOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre local',
        reason: 'Nombre local requerido',
        status: 'REQUESTED',
        requestBatchId: 'override-batch-1',
        requestedById: 'staff-1',
        requestedAt: now,
      }),
    })
    expect(writeCatalogAudit).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'CATALOG_OVERRIDE_REQUESTED',
        entity: 'CatalogVenueOverride',
        batchId: 'override-batch-1',
        actor: context.actor,
      }),
    )
    expect(writeCatalogAudit).toHaveBeenCalledTimes(1)
    expect(prisma.catalogIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'override-batch-1', state: 'PREVIEWED' }),
        data: expect.objectContaining({ state: 'APPLIED', completedAt: now }),
      }),
    )
    expect(result).toEqual({ requestBatchId: 'override-batch-1', state: 'APPLIED', overrideIds: ['override-name'] })
    expect(prisma.staffVenue.findFirst).toHaveBeenCalledTimes(2)
  })

  it('revalidates only targeted values: unrelated Product.updatedAt drift passes, target drift is stale', async () => {
    const preview = await makePreview()
    const previewRecord = createdRecord()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(previewRecord)
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({ product: { ...(binding().product as object), updatedAt: new Date('2026-08-09T10:00:00.000Z') } }),
    )
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).resolves.toMatchObject({ state: 'APPLIED' })

    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(membership())
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(previewRecord)
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({ product: { ...(binding().product as object), name: 'Cambió después del preview' } }),
    )
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STALE_PREVIEW' })
    expect(prisma.catalogVenueOverride.create).not.toHaveBeenCalled()
  })

  it('recovers APPLIED from exact relational REQUESTED rows instead of trusting result JSON', async () => {
    const preview = await makePreview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({
      ...createdRecord(),
      state: 'APPLIED',
      result: { overrideIds: ['forged'] },
      completedAt: now,
    })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'override-real',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre local',
        reason: 'Nombre local requerido',
        status: 'REQUESTED',
        requestBatchId: 'override-batch-1',
        requestedById: 'staff-1',
      },
    ])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).resolves.toEqual({ requestBatchId: 'override-batch-1', state: 'APPLIED', overrideIds: ['override-real'] })
    expect(prisma.catalogVenueOverride.create).not.toHaveBeenCalled()
  })

  it('rejects a corrupt APPLIED relational result instead of trusting record.result', async () => {
    const preview = await makePreview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({
      ...createdRecord(),
      state: 'APPLIED',
      result: { overrideIds: ['forged'] },
      completedAt: now,
    })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([{ id: 'wrong', field: 'name', status: 'APPROVED' }])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_OVERRIDE_RESULT_INVALID' })
  })

  it('persists a captured JSON null with Prisma.JsonNull rather than SQL NULL', async () => {
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({ product: { ...(binding().product as object), description: null } }),
    )
    const preview = await makePreview([{ field: 'description', reason: 'La descripción local debe conservarse vacía' }])
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(createdRecord())
    await confirmCatalogOverrideRequest(context, {
      requestBatchId: preview.requestBatchId,
      previewToken: preview.previewToken,
      confirm: true,
      idempotencyKey: 'override-key-1',
    })
    expect(prisma.catalogVenueOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ field: 'description', localValue: Prisma.JsonNull }),
    })
  })

  it.each([
    [{ code: 'P2002', meta: { target: 'CatalogVenueOverride_one_requested_field_key' } }, 'CATALOG_OVERRIDE_ALREADY_REQUESTED'],
    [{ code: 'P2034' }, 'CATALOG_OVERRIDE_CONCURRENT_RETRY'],
  ])('maps expected concurrency race %# to stable 409', async (failure, code) => {
    const preview = await makePreview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(createdRecord())
    ;(prisma.catalogVenueOverride.create as jest.Mock).mockRejectedValue(failure)
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code })
  })

  it('lets audit failure abort before the idempotency transition', async () => {
    const preview = await makePreview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(createdRecord())
    ;(writeCatalogAudit as jest.Mock).mockRejectedValue(new Error('audit unavailable'))
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: preview.requestBatchId,
        previewToken: preview.previewToken,
        confirm: true,
        idempotencyKey: 'override-key-1',
      }),
    ).rejects.toThrow('audit unavailable')
    expect(prisma.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalled()
  })

  it('returns tenant-scoped provenance and stable bounded keyset pages under read permission', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(
      membership({ permissionSet: { venueId: 'venue-1', permissions: ['catalog-venue:read'] } }),
    )
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(binding())
    await expect(getCatalogVenueProvenance(context, { productId: 'product-1' })).resolves.toMatchObject({
      bindingId: 'binding-1',
      catalogItemId: 'item-1',
      productId: 'product-1',
      revision: 3,
      productUpdatedAtObserved: '2026-08-07T10:00:00.000Z',
    })
    expect(prisma.catalogVenueBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: 'product-1', organizationId: 'org-1', venueId: 'venue-1' },
      }),
    )

    const second = binding({
      id: 'binding-0',
      catalogItemId: 'item-0',
      productId: 'product-0',
      updatedAt: new Date('2026-08-08T09:00:00.000Z'),
    })
    ;(prisma.catalogVenueBinding.findMany as jest.Mock).mockResolvedValue([binding(), second])
    const page = await listCatalogVenueChanges(context, { pageSize: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(prisma.catalogVenueBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', venueId: 'venue-1' }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    )
    ;(prisma.catalogVenueBinding.findMany as jest.Mock).mockResolvedValue([])
    await listCatalogVenueChanges(context, { pageSize: 1, cursor: page.nextCursor })
    expect((prisma.catalogVenueBinding.findMany as jest.Mock).mock.calls.at(-1)[0].where.OR).toEqual([
      { updatedAt: { lt: new Date('2026-08-08T10:00:00.000Z') } },
      { updatedAt: new Date('2026-08-08T10:00:00.000Z'), id: { lt: 'binding-1' } },
    ])
  })
})

import prisma from '@/utils/prismaClient'
import { writeCatalogAudit } from '@/services/master-catalog/catalogAudit.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import {
  confirmCatalogOverrideRequest,
  getCatalogVenueProvenance,
  previewCatalogOverrideRequest,
} from '@/services/master-catalog/catalogOverride.service'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, type CatalogVenueContext } from '@/types/master-catalog'

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

const allowedMembership = {
  role: 'MANAGER',
  permissionSetId: 'set-1',
  permissionSet: { venueId: 'venue-1', permissions: ['catalog-venue:read', 'catalog-venue:request-override'] },
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'binding-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    catalogItemId: 'item-1',
    productId: 'product-1',
    revision: 1,
    status: 'LINKED',
    managedFieldMask: CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
    lastPublishedCatalogRevision: null,
    lastPublishedManagedSnapshot: null,
    lastPublishedManagedHash: null,
    productUpdatedAtObserved: null,
    createdAt: now,
    updatedAt: now,
    venue: { currency: 'MXN' },
    product: {
      id: 'product-1',
      updatedAt: now,
      name: 'Local',
      cost: null,
      description: null,
      imageUrl: null,
      objetoImp: '01',
      satProductKey: null,
      satUnitKey: null,
      taxRate: '0.0800',
      type: 'REGULAR',
      unit: null,
    },
    catalogItem: {
      id: 'item-1',
      kind: 'PREPARED_DISH',
      revision: 2,
      name: 'Corporativo',
      description: 'D',
      imageUrl: 'I',
      objetoImp: '02',
      satProductKey: '1',
      satUnitKey: 'H87',
      taxRate: '0.1600',
      productType: 'FOOD_AND_BEV',
      unit: 'PIECE',
    },
    ...overrides,
  }
}

function previewRecord() {
  const data = (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls.at(-1)[0].data
  return { id: 'batch-1', ...data, updatedAt: data.createdAt }
}

function relationalRequest(status = 'REQUESTED') {
  return { id: 'override-replay', field: 'name', localValue: 'Local', reason: 'Motivo local', status, requestedById: 'staff-1' }
}

async function preview() {
  return previewCatalogOverrideRequest(context, {
    bindingId: 'binding-1',
    idempotencyKey: 'key-1',
    requests: [{ field: 'name', reason: 'Motivo local' }],
  })
}

describe('catalog override concurrency and exact authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(now)
    ;(prisma.$transaction as jest.Mock).mockImplementation(async callback => callback(prisma))
    ;(prisma.$executeRaw as jest.Mock).mockResolvedValue(1)
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(allowedMembership)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(binding())
    ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockImplementation(async ({ data }) => ({ id: 'batch-1', ...data }))
    ;(prisma.catalogIdempotencyRecord.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.catalogVenueOverride.create as jest.Mock).mockResolvedValue({ id: 'override-1' })
    ;(writeCatalogAudit as jest.Mock).mockResolvedValue(undefined)
  })

  afterEach(() => jest.useRealTimers())

  it('denies the generic SUPERADMIN wildcard for preview, confirm, and reads', async () => {
    const reviewed = await preview()
    const record = previewRecord()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ role: 'SUPERADMIN', permissionSetId: null, permissionSet: null })
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(record)

    await expect(preview()).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_VENUE_PERMISSION_DENIED' })
    await expect(getCatalogVenueProvenance(context, { productId: 'product-1' })).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_VENUE_PERMISSION_DENIED' })
  })

  it('treats an empty VenueRolePermission row as an authoritative denial', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ role: 'OWNER', permissionSetId: null, permissionSet: null })
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({ permissions: [] })
    await expect(preview()).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_VENUE_PERMISSION_DENIED' })
  })

  it('tenant-safely denies a PermissionSet owned by another venue', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({
      ...allowedMembership,
      permissionSet: { venueId: 'venue-other', permissions: ['catalog-venue:request-override'] },
    })
    await expect(preview()).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each([
    ['partial', ['name']],
    ['out-of-order', [...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1].reverse()],
    ['duplicated', [...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, 'name']],
  ])('fails closed on a %s persisted managed mask', async (_label, managedFieldMask) => {
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(binding({ managedFieldMask }))
    await expect(
      previewCatalogOverrideRequest(context, {
        bindingId: 'binding-1',
        idempotencyKey: 'mask-key',
        requests: [{ field: 'description', reason: 'Descripción local' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_BINDING_MANAGED_MASK_INVALID' })
  })

  it('fails provenance closed when its persisted managed mask is corrupt', async () => {
    ;(prisma.catalogVenueBinding.findFirst as jest.Mock).mockResolvedValue(
      binding({ managedFieldMask: [...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, 'name'] }),
    )
    await expect(getCatalogVenueProvenance(context, { productId: 'product-1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_BINDING_MANAGED_MASK_INVALID',
    })
  })

  it('keeps resourceType/resourceId null-compatible across PREVIEWED to APPLIED', async () => {
    const reviewed = await preview()
    const record = previewRecord()
    expect(record.resourceType).toBeUndefined()
    expect(record.resourceId).toBeUndefined()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(record)
    await confirmCatalogOverrideRequest(context, {
      requestBatchId: reviewed.requestBatchId,
      previewToken: reviewed.previewToken,
      confirm: true,
      idempotencyKey: 'key-1',
    })
    expect((prisma.catalogIdempotencyRecord.updateMany as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('resourceType')
  })

  it.each([
    ['actor', { staffId: 'staff-other' }, {}, 'CATALOG_OVERRIDE_ACTOR_MISMATCH'],
    ['key', {}, { idempotencyKey: 'key-other' }, 'IDEMPOTENCY_KEY_REUSED'],
    ['token', {}, { previewToken: 'token-other' }, 'CATALOG_OVERRIDE_PREVIEW_TOKEN_INVALID'],
    ['expiry', { previewExpiresAt: now }, {}, 'CATALOG_OVERRIDE_PREVIEW_EXPIRED'],
  ])('rejects a mismatched or stale confirmation identity: %s', async (_label, recordPatch, inputPatch, code) => {
    const reviewed = await preview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({ ...previewRecord(), ...recordPatch })
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
        ...inputPatch,
      }),
    ).rejects.toMatchObject({ code })
    expect(prisma.catalogVenueOverride.create).not.toHaveBeenCalled()
  })

  it('recovers the exact APPLIED relational result after a same-batch serialization loser aborts', async () => {
    const reviewed = await preview()
    const record = previewRecord()
    ;(prisma.$transaction as jest.Mock).mockRejectedValueOnce({ code: 'P2034' })
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({ ...record, state: 'APPLIED', completedAt: now })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([
      { id: 'override-winner', field: 'name', localValue: 'Local', reason: 'Motivo local', status: 'REQUESTED', requestedById: 'staff-1' },
    ])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).resolves.toEqual({ requestBatchId: 'batch-1', state: 'APPLIED', overrideIds: ['override-winner'] })
  })

  it('replays an applied request after Task 9 advances its row to APPROVED', async () => {
    const reviewed = await preview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({
      ...previewRecord(),
      state: 'APPLIED',
      completedAt: now,
    })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'override-approved',
        field: 'name',
        localValue: 'Local',
        reason: 'Motivo local',
        status: 'APPROVED',
        requestedById: 'staff-1',
        requestedAt: now,
        decidedById: 'staff-2',
        decidedAt: now,
      },
    ])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).resolves.toEqual({ requestBatchId: 'batch-1', state: 'APPLIED', overrideIds: ['override-approved'] })
  })

  it('never accepts a DETECTED row as an applied request replay', async () => {
    const reviewed = await preview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({ ...previewRecord(), state: 'APPLIED', completedAt: now })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([
      { id: 'detected', field: 'name', localValue: 'Local', reason: 'Motivo local', status: 'DETECTED', requestedById: 'staff-1' },
    ])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_OVERRIDE_RESULT_INVALID' })
  })

  it('rejects APPLIED recovery when durable dependencies no longer match their target hash', async () => {
    const reviewed = await preview()
    const record = previewRecord()
    const dependencies = {
      ...record.dependencies,
      requests: record.dependencies.requests.map((line: Record<string, unknown>) => ({ ...line, corporateValue: 'forged' })),
    }
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({ ...record, state: 'APPLIED', dependencies })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([relationalRequest()])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_OVERRIDE_PREVIEW_INVALID' })
  })

  it.each([
    ['top-level', (dependencies: any) => ({ ...dependencies, injected: true })],
    ['request-line', (dependencies: any) => ({ ...dependencies, requests: [{ ...dependencies.requests[0], injected: true }] })],
  ])('rejects a hash-consistent dependency snapshot with an extra %s key', async (_label, inject) => {
    const reviewed = await preview()
    const record = previewRecord()
    const dependencies = inject(record.dependencies)
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue({
      ...record,
      state: 'APPLIED',
      dependencies,
      targetHash: hashCanonicalJsonV1('catalog-override-target', dependencies),
    })
    ;(prisma.catalogVenueOverride.findMany as jest.Mock).mockResolvedValue([relationalRequest()])
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_OVERRIDE_PREVIEW_INVALID' })
  })

  it('recognizes Prisma field-array metadata for the exact idempotency reservation', async () => {
    ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockRejectedValue({
      code: 'P2002',
      meta: { target: ['organizationId', 'operation', 'idempotencyKey'] },
    })
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockImplementation(async () => ({
      requestHash: (prisma.catalogIdempotencyRecord.create as jest.Mock).mock.calls[0][0].data.requestHash,
      state: 'PREVIEWED',
    }))
    await expect(preview()).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_OVERRIDE_PREVIEW_TOKEN_NOT_RECOVERABLE',
    })
  })

  it('maps Prisma field-array metadata for the exact REQUESTED partial unique', async () => {
    const reviewed = await preview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(previewRecord())
    ;(prisma.catalogVenueOverride.create as jest.Mock).mockRejectedValue({
      code: 'P2002',
      meta: { target: ['organizationId', 'bindingId', 'field'] },
    })
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_OVERRIDE_ALREADY_REQUESTED' })
  })

  it.each([
    ['preview', { code: 'P2002', meta: { target: 'Another_unique_key' } }],
    ['confirm', { code: 'P2002', meta: { target: 'ActivityLog_unique_key' } }],
  ])('does not relabel an unrelated P2002 raised during %s', async (phase, failure) => {
    if (phase === 'preview') {
      ;(prisma.catalogIdempotencyRecord.create as jest.Mock).mockRejectedValue(failure)
      await expect(preview()).rejects.toBe(failure)
      return
    }
    const reviewed = await preview()
    ;(prisma.catalogIdempotencyRecord.findFirst as jest.Mock).mockResolvedValue(previewRecord())
    ;(prisma.catalogVenueOverride.create as jest.Mock).mockRejectedValue(failure)
    await expect(
      confirmCatalogOverrideRequest(context, {
        requestBatchId: reviewed.requestBatchId,
        previewToken: reviewed.previewToken,
        confirm: true,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toBe(failure)
  })
})

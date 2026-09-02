import { Prisma, StaffRole } from '@prisma/client'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialDirectQuoteV3Service,
  type CommercialDirectQuoteV3Transaction,
} from '@/services/commercial/quotes-v3/commercialDirectQuoteV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'

jest.mock('@/utils/prismaClient', () =>
  Object.defineProperty({ __esModule: true }, 'default', {
    enumerable: true,
    get() {
      throw new Error('COMMERCIAL_DIRECT_QUOTE_V3_GLOBAL_PRISMA_IMPORTED')
    },
  }),
)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const emittedOffer = emitCommercialOfferV3(clone(offerFixture) as CommercialOfferSnapshotV3)
const quoteInput = {
  organizationId: 'organization-direct-v3',
  venueId: 'venue-direct-v3',
  actorId: 'staff-direct-v3',
  offerVersionId: emittedOffer.snapshot.campaignVersionId,
  saasSelections: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
  hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 1 }],
  rateBlockers: [],
  correlationId: 'correlation-direct-v3',
}

function offerRow() {
  return {
    id: emittedOffer.snapshot.campaignVersionId,
    campaignCode: emittedOffer.snapshot.campaignCode,
    sourceRevision: emittedOffer.snapshot.version,
    schemaVersion: 3,
    snapshot: emittedOffer.snapshot,
    checksum: emittedOffer.checksum,
    publishedAt: new Date(emittedOffer.snapshot.publishedAt),
  }
}

function catalogRow() {
  return {
    id: catalog.snapshot.publicationId,
    schemaVersion: 2,
    snapshot: catalog.snapshot,
    checksum: catalog.checksum,
    publishedAt: new Date(catalog.snapshot.publishedAt),
  }
}

function harness() {
  const calls: string[] = []
  const tx: CommercialDirectQuoteV3Transaction = {
    setLocalLockTimeout: jest.fn(async milliseconds => {
      calls.push(`timeout:${milliseconds}`)
    }),
    lockOffer: jest.fn(async id => {
      calls.push(`offer:${id}`)
      return offerRow()
    }),
    readLatestOfferControl: jest.fn(async id => {
      calls.push(`control:${id}`)
      return null
    }),
    lockActiveCatalog: jest.fn(async () => {
      calls.push('catalog')
      return catalogRow()
    }),
    lockOrganization: jest.fn(async id => {
      calls.push(`organization:${id}`)
      return { id }
    }),
    lockVenue: jest.fn(async id => {
      calls.push(`venue:${id}`)
      return { id, organizationId: quoteInput.organizationId }
    }),
    lockStaff: jest.fn(async id => {
      calls.push(`staff:${id}`)
      return { id, active: true }
    }),
    lockMembership: jest.fn(async (staffId, venueId) => {
      calls.push(`membership:${staffId}:${venueId}`)
      return {
        staffId,
        venueId,
        active: true,
        role: StaffRole.OWNER,
        permissionSetId: null,
      }
    }),
    lockPermissionSet: jest.fn(async id => {
      calls.push(`permission-set:${id ?? 'none'}`)
      return null
    }),
    lockRoleOverride: jest.fn(async (venueId, role) => {
      calls.push(`role-override:${venueId}:${role}`)
      return null
    }),
    readDatabaseClock: jest.fn(async () => {
      calls.push('clock')
      return new Date('2026-08-15T12:00:00.000Z')
    }),
    commercialQuote: {
      create: jest.fn(async ({ data }) => {
        calls.push('quote')
        return { id: data.id as string }
      }),
    },
    activityLog: {
      create: jest.fn(async () => {
        calls.push('audit')
        return { id: 'activity-direct-v3' }
      }),
    },
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const sleep = jest.fn(async () => undefined)
  const service = createCommercialDirectQuoteV3Service({
    runInTransaction,
    randomId: () => 'commercial-quote-direct-created-v3',
    sleep,
    retryDelayMilliseconds: () => 42,
  })
  return { service, tx, calls, runInTransaction, sleep }
}

describe('Commercial direct Quote v3 orchestration', () => {
  it.each(['customer@example.com', 'line-one\nline-two'])(
    'rejects unsafe correlation id %j before opening a transaction',
    async correlationId => {
      const { service, runInTransaction } = harness()
      await expect(service.create({ ...quoteInput, correlationId })).rejects.toMatchObject({
        statusCode: 422,
        code: 'COMMERCIAL_DIRECT_QUOTE_V3_INPUT_INVALID',
      })
      expect(runInTransaction).not.toHaveBeenCalled()
    },
  )

  it('materializes input before locks and follows the exact locked authority order in one READ COMMITTED transaction', async () => {
    const { service, tx, calls, runInTransaction } = harness()

    await expect(service.create(quoteInput)).resolves.toMatchObject({
      id: 'commercial-quote-direct-created-v3',
      snapshot: {
        quoteId: 'commercial-quote-direct-created-v3',
        subject: {
          kind: 'VENUE',
          organizationId: quoteInput.organizationId,
          venueId: quoteInput.venueId,
          actorId: quoteInput.actorId,
        },
        quotedAt: '2026-08-15T12:00:00.000Z',
        expiresAt: '2026-08-15T12:15:00.000Z',
      },
    })
    expect(calls).toEqual([
      'timeout:1000',
      `offer:${quoteInput.offerVersionId}`,
      `control:${quoteInput.offerVersionId}`,
      'catalog',
      `organization:${quoteInput.organizationId}`,
      `venue:${quoteInput.venueId}`,
      `staff:${quoteInput.actorId}`,
      `membership:${quoteInput.actorId}:${quoteInput.venueId}`,
      'permission-set:none',
      `role-override:${quoteInput.venueId}:OWNER`,
      'clock',
      'quote',
      'audit',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
    expect(tx.commercialQuote.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        data: expect.objectContaining({ correlationId: quoteInput.correlationId }),
      }),
    })
  })

  it('rejects a hostile selection before opening the transaction or touching any global authority', async () => {
    const { service, runInTransaction } = harness()
    const hostile = new Proxy(quoteInput.saasSelections, {
      ownKeys() {
        throw new Error('hostile')
      },
    })

    await expect(service.create({ ...quoteInput, saasSelections: hostile })).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_INPUT_INVALID',
    })
    expect(runInTransaction).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing Offer',
      (tx: CommercialDirectQuoteV3Transaction) => (tx.lockOffer as jest.Mock).mockResolvedValue(null),
      'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_UNAVAILABLE',
    ],
    [
      'mutated Offer checksum',
      (tx: CommercialDirectQuoteV3Transaction) => {
        const row = offerRow()
        row.snapshot = { ...row.snapshot, status: 'INACTIVE' }
        ;(tx.lockOffer as jest.Mock).mockResolvedValue(row)
      },
      'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_INVALID',
    ],
    [
      'valid but inactive Offer',
      (tx: CommercialDirectQuoteV3Transaction) => {
        const inactive = emitCommercialOfferV3({ ...clone(emittedOffer.snapshot), status: 'INACTIVE' })
        ;(tx.lockOffer as jest.Mock).mockResolvedValue({
          ...offerRow(),
          snapshot: inactive.snapshot,
          checksum: inactive.checksum,
        })
      },
      'COMMERCIAL_DIRECT_QUOTE_V3_OFFER_INVALID',
    ],
    [
      'suspended pending',
      (tx: CommercialDirectQuoteV3Transaction) =>
        (tx.readLatestOfferControl as jest.Mock).mockResolvedValue({ revision: 1, action: 'SUSPEND_ALL_PENDING' }),
      'COMMERCIAL_OFFER_PENDING_SUSPENDED',
    ],
    [
      'missing active Catalog',
      (tx: CommercialDirectQuoteV3Transaction) => (tx.lockActiveCatalog as jest.Mock).mockResolvedValue(null),
      'COMMERCIAL_DIRECT_QUOTE_V3_CATALOG_UNAVAILABLE',
    ],
    [
      'Catalog schema drift',
      (tx: CommercialDirectQuoteV3Transaction) => {
        const row = catalogRow()
        row.schemaVersion = 1
        ;(tx.lockActiveCatalog as jest.Mock).mockResolvedValue(row)
      },
      'COMMERCIAL_DIRECT_QUOTE_V3_CATALOG_INVALID',
    ],
    [
      'missing organization',
      (tx: CommercialDirectQuoteV3Transaction) => (tx.lockOrganization as jest.Mock).mockResolvedValue(null),
      'COMMERCIAL_DIRECT_QUOTE_V3_ORGANIZATION_UNAVAILABLE',
    ],
    [
      'missing venue',
      (tx: CommercialDirectQuoteV3Transaction) => (tx.lockVenue as jest.Mock).mockResolvedValue(null),
      'COMMERCIAL_DIRECT_QUOTE_V3_VENUE_UNAVAILABLE',
    ],
    [
      'venue transfer',
      (tx: CommercialDirectQuoteV3Transaction) =>
        (tx.lockVenue as jest.Mock).mockResolvedValue({ id: quoteInput.venueId, organizationId: 'organization-other' }),
      'COMMERCIAL_QUOTE_V3_TENANT_MISMATCH',
    ],
    [
      'inactive Staff',
      (tx: CommercialDirectQuoteV3Transaction) => (tx.lockStaff as jest.Mock).mockResolvedValue({ id: quoteInput.actorId, active: false }),
      'COMMERCIAL_QUOTE_V3_ACTOR_INACTIVE',
    ],
    [
      'deactivated membership',
      (tx: CommercialDirectQuoteV3Transaction) => {
        const membership = {
          staffId: quoteInput.actorId,
          venueId: quoteInput.venueId,
          active: false,
          role: StaffRole.OWNER,
          permissionSetId: null,
        }
        ;(tx.lockMembership as jest.Mock).mockResolvedValue(membership)
      },
      'COMMERCIAL_QUOTE_V3_MEMBERSHIP_INACTIVE',
    ],
    [
      'role denial',
      (tx: CommercialDirectQuoteV3Transaction) => {
        ;(tx.lockMembership as jest.Mock).mockResolvedValue({
          staffId: quoteInput.actorId,
          venueId: quoteInput.venueId,
          active: true,
          role: StaffRole.VIEWER,
          permissionSetId: null,
        })
        ;(tx.lockRoleOverride as jest.Mock).mockResolvedValue({
          permissions: ['orders:read'],
          deniedPermissions: ['billing:subscriptions:manage'],
        })
      },
      'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED',
    ],
  ])('rolls back before persistence on %s', async (_label, mutate, code) => {
    const { service, tx } = harness()
    mutate(tx)

    await expect(service.create(quoteInput)).rejects.toMatchObject({ code })
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('denies a replacement PermissionSet that lacks billing even though OWNER would grant it', async () => {
    const { service, tx } = harness()
    ;(tx.lockMembership as jest.Mock).mockResolvedValue({
      staffId: quoteInput.actorId,
      venueId: quoteInput.venueId,
      active: true,
      role: StaffRole.OWNER,
      permissionSetId: 'permission-set-replacement',
    })
    ;(tx.lockPermissionSet as jest.Mock).mockResolvedValue({
      id: 'permission-set-replacement',
      venueId: quoteInput.venueId,
      permissions: ['orders:read'],
    })
    ;(tx.lockRoleOverride as jest.Mock).mockResolvedValue({
      permissions: ['billing:subscriptions:manage'],
      deniedPermissions: [],
    })

    await expect(service.create(quoteInput)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED',
    })
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
  })

  it('fails fast on lock timeout with a stable unavailable error without persisting', async () => {
    const { service, tx, runInTransaction, sleep } = harness()
    const timeout = Object.assign(new Error('lock timeout'), { code: '55P03' })
    runInTransaction.mockRejectedValueOnce(timeout)

    await expect(service.create(quoteInput)).rejects.toMatchObject({
      code: 'COMMERCIAL_DIRECT_QUOTE_V3_UNAVAILABLE',
      details: { retryable: true, attempts: 1 },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
  })

  it.each([
    ['raw deadlock', Object.assign(new Error('deadlock'), { code: '40P01' })],
    ['Prisma nested deadlock', Object.assign(new Error('deadlock'), { code: 'P2010', meta: { sqlState: '40P01' } })],
    ['raw serialization failure', Object.assign(new Error('serialization failure'), { code: '40001' })],
    ['Prisma serialization conflict', Object.assign(new Error('serialization conflict'), { code: 'P2034' })],
  ])('retries one %s and then returns the bounded unavailable error', async (_label, deadlock) => {
    const { service, tx, runInTransaction, sleep } = harness()
    runInTransaction.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(deadlock)

    await expect(service.create(quoteInput)).rejects.toMatchObject({
      code: 'COMMERCIAL_DIRECT_QUOTE_V3_UNAVAILABLE',
      details: { retryable: true, attempts: 2 },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(42)
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
  })

  it('maps a Prisma interactive-transaction timeout to one stable rollback-safe error without retrying', async () => {
    const { service, tx, runInTransaction } = harness()
    runInTransaction.mockRejectedValueOnce(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }))

    await expect(service.create(quoteInput)).rejects.toMatchObject({
      statusCode: 503,
      code: 'COMMERCIAL_DIRECT_QUOTE_V3_TIMEOUT',
      details: { retryable: true, attempts: 1 },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
  })

  it('reports the exact attempt when a transaction timeout follows one concurrency retry', async () => {
    const { service, tx, runInTransaction } = harness()
    runInTransaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: '40001' }))
      .mockRejectedValueOnce(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }))

    await expect(service.create(quoteInput)).rejects.toMatchObject({
      statusCode: 503,
      code: 'COMMERCIAL_DIRECT_QUOTE_V3_TIMEOUT',
      details: { retryable: true, attempts: 2 },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(2)
    expect(tx.commercialQuote.create).not.toHaveBeenCalled()
  })
})

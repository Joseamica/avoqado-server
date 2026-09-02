import { Prisma, StaffRole } from '@prisma/client'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import quoteFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  COMMERCIAL_QUOTE_V3_ACCEPTANCE_TRANSACTION_OPTIONS,
  createCommercialQuoteV3AcceptanceService,
  type CommercialQuoteV3AcceptanceTransaction,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Acceptance.service'
import { emitCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities } from '@/types/commercialQuoteV3'

jest.mock('@/utils/prismaClient', () =>
  Object.defineProperty({ __esModule: true }, 'default', {
    enumerable: true,
    get() {
      throw new Error('COMMERCIAL_QUOTE_V3_ACCEPTANCE_GLOBAL_PRISMA_IMPORTED')
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
function directOfferSource(): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')
  if (saas?.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
  saas.rules = [
    {
      code: 'A_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 90,
      target: { productCodes: ['POS'] },
      cycles: 3,
      percentBasisPoints: 1000,
    },
    {
      code: 'Z_FIXED_200',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '200.00',
    },
  ]
  saas.stackingGroups = [
    {
      code: 'POS_STACK',
      steps: [
        { position: 1, ruleCode: 'Z_FIXED_200' },
        { position: 2, ruleCode: 'A_TEN_PERCENT' },
      ],
    },
  ]
  return source
}

const emittedOffer = emitCommercialOfferV3(directOfferSource())
const offer: CommercialQuoteV3Authorities['offer'] = {
  rowSchemaVersion: 3,
  snapshot: emittedOffer.snapshot,
  checksum: emittedOffer.checksum,
  rowContext: {
    id: emittedOffer.snapshot.campaignVersionId,
    campaignCode: emittedOffer.snapshot.campaignCode,
    sourceRevision: emittedOffer.snapshot.version,
    schemaVersion: 3,
    publishedAt: new Date(emittedOffer.snapshot.publishedAt),
  },
}
const emittedQuote = emitCommercialQuoteV3(clone(quoteFixture) as CommercialQuoteSnapshotV3, {
  catalog,
  offer,
  acquisitionContext: null,
})

const input = {
  quoteId: emittedQuote.snapshot.quoteId,
  organizationId: 'organization-direct-v3',
  venueId: 'venue-direct-v3',
  acceptedById: 'staff-authorized-acceptor-v3',
  idempotencyKey: 'acceptance-direct-v3-0001',
  correlationId: 'correlation-acceptance-v3',
}

const acquisitionContextId = 'acquisition-context-acceptance-v3'
const acquisitionContextCreatedAt = new Date('2026-08-15T11:45:00.000Z')
const acquisitionInput = {
  quoteId: 'quote-acquisition-acceptance-v3',
  organizationId: 'organization-acquisition-v3',
  venueId: 'venue-acquisition-v3',
  acceptedById: 'staff-acquisition-v3',
  idempotencyKey: 'acceptance-acquisition-v3-0001',
  correlationId: 'correlation-acquisition-acceptance-v3',
}
const acquisitionQuoteSource = clone(emittedQuote.snapshot)
acquisitionQuoteSource.quoteId = acquisitionInput.quoteId
acquisitionQuoteSource.subject = {
  kind: 'VENUE',
  organizationId: acquisitionInput.organizationId,
  venueId: acquisitionInput.venueId,
  actorId: acquisitionInput.acceptedById,
}
acquisitionQuoteSource.acquisitionContextId = acquisitionContextId
acquisitionQuoteSource.resolution.resolvedAt = acquisitionContextCreatedAt.toISOString()
acquisitionQuoteSource.derivedFromPreview = {
  previewQuoteId: 'preview-quote-acquisition-v3',
  previewChecksum: 'a'.repeat(64),
  selectionFingerprint: 'b'.repeat(64),
}
const emittedAcquisitionQuote = emitCommercialQuoteV3(acquisitionQuoteSource, {
  catalog,
  offer,
  acquisitionContext: { id: acquisitionContextId, createdAt: acquisitionContextCreatedAt },
})

function quoteRow() {
  const dueNow = emittedQuote.snapshot.totals.dueNow
  const renewal = emittedQuote.snapshot.renewal
  return {
    id: emittedQuote.snapshot.quoteId,
    schemaVersion: 3,
    catalogPublicationId: catalog.snapshot.publicationId,
    offerVersionId: emittedOffer.snapshot.campaignVersionId,
    offerSchemaVersion: 3,
    acquisitionContextId: null,
    organizationId: input.organizationId,
    venueId: input.venueId,
    createdById: 'staff-direct-v3',
    market: 'MX',
    currency: 'MXN',
    snapshot: emittedQuote.snapshot,
    checksum: emittedQuote.checksum,
    listSubtotalMinor: BigInt(dueNow.listSubtotalMinor),
    discountMinor: BigInt(dueNow.discountMinor),
    subtotalMinor: BigInt(dueNow.subtotalMinor),
    taxMinor: BigInt(dueNow.taxMinor),
    totalMinor: BigInt(dueNow.totalMinor),
    renewalSubtotalMinor: BigInt(renewal.subtotalMinor),
    renewalTaxMinor: BigInt(renewal.taxMinor),
    renewalTotalMinor: BigInt(renewal.totalMinor),
    quotedAt: new Date(emittedQuote.snapshot.quotedAt),
    expiresAt: new Date(emittedQuote.snapshot.expiresAt),
  }
}

function acquisitionQuoteRow() {
  const dueNow = emittedAcquisitionQuote.snapshot.totals.dueNow
  const renewal = emittedAcquisitionQuote.snapshot.renewal
  return {
    id: emittedAcquisitionQuote.snapshot.quoteId,
    schemaVersion: 3,
    catalogPublicationId: catalog.snapshot.publicationId,
    offerVersionId: emittedOffer.snapshot.campaignVersionId,
    offerSchemaVersion: 3,
    acquisitionContextId,
    organizationId: acquisitionInput.organizationId,
    venueId: acquisitionInput.venueId,
    createdById: acquisitionInput.acceptedById,
    market: 'MX',
    currency: 'MXN',
    snapshot: emittedAcquisitionQuote.snapshot,
    checksum: emittedAcquisitionQuote.checksum,
    listSubtotalMinor: BigInt(dueNow.listSubtotalMinor),
    discountMinor: BigInt(dueNow.discountMinor),
    subtotalMinor: BigInt(dueNow.subtotalMinor),
    taxMinor: BigInt(dueNow.taxMinor),
    totalMinor: BigInt(dueNow.totalMinor),
    renewalSubtotalMinor: BigInt(renewal.subtotalMinor),
    renewalTaxMinor: BigInt(renewal.taxMinor),
    renewalTotalMinor: BigInt(renewal.totalMinor),
    quotedAt: new Date(emittedAcquisitionQuote.snapshot.quotedAt),
    expiresAt: new Date(emittedAcquisitionQuote.snapshot.expiresAt),
  }
}

function acceptance(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acceptance-direct-v3',
    quoteId: input.quoteId,
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
    venueId: input.venueId,
    acceptedById: input.acceptedById,
    status: 'ACCEPTED',
    revision: 1,
    acceptedAt: new Date('2026-08-15T12:10:00.321Z'),
    ...overrides,
  }
}

function harness() {
  const calls: string[] = []
  const tx: CommercialQuoteV3AcceptanceTransaction = {
    setLocalLockTimeout: jest.fn(async milliseconds => {
      calls.push(`timeout:${milliseconds}`)
    }),
    discoverQuote: jest.fn(async (quoteId, organizationId, venueId) => {
      calls.push(`discover:${quoteId}:${organizationId}:${venueId}`)
      const row = quoteRow()
      return {
        id: row.id,
        schemaVersion: row.schemaVersion,
        catalogPublicationId: row.catalogPublicationId,
        offerVersionId: row.offerVersionId,
        offerSchemaVersion: row.offerSchemaVersion,
        acquisitionContextId: row.acquisitionContextId,
      }
    }),
    lockOffer: jest.fn(async offerVersionId => {
      calls.push(`offer:${offerVersionId}`)
      return {
        id: offerVersionId,
        campaignCode: emittedOffer.snapshot.campaignCode,
        sourceRevision: emittedOffer.snapshot.version,
        schemaVersion: 3,
        snapshot: emittedOffer.snapshot,
        checksum: emittedOffer.checksum,
        publishedAt: new Date(emittedOffer.snapshot.publishedAt),
      }
    }),
    readLatestOfferControl: jest.fn(async offerVersionId => {
      calls.push(`control:${offerVersionId}`)
      return null
    }),
    lockCatalog: jest.fn(async publicationId => {
      calls.push(`catalog:${publicationId}`)
      return {
        id: publicationId,
        schemaVersion: 2,
        snapshot: catalog.snapshot,
        checksum: catalog.checksum,
        publishedAt: new Date(catalog.snapshot.publishedAt),
      }
    }),
    lockAcquisitionContext: jest.fn(async () => null),
    lockAcquisitionBinding: jest.fn(async () => null),
    lockOrganization: jest.fn(async organizationId => {
      calls.push(`organization:${organizationId}`)
      return { id: organizationId }
    }),
    lockVenue: jest.fn(async venueId => {
      calls.push(`venue:${venueId}`)
      return { id: venueId, organizationId: input.organizationId }
    }),
    lockStaff: jest.fn(async staffId => {
      calls.push(`staff:${staffId}`)
      return { id: staffId, active: true }
    }),
    lockMembership: jest.fn(async (staffId, venueId) => {
      calls.push(`membership:${staffId}:${venueId}`)
      return { staffId, venueId, active: true, role: StaffRole.OWNER, permissionSetId: null }
    }),
    lockPermissionSet: jest.fn(async permissionSetId => {
      calls.push(`permission-set:${permissionSetId ?? 'none'}`)
      return null
    }),
    lockRoleOverride: jest.fn(async (venueId, role) => {
      calls.push(`role-override:${venueId}:${role}`)
      return null
    }),
    lockQuote: jest.fn(async quoteId => {
      calls.push(`quote:${quoteId}`)
      return quoteRow()
    }),
    lockPreviewBridgeByQuoteId: jest.fn(async () => null),
    readDatabaseClock: jest.fn(async () => {
      calls.push('clock')
      return new Date('2026-08-15T12:10:00.321Z')
    }),
    findAcceptanceByQuoteId: jest.fn(async quoteId => {
      calls.push(`existing:${quoteId}`)
      return null
    }),
    findRedemptionByContextId: jest.fn(async () => null),
    createAcceptance: jest.fn(async createInput => {
      calls.push('acceptance')
      return acceptance({ id: createInput.id, acceptedAt: createInput.acceptedAt }) as never
    }),
    createRedemption: jest.fn(async () => {
      throw new Error('DIRECT_ACCEPTANCE_MUST_NOT_REDEEM_ACQUISITION')
    }),
    writeAudit: jest.fn(async () => {
      calls.push('audit')
    }),
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const recordPoisonedResolution = jest.fn()
  const sleep = jest.fn<Promise<void>, [number]>(async () => undefined)
  const service = createCommercialQuoteV3AcceptanceService({
    runInTransaction,
    randomId: () => 'acceptance-direct-v3',
    sleep,
    retryDelayMilliseconds: () => 0,
    recordPoisonedResolution,
  })
  return { service, tx, calls, runInTransaction, recordPoisonedResolution, sleep }
}

function acquisitionAcceptance(overrides: Partial<Record<string, unknown>> = {}) {
  return acceptance({
    id: 'acceptance-acquisition-v3',
    quoteId: acquisitionInput.quoteId,
    idempotencyKey: acquisitionInput.idempotencyKey,
    organizationId: acquisitionInput.organizationId,
    venueId: acquisitionInput.venueId,
    acceptedById: acquisitionInput.acceptedById,
    ...overrides,
  })
}

function acquisitionRedemption(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'redemption-acquisition-v3',
    acquisitionContextId,
    quoteId: acquisitionInput.quoteId,
    acceptanceId: 'acceptance-acquisition-v3',
    organizationId: acquisitionInput.organizationId,
    venueId: acquisitionInput.venueId,
    staffId: acquisitionInput.acceptedById,
    redeemedAt: new Date('2026-08-15T12:10:00.321Z'),
    ...overrides,
  }
}

function acquisitionHarness() {
  const base = harness()
  const calls = base.calls
  const tx = base.tx as CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>
  ;(tx.discoverQuote as jest.Mock).mockImplementation(async (quoteId, organizationId, venueId) => {
    calls.push(`discover:${quoteId}:${organizationId}:${venueId}`)
    const row = acquisitionQuoteRow()
    return {
      id: row.id,
      schemaVersion: row.schemaVersion,
      catalogPublicationId: row.catalogPublicationId,
      offerVersionId: row.offerVersionId,
      offerSchemaVersion: row.offerSchemaVersion,
      acquisitionContextId: row.acquisitionContextId,
    }
  })
  ;(tx.lockOrganization as jest.Mock).mockImplementation(async organizationId => {
    calls.push(`organization:${organizationId}`)
    return { id: organizationId }
  })
  ;(tx.lockVenue as jest.Mock).mockImplementation(async venueId => {
    calls.push(`venue:${venueId}`)
    return { id: venueId, organizationId: acquisitionInput.organizationId }
  })
  ;(tx.lockQuote as jest.Mock).mockImplementation(async quoteId => {
    calls.push(`quote:${quoteId}`)
    return acquisitionQuoteRow()
  })
  ;(tx.createAcceptance as jest.Mock).mockImplementation(async createInput => {
    calls.push('acceptance')
    return acquisitionAcceptance({ id: createInput.id, acceptedAt: createInput.acceptedAt })
  })
  tx.lockAcquisitionContext = jest.fn(async contextId => {
    calls.push(`context:${contextId}`)
    return {
      id: contextId,
      offerVersionId: emittedOffer.snapshot.campaignVersionId,
      offerSchemaVersion: 3,
      reservedCatalogPublicationId: catalog.snapshot.publicationId,
      reservedCatalogSchemaVersion: 2,
      createdAt: acquisitionContextCreatedAt,
    }
  })
  tx.lockAcquisitionBinding = jest.fn(async contextId => {
    calls.push(`binding:${contextId}`)
    return {
      acquisitionContextId: contextId,
      staffId: acquisitionInput.acceptedById,
      organizationId: acquisitionInput.organizationId,
      purpose: 'NEW_ACCOUNT' as const,
    }
  })
  tx.lockPreviewBridgeByQuoteId = jest.fn(async quoteId => {
    calls.push(`bridge:${quoteId}`)
    return {
      previewQuoteId: emittedAcquisitionQuote.snapshot.derivedFromPreview!.previewQuoteId,
      previewChecksum: emittedAcquisitionQuote.snapshot.derivedFromPreview!.previewChecksum,
      acquisitionContextId,
      organizationId: acquisitionInput.organizationId,
      venueId: acquisitionInput.venueId,
      actorId: acquisitionInput.acceptedById,
      selectionFingerprint: emittedAcquisitionQuote.snapshot.derivedFromPreview!.selectionFingerprint,
      venueQuoteId: quoteId,
    }
  })
  tx.findRedemptionByContextId = jest.fn(async contextId => {
    calls.push(`redemption-existing:${contextId}`)
    return null
  })
  tx.createRedemption = jest.fn(async createInput => {
    calls.push('redemption')
    return acquisitionRedemption({ id: createInput.id, redeemedAt: createInput.redeemedAt })
  })
  const service = createCommercialQuoteV3AcceptanceService({
    runInTransaction: base.runInTransaction,
    randomId: jest
      .fn()
      .mockReturnValueOnce('acceptance-acquisition-v3')
      .mockReturnValueOnce('redemption-acquisition-v3'),
    sleep: base.sleep,
    retryDelayMilliseconds: () => 0,
    recordPoisonedResolution: base.recordPoisonedResolution,
  })
  return { ...base, service, tx }
}

describe('Commercial Quote v3 acceptance consent boundary', () => {
  it('locks immutable sources and current actor authority in canonical order before storing consent only', async () => {
    const { service, tx, calls, runInTransaction } = harness()

    await expect(service.accept(input)).resolves.toMatchObject({
      id: 'acceptance-direct-v3',
      quoteId: input.quoteId,
      acceptedById: input.acceptedById,
      status: 'ACCEPTED',
      revision: 1,
    })

    expect(calls).toEqual([
      'timeout:1000',
      `discover:${input.quoteId}:${input.organizationId}:${input.venueId}`,
      `offer:${emittedOffer.snapshot.campaignVersionId}`,
      `control:${emittedOffer.snapshot.campaignVersionId}`,
      `catalog:${catalog.snapshot.publicationId}`,
      `organization:${input.organizationId}`,
      `venue:${input.venueId}`,
      `staff:${input.acceptedById}`,
      `membership:${input.acceptedById}:${input.venueId}`,
      'permission-set:none',
      `role-override:${input.venueId}:OWNER`,
      `quote:${input.quoteId}`,
      `existing:${input.quoteId}`,
      'clock',
      'acceptance',
      'audit',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), COMMERCIAL_QUOTE_V3_ACCEPTANCE_TRANSACTION_OPTIONS)
    expect(tx.createAcceptance).toHaveBeenCalledWith({
      id: 'acceptance-direct-v3',
      quoteId: input.quoteId,
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      venueId: input.venueId,
      acceptedById: input.acceptedById,
      status: 'ACCEPTED',
      revision: 1,
      acceptedAt: new Date('2026-08-15T12:10:00.321Z'),
    })
    expect(tx.writeAudit).toHaveBeenCalledWith({
      acceptanceId: 'acceptance-direct-v3',
      quoteId: input.quoteId,
      organizationId: input.organizationId,
      venueId: input.venueId,
      acceptedById: input.acceptedById,
      acceptedAt: new Date('2026-08-15T12:10:00.321Z'),
    })
    expect(JSON.stringify((tx.writeAudit as jest.Mock).mock.calls)).not.toMatch(/snapshot|checksum|correlation/i)
  })

  it('returns the stored row for the same quote and key without inserting or auditing again', async () => {
    const { service, tx } = harness()
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acceptance())

    await expect(service.accept(input)).resolves.toEqual(acceptance())
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it.each([
    ['quote expiry', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.readDatabaseClock as jest.Mock).mockResolvedValue(new Date('2026-08-15T12:15:00.000Z'))
    }],
    ['emergency suspension', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.readLatestOfferControl as jest.Mock).mockResolvedValue({ revision: 1, action: 'SUSPEND_ALL_PENDING' })
    }],
    ['Staff deactivation', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockStaff as jest.Mock).mockResolvedValue({ id: input.acceptedById, active: false })
    }],
    ['actor permission revocation', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockMembership as jest.Mock).mockResolvedValue({
        staffId: input.acceptedById,
        venueId: input.venueId,
        active: true,
        role: StaffRole.OWNER,
        permissionSetId: 'permission-set-revoked-after-acceptance',
      })
      ;(tx.lockPermissionSet as jest.Mock).mockResolvedValue({
        id: 'permission-set-revoked-after-acceptance',
        venueId: input.venueId,
        permissions: ['orders:read'],
      })
    }],
  ])('replays the stored same-key acceptance before later %s', async (_name, mutate) => {
    const { service, tx } = harness()
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acceptance())
    mutate(tx)

    await expect(service.accept(input)).resolves.toEqual(acceptance())
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it.each([
    ['same key', input.idempotencyKey],
    ['different key', 'acceptance-foreign-actor-key-0001'],
  ])('never replays or exposes the stored acceptance to a different actor using the %s', async (_name, idempotencyKey) => {
    const { service, tx } = harness()
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acceptance())

    await expect(
      service.accept({
        ...input,
        acceptedById: 'staff-foreign-acceptor-v3',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED',
    })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects a different key after acceptance', async () => {
    const { service, tx } = harness()
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acceptance({ idempotencyKey: 'acceptance-other-key-0001' }))

    await expect(service.accept(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_ALREADY_ACCEPTED',
    })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
  })

  it.each([
    ['missing discovery row', (tx: CommercialQuoteV3AcceptanceTransaction) => (tx.discoverQuote as jest.Mock).mockResolvedValue(null), 'COMMERCIAL_QUOTE_V3_NOT_FOUND'],
    ['missing locked quote', (tx: CommercialQuoteV3AcceptanceTransaction) => (tx.lockQuote as jest.Mock).mockResolvedValue(null), 'COMMERCIAL_QUOTE_V3_NOT_FOUND'],
    ['schema mismatch', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      const row = quoteRow()
      ;(tx.discoverQuote as jest.Mock).mockResolvedValue({
        id: row.id,
        schemaVersion: 2,
        catalogPublicationId: row.catalogPublicationId,
        offerVersionId: null,
        offerSchemaVersion: null,
      })
    }, 'COMMERCIAL_QUOTE_V3_SCHEMA_UNSUPPORTED'],
    ['tenant mismatch', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockVenue as jest.Mock).mockResolvedValue({ id: input.venueId, organizationId: 'organization-foreign' })
    }, 'COMMERCIAL_QUOTE_V3_NOT_FOUND'],
    ['inactive Staff', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockStaff as jest.Mock).mockResolvedValue({ id: input.acceptedById, active: false })
    }, 'COMMERCIAL_QUOTE_V3_ACTOR_INACTIVE'],
    ['inactive membership', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockMembership as jest.Mock).mockResolvedValue({
        staffId: input.acceptedById,
        venueId: input.venueId,
        active: false,
        role: StaffRole.OWNER,
        permissionSetId: null,
      })
    }, 'COMMERCIAL_QUOTE_V3_MEMBERSHIP_INACTIVE'],
    ['expired quote', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.readDatabaseClock as jest.Mock).mockResolvedValue(new Date('2026-08-15T12:15:00.000Z'))
    }, 'COMMERCIAL_QUOTE_V3_EXPIRED'],
    ['source identity drift', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.lockQuote as jest.Mock).mockResolvedValue({
        ...quoteRow(),
        catalogPublicationId: 'catalog-publication-changed',
      })
    }, 'COMMERCIAL_QUOTE_V3_SOURCE_CHANGED'],
    ['invalid database clock', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.readDatabaseClock as jest.Mock).mockResolvedValue(new Date(Number.NaN))
    }, 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_CLOCK_INVALID'],
    ['emergency suspension', (tx: CommercialQuoteV3AcceptanceTransaction) => {
      ;(tx.readLatestOfferControl as jest.Mock).mockResolvedValue({ revision: 1, action: 'SUSPEND_ALL_PENDING' })
    }, 'COMMERCIAL_OFFER_PENDING_SUSPENDED'],
  ])('fails closed for %s', async (_name, mutate, code) => {
    const { service, tx } = harness()
    mutate(tx)
    await expect(service.accept(input)).rejects.toMatchObject({ code })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('treats an assigned PermissionSet as replacement authority even when OWNER would grant', async () => {
    const { service, tx } = harness()
    ;(tx.lockMembership as jest.Mock).mockResolvedValue({
      staffId: input.acceptedById,
      venueId: input.venueId,
      active: true,
      role: StaffRole.OWNER,
      permissionSetId: 'permission-set-no-billing',
    })
    ;(tx.lockPermissionSet as jest.Mock).mockResolvedValue({
      id: 'permission-set-no-billing',
      venueId: input.venueId,
      permissions: ['orders:read'],
    })

    await expect(service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED' })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
  })

  it('rejects tampered quote bytes and records unknown resolution without reaching persistence', async () => {
    const tampered = harness()
    ;(tampered.tx.lockQuote as jest.Mock).mockResolvedValue({ ...quoteRow(), checksum: '0'.repeat(64) })
    await expect(tampered.service.accept(input)).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH' })
    expect(tampered.tx.createAcceptance).not.toHaveBeenCalled()

    const poisoned = harness()
    const snapshot = clone(emittedQuote.snapshot)
    snapshot.resolution.resolutionVersion = 3 as 2
    ;(poisoned.tx.lockQuote as jest.Mock).mockResolvedValue({ ...quoteRow(), snapshot })
    await expect(poisoned.service.accept(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_UNSUPPORTED',
    })
    expect(poisoned.recordPoisonedResolution).toHaveBeenCalledWith({
      quoteId: input.quoteId,
      correlationId: input.correlationId,
      code: 'COMMERCIAL_OFFER_RESOLUTION_VERSION_POISONED_ROW',
    })
    expect(poisoned.tx.createAcceptance).not.toHaveBeenCalled()
  })

  it('recovers an exact quote unique race only in a fresh transaction', async () => {
    const { service, tx, runInTransaction } = harness()
    ;(tx.createAcceptance as jest.Mock).mockRejectedValueOnce({
      code: '23505',
      constraint: 'CommercialQuoteAcceptance_quoteId_key',
    })
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(acceptance())

    await expect(service.accept(input)).resolves.toEqual(acceptance())
    expect(runInTransaction).toHaveBeenCalledTimes(2)
    expect(tx.createAcceptance).toHaveBeenCalledTimes(1)
  })

  it('retries one serialization failure while recovering the exact quote winner', async () => {
    const { service, tx, runInTransaction, sleep } = harness()
    ;(tx.createAcceptance as jest.Mock).mockRejectedValueOnce({
      code: '23505',
      constraint: 'CommercialQuoteAcceptance_quoteId_key',
    })
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(acceptance())
    runInTransaction
      .mockImplementationOnce(async operation => operation(tx))
      .mockRejectedValueOnce({ code: '40001' })
      .mockImplementationOnce(async operation => operation(tx))

    await expect(service.accept(input)).resolves.toEqual(acceptance())
    expect(runInTransaction).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(tx.createAcceptance).toHaveBeenCalledTimes(1)
  })

  it('classifies an exact Prisma string target and fails closed for an unknown unique target', async () => {
    const exact = harness()
    ;(exact.tx.createAcceptance as jest.Mock).mockRejectedValueOnce({
      code: 'P2002',
      meta: { modelName: 'CommercialQuoteAcceptance', target: 'quoteId' },
    })
    ;(exact.tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(acceptance())
    await expect(exact.service.accept(input)).resolves.toEqual(acceptance())
    expect(exact.runInTransaction).toHaveBeenCalledTimes(2)

    const unknown = harness()
    ;(unknown.tx.createAcceptance as jest.Mock).mockRejectedValueOnce({
      code: 'P2002',
      meta: { modelName: 'CommercialQuoteAcceptance', target: ['unexpectedColumn'] },
    })
    await expect(unknown.service.accept(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_UNAVAILABLE',
      details: { retryable: true, attempts: 1 },
    })
    expect(unknown.runInTransaction).toHaveBeenCalledTimes(1)
  })

  it('never looks up or returns a foreign row for an idempotency-key collision', async () => {
    const { service, tx, runInTransaction } = harness()
    ;(tx.createAcceptance as jest.Mock).mockRejectedValue({
      code: '23505',
      constraint: 'CommercialQuoteAcceptance_idempotencyKey_key',
    })

    await expect(service.accept(input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_QUOTE_ACCEPTANCE_IDEMPOTENCY_KEY_CONFLICT',
    })
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(tx.findAcceptanceByQuoteId).toHaveBeenCalledTimes(1)
    expect(Object.keys(tx)).not.toContain('findAcceptanceByIdempotencyKey')
  })

  it.each(['40001', '40P01', 'P2034'])(
    'retries one %s concurrency failure and then succeeds',
    async code => {
      const retry = harness()
      retry.runInTransaction.mockRejectedValueOnce({ code })
      await expect(retry.service.accept(input)).resolves.toMatchObject({ quoteId: input.quoteId })
      expect(retry.runInTransaction).toHaveBeenCalledTimes(2)
    },
  )

  it('normalizes lock and transaction timeouts without retrying', async () => {
    const locked = harness()
    locked.runInTransaction.mockRejectedValue({ code: '55P03' })
    await expect(locked.service.accept(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_UNAVAILABLE',
      details: { retryable: true, attempts: 1 },
    })

    for (const code of ['P2028', '57014']) {
      const timedOut = harness()
      timedOut.runInTransaction.mockRejectedValue({ code })
      await expect(timedOut.service.accept(input)).rejects.toMatchObject({
        statusCode: 503,
        code: 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_TIMEOUT',
        details: { retryable: true, attempts: 1 },
      })
    }
  })

  it('propagates an audit failure from the same acceptance transaction', async () => {
    const auditFailure = new Error('acceptance audit unavailable')
    const { service, tx, runInTransaction } = harness()
    ;(tx.writeAudit as jest.Mock).mockRejectedValueOnce(auditFailure)

    await expect(service.accept(input)).rejects.toBe(auditFailure)
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(tx.createAcceptance).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
  })

  it('authorizes and redeems an acquisition Quote atomically in canonical lock order', async () => {
    const { service, tx, calls } = acquisitionHarness()

    await expect(service.accept(acquisitionInput)).resolves.toEqual(acquisitionAcceptance())
    expect(calls).toEqual([
      'timeout:1000',
      `discover:${acquisitionInput.quoteId}:${acquisitionInput.organizationId}:${acquisitionInput.venueId}`,
      `offer:${emittedOffer.snapshot.campaignVersionId}`,
      `control:${emittedOffer.snapshot.campaignVersionId}`,
      `catalog:${catalog.snapshot.publicationId}`,
      `context:${acquisitionContextId}`,
      `binding:${acquisitionContextId}`,
      `organization:${acquisitionInput.organizationId}`,
      `venue:${acquisitionInput.venueId}`,
      `staff:${acquisitionInput.acceptedById}`,
      `membership:${acquisitionInput.acceptedById}:${acquisitionInput.venueId}`,
      'permission-set:none',
      `role-override:${acquisitionInput.venueId}:OWNER`,
      `quote:${acquisitionInput.quoteId}`,
      `bridge:${acquisitionInput.quoteId}`,
      `existing:${acquisitionInput.quoteId}`,
      `redemption-existing:${acquisitionContextId}`,
      'clock',
      'acceptance',
      'redemption',
      'audit',
    ])
    expect(tx.createRedemption).toHaveBeenCalledWith({
      id: 'redemption-acquisition-v3',
      acquisitionContextId,
      quoteId: acquisitionInput.quoteId,
      acceptanceId: 'acceptance-acquisition-v3',
      organizationId: acquisitionInput.organizationId,
      venueId: acquisitionInput.venueId,
      staffId: acquisitionInput.acceptedById,
      redeemedAt: new Date('2026-08-15T12:10:00.321Z'),
    })
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
  })

  it('keeps direct Quote acceptance free of acquisition locks and redemption', async () => {
    const { service, tx } = harness()

    await expect(service.accept(input)).resolves.toMatchObject({ quoteId: input.quoteId })
    expect(tx.lockAcquisitionContext).not.toHaveBeenCalled()
    expect(tx.lockAcquisitionBinding).not.toHaveBeenCalled()
    expect(tx.lockPreviewBridgeByQuoteId).not.toHaveBeenCalled()
    expect(tx.findRedemptionByContextId).not.toHaveBeenCalled()
    expect(tx.createRedemption).not.toHaveBeenCalled()
  })

  it.each([
    ['revoked permission', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockMembership as jest.Mock).mockResolvedValue({
        staffId: acquisitionInput.acceptedById,
        venueId: acquisitionInput.venueId,
        active: true,
        role: StaffRole.OWNER,
        permissionSetId: 'permission-set-revoked-acquisition',
      })
      ;(tx.lockPermissionSet as jest.Mock).mockResolvedValue({
        id: 'permission-set-revoked-acquisition',
        venueId: acquisitionInput.venueId,
        permissions: ['orders:read'],
      })
    }, 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED'],
    ['foreign bound Staff', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockAcquisitionBinding as jest.Mock).mockResolvedValue({
        acquisitionContextId,
        staffId: 'staff-foreign-bound-v3',
        organizationId: acquisitionInput.organizationId,
        purpose: 'NEW_ACCOUNT',
      })
    }, 'COMMERCIAL_ACQUISITION_BINDING_MISMATCH'],
    ['foreign bound Organization', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockAcquisitionBinding as jest.Mock).mockResolvedValue({
        acquisitionContextId,
        staffId: acquisitionInput.acceptedById,
        organizationId: 'organization-foreign-bound-v3',
        purpose: 'NEW_ACCOUNT',
      })
    }, 'COMMERCIAL_ACQUISITION_BINDING_MISMATCH'],
  ])('checks acquisition authority before acceptance replay for %s', async (_name, mutate, code) => {
    const { service, tx } = acquisitionHarness()
    ;(tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acquisitionAcceptance())
    mutate(tx)

    await expect(service.accept(acquisitionInput)).rejects.toMatchObject({ code })
    expect(tx.findAcceptanceByQuoteId).not.toHaveBeenCalled()
    expect(tx.createAcceptance).not.toHaveBeenCalled()
  })

  it('replays only the exact acquisition acceptance and redemption tuple', async () => {
    const exact = acquisitionHarness()
    ;(exact.tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acquisitionAcceptance())
    ;(exact.tx.findRedemptionByContextId as jest.Mock).mockResolvedValue(acquisitionRedemption())

    await expect(exact.service.accept(acquisitionInput)).resolves.toEqual(acquisitionAcceptance())
    expect(exact.tx.createAcceptance).not.toHaveBeenCalled()
    expect(exact.tx.createRedemption).not.toHaveBeenCalled()
    expect(exact.tx.writeAudit).not.toHaveBeenCalled()

    const inconsistent = acquisitionHarness()
    ;(inconsistent.tx.findAcceptanceByQuoteId as jest.Mock).mockResolvedValue(acquisitionAcceptance())
    ;(inconsistent.tx.findRedemptionByContextId as jest.Mock).mockResolvedValue(
      acquisitionRedemption({ staffId: 'staff-foreign-redemption-v3' }),
    )
    await expect(inconsistent.service.accept(acquisitionInput)).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_REDEMPTION_INCONSISTENT',
    })
  })

  it.each([
    'CommercialAcquisitionRedemption_acquisitionContextId_key',
    'CommercialAcquisitionRedemption_quoteId_key',
    'CommercialAcquisitionRedemption_acceptanceId_key',
  ])('maps the exact %s race to one permanent consumed-offer conflict', async constraint => {
    const { service, tx, runInTransaction } = acquisitionHarness()
    ;(tx.createRedemption as jest.Mock).mockRejectedValueOnce({ code: '23505', constraint })

    await expect(service.accept(acquisitionInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_ACQUISITION_ALREADY_REDEEMED',
      details: { retryable: false },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['context Offer lineage', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockAcquisitionContext as jest.Mock).mockResolvedValue({
        id: acquisitionContextId,
        offerVersionId: 'offer-foreign-v3',
        offerSchemaVersion: 3,
        reservedCatalogPublicationId: catalog.snapshot.publicationId,
        reservedCatalogSchemaVersion: 2,
        createdAt: acquisitionContextCreatedAt,
      })
    }, 'COMMERCIAL_ACQUISITION_SOURCE_MISMATCH'],
    ['preview bridge tuple', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockPreviewBridgeByQuoteId as jest.Mock).mockResolvedValue({
        previewQuoteId: 'preview-quote-foreign-v3',
        previewChecksum: 'a'.repeat(64),
        acquisitionContextId,
        organizationId: acquisitionInput.organizationId,
        venueId: acquisitionInput.venueId,
        actorId: acquisitionInput.acceptedById,
        selectionFingerprint: 'b'.repeat(64),
        venueQuoteId: acquisitionInput.quoteId,
      })
    }, 'COMMERCIAL_ACQUISITION_BRIDGE_MISMATCH'],
    ['acquisition authority timestamp', (tx: CommercialQuoteV3AcceptanceTransaction & Record<string, jest.Mock>) => {
      ;(tx.lockAcquisitionContext as jest.Mock).mockResolvedValue({
        id: acquisitionContextId,
        offerVersionId: emittedOffer.snapshot.campaignVersionId,
        offerSchemaVersion: 3,
        reservedCatalogPublicationId: catalog.snapshot.publicationId,
        reservedCatalogSchemaVersion: 2,
        createdAt: new Date('2026-08-15T11:46:00.000Z'),
      })
    }, 'COMMERCIAL_QUOTE_V3_INVALID'],
  ])('fails closed for mismatched acquisition %s', async (_name, mutate, code) => {
    const { service, tx } = acquisitionHarness()
    mutate(tx)

    await expect(service.accept(acquisitionInput)).rejects.toMatchObject({ code })
    expect(tx.createAcceptance).not.toHaveBeenCalled()
    expect(tx.createRedemption).not.toHaveBeenCalled()
  })

  it('keeps acquisition acceptance, redemption and audit in one failing transaction boundary', async () => {
    const auditFailure = new Error('acquisition acceptance audit unavailable')
    const { service, tx, runInTransaction } = acquisitionHarness()
    ;(tx.writeAudit as jest.Mock).mockRejectedValueOnce(auditFailure)

    await expect(service.accept(acquisitionInput)).rejects.toBe(auditFailure)
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(tx.createAcceptance).toHaveBeenCalledTimes(1)
    expect(tx.createRedemption).toHaveBeenCalledTimes(1)
    expect(tx.writeAudit).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ ...input, idempotencyKey: 'short' }],
    [{ ...input, correlationId: '' }],
    [{ ...input, correlationId: 'customer@example.com' }],
    [{ ...input, correlationId: 'line-one\nline-two' }],
    [{ ...input, acceptedById: 'x'.repeat(129) }],
  ])('rejects invalid public input before opening a transaction', async invalid => {
    const { service, runInTransaction } = harness()
    await expect(service.accept(invalid)).rejects.toMatchObject({
      statusCode: 422,
      code: 'COMMERCIAL_QUOTE_V3_ACCEPTANCE_INVALID',
    })
    expect(runInTransaction).not.toHaveBeenCalled()
  })
})

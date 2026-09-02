import { createHash } from 'node:crypto'
import { OrgRole, Prisma } from '@prisma/client'

import {
  createCommercialAcquisitionBindingV3Service,
  type CommercialAcquisitionBindingV3Transaction,
} from '@/services/commercial/quotes-v3/commercialAcquisitionBindingV3.service'

const token = Buffer.alloc(32, 0x41).toString('base64url')
const contextCreatedAt = new Date('2026-08-15T12:34:56.789Z')
const contextExpiresAt = new Date('2026-08-22T12:34:56.789Z')
const staffCreatedAt = new Date('2026-08-15T12:35:00.000Z')
const organizationCreatedAt = new Date('2026-08-15T12:35:01.000Z')
const membershipJoinedAt = new Date('2026-08-15T12:35:02.000Z')
const boundAt = new Date('2026-08-15T12:36:00.123Z')
const input = {
  acquisitionToken: token,
  staffId: 'staff-new-v3',
  organizationId: 'organization-new-v3',
  purpose: 'NEW_ACCOUNT' as const,
}

function contextRow() {
  return {
    id: 'acquisition-context-v3-1',
    tokenHash: createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('avoqado.commercial.acquisition-context@3\0', 'ascii'),
          Buffer.from(token, 'base64url'),
        ]),
      )
      .digest('hex'),
    campaignVersionId: null,
    offerVersionId: 'commercial-offer-version-summer-2026-v3',
    offerSchemaVersion: 3,
    reservedCatalogPublicationId: 'commercial-publication-base-v2',
    reservedCatalogSchemaVersion: 2,
    createdAt: contextCreatedAt,
    expiresAt: contextExpiresAt,
  }
}

function harness() {
  const calls: string[] = []
  let binding: any = null
  const tx: CommercialAcquisitionBindingV3Transaction = {
    setLocalLockTimeout: jest.fn(async milliseconds => calls.push(`timeout:${milliseconds}`)),
    findContextByTokenHash: jest.fn(async hash => {
      calls.push(`route-context:${hash}`)
      return hash === contextRow().tokenHash ? contextRow() : null
    }),
    lockOffer: jest.fn(async id => {
      calls.push(`offer:${id}`)
      return { id, schemaVersion: 3 }
    }),
    readLatestOfferControl: jest.fn(async id => {
      calls.push(`control:${id}`)
      return null
    }),
    lockReservedCatalog: jest.fn(async id => {
      calls.push(`catalog:${id}`)
      return { id, schemaVersion: 2 }
    }),
    lockContext: jest.fn(async id => {
      calls.push(`context:${id}`)
      return contextRow()
    }),
    findBindingByContextId: jest.fn(async id => {
      calls.push(`existing:${id}`)
      return binding
    }),
    lockStaff: jest.fn(async id => {
      calls.push(`staff:${id}`)
      return { id, active: true, commercialCreatedAt: staffCreatedAt }
    }),
    lockOrganization: jest.fn(async id => {
      calls.push(`organization:${id}`)
      return { id, createdAt: organizationCreatedAt }
    }),
    lockMembership: jest.fn(async (staffId, organizationId) => {
      calls.push(`membership:${staffId}:${organizationId}`)
      return {
        staffId,
        organizationId,
        role: OrgRole.OWNER,
        isActive: true,
        isPrimary: true,
        joinedAt: membershipJoinedAt,
        leftAt: null,
      }
    }),
    findEarliestVenueCreatedAt: jest.fn(async organizationId => {
      calls.push(`venue:${organizationId}`)
      return null
    }),
    readDatabaseClock: jest.fn(async () => {
      calls.push('clock')
      return boundAt
    }),
    createBinding: jest.fn(async record => {
      calls.push('binding')
      binding = record
    }),
    writeAudit: jest.fn(async () => {
      calls.push('audit')
    }),
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const service = createCommercialAcquisitionBindingV3Service({
    runInTransaction,
    randomId: () => 'binding-v3-1',
    sleep: async () => undefined,
    retryDelayMilliseconds: () => 29,
  })
  return {
    calls,
    getBinding: () => binding,
    runInTransaction,
    service,
    setBinding: (value: any) => {
      binding = value
    },
    tx,
  }
}

describe('Commercial acquisition new-account binding v3', () => {
  it('binds a context to one new OWNER Staff and new Organization with observed timestamps', async () => {
    const { calls, runInTransaction, service, tx } = harness()

    await expect(service.bind(input)).resolves.toEqual({
      outcome: 'CREATED',
      acquisitionContextId: contextRow().id,
      staffId: input.staffId,
      organizationId: input.organizationId,
      boundAt: boundAt.toISOString(),
    })
    expect(tx.createBinding).toHaveBeenCalledWith({
      id: 'binding-v3-1',
      acquisitionContextId: contextRow().id,
      staffId: input.staffId,
      organizationId: input.organizationId,
      purpose: 'NEW_ACCOUNT',
      staffCreatedAt,
      organizationCreatedAt,
      boundAt,
    })
    expect(tx.writeAudit).toHaveBeenCalledWith({
      staffId: input.staffId,
      actorType: null,
      organizationId: input.organizationId,
      venueId: null,
      action: 'COMMERCIAL_ACQUISITION_CONTEXT_BOUND',
      entity: 'CommercialAcquisitionContextBinding',
      entityId: 'binding-v3-1',
      data: {
        acquisitionContextId: contextRow().id,
        organizationId: input.organizationId,
        purpose: 'NEW_ACCOUNT',
        boundAt: boundAt.toISOString(),
      },
    })
    expect(calls).toEqual([
      'timeout:1000',
      `route-context:${contextRow().tokenHash}`,
      `offer:${contextRow().offerVersionId}`,
      `control:${contextRow().offerVersionId}`,
      `catalog:${contextRow().reservedCatalogPublicationId}`,
      `context:${contextRow().id}`,
      `existing:${contextRow().id}`,
      `staff:${input.staffId}`,
      `organization:${input.organizationId}`,
      `membership:${input.staffId}:${input.organizationId}`,
      `venue:${input.organizationId}`,
      'clock',
      'binding',
      'audit',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
  })

  it.each([
    ['context before staff', 'CREATED'],
    ['identical replay', 'REPLAYED'],
  ] as const)('%s returns %s', async (_case, expectedOutcome) => {
    const { service } = harness()
    const first = await service.bind(input)
    const result = expectedOutcome === 'REPLAYED' ? await service.bind(input) : first
    expect(result.outcome).toBe(expectedOutcome)
  })

  it('rejects legacy Staff, Staff-before-context and Organization-before-context', async () => {
    const { service, tx } = harness()
    jest.mocked(tx.lockStaff).mockResolvedValueOnce({ id: input.staffId, active: true, commercialCreatedAt: null })
    await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
    jest.mocked(tx.lockStaff).mockResolvedValueOnce({
      id: input.staffId,
      active: true,
      commercialCreatedAt: new Date('2026-08-15T12:34:56.788Z'),
    })
    await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
    jest.mocked(tx.lockOrganization).mockResolvedValueOnce({
      id: input.organizationId,
      createdAt: new Date('2026-08-15T12:34:56.788Z'),
    })
    await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
  })

  it('rejects non-owner, non-primary, inactive or out-of-window memberships', async () => {
    for (const membership of [
      { role: OrgRole.MEMBER },
      { isPrimary: false },
      { isActive: false },
      { leftAt: boundAt },
      { joinedAt: new Date('2026-08-22T12:34:56.790Z') },
    ]) {
      const { service, tx } = harness()
      jest.mocked(tx.lockMembership).mockResolvedValueOnce({
        staffId: input.staffId,
        organizationId: input.organizationId,
        role: OrgRole.OWNER,
        isActive: true,
        isPrimary: true,
        joinedAt: membershipJoinedAt,
        leftAt: null,
        ...membership,
      })
      await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
      expect(tx.createBinding).not.toHaveBeenCalled()
    }
  })

  it('rejects a Venue that predates the context and binding after context expiry', async () => {
    const { service, tx } = harness()
    jest.mocked(tx.findEarliestVenueCreatedAt).mockResolvedValueOnce(new Date('2026-08-15T12:34:56.788Z'))
    await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NEW_ACCOUNT_INELIGIBLE' })
    jest.mocked(tx.readDatabaseClock).mockResolvedValueOnce(contextExpiresAt)
    await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_EXPIRED' })
  })

  it('returns exact replay but hides different Staff or Organization collisions', async () => {
    const exact = {
      id: 'binding-v3-existing',
      acquisitionContextId: contextRow().id,
      staffId: input.staffId,
      organizationId: input.organizationId,
      purpose: 'NEW_ACCOUNT' as const,
      staffCreatedAt,
      organizationCreatedAt,
      boundAt,
    }
    const exactHarness = harness()
    exactHarness.setBinding(exact)
    await expect(exactHarness.service.bind(input)).resolves.toMatchObject({ outcome: 'REPLAYED', boundAt: boundAt.toISOString() })
    expect(exactHarness.tx.createBinding).not.toHaveBeenCalled()

    for (const collision of [{ ...exact, staffId: 'another-staff' }, { ...exact, organizationId: 'another-org' }]) {
      const collisionHarness = harness()
      collisionHarness.setBinding(collision)
      await expect(collisionHarness.service.bind(input)).rejects.toMatchObject({
        code: 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT',
      })
      expect(collisionHarness.tx.createBinding).not.toHaveBeenCalled()
    }
  })

  it('maps only named binding unique constraints and retries one deadlock', async () => {
    for (const target of [
      'CommercialAcquisitionContextBinding_acquisitionContextId_key',
      'CommercialAcquisitionContextBinding_staffId_purpose_key',
      'CommercialAcquisitionContextBinding_organizationId_purpose_key',
    ]) {
      const { service, tx } = harness()
      jest.mocked(tx.createBinding).mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002', meta: { target } }))
      await expect(service.bind(input)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_BINDING_CONFLICT' })
    }

    const retryHarness = harness()
    retryHarness.runInTransaction.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
    await expect(retryHarness.service.bind(input)).resolves.toMatchObject({ outcome: 'CREATED' })
    expect(retryHarness.runInTransaction).toHaveBeenCalledTimes(2)
  })

  it('keeps binding and audit atomic', async () => {
    const { service, tx } = harness()
    jest.mocked(tx.writeAudit).mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(service.bind(input)).rejects.toThrow('audit unavailable')
  })
})

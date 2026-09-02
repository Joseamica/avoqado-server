import { Prisma } from '@prisma/client'

import {
  assertCommercialOfferAllowsAcceptanceV3,
  assertCommercialOfferAllowsBridgeV3,
  assertCommercialOfferAllowsDirectQuoteV3,
  assertCommercialOfferAllowsNewAcquisitionContextV3,
  assertCommercialOfferAllowsNewClaimV3,
  assertCommercialOfferAllowsPreviewV3,
  createCommercialOfferControlV3Service,
  resolveCommercialOfferControlStateV3,
  type CommercialOfferControlTransactionV3,
} from '@/services/commercial/quotes-v3/commercialOfferControlV3.service'

function postgresFailure(code: '55P03' | '57014' | '40001' | '40P01'): Error & { code: string } {
  return Object.assign(new Error(`postgres ${code}`), { code })
}

function harness() {
  const calls: string[] = []
  const tx: CommercialOfferControlTransactionV3 = {
    setLocalLockTimeout: jest.fn(async milliseconds => {
      calls.push(`timeout:${milliseconds}`)
    }),
    lockOffer: jest.fn(async (offerVersionId, mode) => {
      calls.push(`lock:${mode}:${offerVersionId}`)
      return { id: offerVersionId, schemaVersion: 3 }
    }),
    readLatestEvent: jest.fn(async offerVersionId => {
      calls.push(`latest:${offerVersionId}`)
      return null
    }),
    createEvent: jest.fn(async input => {
      calls.push(`event:${input.revision}`)
      return { ...input }
    }),
    writeControlOutbox: jest.fn(async input => {
      calls.push(`outbox:${input.sourceRevision}`)
    }),
    writeChangedAudit: jest.fn(async input => {
      calls.push(`audit:${input.action}`)
    }),
  }
  const runInTransaction = jest.fn(async operation => operation(tx))
  const writeFailedAudit = jest.fn(async () => undefined)
  const sleep = jest.fn<Promise<void>, [number]>(async () => undefined)
  const service = createCommercialOfferControlV3Service({
    runInTransaction,
    writeFailedAudit,
    randomId: () => 'offer-control-event-1',
    sleep,
  })
  return { service, tx, calls, runInTransaction, writeFailedAudit, sleep }
}

const actor = {
  staffId: 'staff-publisher-v3',
  permissions: ['commercial:publish'],
  ipAddress: '127.0.0.1',
  userAgent: 'offer-control-test',
}
const input = {
  offerVersionId: 'commercial-offer-version-summer-2026-v3',
  action: 'SUSPEND_ALL_PENDING' as const,
  reason: '  Incidente de conciliación  ',
  confirmedById: actor.staffId,
  confirm: true as const,
}

describe('Commercial Offer control v3', () => {
  it('resolves no-event/RESUME as OPEN and blocks only SUSPEND_ALL_PENDING for direct Quote and acceptance', () => {
    expect(resolveCommercialOfferControlStateV3(null)).toBe('OPEN')
    expect(resolveCommercialOfferControlStateV3({ revision: 1, action: 'SUSPEND_NEW_CLAIMS' })).toBe('SUSPEND_NEW_CLAIMS')
    expect(resolveCommercialOfferControlStateV3({ revision: 2, action: 'SUSPEND_ALL_PENDING' })).toBe('SUSPEND_ALL_PENDING')
    expect(resolveCommercialOfferControlStateV3({ revision: 3, action: 'RESUME' })).toBe('OPEN')

    for (const state of ['OPEN', 'SUSPEND_NEW_CLAIMS'] as const) {
      expect(() => assertCommercialOfferAllowsDirectQuoteV3(state)).not.toThrow()
      expect(() => assertCommercialOfferAllowsAcceptanceV3(state)).not.toThrow()
    }
    for (const operation of [assertCommercialOfferAllowsDirectQuoteV3, assertCommercialOfferAllowsAcceptanceV3]) {
      expect(() => operation('SUSPEND_ALL_PENDING')).toThrow(
        expect.objectContaining({ statusCode: 409, code: 'COMMERCIAL_OFFER_PENDING_SUSPENDED' }),
      )
    }
  })

  it('rejects an unknown persisted control action instead of opening the Offer', () => {
    expect(() =>
      resolveCommercialOfferControlStateV3({
        revision: 9,
        action: 'FUTURE_ACTION' as never,
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'COMMERCIAL_OFFER_CONTROL_STATE_INVALID',
      }),
    )
  })

  it('blocks new claims and contexts during normal suspension while honoring reserved previews and bridges', () => {
    const state = 'SUSPEND_NEW_CLAIMS' as const

    for (const operation of [assertCommercialOfferAllowsNewClaimV3, assertCommercialOfferAllowsNewAcquisitionContextV3]) {
      expect(() => operation(state)).toThrow(
        expect.objectContaining({
          statusCode: 409,
          code: 'COMMERCIAL_OFFER_NEW_ACQUISITION_SUSPENDED',
        }),
      )
    }
    for (const operation of [assertCommercialOfferAllowsPreviewV3, assertCommercialOfferAllowsBridgeV3]) {
      expect(() => operation(state)).not.toThrow()
      expect(() => operation('SUSPEND_ALL_PENDING')).toThrow(
        expect.objectContaining({
          statusCode: 409,
          code: 'COMMERCIAL_OFFER_PENDING_SUSPENDED',
        }),
      )
    }
  })

  it('locks the Offer anchor before a fresh latest-event statement and writes monotonic event plus global audit', async () => {
    const { service, tx, calls, runInTransaction } = harness()
    ;(tx.readLatestEvent as jest.Mock).mockImplementationOnce(async offerVersionId => {
      calls.push(`latest:${offerVersionId}`)
      return { revision: 7, action: 'SUSPEND_NEW_CLAIMS' }
    })

    await expect(service.create(input, actor)).resolves.toEqual({
      id: 'offer-control-event-1',
      offerVersionId: input.offerVersionId,
      offerSchemaVersion: 3,
      revision: 8,
      action: 'SUSPEND_ALL_PENDING',
      reason: 'Incidente de conciliación',
      confirmedById: actor.staffId,
      state: 'SUSPEND_ALL_PENDING',
    })
    expect(calls).toEqual([
      'timeout:5000',
      `lock:FOR_UPDATE:${input.offerVersionId}`,
      `latest:${input.offerVersionId}`,
      'event:8',
      'outbox:8',
      'audit:COMMERCIAL_OFFER_CONTROL_CHANGED',
    ])
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
    expect(tx.createEvent).toHaveBeenCalledWith({
      id: 'offer-control-event-1',
      offerVersionId: input.offerVersionId,
      offerSchemaVersion: 3,
      revision: 8,
      action: 'SUSPEND_ALL_PENDING',
      reason: 'Incidente de conciliación',
      confirmedById: actor.staffId,
    })
    expect(tx.writeControlOutbox).toHaveBeenCalledWith({
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceType: 'OFFER_CONTROL_EVENT',
      sourceId: 'offer-control-event-1',
      sourceRevision: 8,
      eventType: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
      payload: {
        schemaVersion: 1,
        offerVersionId: input.offerVersionId,
        offerSchemaVersion: 3,
        controlEventId: 'offer-control-event-1',
        controlAction: 'SUSPEND_ALL_PENDING',
        state: 'SUSPEND_ALL_PENDING',
      },
    })
    expect(tx.writeChangedAudit).toHaveBeenCalledWith({
      staffId: actor.staffId,
      actorType: null,
      organizationId: null,
      venueId: null,
      action: 'COMMERCIAL_OFFER_CONTROL_CHANGED',
      entity: 'CommercialCampaignVersion',
      entityId: input.offerVersionId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      data: {
        offerSchemaVersion: 3,
        revision: 8,
        controlAction: 'SUSPEND_ALL_PENDING',
        state: 'SUSPEND_ALL_PENDING',
      },
    })
    expect(JSON.stringify((tx.writeChangedAudit as jest.Mock).mock.calls)).not.toContain(input.reason.trim())
  })

  it('returns OPEN after a monotonic RESUME event', async () => {
    const { service, tx } = harness()
    ;(tx.readLatestEvent as jest.Mock).mockResolvedValueOnce({ revision: 4, action: 'SUSPEND_ALL_PENDING' })

    await expect(service.create({ ...input, action: 'RESUME' }, actor)).resolves.toMatchObject({
      revision: 5,
      action: 'RESUME',
      state: 'OPEN',
    })
  })

  it.each([
    ['missing confirmation', { ...input, confirm: false }, actor, 'COMMERCIAL_OFFER_CONTROL_CONFIRMATION_REQUIRED'],
    ['short reason', { ...input, reason: ' x ' }, actor, 'COMMERCIAL_OFFER_CONTROL_REASON_INVALID'],
    ['long reason', { ...input, reason: 'x'.repeat(501) }, actor, 'COMMERCIAL_OFFER_CONTROL_REASON_INVALID'],
    ['actor mismatch', { ...input, confirmedById: 'staff-other' }, actor, 'COMMERCIAL_OFFER_CONTROL_ACTOR_MISMATCH'],
    ['missing permission', input, { ...actor, permissions: [] }, 'COMMERCIAL_OFFER_CONTROL_FORBIDDEN'],
  ])('rejects %s before opening a transaction', async (_label, candidate, candidateActor, code) => {
    const { service, runInTransaction } = harness()
    await expect(service.create(candidate as typeof input, candidateActor)).rejects.toMatchObject({ code })
    expect(runInTransaction).not.toHaveBeenCalled()
  })

  it('fails closed when the Offer is missing or the revision is exhausted', async () => {
    const missing = harness()
    ;(missing.tx.lockOffer as jest.Mock).mockResolvedValueOnce(null)
    await expect(missing.service.create(input, actor)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMERCIAL_OFFER_CONTROL_OFFER_NOT_FOUND',
    })
    expect(missing.tx.readLatestEvent).not.toHaveBeenCalled()

    const exhausted = harness()
    ;(exhausted.tx.readLatestEvent as jest.Mock).mockResolvedValueOnce({
      revision: 2_147_483_647,
      action: 'SUSPEND_NEW_CLAIMS',
    })
    await expect(exhausted.service.create(input, actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_OFFER_CONTROL_REVISION_EXHAUSTED',
    })
    expect(exhausted.tx.createEvent).not.toHaveBeenCalled()
  })

  it.each(['55P03', '57014', '40001', '40P01'] as const)(
    'performs at most two jittered retries for PostgreSQL %s, never assumes OPEN and writes one safe failure audit',
    async code => {
      const { service, runInTransaction, writeFailedAudit, sleep } = harness()
      runInTransaction.mockRejectedValue(postgresFailure(code))

      await expect(service.create(input, actor)).rejects.toMatchObject({
        statusCode: 409,
        code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
        details: { retryable: true, attempts: 3 },
      })
      expect(runInTransaction).toHaveBeenCalledTimes(3)
      expect(sleep).toHaveBeenCalledTimes(2)
      for (const [delay] of sleep.mock.calls) {
        expect(delay).toBeGreaterThanOrEqual(25)
        expect(delay).toBeLessThanOrEqual(75)
      }
      expect(writeFailedAudit).toHaveBeenCalledTimes(1)
      expect(writeFailedAudit).toHaveBeenCalledWith({
        staffId: actor.staffId,
        actorType: null,
        organizationId: null,
        venueId: null,
        action: 'COMMERCIAL_OFFER_CONTROL_FAILED',
        entity: 'CommercialCampaignVersion',
        entityId: input.offerVersionId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        data: {
          offerSchemaVersion: 3,
          attemptedAction: 'SUSPEND_ALL_PENDING',
          code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
          attempts: 3,
        },
      })
      expect(JSON.stringify(writeFailedAudit.mock.calls)).not.toContain(input.reason.trim())
    },
  )

  it('classifies retryable PostgreSQL codes nested in Prisma P2010 metadata', async () => {
    const { service, runInTransaction, writeFailedAudit, sleep } = harness()
    runInTransaction.mockRejectedValue({ code: 'P2010', meta: { code: '40P01' } })

    await expect(service.create(input, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
      details: { retryable: true, attempts: 3 },
    })
    expect(runInTransaction).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(writeFailedAudit).toHaveBeenCalledTimes(1)
  })

  it('preserves the stable unavailable result even if the best-effort failure audit also fails', async () => {
    const { service, runInTransaction, writeFailedAudit } = harness()
    runInTransaction.mockRejectedValue(postgresFailure('55P03'))
    writeFailedAudit.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(service.create(input, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_CONTROL_UNAVAILABLE',
    })
    expect(runInTransaction).toHaveBeenCalledTimes(3)
  })

  it('does not retry or create a misleading failure audit for non-lock infrastructure errors', async () => {
    const infrastructure = new Error('database disconnected')
    const { service, runInTransaction, writeFailedAudit, sleep } = harness()
    runInTransaction.mockRejectedValueOnce(infrastructure)

    await expect(service.create(input, actor)).rejects.toBe(infrastructure)
    expect(runInTransaction).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(writeFailedAudit).not.toHaveBeenCalled()
  })
})

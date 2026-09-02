import {
  commercialOfferDraftService,
  createCommercialOfferDraftService,
} from '@/services/commercial/offers/commercialOfferDraft.service'

const actor = { staffId: 'staff-1', reason: 'Agregar hardware al piloto CDMX' }
const benefits = [
  {
    benefitCode: 'HARDWARE_PAX_10_OFF',
    kind: 'HARDWARE_PERCENT_OFF' as const,
    priority: 50,
    hardwareCatalogKey: 'PAX_A910S',
    percentBasisPoints: 1000,
    quantityLimit: 1,
    benefitStartsAt: '2026-08-01T06:00:00.000Z',
    benefitEndsAt: '2026-09-01T06:00:00.000Z',
  },
]

function harness() {
  const promoted = { id: 'draft-1', revision: 2, offerSchemaVersion: 3 as const, offerBenefits: benefits }
  const tx = {
    promoteIfRevision: jest.fn(async () => promoted),
    replaceIfRevision: jest.fn(async () => ({ ...promoted, revision: 3 })),
    exists: jest.fn(async () => true),
    writeAudit: jest.fn(async () => undefined),
  }
  const dependencies = {
    getGraph: jest.fn(async () => promoted),
    runInTransaction: jest.fn(async operation => operation(tx)),
  }
  return { service: createCommercialOfferDraftService(dependencies as never), dependencies, tx }
}

describe('Commercial Offer v3 draft lifecycle', () => {
  it('exposes the production Prisma-backed service without weakening the injectable unit seam', () => {
    expect(commercialOfferDraftService).toEqual(
      expect.objectContaining({ getDraft: expect.any(Function), promoteDraft: expect.any(Function), replaceBenefits: expect.any(Function) }),
    )
  })

  it('promotes one v2 draft atomically, normalizes benefit order and audits the schema transition', async () => {
    const { service, tx } = harness()
    const unordered = [
      { ...benefits[0], benefitCode: 'Z_HARDWARE' },
      {
        benefitCode: 'A_HARDWARE',
        kind: 'HARDWARE_FIXED_PRICE' as const,
        priority: 100,
        hardwareCatalogKey: 'NEXGO_N62',
        unitAmountMinor: '150000',
        quantityLimit: 2,
        benefitStartsAt: '2026-08-01T06:00:00.000Z',
        benefitEndsAt: '2026-09-01T06:00:00.000Z',
      },
    ]

    await expect(service.promoteDraft('draft-1', unordered, 1, actor)).resolves.toMatchObject({
      revision: 2,
      offerSchemaVersion: 3,
    })
    expect(tx.promoteIfRevision).toHaveBeenCalledWith(
      'draft-1',
      [expect.objectContaining({ benefitCode: 'A_HARDWARE' }), expect.objectContaining({ benefitCode: 'Z_HARDWARE' })],
      1,
      'staff-1',
    )
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_OFFER_DRAFT_PROMOTED',
        before: { revision: 1, offerSchemaVersion: 2 },
        after: { revision: 2, offerSchemaVersion: 3 },
      }),
    )
  })

  it('allows an immutable rate-version reference in a draft while publication remains a separate gate', async () => {
    const { service, tx } = harness()
    await service.promoteDraft(
      'draft-1',
      [
        {
          benefitCode: 'PAYMENTS_STARTER_RATE',
          kind: 'PAYMENTS_RATE_SCHEDULE',
          priority: 10,
          paymentsRateScheduleVersionId: 'payments-rate-schedule-version-starter-2026-v1',
        },
      ],
      1,
      actor,
    )
    expect(tx.promoteIfRevision).toHaveBeenCalledTimes(1)
  })

  it('replaces only a v3 benefit graph under optimistic revision', async () => {
    const { service, tx } = harness()
    await expect(service.replaceBenefits('draft-1', benefits, 2, actor)).resolves.toMatchObject({ revision: 3 })
    expect(tx.replaceIfRevision).toHaveBeenCalledWith('draft-1', benefits, 2, 'staff-1')
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COMMERCIAL_OFFER_DRAFT_REPLACED', before: { revision: 2, offerSchemaVersion: 3 } }),
    )
  })

  it('rejects invalid references, overlaps, reserved codes and stale revisions before audit', async () => {
    const invalidCases = [
      [{ ...benefits[0], benefitCode: 'SAAS_PRICE' }],
      [{ ...benefits[0], quantityLimit: 0 }],
      [
        benefits[0],
        {
          ...benefits[0],
          benefitCode: 'HARDWARE_PAX_SECOND',
          benefitStartsAt: '2026-08-15T06:00:00.000Z',
          benefitEndsAt: '2026-09-15T06:00:00.000Z',
        },
      ],
    ]
    for (const invalid of invalidCases) {
      const { service, tx } = harness()
      await expect(service.promoteDraft('draft-1', invalid, 1, actor)).rejects.toMatchObject({
        code: 'COMMERCIAL_OFFER_DRAFT_INVALID',
      })
      expect(tx.promoteIfRevision).not.toHaveBeenCalled()
      expect(tx.writeAudit).not.toHaveBeenCalled()
    }

    const stale = harness()
    stale.tx.promoteIfRevision.mockResolvedValueOnce(null as never)
    await expect(stale.service.promoteDraft('draft-1', benefits, 1, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_OFFER_DRAFT_CONFLICT',
    })
    expect(stale.tx.writeAudit).not.toHaveBeenCalled()
  })

  it('distinguishes a missing draft from a revision conflict', async () => {
    const missing = harness()
    missing.tx.replaceIfRevision.mockResolvedValueOnce(null as never)
    missing.tx.exists.mockResolvedValueOnce(false)
    await expect(missing.service.replaceBenefits('missing', benefits, 2, actor)).rejects.toMatchObject({ statusCode: 404 })
  })
})

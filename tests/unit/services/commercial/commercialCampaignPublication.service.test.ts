import { prismaMock } from '@tests/__helpers__/setup'
import campaignFixtureV1 from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import { buildCommercialCampaignV2 } from '@/services/commercial/commercialCampaignV2Builder.service'
import {
  createCommercialCampaignPublicationService,
  prismaCommercialCampaignPublicationDependencies,
} from '@/services/commercial/commercialCampaignPublication.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCampaignDraftView } from '@/types/commercialQuote'

const now = new Date('2026-08-22T15:00:00.000Z')
const draft: CommercialCampaignDraftView = {
  id: 'campaign-draft-1',
  code: 'POS_INTRO_2026',
  name: 'POS introducción',
  revision: 1,
  offerSchemaVersion: 2,
  status: 'ACTIVE',
  startsAt: '2026-08-22T06:00:00.000Z',
  endsAt: '2026-09-22T06:00:00.000Z',
  stackingGroups: [],
  rules: [
    {
      code: 'POS_FIFTY',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      amount: '50.00',
      cycles: 3,
    },
  ],
}
const actor = {
  staffId: 'staff-1',
  reason: 'Campaña aprobada para el piloto CDMX',
  permissions: ['commercial:publish'],
}

function storedVersionV2(id: string, sourceRevision: number, publishedAt = now) {
  const emitted = buildCommercialCampaignV2({ ...draft, revision: sourceRevision }, { campaignVersionId: id, publishedAt })
  return {
    id,
    campaignCode: draft.code,
    sourceDraftId: draft.id,
    sourceRevision,
    schemaVersion: 2,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    publishedAt,
  }
}

function storedVersionV1(id = 'campaign-version-v1', sourceRevision = 1) {
  const snapshot = {
    ...campaignFixtureV1,
    campaignVersionId: id,
    campaignCode: draft.code,
    version: sourceRevision,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
  }
  return {
    id,
    campaignCode: draft.code,
    sourceDraftId: draft.id,
    sourceRevision,
    schemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-campaign-snapshot-v1', snapshot),
    publishedAt: new Date('2026-08-21T15:00:00.000Z'),
  }
}

function harness() {
  const versions = new Map<string, any>()
  let activation: any = null
  const tx = {
    lockDraft: jest.fn(async () => draft),
    findVersionBySourceRevision: jest.fn(
      async (_draftId, revision) =>
        [...versions.values()].find(version => version.sourceRevision === revision && version.schemaVersion === 2) ?? null,
    ),
    createVersion: jest.fn(async input => {
      const version = {
        id: input.id,
        campaignCode: input.campaignCode,
        sourceDraftId: input.sourceDraftId,
        sourceRevision: input.sourceRevision,
        schemaVersion: 2,
        snapshot: input.emitted.snapshot,
        checksum: input.emitted.checksum,
        publishedAt: input.publishedAt,
      }
      versions.set(version.id, version)
      return version
    }),
    getVersion: jest.fn(async id => versions.get(id) ?? null),
    getActivation: jest.fn(async () => {
      if (!activation) return null
      return { ...activation, campaignVersion: versions.get(activation.campaignVersionId) ?? activation.campaignVersion }
    }),
    createActivation: jest.fn(async input => {
      activation = { ...input, revision: 1 }
      return { ...activation, campaignVersion: versions.get(input.campaignVersionId) }
    }),
    moveActivationIfRevision: jest.fn(async input => {
      if (!activation || activation.revision !== input.expectedRevision) return null
      activation = { ...activation, campaignVersionId: input.campaignVersionId, reason: input.reason, revision: input.expectedRevision + 1 }
      return { ...activation, campaignVersion: versions.get(input.campaignVersionId) }
    }),
    writeAudit: jest.fn(async () => undefined),
  }
  const dependencies = {
    now: () => now,
    randomId: jest.fn(() => (versions.size > 0 ? 'campaign-version-2' : 'campaign-version-1')),
    runInTransaction: jest.fn(async operation => operation(tx)),
  }
  return {
    service: createCommercialCampaignPublicationService(dependencies),
    tx,
    setVersion: (value: any) => {
      versions.set(value.id, value)
    },
    setActivation: (value: any) => {
      activation = value
    },
  }
}

function primePrismaCampaignDraft(amountMinor: bigint | number | null) {
  prismaMock.$queryRaw = jest.fn(async () => [
    {
      ...draft,
      description: null,
      offerSchemaVersion: 2,
      startsAt: new Date(draft.startsAt),
      endsAt: new Date(draft.endsAt),
      allowedRuleCodeGroups: null,
      allowedRuleCodeGroupsKind: 'SQL_NULL',
      stackingGroups: [],
      stackingGroupsKind: 'array',
      transactionIsolation: 'read committed',
      createdAt: new Date('2026-08-22T05:00:00.000Z'),
      updatedAt: new Date('2026-08-22T05:00:00.000Z'),
    },
  ])
  prismaMock.commercialCampaignRuleDraft = {
    findMany: jest.fn(async () => draft.rules.map(rule => ({ ...rule, amountMinor, percentBasisPoints: null }))),
  }
  prismaMock.commercialCampaignVersion = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(),
  }
  prismaMock.commercialCampaignActivation = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(),
    updateMany: jest.fn(),
  }
  prismaMock.activityLog.create = jest.fn()
  return prismaMock
}

describe('commercial campaign publication and activation', () => {
  it('cannot publish or activate a v3 offer through the Campaign v2 service', async () => {
    const { service, tx } = harness()
    tx.lockDraft.mockResolvedValueOnce({ ...draft, offerSchemaVersion: 3 })

    await expect(
      service.publishAndActivate(
        {
          draftId: draft.id,
          expectedDraftRevision: 1,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID' })
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.createActivation).not.toHaveBeenCalled()
  })

  it('[P3-2B-U3] emits the exact branded v2 snapshot and checksum after a Prisma bigint draft read', async () => {
    primePrismaCampaignDraft(5000n)

    const projectedDraft = await prismaCommercialCampaignPublicationDependencies.runInTransaction(tx => tx.lockDraft(draft.id))
    const built = buildCommercialCampaignV2(projectedDraft!, {
      campaignVersionId: 'campaign-version-1',
      publishedAt: now,
    })

    expect(built).toMatchObject({ kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(built.snapshot).toEqual({
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: 'campaign-version-1',
      campaignCode: 'POS_INTRO_2026',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-22T15:00:00.000Z',
      startsAt: '2026-08-22T06:00:00.000Z',
      endsAt: '2026-09-22T06:00:00.000Z',
      stackingGroups: [],
      rules: [
        {
          code: 'POS_FIFTY',
          priority: 100,
          target: { productCodes: ['POS'] },
          cycles: 3,
          type: 'FIXED_PRICE',
          amount: '50.00',
        },
      ],
    })
    expect(built.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('[P3-2B-U4] enforces the complete publication adapter range before every persistence delegate', async () => {
    const validAmounts = [0n, 2147483648n, 999999999999n]
    const invalidAmounts: Array<{ value: bigint | number | null; code: string }> = [
      { value: 1000000000000n, code: 'COMMERCIAL_CAMPAIGN_DRAFT_AMOUNT_OUT_OF_RANGE' },
      { value: -1n, code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID' },
      { value: null, code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID' },
      { value: 5000, code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID' },
    ]
    const validResults = []
    for (const amountMinor of validAmounts) {
      primePrismaCampaignDraft(amountMinor)
      validResults.push(await prismaCommercialCampaignPublicationDependencies.runInTransaction(tx => tx.lockDraft(draft.id)))
    }
    const invalidResults: Array<{ error: unknown; delegates: jest.Mock[] }> = []
    for (const invalidAmount of invalidAmounts) {
      const currentPrismaMock = primePrismaCampaignDraft(invalidAmount.value)
      let error: unknown
      try {
        await createCommercialCampaignPublicationService(prismaCommercialCampaignPublicationDependencies).publishAndActivate(
          {
            draftId: draft.id,
            expectedDraftRevision: 1,
            expectedActivationRevision: null,
            reason: actor.reason,
            confirm: true,
          },
          actor,
        )
      } catch (caught) {
        error = caught
      }
      invalidResults.push({
        error,
        delegates: [
          currentPrismaMock.commercialCampaignVersion.create,
          currentPrismaMock.commercialCampaignActivation.create,
          currentPrismaMock.commercialCampaignActivation.updateMany,
          currentPrismaMock.activityLog.create,
        ],
      })
    }

    expect({
      validAmounts: validResults.map(result => (result?.rules[0] as { amount: unknown }).amount),
      invalid: invalidResults.map(result => ({
        statusCode: (result.error as { statusCode?: unknown } | undefined)?.statusCode,
        code: (result.error as { code?: unknown } | undefined)?.code,
        persistenceDelegateCalls: result.delegates.map(delegate => delegate.mock.calls.length),
      })),
    }).toEqual({
      validAmounts: validAmounts.map(amountMinor => `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}`),
      invalid: invalidAmounts.map(({ code }) => ({
        statusCode: 409,
        code,
        persistenceDelegateCalls: [0, 0, 0, 0],
      })),
    })
  })

  it('[P3-2B-U5] selects only schema 2 through the generated triple-unique selector', async () => {
    const prismaMock = primePrismaCampaignDraft(5000n)

    await prismaCommercialCampaignPublicationDependencies.runInTransaction(tx => tx.findVersionBySourceRevision('campaign-draft-1', 7))

    expect(prismaMock.commercialCampaignVersion.findUnique).toHaveBeenCalledWith({
      where: {
        sourceDraftId_sourceRevision_schemaVersion: {
          sourceDraftId: 'campaign-draft-1',
          sourceRevision: 7,
          schemaVersion: 2,
        },
      },
    })
  })

  it('publishes one immutable version and activates it with separate audit records', async () => {
    const { service, tx } = harness()

    const result = await service.publishAndActivate(
      {
        draftId: 'campaign-draft-1',
        expectedDraftRevision: 1,
        expectedActivationRevision: null,
        reason: 'Campaña aprobada para el piloto CDMX',
        confirm: true,
      },
      actor,
    )

    expect(result.version.id).toBe('campaign-version-1')
    expect(result.version.snapshot).toMatchObject({ campaignCode: 'POS_INTRO_2026', version: 1 })
    expect(result.version.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(result.activation).toMatchObject({
      campaignCode: 'POS_INTRO_2026',
      campaignVersionId: 'campaign-version-1',
      revision: 1,
    })
    expect(tx.writeAudit).toHaveBeenCalledTimes(2)
  })

  it('rejects stale draft and activation revisions', async () => {
    const staleDraft = harness()
    await expect(
      staleDraft.service.publishAndActivate(
        {
          draftId: 'campaign-draft-1',
          expectedDraftRevision: 2,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_DRAFT_CONFLICT' })

    const staleActivation = harness()
    staleActivation.setVersion(storedVersionV2('old-version', 2))
    staleActivation.setActivation({
      id: 'activation-1',
      campaignCode: draft.code,
      campaignVersionId: 'old-version',
      revision: 4,
    })
    await expect(
      staleActivation.service.publishAndActivate(
        {
          draftId: 'campaign-draft-1',
          expectedDraftRevision: 1,
          expectedActivationRevision: 3,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT' })
  })

  it('reuses a version already published from the same draft revision', async () => {
    const { service, tx, setVersion, setActivation } = harness()
    setVersion(storedVersionV2('campaign-version-existing', 1))
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: 'campaign-version-existing', revision: 2 })

    const result = await service.publishAndActivate(
      {
        draftId: draft.id,
        expectedDraftRevision: 1,
        expectedActivationRevision: 2,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )

    expect(result.version.id).toBe('campaign-version-existing')
    expect(result.activation.revision).toBe(2)
    expect(tx.createVersion).not.toHaveBeenCalled()
    expect(tx.moveActivationIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it.each([
    [
      'cuts over from verified v1 to verified v2',
      storedVersionV1('current-v1', 1),
      storedVersionV2('target-v2', 1),
      'COMMERCIAL_CAMPAIGN_ACTIVATED',
    ],
    [
      'moves forward between v2 revisions',
      storedVersionV2('current-v2', 2),
      storedVersionV2('target-v2', 3),
      'COMMERCIAL_CAMPAIGN_ACTIVATED',
    ],
    [
      'rolls back only between verified v2 revisions',
      storedVersionV2('current-v2', 3),
      storedVersionV2('target-v2', 2),
      'COMMERCIAL_CAMPAIGN_ROLLED_BACK',
    ],
  ])('%s with the exact audit action', async (_label, currentVersion, targetVersion, action) => {
    const { service, tx, setVersion, setActivation } = harness()
    setVersion(currentVersion)
    setVersion(targetVersion)
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: currentVersion.id, revision: 5 })

    const result = await service.activateVersion(
      {
        campaignCode: draft.code,
        campaignVersionId: targetVersion.id,
        expectedActivationRevision: 5,
        reason: 'Transición de campaña aprobada',
        confirm: true,
      },
      actor,
    )

    expect(result).toMatchObject({ campaignVersionId: targetVersion.id, revision: 6 })
    expect(tx.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action }))
  })

  it('publishes the v2 cutover over an active verified v1 campaign with published and activated audits', async () => {
    const { service, tx, setVersion, setActivation } = harness()
    const current = storedVersionV1('current-v1', 1)
    setVersion(current)
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: current.id, revision: 4 })

    await service.publishAndActivate(
      {
        draftId: draft.id,
        expectedDraftRevision: 1,
        expectedActivationRevision: 4,
        reason: 'Corte definitivo de campaña a v2',
        confirm: true,
      },
      actor,
    )

    expect(tx.writeAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'COMMERCIAL_CAMPAIGN_PUBLISHED' }))
    expect(tx.writeAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'COMMERCIAL_CAMPAIGN_ACTIVATED' }))
  })

  it('rejects a v1 target after cutover and never moves or audits', async () => {
    const { service, tx, setVersion, setActivation } = harness()
    const current = storedVersionV2('current-v2', 2)
    const target = storedVersionV1('target-v1', 1)
    setVersion(current)
    setVersion(target)
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: current.id, revision: 2 })

    await expect(
      service.activateVersion(
        {
          campaignCode: draft.code,
          campaignVersionId: target.id,
          expectedActivationRevision: 2,
          reason: 'Intento de regreso a v1',
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_VERSION_INVALID' })
    expect(tx.moveActivationIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects two different v2 identities at the same source revision', async () => {
    const { service, tx, setVersion, setActivation } = harness()
    const current = storedVersionV2('current-v2', 2)
    const target = storedVersionV2('different-v2', 2)
    setVersion(current)
    setVersion(target)
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: current.id, revision: 3 })

    await expect(
      service.activateVersion(
        {
          campaignCode: draft.code,
          campaignVersionId: target.id,
          expectedActivationRevision: 3,
          reason: 'Identidad duplicada detectada',
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_VERSION_INVALID' })
    expect(tx.moveActivationIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it.each(['target', 'current', 'replay'] as const)('fails closed when the %s stored authority is malformed', async malformed => {
    const { service, tx, setVersion, setActivation } = harness()
    const current = storedVersionV2('current-v2', 2)
    const target = malformed === 'replay' ? current : storedVersionV2('target-v2', 3)
    if (malformed === 'target' || malformed === 'replay') target.checksum = '0'.repeat(64)
    if (malformed === 'current') current.checksum = '0'.repeat(64)
    setVersion(current)
    setVersion(target)
    setActivation({ id: 'activation-1', campaignCode: draft.code, campaignVersionId: current.id, revision: 7 })

    await expect(
      service.activateVersion(
        {
          campaignCode: draft.code,
          campaignVersionId: target.id,
          expectedActivationRevision: 7,
          reason: 'Validación de autoridad persistida',
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_VERSION_INVALID' })
    expect(tx.moveActivationIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects activateVersion without a production pointer', async () => {
    const { service, tx, setVersion } = harness()
    const target = storedVersionV2('target-v2', 1)
    setVersion(target)

    await expect(
      service.activateVersion(
        {
          campaignCode: draft.code,
          campaignVersionId: target.id,
          expectedActivationRevision: 1,
          reason: 'Activación sin puntero',
          confirm: true,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_ACTIVATION_CONFLICT' })
    expect(tx.moveActivationIfRevision).not.toHaveBeenCalled()
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('requires an authorized human confirmation', async () => {
    const { service, tx } = harness()
    await expect(
      service.publishAndActivate(
        {
          draftId: draft.id,
          expectedDraftRevision: 1,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true,
        },
        { ...actor, permissions: [] },
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_PUBLISH_FORBIDDEN' })
    await expect(
      service.activateVersion(
        {
          campaignCode: draft.code,
          campaignVersionId: 'campaign-version-old',
          expectedActivationRevision: 1,
          reason: actor.reason,
          confirm: false,
        } as any,
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/confirma/i) })
    expect(tx.lockDraft).not.toHaveBeenCalled()
  })
})

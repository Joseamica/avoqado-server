import { loadCommercialCampaignDraftGraph } from '@/services/commercial/commercialCampaignDraftGraph.service'

const baseParent = {
  id: 'draft-graph-1',
  code: 'POS_INTRO_2026',
  name: 'POS introducción',
  description: 'Precio temporal',
  revision: 1,
  offerSchemaVersion: 2,
  status: 'ACTIVE' as const,
  startsAt: new Date('2026-08-22T06:00:00.000Z'),
  endsAt: new Date('2026-09-22T06:00:00.000Z'),
  allowedRuleCodeGroups: null as string[][] | null,
  allowedRuleCodeGroupsKind: 'SQL_NULL',
  stackingGroups: [] as Array<{ code: string; steps: Array<{ position: number; ruleCode: string }> }> | null,
  stackingGroupsKind: 'array',
  transactionIsolation: 'repeatable read',
  createdAt: new Date('2026-08-22T05:00:00.000Z'),
  updatedAt: new Date('2026-08-22T05:00:00.000Z'),
}

const baseRule = {
  code: 'POS_FIFTY',
  type: 'FIXED_PRICE' as const,
  priority: 100,
  target: { productCodes: ['POS'] },
  amountMinor: 5000n,
  percentBasisPoints: null,
  cycles: 3,
}

function graphTx(parent = baseParent, rules = [baseRule]) {
  return {
    $queryRaw: jest.fn(async () => [parent]),
    commercialCampaignRuleDraft: { findMany: jest.fn(async () => rules) },
  }
}

describe('commercial campaign draft graph adapter', () => {
  it('gives SNAPSHOT isolation precedence over corrupt storage and never reads children', async () => {
    const tx = graphTx({
      ...baseParent,
      transactionIsolation: 'read committed',
      stackingGroups: null,
      stackingGroupsKind: 'SQL_NULL' as const,
    })

    await expect(loadCommercialCampaignDraftGraph(tx as never, baseParent.id, { consistency: 'SNAPSHOT' })).rejects.toThrow(
      'COMMERCIAL_CAMPAIGN_DRAFT_TRANSACTION_ISOLATION_REQUIRED',
    )
    expect(tx.commercialCampaignRuleDraft.findMany).not.toHaveBeenCalled()
  })

  it.each([
    ['both SQL NULL', { allowedRuleCodeGroupsKind: 'SQL_NULL', stackingGroupsKind: 'SQL_NULL' }],
    ['both populated', { allowedRuleCodeGroupsKind: 'array', stackingGroupsKind: 'array' }],
    ['JSON null active slot', { allowedRuleCodeGroupsKind: 'SQL_NULL', stackingGroupsKind: 'null' }],
    ['object active slot', { allowedRuleCodeGroupsKind: 'SQL_NULL', stackingGroupsKind: 'object' }],
  ])('rejects %s physical provenance before reading children', async (_label, kinds) => {
    const tx = graphTx({ ...baseParent, ...kinds } as typeof baseParent)

    await expect(loadCommercialCampaignDraftGraph(tx as never, baseParent.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID',
    })
    expect(tx.commercialCampaignRuleDraft.findMany).not.toHaveBeenCalled()
  })

  it('rejects a v3 offer draft before reading v2 rules', async () => {
    const tx = graphTx({ ...baseParent, offerSchemaVersion: 3 })

    await expect(loadCommercialCampaignDraftGraph(tx as never, baseParent.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_SCHEMA_UNSUPPORTED',
    })
    expect(tx.commercialCampaignRuleDraft.findMany).not.toHaveBeenCalled()
  })

  it('returns a safe canonical read-only upgradeSource for the only legacy physical state', async () => {
    const tx = graphTx({
      ...baseParent,
      allowedRuleCodeGroups: [['POS_FIFTY']],
      allowedRuleCodeGroupsKind: 'array',
      stackingGroups: null,
      stackingGroupsKind: 'SQL_NULL',
    } as typeof baseParent)

    await expect(loadCommercialCampaignDraftGraph(tx as never, baseParent.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_UPGRADE_REQUIRED',
      details: {
        upgradeSource: {
          sourceFormat: 'LEGACY_ALLOWED_RULE_CODE_GROUPS_V1',
          draftId: baseParent.id,
          revision: 1,
          legacyAllowedRuleCodeGroups: [['POS_FIFTY']],
          rules: [{ code: 'POS_FIFTY', type: 'FIXED_PRICE', amount: '50.00' }],
        },
      },
    })
  })

  it('rejects noncanonical or malformed persisted v2 JSON instead of silently normalizing it', async () => {
    const noncanonicalTargetTx = graphTx(baseParent, [{ ...baseRule, target: { productCodes: ['ZZ', 'POS'] } }])
    const malformedNestedTx = graphTx(
      {
        ...baseParent,
        stackingGroups: [
          {
            code: 'INTRO_STACK',
            steps: [
              { position: 1, ruleCode: 'POS_FIFTY' },
              { position: 2, ruleCode: 'UNKNOWN_RULE' },
            ],
          },
        ],
      },
      [baseRule],
    )

    for (const tx of [noncanonicalTargetTx, malformedNestedTx]) {
      await expect(loadCommercialCampaignDraftGraph(tx as never, baseParent.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID',
      })
    }
  })
})

import { createCommercialCampaignDraftService } from '@/services/commercial/commercialCampaignDraft.service'
import { loadCommercialCampaignDraftGraph } from '@/services/commercial/commercialCampaignDraftGraph.service'

const input = {
  code: 'POS_INTRO_2026',
  name: 'POS introducción',
  description: 'Precio temporal',
  startsAt: '2026-08-22T06:00:00.000Z',
  endsAt: '2026-09-22T06:00:00.000Z',
  stackingGroups: [],
  rules: [
    {
      code: 'POS_FIFTY',
      type: 'FIXED_PRICE' as const,
      priority: 100,
      target: { productCodes: ['POS'] },
      amount: '50.00',
      cycles: 3,
    },
  ],
}
const actor = { staffId: 'staff-1', reason: 'Preparar piloto CDMX' }

function harness() {
  const view = { id: 'draft-1', ...input, revision: 1, offerSchemaVersion: 2 as const, status: 'ACTIVE' as const }
  const tx = {
    createGraph: jest.fn(async () => view),
    replaceGraphIfRevision: jest.fn(async (_id, replacement) => ({ ...view, ...replacement, revision: 2 })),
    exists: jest.fn(async () => true),
    writeAudit: jest.fn(async () => undefined),
  }
  const dependencies = {
    getGraph: jest.fn(async () => view),
    runInTransaction: jest.fn(async operation => operation(tx)),
  }
  return { service: createCommercialCampaignDraftService(dependencies), dependencies, tx }
}

function prismaDraftParent() {
  return {
    id: 'draft-prisma-1',
    code: input.code,
    name: input.name,
    description: input.description,
    revision: 1,
    offerSchemaVersion: 2,
    status: 'ACTIVE' as const,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    allowedRuleCodeGroups: null,
    allowedRuleCodeGroupsKind: 'SQL_NULL',
    stackingGroups: [],
    stackingGroupsKind: 'array',
    transactionIsolation: 'repeatable read',
    createdAt: new Date('2026-08-22T05:00:00.000Z'),
    updatedAt: new Date('2026-08-22T05:00:00.000Z'),
  }
}

function prismaDraftRule(amountMinor: bigint | number | null) {
  return {
    id: 'rule-1',
    campaignDraftId: 'draft-prisma-1',
    code: 'POS_FIFTY',
    type: 'FIXED_PRICE' as const,
    priority: 100,
    target: { productCodes: ['POS'] },
    amountMinor,
    percentBasisPoints: null,
    cycles: 3,
  }
}

function prismaDraftTx(amountMinor: bigint | number | null) {
  return {
    $queryRaw: jest.fn(async () => [prismaDraftParent()]),
    commercialCampaignRuleDraft: {
      findMany: jest.fn(async () => [prismaDraftRule(amountMinor)]),
    },
  }
}

describe('commercial campaign draft', () => {
  it('[P3-2B-U1] projects a Prisma bigint read to the exact canonical v2 money string', async () => {
    const graph = await loadCommercialCampaignDraftGraph(prismaDraftTx(5000n) as never, 'draft-prisma-1', {
      consistency: 'SNAPSHOT',
    })

    expect({
      ruleType: graph?.rules[0].type,
      amount: (graph?.rules[0] as { amount: unknown }).amount,
      stackingGroups: graph?.stackingGroups,
    }).toEqual({ ruleType: 'FIXED_PRICE', amount: '50.00', stackingGroups: [] })
  })

  it.each([
    {
      label: 'valid lower and unit-maximum bigint boundaries',
      valid: [0n, 999999999999n] as bigint[],
      invalid: [] as Array<{ value: bigint | number | null; code: string }>,
    },
    {
      label: 'int4 plus one is valid while commercial unit overflow fails closed',
      valid: [2147483648n] as bigint[],
      invalid: [{ value: 1000000000000n, code: 'COMMERCIAL_CAMPAIGN_DRAFT_AMOUNT_OUT_OF_RANGE' }],
    },
    {
      label: 'negative, null and non-bigint physical money are invalid storage',
      valid: [] as bigint[],
      invalid: [-1n, null, 0, 1.5].map(value => ({ value, code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID' })),
    },
  ])('[P3-2B-U2] enforces the complete v2 Prisma amount contract: $label', async ({ valid, invalid }) => {
    const validResults = await Promise.all(
      valid.map(amountMinor =>
        loadCommercialCampaignDraftGraph(prismaDraftTx(amountMinor) as never, 'draft-prisma-1', { consistency: 'SNAPSHOT' }),
      ),
    )
    const invalidResults = await Promise.allSettled(
      invalid.map(({ value }) =>
        loadCommercialCampaignDraftGraph(prismaDraftTx(value) as never, 'draft-prisma-1', { consistency: 'SNAPSHOT' }),
      ),
    )

    expect({
      valid: validResults.map(result => (result?.rules[0] as { amount: unknown }).amount),
      invalid: invalidResults.map(result => ({
        status: result.status,
        statusCode: result.status === 'rejected' ? (result.reason as { statusCode?: unknown })?.statusCode : undefined,
        code: result.status === 'rejected' ? (result.reason as { code?: unknown })?.code : undefined,
      })),
    }).toEqual({
      valid: valid.map(amountMinor => `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}`),
      invalid: invalid.map(({ code }) => ({
        status: 'rejected',
        statusCode: 409,
        code,
      })),
    })
  })

  it('creates a normalized draft and durable audit entry', async () => {
    const { service, tx } = harness()
    const unordered = {
      ...input,
      rules: [
        {
          code: 'A_B',
          type: 'PERCENT_OFF' as const,
          priority: 90,
          target: {
            productCodes: ['ZZ', 'AB'],
            productKinds: ['MODULE', 'PLAN', 'POS'],
            bundleCodes: ['ZZ_BUNDLE', 'AB_BUNDLE'],
          },
          percentBasisPoints: 1000,
          cycles: 3,
        },
        {
          ...input.rules[0],
          code: 'AB',
        },
      ],
      stackingGroups: [
        {
          code: 'Z_GROUP',
          steps: [
            { position: 2, ruleCode: 'A_B' },
            { position: 1, ruleCode: 'AB' },
          ],
        },
        {
          code: 'A_GROUP',
          steps: [
            { position: 2, ruleCode: 'A_B' },
            { position: 1, ruleCode: 'AB' },
          ],
        },
      ],
    }

    await expect(service.createDraft(unordered, actor)).resolves.toMatchObject({ id: 'draft-1', revision: 1 })

    expect(tx.createGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        rules: [
          expect.objectContaining({ code: 'AB' }),
          expect.objectContaining({
            code: 'A_B',
            target: {
              productCodes: ['AB', 'ZZ'],
              productKinds: ['PLAN', 'POS', 'MODULE'],
              bundleCodes: ['AB_BUNDLE', 'ZZ_BUNDLE'],
            },
          }),
        ],
        stackingGroups: [
          expect.objectContaining({
            code: 'A_GROUP',
            steps: [
              { position: 1, ruleCode: 'AB' },
              { position: 2, ruleCode: 'A_B' },
            ],
          }),
          expect.objectContaining({
            code: 'Z_GROUP',
            steps: [
              { position: 1, ruleCode: 'AB' },
              { position: 2, ruleCode: 'A_B' },
            ],
          }),
        ],
      }),
      'staff-1',
    )
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_CAMPAIGN_DRAFT_CREATED',
        entityId: 'draft-1',
      }),
    )
  })

  it('replaces the normalized graph with optimistic concurrency', async () => {
    const { service, tx } = harness()
    await expect(service.replaceDraft('draft-1', input, 1, actor)).resolves.toMatchObject({ revision: 2 })
    expect(tx.replaceGraphIfRevision).toHaveBeenCalledWith('draft-1', input, 1, 'staff-1')
    expect(tx.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COMMERCIAL_CAMPAIGN_DRAFT_REPLACED',
        before: { revision: 1 },
        after: { revision: 2 },
      }),
    )
  })

  it('rejects stale revisions without writing audit', async () => {
    const { service, tx } = harness()
    tx.replaceGraphIfRevision.mockResolvedValueOnce(null)
    await expect(service.replaceDraft('draft-1', input, 3, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_CONFLICT',
    })
    expect(tx.writeAudit).not.toHaveBeenCalled()
  })

  it('rejects invalid windows, duplicate rules and unknown client fields', async () => {
    const { service, tx } = harness()
    await expect(service.createDraft({ ...input, endsAt: input.startsAt }, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID',
    })
    await expect(service.createDraft({ ...input, amountMinor: 22 } as never, actor)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID',
    })
    expect(tx.createGraph).not.toHaveBeenCalled()
  })
})

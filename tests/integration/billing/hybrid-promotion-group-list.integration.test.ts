import prisma from '@/utils/prismaClient'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { getPromotionGroup, listPromotionGroups } from '@/services/launchCampaigns/hybridPromotionGroup.service'
import { listHybridCampaigns } from '@/services/launchCampaigns/hybridCampaign.service'

const stamp = `${Date.now()}${process.pid}`
// Every row of this suite carries this author; they are ENDED after the run (groups and campaigns are never deleted).
const MARK = 'test:hybrid-promotion-group-list'
const definition = compileHybridPublication({
  schemaVersion: 1,
  kind: 'FEATURES',
  featureCodes: ['TRANSACTION_EXPORT'],
  terms: { currency: 'MXN', interval: 'MONTHLY', price: 99, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
})
const window = { startsAt: new Date(Date.now() - 86400000), endsAt: new Date(Date.now() + 7 * 86400000) }
const groups: { id: string; status: string }[] = []
let totals: { all: number; active: number }

async function campaign(groupId: string, ordinal: number, published: boolean) {
  const row = await prisma.hybridCampaign.create({
    data: {
      code: `GLIST${stamp}_${ordinal}`,
      slug: `glist-${stamp}-${ordinal}`,
      name: `Lista de grupos ${stamp} ${ordinal}`,
      draftDefinition: definition.definition,
      ...window,
      capacity: 10,
      audience: 'ALL',
      listed: true,
      purpose: 'PROMOTION',
      promotionGroupId: groupId,
      status: 'PAUSED',
      createdById: MARK,
    },
  })
  if (!published) return row
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: row.id,
      version: 1,
      name: row.name,
      definition: definition.definition,
      definitionHash: definition.definitionHash,
      includedFeatureCodes: definition.includedFeatureCodes,
      createdById: MARK,
    },
  })
  return prisma.hybridCampaign.update({ where: { id: row.id }, data: { currentPublicationId: publication.id } })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  totals = {
    all: (await listPromotionGroups({ pageSize: 1 })).total,
    active: (await listPromotionGroups({ pageSize: 1, status: 'ACTIVE' })).total,
  }
  // Distinct, increasing createdAt: the newest rows of the table, in a known order.
  const base = Date.now()
  for (const [index, status] of (['PAUSED', 'ACTIVE', 'PAUSED', 'ENDED'] as const).entries())
    groups.push(
      await prisma.hybridPromotionGroup.create({
        data: {
          name: `Grupo ${stamp} ${index + 1}`,
          percentOff: 10 + index,
          target: { kind: 'FEATURES', featureCodes: ['TRANSACTION_EXPORT'] },
          ...window,
          promotionCycles: index === 0 ? 3 : null,
          capacityPerFeature: 5 + index,
          status,
          createdById: MARK,
          createdAt: new Date(base + index),
        },
      }),
    )
  await campaign(groups[0].id, 2, false)
  await campaign(groups[0].id, 1, true)
})
afterAll(async () => {
  await prisma.hybridCampaign.updateMany({ where: { createdById: MARK }, data: { status: 'ENDED' } })
  await prisma.hybridPromotionGroup.updateMany({ where: { createdById: MARK }, data: { status: 'ENDED' } })
})

describe('«Descuentos %» list, paginated by the server (audit #12)', () => {
  it('pages newest first with a unique tie-breaker and the exact total', async () => {
    const first = await listPromotionGroups({ page: 1, pageSize: 3 })
    expect(first).toMatchObject({ total: totals.all + 4, page: 1, pageSize: 3, totalPages: Math.ceil((totals.all + 4) / 3) })
    expect(first.items.map(group => group.id)).toEqual([groups[3].id, groups[2].id, groups[1].id])
    const second = await listPromotionGroups({ page: '2', pageSize: '3' })
    expect(second.items[0].id).toBe(groups[0].id)
  })

  it('each row carries name, %, dates, status, revision, number of functions and capacity per function', async () => {
    const { items } = await listPromotionGroups({ page: 2, pageSize: 3 })
    expect(items[0]).toMatchObject({
      id: groups[0].id,
      name: `Grupo ${stamp} 1`,
      percentOff: 10,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      promotionCycles: 3,
      status: 'PAUSED',
      revision: 1,
      functions: 2,
      capacityPerFeature: 5,
    })
  })

  it('filters by status before paginating', async () => {
    const active = await listPromotionGroups({ status: 'ACTIVE', pageSize: 100 })
    expect(active.total).toBe(totals.active + 1)
    expect(active.items.every(group => group.status === 'ACTIVE')).toBe(true)
    expect(active.items[0].id).toBe(groups[1].id)
  })

  it.each([{ pageSize: 101 }, { page: 0 }, { page: 10001 }, { status: 'DRAFT' }, { sort: 'name' }])(
    'rejects the hostile query %o',
    async query => {
      await expect(listPromotionGroups(query)).rejects.toMatchObject({ code: 'HYBRID_PROMOTION_INVALID' })
    },
  )
})

describe('a group and its campaigns', () => {
  it('returns the group with every campaign in ordinal order and the publication on sale', async () => {
    const detail = await getPromotionGroup(groups[0].id)
    expect(detail).toMatchObject({ id: groups[0].id, percentOff: 10, revision: 1 })
    expect(detail.campaigns.map(c => c.code)).toEqual([`GLIST${stamp}_1`, `GLIST${stamp}_2`])
    expect(detail.campaigns[0].publication).toMatchObject({ definitionHash: definition.definitionHash })
    expect(detail.campaigns[1].publication).toBeNull()
  })

  it('an unknown group is a 404', async () => {
    await expect(getPromotionGroup('missing-group')).rejects.toMatchObject({ statusCode: 404, code: 'HYBRID_PROMOTION_GROUP_NOT_FOUND' })
  })
})

describe('«Campañas» can leave out what a group owns (excludeGrouped)', () => {
  it('omits grouped campaigns only when asked; the default response is unchanged', async () => {
    const plain = await listHybridCampaigns({ q: `GLIST${stamp}` })
    expect(plain.total).toBe(2)
    expect(await listHybridCampaigns({ q: `GLIST${stamp}`, excludeGrouped: 'false' })).toEqual(plain)
    expect(await listHybridCampaigns({ q: `GLIST${stamp}`, excludeGrouped: 'true' })).toMatchObject({ items: [], total: 0 })
  })

  it('rejects a value that is not true or false', async () => {
    await expect(listHybridCampaigns({ excludeGrouped: 'yes' })).rejects.toMatchObject({ code: 'HYBRID_CAMPAIGN_INVALID' })
  })
})

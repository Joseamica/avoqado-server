import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
// Stripe is not what this suite measures: «preparing» a publication just stamps fake Product/Price ids on it.
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) =>
    require('@/utils/prismaClient').default.hybridOfferPublication.update({
      where: { id },
      data: { stripeProductId: `prod_seed_${id}`, stripePriceId: `price_seed_${id}` },
    }),
  ),
}))
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { STANDARD_PLAN_GROSS_CENTS } from '@/services/access/planPricing.constants'
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { seedPlanLists } from '../../../scripts/seed-plan-list-prices'

const stamp = `${Date.now()}${process.pid}`
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const host = new URL(process.env.TEST_DATABASE_URL!).hostname
const dbName = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1)
let staffId: string
// Plan lists other suites (or an earlier seed) left on the shared disposable DB: parked during the run, restored after.
let parked: { id: string; listProductKey: string | null; code: string; slug: string }[] = []

const planLists = () =>
  prisma.hybridCampaign.findMany({ where: { purpose: 'LIST', listProductKey: { in: KEYS } }, orderBy: { listProductKey: 'asc' }, take: 2 })
const priceOf = async (publicationId: string | null) =>
  hybridOfferDefinition.parse((await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: publicationId! } })).definition).terms
    .price
async function run(options: { apply: boolean; confirmHost?: string; confirmDb?: string }) {
  const lines: string[] = []
  const report = await seedPlanLists({ ...options, staffId }, line => lines.push(line))
  return { report, text: lines.join('\n') }
}

/** Lists are never deleted (their publications cannot be): free the product key, code and slug a seed claims. */
async function retireSeeded() {
  const rows = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', OR: [{ listProductKey: { in: KEYS } }, { code: { in: ['L_PLAN_PRO', 'L_PLAN_PREMIUM'] } }] },
    select: { id: true },
    take: 10,
  })
  for (const { id } of rows)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:RETIRED_${id}`, code: `RETIRED_${id}`, slug: `retired-${id}`, status: 'PAUSED' },
    })
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  parked = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', OR: [{ listProductKey: { in: KEYS } }, { code: { in: ['L_PLAN_PRO', 'L_PLAN_PREMIUM'] } }] },
    select: { id: true, listProductKey: true, code: true, slug: true },
    take: 10,
  })
  for (const { id } of parked)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:PARKED_${id}`, code: `PARKED_${id}`, slug: `parked-${id}` },
    })
  staffId = (await prisma.staff.create({ data: { email: `seed-${stamp}@example.test`, firstName: 'Seed', lastName: 'Test' } })).id
})
afterAll(async () => {
  await retireSeeded()
  for (const { id, listProductKey, code, slug } of parked)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } })
})

describe('seeding the plan lists at the classic monthly price (spec §4.2)', () => {
  it('derives the prices from the classic plan, never typed by hand', () => {
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.monthly / 100).toBe(1158.84)
    expect(STANDARD_PLAN_GROSS_CENTS.PREMIUM.monthly / 100).toBe(1970.84)
  })

  it('without --apply it prints the database host and writes nothing', async () => {
    const { report, text } = await run({ apply: false })
    expect(text.split('\n')[0]).toContain(host)
    expect(report.results.map(r => [r.productKey, r.outcome, r.price])).toEqual([
      ['PLAN:PRO', 'CREATE', 1158.84],
      ['PLAN:PREMIUM', 'CREATE', 1970.84],
    ])
    expect(text).toMatch(/se crearía/)
    expect(await planLists()).toEqual([])
  })

  it('--apply without the exact host refuses before writing anything', async () => {
    await expect(run({ apply: true })).rejects.toThrow(/--confirm-host/)
    await expect(run({ apply: true, confirmHost: 'otra-base.example.com', confirmDb: dbName })).rejects.toThrow(/--confirm-host/)
    expect(await planLists()).toEqual([])
  })

  it('--apply with the right host but another database name refuses before writing anything', async () => {
    // Several databases share one host (localhost): the host alone does not say which one is written.
    const refused = run({ apply: true, confirmHost: host, confirmDb: 'av-db-25' })
    await expect(refused).rejects.toThrow(`--confirm-host ${host} --confirm-db ${dbName}`)
    await expect(run({ apply: true, confirmHost: host })).rejects.toThrow(/--confirm-db/)
    expect(await planLists()).toEqual([])
  })

  it('a failed Stripe preparation puts nothing on sale; the next --apply finishes it and creates the rest', async () => {
    jest.mocked(ensureHybridPublicationPrices).mockRejectedValueOnce(new Error('Stripe no contestó'))
    await expect(run({ apply: true, confirmHost: host, confirmDb: dbName })).rejects.toMatchObject({ code: 'HYBRID_LIST_PREPARING' })
    const [pending] = await planLists()
    expect(pending).toMatchObject({ listProductKey: 'PLAN:PRO', status: 'DRAFT', currentPublicationId: null })
    expect((await run({ apply: false })).report.results.map(r => r.outcome)).toEqual(['PENDING', 'CREATE'])
    const { report, text } = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(report.results.map(r => r.outcome)).toEqual(['PENDING', 'CREATE'])
    expect(text).toMatch(/PLAN:PRO: precio pendiente terminado a \$1158\.84/)
  })

  it('--apply leaves both lists ACTIVE at the classic price, with their Stripe prices prepared', async () => {
    const lists = await planLists()
    expect(lists.map(list => [list.listProductKey, list.status, list.pendingPublicationId, list.createdById])).toEqual([
      ['PLAN:PREMIUM', 'ACTIVE', null, staffId],
      ['PLAN:PRO', 'ACTIVE', null, staffId],
    ])
    expect(await priceOf(lists[0].currentPublicationId)).toBe(1970.84)
    expect(await priceOf(lists[1].currentPublicationId)).toBe(1158.84)
    // A Stripe Product name is permanent: never the classic plans' «Pro» / «Premium».
    expect(lists.map(list => list.name)).toEqual(['Plan Premium', 'Plan Pro'])
    for (const list of lists) {
      const publication = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: list.currentPublicationId! } })
      expect(publication.name).toBe(list.name)
      expect(publication.stripePriceId).toBe(`price_seed_${publication.id}`)
      expect(hybridOfferDefinition.parse(publication.definition)).toMatchObject({
        kind: 'PLAN',
        terms: { renewal: { kind: 'SAME_PRICE' } },
      })
    }
    const audits = await prisma.activityLog.count({ where: { staffId, action: 'HYBRID_LIST_PRICE_SAVED' } })
    expect(audits).toBe(2)
  })

  it('a second run duplicates nothing and says the list already exists', async () => {
    const before = await planLists()
    const publications = await prisma.hybridOfferPublication.count({ where: { campaignId: { in: before.map(list => list.id) } } })
    const { report, text } = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(report.results.map(r => r.outcome)).toEqual(['EXISTS', 'EXISTS'])
    expect(text).toMatch(/ya existe/)
    expect(await planLists()).toEqual(before)
    expect(await prisma.hybridOfferPublication.count({ where: { campaignId: { in: before.map(list => list.id) } } })).toBe(publications)
  })

  it('a plan list at another price is left alone: phase 2 decides plan prices', async () => {
    const pro = (await planLists()).find(list => list.listProductKey === 'PLAN:PRO')!
    const compiled = compileHybridPublication({
      schemaVersion: 1,
      kind: 'PLAN',
      planTier: 'PRO',
      terms: {
        currency: 'MXN',
        interval: 'MONTHLY',
        price: 999,
        taxIncluded: true,
        promotionCycles: null,
        renewal: { kind: 'SAME_PRICE' },
      },
    })
    const other = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: pro.id,
        version: pro.revision,
        name: pro.name,
        definition: compiled.definition,
        definitionHash: compiled.definitionHash,
        includedFeatureCodes: compiled.includedFeatureCodes,
        createdById: staffId,
      },
    })
    await prisma.hybridCampaign.update({ where: { id: pro.id }, data: { currentPublicationId: other.id, revision: { increment: 1 } } })
    const changed = await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: pro.id } })
    const { report, text } = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(report.results.find(r => r.productKey === 'PLAN:PRO')).toMatchObject({ outcome: 'DIFFERENT_PRICE', current: 999 })
    expect(text).toMatch(/precio distinto: la fase 2 lo decide/)
    expect(await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: pro.id } })).toEqual(changed)
  })

  /** Puts on sale a copy of the list's current publication without SERVICE_PAY: how the lists published on 5-oct look. */
  async function sellWithoutServicePay(key: string) {
    const list = (await planLists()).find(candidate => candidate.listProductKey === key)!
    const current = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: list.currentPublicationId! } })
    expect(current.includedFeatureCodes).toContain('SERVICE_PAY')
    const stale = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: list.id,
        version: list.revision,
        name: list.name,
        definition: current.definition as Prisma.InputJsonValue,
        definitionHash: current.definitionHash,
        includedFeatureCodes: current.includedFeatureCodes.filter(code => code !== 'SERVICE_PAY'),
        createdById: staffId,
      },
    })
    await prisma.hybridCampaign.update({ where: { id: list.id }, data: { currentPublicationId: stale.id, revision: { increment: 1 } } })
    return { list, current, stale }
  }

  it('a plan list selling an older composition: the dry run names what it lacks and writes nothing', async () => {
    const { list } = await sellWithoutServicePay('PLAN:PREMIUM')
    const before = await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: list.id } })
    const { report, text } = await run({ apply: false })
    expect(report.results.find(r => r.productKey === 'PLAN:PREMIUM')).toMatchObject({
      outcome: 'EXISTS',
      missing: ['SERVICE_PAY'],
      extra: [],
      recomposed: false,
    })
    expect(text).toMatch(/PLAN:PREMIUM: .*le falta SERVICE_PAY.*--apply la republica al mismo precio/)
    expect(await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: list.id } })).toEqual(before)
  })

  it('--apply republishes it at the same price with the code composition, and a second run publishes nothing', async () => {
    const list = (await planLists()).find(candidate => candidate.listProductKey === 'PLAN:PREMIUM')!
    const stale = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: list.currentPublicationId! } })
    const { report, text } = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(report.results.find(r => r.productKey === 'PLAN:PREMIUM')).toMatchObject({
      outcome: 'EXISTS',
      missing: ['SERVICE_PAY'],
      recomposed: true,
    })
    expect(text).toMatch(/PLAN:PREMIUM: .*republicada al mismo precio/)
    const after = await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: list.id } })
    expect(after).toMatchObject({ status: 'ACTIVE', pendingPublicationId: null })
    expect(after.currentPublicationId).not.toBe(stale.id)
    const republished = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: after.currentPublicationId! } })
    expect(republished.includedFeatureCodes).toContain('SERVICE_PAY')
    expect(republished.definitionHash).toBe(stale.definitionHash)
    expect(await priceOf(republished.id)).toBe(1970.84)
    expect(republished.stripePriceId).toBe(`price_seed_${republished.id}`)

    const publications = await prisma.hybridOfferPublication.count({ where: { campaignId: list.id } })
    const again = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(again.report.results.find(r => r.productKey === 'PLAN:PREMIUM')).toMatchObject({ missing: [], extra: [], recomposed: false })
    expect(await prisma.hybridOfferPublication.count({ where: { campaignId: list.id } })).toBe(publications)
  })

  it('a plan list at another price keeps that price when its composition is brought up to date', async () => {
    const { list } = await sellWithoutServicePay('PLAN:PRO')
    const { report } = await run({ apply: true, confirmHost: host, confirmDb: dbName })
    expect(report.results.find(r => r.productKey === 'PLAN:PRO')).toMatchObject({
      outcome: 'DIFFERENT_PRICE',
      current: 999,
      missing: ['SERVICE_PAY'],
      recomposed: true,
    })
    const after = await prisma.hybridCampaign.findUniqueOrThrow({ where: { id: list.id } })
    const republished = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: after.currentPublicationId! } })
    expect(republished.includedFeatureCodes).toContain('SERVICE_PAY')
    expect(await priceOf(republished.id)).toBe(999)
  })
})

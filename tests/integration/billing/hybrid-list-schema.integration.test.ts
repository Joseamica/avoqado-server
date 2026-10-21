import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const stamp = `${Date.now()}${process.pid}`
const PURPOSE_SHAPE = /HybridCampaign_purpose_shape/
const GROUP_SHAPE = /HybridPromotionGroup_percent/

beforeAll(() => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
})

const base = (over: Partial<Prisma.HybridCampaignUncheckedCreateInput>): Prisma.HybridCampaignUncheckedCreateInput => ({
  code: `S${stamp}${Math.random().toString(36).slice(2, 6)}`.toUpperCase().slice(0, 30),
  slug: `s-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Esquema',
  draftDefinition: {},
  startsAt: new Date(),
  audience: 'ALL',
  createdById: 'staff-schema',
  ...over,
})

const group = (over: Partial<Prisma.HybridPromotionGroupUncheckedCreateInput>) =>
  prisma.hybridPromotionGroup.create({
    data: {
      name: 'Grupo',
      percentOff: 20,
      target: { kind: 'ALL_FEATURES' },
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 1e7),
      capacityPerFeature: 10,
      createdById: 'staff-schema',
      ...over,
    },
  })

describe('HybridCampaign purpose constraints', () => {
  it('a PROMOTION requires endsAt and capacity', async () => {
    await expect(prisma.hybridCampaign.create({ data: base({ purpose: 'PROMOTION', endsAt: null, capacity: 5 }) })).rejects.toThrow(
      PURPOSE_SHAPE,
    )
    await expect(
      prisma.hybridCampaign.create({ data: base({ purpose: 'PROMOTION', endsAt: new Date(Date.now() + 1e7), capacity: null }) }),
    ).rejects.toThrow(PURPOSE_SHAPE)
    await expect(
      prisma.hybridCampaign.create({
        data: base({ purpose: 'PROMOTION', listProductKey: `FEATURE:PROMO_${stamp}`, endsAt: new Date(Date.now() + 1e7), capacity: 5 }),
      }),
    ).rejects.toThrow(PURPOSE_SHAPE)
  })

  it('a LIST has no end, no capacity, and one per product', async () => {
    const key = `FEATURE:SCHEMA_${stamp}`
    await prisma.hybridCampaign.create({ data: base({ purpose: 'LIST', listProductKey: key, endsAt: null, capacity: null }) })
    await expect(
      prisma.hybridCampaign.create({ data: base({ purpose: 'LIST', listProductKey: key, endsAt: null, capacity: null }) }),
    ).rejects.toMatchObject({ code: 'P2002' })
    await expect(
      prisma.hybridCampaign.create({ data: base({ purpose: 'LIST', listProductKey: `${key}_2`, endsAt: new Date(), capacity: null }) }),
    ).rejects.toThrow(PURPOSE_SHAPE)
  })

  it('existing campaigns default to PROMOTION', async () => {
    const row = await prisma.hybridCampaign.create({ data: base({ endsAt: new Date(Date.now() + 1e7), capacity: 3 }) })
    expect(row.purpose).toBe('PROMOTION')
    expect(row.currentPublicationId).toBeNull()
    expect(row.pendingPublicationId).toBeNull()
  })

  it('a promotion group bounds percent, capacity and window, and only PROMOTION campaigns join it', async () => {
    await expect(group({ percentOff: 0 })).rejects.toThrow(GROUP_SHAPE)
    await expect(group({ percentOff: 91 })).rejects.toThrow(GROUP_SHAPE)
    await expect(group({ capacityPerFeature: 0 })).rejects.toThrow(GROUP_SHAPE)
    await expect(group({ endsAt: new Date(Date.now() - 1e7) })).rejects.toThrow(GROUP_SHAPE)
    const created = await group({})
    expect(created.status).toBe('PAUSED')
    const member = await prisma.hybridCampaign.create({
      data: base({ purpose: 'PROMOTION', promotionGroupId: created.id, endsAt: created.endsAt, capacity: created.capacityPerFeature }),
    })
    expect(member.promotionGroupId).toBe(created.id)
    await expect(
      prisma.hybridCampaign.create({
        data: base({
          purpose: 'LIST',
          listProductKey: `FEATURE:GROUP_${stamp}`,
          promotionGroupId: created.id,
          endsAt: null,
          capacity: null,
        }),
      }),
    ).rejects.toThrow(PURPOSE_SHAPE)
  })
})

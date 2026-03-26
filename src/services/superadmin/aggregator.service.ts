import prisma from '../../utils/prismaClient'

export async function getAggregators(filters: { active?: boolean } = {}) {
  const where: any = {}
  if (filters.active !== undefined) where.active = filters.active

  return prisma.aggregator.findMany({
    where,
    include: {
      _count: { select: { merchants: true, venueCommissions: true } },
    },
    orderBy: { name: 'asc' },
  })
}

export async function getAggregatorById(id: string) {
  return prisma.aggregator.findUnique({
    where: { id },
    include: {
      merchants: {
        select: { id: true, displayName: true, externalMerchantId: true, active: true },
      },
      venueCommissions: {
        include: { venue: { select: { id: true, name: true, slug: true } } },
      },
    },
  })
}

export async function createAggregator(data: {
  name: string
  venueId?: string
  baseFees: Record<string, number>
  ivaRate?: number
  active?: boolean
}) {
  return prisma.aggregator.create({ data })
}

export async function updateAggregator(
  id: string,
  data: { name?: string; venueId?: string; baseFees?: Record<string, number>; ivaRate?: number; active?: boolean },
) {
  return prisma.aggregator.update({ where: { id }, data })
}

export async function toggleAggregator(id: string) {
  const aggregator = await prisma.aggregator.findUniqueOrThrow({ where: { id } })
  return prisma.aggregator.update({
    where: { id },
    data: { active: !aggregator.active },
  })
}

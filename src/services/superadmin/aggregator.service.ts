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
        select: {
          id: true,
          displayName: true,
          externalMerchantId: true,
          active: true,
          financialAccount: {
            select: {
              id: true,
              label: true,
              lastBalance: true,
              balanceState: true,
              connection: { select: { provider: { select: { code: true, name: true } } } },
            },
          },
        },
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

/**
 * Hard-delete un agregador. Falla si tiene merchants o comisiones por venue
 * ligadas — desactivar (toggle) es lo correcto en ese caso. Esto solo permite
 * borrar agregadores realmente huérfanos (típico: uno creado por error).
 */
export async function deleteAggregator(id: string) {
  const aggregator = await prisma.aggregator.findUnique({
    where: { id },
    include: {
      _count: { select: { merchants: true, venueCommissions: true } },
    },
  })
  if (!aggregator) {
    const { NotFoundError } = await import('../../errors/AppError')
    throw new NotFoundError('Agregador no encontrado')
  }
  const c = aggregator._count
  if (c.merchants > 0 || c.venueCommissions > 0) {
    const { BadRequestError } = await import('../../errors/AppError')
    const refs: string[] = []
    if (c.merchants > 0) refs.push(`${c.merchants} comercio${c.merchants === 1 ? '' : 's'}`)
    if (c.venueCommissions > 0) refs.push(`${c.venueCommissions} comisión${c.venueCommissions === 1 ? '' : 'es'}`)
    throw new BadRequestError(
      `No se puede eliminar: tiene ${refs.join(', ')} ligado${refs.length > 1 ? 's' : ''}. Desactívalo o quita esas referencias primero.`,
    )
  }
  await prisma.aggregator.delete({ where: { id } })
}

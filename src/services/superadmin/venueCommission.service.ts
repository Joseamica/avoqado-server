import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'

export async function getVenueCommissions(filters: { aggregatorId?: string; active?: boolean } = {}) {
  const where: any = {}
  if (filters.aggregatorId) where.aggregatorId = filters.aggregatorId
  if (filters.active !== undefined) where.active = filters.active

  return prisma.venueCommission.findMany({
    where,
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      aggregator: { select: { id: true, name: true } },
    },
    orderBy: { venue: { name: 'asc' } },
  })
}

export async function getVenueCommissionById(id: string) {
  return prisma.venueCommission.findUnique({
    where: { id },
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      aggregator: { select: { id: true, name: true, baseFees: true } },
    },
  })
}

export async function getVenueCommissionByVenueId(venueId: string) {
  return prisma.venueCommission.findUnique({
    where: { venueId },
    include: {
      aggregator: { select: { id: true, name: true, baseFees: true } },
    },
  })
}

export async function createVenueCommission(data: {
  venueId: string
  aggregatorId: string
  rate: number
  referredBy: string
  active?: boolean
}) {
  return prisma.venueCommission.create({
    data: {
      venueId: data.venueId,
      aggregatorId: data.aggregatorId,
      rate: new Prisma.Decimal(data.rate),
      referredBy: data.referredBy,
      active: data.active,
    },
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      aggregator: { select: { id: true, name: true } },
    },
  })
}

export async function updateVenueCommission(id: string, data: { rate?: number; referredBy?: string; active?: boolean }) {
  const updateData: any = {}
  if (data.rate !== undefined) updateData.rate = new Prisma.Decimal(data.rate)
  if (data.referredBy !== undefined) updateData.referredBy = data.referredBy
  if (data.active !== undefined) updateData.active = data.active

  return prisma.venueCommission.update({
    where: { id },
    data: updateData,
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      aggregator: { select: { id: true, name: true } },
    },
  })
}

export async function deleteVenueCommission(id: string) {
  return prisma.venueCommission.delete({ where: { id } })
}

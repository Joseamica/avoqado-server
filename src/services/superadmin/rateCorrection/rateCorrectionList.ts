import prisma from '@/utils/prismaClient'

export async function listRateCorrections(args: { venueId?: string }) {
  return prisma.rateCorrectionBatch.findMany({
    where: args.venueId ? { venueId: args.venueId } : {},
    orderBy: { createdAt: 'desc' },
    include: {
      merchantAccount: { select: { id: true, displayName: true, alias: true } },
      appliedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  })
}

import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import logger from '../../config/logger'

export async function offboardVenueStripeConnect(venueId: string, staffId?: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, name: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const merchants = await prisma.ecommerceMerchant.findMany({
    where: {
      venueId,
      provider: { code: 'STRIPE_CONNECT' },
    },
    include: { provider: true },
  })

  if (merchants.length === 0) {
    throw new NotFoundError('No hay merchant Stripe Connect para este venue')
  }

  await prisma.ecommerceMerchant.updateMany({
    where: {
      venueId,
      provider: { code: 'STRIPE_CONNECT' },
    },
    data: {
      active: false,
      chargesEnabled: false,
      offboardingInitiatedAt: new Date(),
    },
  })

  const [openDisputes, refundsInFlight, paidDeposits] = await Promise.all([
    prisma.reservation.count({ where: { venueId, depositStatus: 'DISPUTED' } }),
    prisma.reservation.count({ where: { venueId, refundStatus: 'PENDING' } }),
    prisma.reservation.count({ where: { venueId, depositStatus: 'PAID' } }),
  ])

  logger.warn('⚠️ [STRIPE CONNECT OFFBOARDING] Venue payments disabled', {
    venueId,
    venueName: venue.name,
    staffId,
    merchants: merchants.map(m => ({ id: m.id, providerMerchantId: m.providerMerchantId })),
    openDisputes,
    refundsInFlight,
    paidDeposits,
  })

  return {
    venueId,
    venueName: venue.name,
    disabledMerchantIds: merchants.map(m => m.id),
    retainedConnectAccountIds: merchants.map(m => m.providerMerchantId).filter(Boolean),
    pending: {
      openDisputes,
      refundsInFlight,
      paidDeposits,
    },
  }
}

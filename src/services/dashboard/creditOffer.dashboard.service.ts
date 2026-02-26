/**
 * Credit Offer Dashboard Service
 *
 * Client-facing service for venues to view their pending credit offers.
 * This follows the Square Capital model: venues receive "invitations" but
 * never see their internal credit scores.
 *
 * IMPORTANT: This service NEVER exposes credit scores, grades, or internal metrics.
 * Only the offer details (amount, terms) are shown to the client.
 */

import prisma from '../../utils/prismaClient'
import { CreditOfferStatus } from '@prisma/client'
import { logAction } from './activity-log.service'

export interface VenueCreditOffer {
  id: string
  offerAmount: number
  factorRate: number
  totalRepayment: number
  repaymentPercent: number
  estimatedTermDays: number
  expiresAt: string
  status: CreditOfferStatus
  createdAt: string
}

export interface VenueCreditOfferResponse {
  hasOffer: boolean
  offer: VenueCreditOffer | null
}

/**
 * Get pending credit offer for a venue (if any)
 *
 * This is the client-facing endpoint. It only returns PENDING offers,
 * never the credit assessment data itself.
 */
export async function getPendingCreditOffer(venueId: string): Promise<VenueCreditOfferResponse> {
  const offer = await prisma.creditOffer.findFirst({
    where: {
      venueId,
      status: CreditOfferStatus.PENDING,
      expiresAt: { gt: new Date() }, // Not expired
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      offerAmount: true,
      factorRate: true,
      totalRepayment: true,
      repaymentPercent: true,
      estimatedTermDays: true,
      expiresAt: true,
      status: true,
      createdAt: true,
    },
  })

  if (!offer) {
    return { hasOffer: false, offer: null }
  }

  return {
    hasOffer: true,
    offer: {
      id: offer.id,
      offerAmount: Number(offer.offerAmount),
      factorRate: Number(offer.factorRate),
      totalRepayment: Number(offer.totalRepayment),
      repaymentPercent: Number(offer.repaymentPercent),
      estimatedTermDays: offer.estimatedTermDays,
      expiresAt: offer.expiresAt.toISOString(),
      status: offer.status,
      createdAt: offer.createdAt.toISOString(),
    },
  }
}

/**
 * Accept a credit offer
 * This will be handled through a separate flow (KYC, contract signing, etc.)
 * For now, we just mark interest
 */
export async function expressInterestInOffer(venueId: string, offerId: string, staffId: string): Promise<void> {
  // Verify the offer belongs to this venue and is pending
  const offer = await prisma.creditOffer.findFirst({
    where: {
      id: offerId,
      venueId,
      status: CreditOfferStatus.PENDING,
      expiresAt: { gt: new Date() },
    },
  })

  if (!offer) {
    throw new Error('No valid pending offer found')
  }

  // For MVP, we'll just log the interest. Full acceptance flow will require:
  // 1. Additional KYC verification
  // 2. Contract review and e-signature
  // 3. Bank account verification
  // This is a placeholder that would trigger the SOFOM process

  // Update offer notes to indicate interest
  await prisma.creditOffer.update({
    where: { id: offerId },
    data: {
      notes: `Interest expressed by staff ${staffId} on ${new Date().toISOString()}`,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'CREDIT_OFFER_INTEREST',
    entity: 'CreditOffer',
    entityId: offerId,
  })
}

/**
 * Dismiss/decline a credit offer
 */
export async function declineOffer(venueId: string, offerId: string, reason?: string): Promise<void> {
  const offer = await prisma.creditOffer.findFirst({
    where: {
      id: offerId,
      venueId,
      status: CreditOfferStatus.PENDING,
    },
  })

  if (!offer) {
    throw new Error('No valid pending offer found')
  }

  await prisma.creditOffer.update({
    where: { id: offerId },
    data: {
      status: CreditOfferStatus.REJECTED,
      rejectedAt: new Date(),
      rejectionReason: reason || 'Declined by venue',
    },
  })

  logAction({
    venueId,
    action: 'CREDIT_OFFER_DECLINED',
    entity: 'CreditOffer',
    entityId: offerId,
  })
}

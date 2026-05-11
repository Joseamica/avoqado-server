import { Request, Response, NextFunction } from 'express'
import * as creditPackPublicService from '../../services/dashboard/creditPack.public.service'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// ==========================================
// PUBLIC CREDIT PACK CONTROLLER (Unauthenticated)
// For booking widget / public storefront
// ==========================================

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: { id: true, name: true, slug: true },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

/**
 * GET /public/venues/:venueSlug/credit-packs
 */
export async function getAvailablePacks(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { productId } = req.query as { productId?: string }

    const packs = await creditPackPublicService.getAvailablePacks(venue.id, productId)

    res.json(packs)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/credit-packs/balance?email=&phone=&seats=N&productId=&productIds=a,b,c
 *
 * `seats` (optional): when provided, each balance is annotated with `sufficient: boolean`
 *   indicating whether remainingQuantity >= seats. Widget uses this to disable balances
 *   that can't cover the requested party size.
 * `productId` (optional): when provided, balances for other products are filtered out of
 *   the response purely as a UX convenience.
 * `productIds` (optional): comma-separated list. Widget uses this on the multi-service
 *   /appointments wizard so PaymentChoiceInline can verify the customer has matching
 *   balances for EVERY service at once (Square's "pay with credits" only enables when
 *   all services are covered). Wins over `productId` when both are present.
 */
export async function getCustomerBalance(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, phone, seats, productId, productIds } = req.query as {
      email?: string
      phone?: string
      seats?: string
      productId?: string
      productIds?: string
    }

    const seatsNum = seats ? Math.max(1, parseInt(seats, 10) || 1) : undefined

    // Parse comma-separated productIds. Cap at 20 to avoid abuse.
    const productIdsArr =
      typeof productIds === 'string'
        ? productIds
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 20)
        : undefined

    const result = await creditPackPublicService.lookupCustomerCredits(venue.id, email, phone, {
      seats: seatsNum,
      productId,
      productIds: productIdsArr,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/credit-packs/:packId/checkout
 */
export async function createCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, packId } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, phone, successUrl, cancelUrl } = req.body

    const result = await creditPackPublicService.createCheckoutSession(venue.id, packId, email, phone, successUrl, cancelUrl)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

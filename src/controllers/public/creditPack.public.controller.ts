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
 * GET /public/venues/:venueSlug/credit-packs/balance?email=&phone=
 */
export async function getCustomerBalance(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, phone } = req.query as { email?: string; phone?: string }

    const result = await creditPackPublicService.lookupCustomerCredits(venue.id, email, phone)

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

import { Request, Response, NextFunction } from 'express'
import * as customerPortalService from '../../services/public/customerPortal.public.service'
import { NotFoundError } from '../../errors/AppError'
import type { CustomerAuthContext } from '../../middlewares/customerAuth.middleware'
import prisma from '../../utils/prismaClient'

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: { id: true },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

/**
 * POST /public/venues/:venueSlug/customer/register
 */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, password, phone, firstName, lastName } = req.body

    const result = await customerPortalService.registerCustomer(venue.id, {
      email,
      password,
      phone,
      firstName,
      lastName,
    })

    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/customer/login
 */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, password } = req.body

    const result = await customerPortalService.loginCustomer(venue.id, email, password)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/customer/portal
 * Requires customer auth token
 */
export async function getPortal(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerId, venueId } = (req as any).customerAuth as CustomerAuthContext

    const result = await customerPortalService.getCustomerPortal(venueId, customerId)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /public/venues/:venueSlug/customer/profile
 * Requires customer auth token
 */
export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerId, venueId } = (req as any).customerAuth as CustomerAuthContext
    const { firstName, lastName, phone } = req.body

    const result = await customerPortalService.updateProfile(venueId, customerId, {
      firstName,
      lastName,
      phone,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
}

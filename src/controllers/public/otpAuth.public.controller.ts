import { Request, Response, NextFunction } from 'express'
import * as otpService from '../../services/public/otpAuth.public.service'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { computeBookingAccess, withBookingAccess } from '../../services/public/bookingAccess.service'

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: { id: true },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

/**
 * POST /public/venues/:venueSlug/auth/otp/request
 */
export async function requestOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { phone, email } = req.body

    const channel = phone ? 'whatsapp' : 'email'
    const destination = phone ?? email

    await otpService.requestOtp({ venueId: venue.id, channel, destination, ip: req.ip })

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/auth/otp/verify
 */
export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { phone, email, code, purpose, firstName } = req.body

    const channel = phone ? 'whatsapp' : 'email'
    const destination = phone ?? email

    const result = await otpService.verifyOtp({
      venueId: venue.id,
      channel,
      destination,
      code,
      firstName,
      ...(purpose === 'ORDERING' ? { purpose: 'ORDERING' as const } : {}),
    })
    // H1: el token de pedidos no sirve para reservar; su respuesta no lleva `bookingAccess` (no promete lo que no puede).
    if (purpose === 'ORDERING') return res.json(result)

    // Fase 0.B: es un emisor de token → lleva bookingAccess como login/register/portal.
    const bookingAccess = await computeBookingAccess(venue.id, result.customer?.id)
    res.json({ ...result, ...withBookingAccess(bookingAccess) })
  } catch (error) {
    next(error)
  }
}

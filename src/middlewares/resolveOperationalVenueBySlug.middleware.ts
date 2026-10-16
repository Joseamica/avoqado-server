/**
 * Como `resolveVenueBySlug`, pero exige un venue OPERATIVO y que no sea el demo público: una tienda en línea no recibe
 * pedidos de un negocio suspendido o cerrado (`resolveVenueBySlug` sólo pide `active: true`), ni de un `LIVE_DEMO`
 * (anónimo; recibiría pedidos reales y gastaría OTP de WhatsApp). Los `TRIAL` son prospectos reales y sí pueden (R10).
 * Nace aparte para no cambiar el comportamiento de reservas.
 */
import { VenueStatus } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { OPERATIONAL_VENUE_STATUSES } from '../lib/venueStatus.constants'
import prisma from '../utils/prismaClient'
import type { PublicVenueContext } from './resolveVenueBySlug.middleware'

const ORDERING_VENUE_STATUSES = OPERATIONAL_VENUE_STATUSES.filter(s => s !== VenueStatus.LIVE_DEMO)

export async function resolveOperationalVenueBySlug(req: Request, res: Response, next: NextFunction) {
  const slug = typeof req.params?.venueSlug === 'string' ? req.params.venueSlug : ''
  if (!slug) return res.status(404).json({ message: 'Negocio no encontrado', code: 'VENUE_NOT_FOUND' })

  const venue = await prisma.venue.findFirst({
    where: { slug, active: true, status: { in: ORDERING_VENUE_STATUSES } },
    select: { id: true, slug: true },
  })
  if (!venue) return res.status(404).json({ message: 'Negocio no encontrado', code: 'VENUE_NOT_FOUND' })
  ;(req as any).publicVenue = { id: venue.id, slug: venue.slug } satisfies PublicVenueContext
  return next()
}

/**
 * Resuelve `:venueSlug` de una ruta pública a `req.publicVenue = { id, slug }`.
 *
 * Fase 0.B: va ANTES de `authenticateCustomer` en la cadena, para que la identidad se
 * compare contra el venue de la URL (que manda) y no contra el que diga el token. Un slug
 * inexistente o inactivo es 404 antes de mirar ningún header — así un token válido de otro
 * venue nunca produce un mismatch sobre un venue fantasma.
 *
 * Cadena canónica (spec §0.B):
 *   rateLimit → resolveVenueBySlug → authenticateCustomer(Optional) → requireReservationsPlan → validateRequest → controller
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '../utils/prismaClient'

export interface PublicVenueContext {
  id: string
  slug: string
}

export async function resolveVenueBySlug(req: Request, res: Response, next: NextFunction) {
  const slug = typeof req.params?.venueSlug === 'string' ? req.params.venueSlug : ''
  if (!slug) {
    return res.status(404).json({ message: 'Negocio no encontrado', code: 'VENUE_NOT_FOUND' })
  }

  const venue = await prisma.venue.findFirst({
    where: { slug, active: true },
    select: { id: true, slug: true },
  })
  if (!venue) {
    return res.status(404).json({ message: 'Negocio no encontrado', code: 'VENUE_NOT_FOUND' })
  }

  ;(req as any).publicVenue = { id: venue.id, slug: venue.slug } satisfies PublicVenueContext
  return next()
}

import { Request, Response, NextFunction } from 'express'
import * as otpService from '../../services/public/otpAuth.public.service'
import { crearFichaConPrueba } from '../../services/public/sesionDeCliente.service'
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
    const { phone, email, code, purpose, firstName, alNoEncontrar, vincular } = req.body

    const channel = phone ? 'whatsapp' : 'email'
    const destination = phone ?? email

    // S7: la sesión única tiene su propia respuesta (`SesionEmitida` o la prueba pendiente); no pasa por la activación de reservas
    // ni promete un `bookingAccess` que no se calculó.
    if (purpose === 'SESSION') {
      return res.json(
        await otpService.verifyOtp({
          venueId: venue.id,
          channel,
          destination,
          code,
          firstName,
          purpose: 'SESSION',
          alNoEncontrar,
          vincular,
        }),
      )
    }

    const result = await otpService.verifyOtp({
      venueId: venue.id,
      channel,
      destination,
      code,
      firstName,
      ...(purpose === 'ORDERING' ? { purpose: 'ORDERING' as const } : {}),
    })
    // H1: el token de pedidos no sirve para reservar; su respuesta lleva sólo token y cliente. Ni `bookingAccess` ni
    // `approvalStatus`: son de reservas, que verificar para pedir no toca (no promete lo que no puede).
    if (purpose === 'ORDERING') return res.json({ token: result.token, customer: result.customer })

    // Fase 0.B: es un emisor de token → lleva bookingAccess como login/register/portal.
    const bookingAccess = await computeBookingAccess(venue.id, result.customer?.id)
    res.json({ ...result, ...withBookingAccess(bookingAccess) })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/auth/session/nueva-ficha — S7: «no, soy nueva». La identidad sale SÓLO de la prueba firmada.
 */
export async function crearFichaNueva(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await resolveVenueBySlug(req.params.venueSlug)
    const { pruebaPendiente, firstName } = req.body
    res.json(await crearFichaConPrueba(venue.id, pruebaPendiente, firstName))
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/auth/google — S7: entrar con Google (sólo un correo que Google da por suyo).
 */
export async function entrarConGoogle(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await resolveVenueBySlug(req.params.venueSlug)
    const { idToken, alNoEncontrar, vincular, firstName } = req.body
    res.json(await otpService.entrarConGoogle(venue.id, idToken, { alNoEncontrar, vincular, firstName, ip: req.ip }))
  } catch (error) {
    next(error)
  }
}

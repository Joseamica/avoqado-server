import { Request, Response, NextFunction } from 'express'
import * as reservationService from '../../services/dashboard/reservation.dashboard.service'
import * as availabilityService from '../../services/dashboard/reservationAvailability.service'
import { getReservationSettings } from '../../services/dashboard/reservationSettings.service'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// ==========================================
// PUBLIC RESERVATION CONTROLLER (Unauthenticated)
// For booking widget + public booking page
// ==========================================

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      type: true,
      timezone: true,
    },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

/**
 * GET /public/venues/:venueSlug/info
 */
export async function getVenueInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    // Get public-safe venue info
    const venueInfo = await prisma.venue.findUnique({
      where: { id: venue.id },
      select: {
        name: true,
        slug: true,
        logo: true,
        type: true,
        address: true,
        phone: true,
        products: {
          where: { active: true, type: { in: ['APPOINTMENTS_SERVICE', 'EVENT'] } },
          select: { id: true, name: true, price: true, duration: true, eventCapacity: true },
          orderBy: { name: 'asc' },
        },
      },
    })

    const settings = await getReservationSettings(venue.id)

    res.json({
      ...venueInfo,
      timezone: venue.timezone || 'America/Mexico_City',
      publicBooking: settings.publicBooking,
      operatingHours: settings.operatingHours,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/availability
 */
export async function getAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { date, duration, partySize, productId } = req.query as any

    const settings = await getReservationSettings(venue.id)

    const slots = await availabilityService.getAvailableSlots(
      venue.id,
      date,
      { duration: duration ? Number(duration) : undefined, partySize: partySize ? Number(partySize) : undefined, productId },
      settings,
      venue.timezone || 'America/Mexico_City',
    )

    // Public response: simplified (no internal table/staff IDs)
    res.json({
      date,
      slots: slots.map(s => ({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        available: true,
      })),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations
 */
export async function createReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    const settings = await getReservationSettings(venue.id)

    // Check public booking is enabled
    if (!settings.publicBooking.enabled) {
      throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
    }

    // Validate required fields based on config
    if (settings.publicBooking.requirePhone && !req.body.guestPhone) {
      throw new BadRequestError('El telefono es requerido')
    }
    if (settings.publicBooking.requireEmail && !req.body.guestEmail) {
      throw new BadRequestError('El email es requerido')
    }

    const reservation = await reservationService.createReservation(
      venue.id,
      {
        ...req.body,
        channel: 'WEB' as const,
      },
      undefined, // no createdById for public bookings
      settings,
    )

    // Return only public-safe data + cancelSecret
    res.status(201).json({
      confirmationCode: reservation.confirmationCode,
      cancelSecret: reservation.cancelSecret,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      status: reservation.status,
      depositRequired: !!reservation.depositAmount,
      depositAmount: reservation.depositAmount,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/reservations/:cancelSecret
 */
export async function getReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Public-safe response
    res.json({
      confirmationCode: reservation.confirmationCode,
      status: reservation.status,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      duration: reservation.duration,
      partySize: reservation.partySize,
      guestName: reservation.guestName,
      product: reservation.product,
      assignedStaff: reservation.assignedStaff
        ? {
            firstName: reservation.assignedStaff.firstName,
            lastName: reservation.assignedStaff.lastName,
          }
        : null,
      table: reservation.table ? { number: reservation.table.number } : null,
      specialRequests: reservation.specialRequests,
      depositAmount: reservation.depositAmount,
      depositStatus: reservation.depositStatus,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/cancel
 */
export async function cancelReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Check if venue allows customer cancellation
    const settings = await getReservationSettings(reservation.venueId)
    if (!settings.cancellation.allowCustomerCancel) {
      throw new BadRequestError('La cancelacion en linea no esta permitida. Contacta al negocio directamente.')
    }

    // Check cancellation time window
    if (settings.cancellation.minHoursBeforeStart) {
      const minHours = settings.cancellation.minHoursBeforeStart
      const hoursUntilStart = (reservation.startsAt.getTime() - Date.now()) / (1000 * 60 * 60)
      if (hoursUntilStart < minHours) {
        throw new BadRequestError(`No se puede cancelar con menos de ${minHours} horas de anticipacion. Contacta al negocio directamente.`)
      }
    }

    const cancelled = await reservationService.cancelReservation(reservation.venueId, reservation.id, 'CUSTOMER', req.body?.reason)

    res.json({
      confirmationCode: cancelled.confirmationCode,
      status: cancelled.status,
      cancelledAt: cancelled.cancelledAt,
      depositStatus: cancelled.depositStatus,
    })
  } catch (error) {
    next(error)
  }
}

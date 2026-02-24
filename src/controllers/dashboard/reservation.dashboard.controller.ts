import { Request, Response, NextFunction } from 'express'
import * as reservationService from '../../services/dashboard/reservation.dashboard.service'
import * as availabilityService from '../../services/dashboard/reservationAvailability.service'
import { getReservationSettings, updateReservationSettings } from '../../services/dashboard/reservationSettings.service'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'

// ==========================================
// RESERVATION DASHBOARD CONTROLLER
// ==========================================

function resolveVenueId(req: Request): string {
  const venueId = req.params.venueId
  if (!venueId) {
    throw new BadRequestError('Venue ID requerido en la ruta')
  }
  return venueId
}

/**
 * GET /venues/:venueId/reservations
 */
export async function getReservations(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { page, pageSize, ...filters } = req.query as any

    const result = await reservationService.getReservations(venueId, filters, page, pageSize)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations
 */
export async function createReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const settings = await getReservationSettings(venueId)

    const reservation = await reservationService.createReservation(venueId, req.body, userId, settings)
    res.status(201).json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/reservations/stats
 */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { dateFrom, dateTo } = req.query as any

    const stats = await reservationService.getReservationStats(venueId, new Date(dateFrom), new Date(dateTo))
    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/reservations/calendar
 */
export async function getCalendar(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { dateFrom, dateTo, groupBy } = req.query as any

    const result = await reservationService.getReservationsCalendar(venueId, new Date(dateFrom), new Date(dateTo), groupBy)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/reservations/availability
 */
export async function getAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { date, duration, partySize, tableId, staffId, productId } = req.query as any
    const settings = await getReservationSettings(venueId)

    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const slots = await availabilityService.getAvailableSlots(
      venueId,
      date,
      {
        duration: duration ? Number(duration) : undefined,
        partySize: partySize ? Number(partySize) : undefined,
        tableId,
        staffId,
        productId,
      },
      settings,
      venue?.timezone || 'America/Mexico_City',
    )
    res.json({ date, slots })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/reservations/:id
 */
export async function getReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { id } = req.params
    const reservation = await reservationService.getReservationById(venueId, id)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /venues/:venueId/reservations/:id
 */
export async function updateReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params
    const settings = await getReservationSettings(venueId)

    const reservation = await reservationService.updateReservation(venueId, id, req.body, userId, settings)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /venues/:venueId/reservations/:id → CANCELLED
 */
export async function deleteReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params

    const reservation = await reservationService.cancelReservation(venueId, id, userId, 'Cancelada por staff')
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations/:id/confirm
 */
export async function confirmReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params

    const reservation = await reservationService.confirmReservation(venueId, id, userId)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations/:id/check-in
 */
export async function checkInReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params

    const reservation = await reservationService.checkInReservation(venueId, id, userId)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations/:id/complete
 */
export async function completeReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { id } = req.params
    const reservation = await reservationService.completeReservation(venueId, id)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations/:id/no-show
 */
export async function markNoShow(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params

    const reservation = await reservationService.markNoShow(venueId, id, userId)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/reservations/:id/reschedule
 */
export async function rescheduleReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const { id } = req.params
    const { startsAt, endsAt } = req.body
    const settings = await getReservationSettings(venueId)

    const reservation = await reservationService.rescheduleReservation(venueId, id, new Date(startsAt), new Date(endsAt), userId, settings)
    res.json(reservation)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/reservations/settings
 */
export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const settings = await getReservationSettings(venueId)
    res.json(settings)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /venues/:venueId/reservations/settings
 */
export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const updated = await updateReservationSettings(venueId, req.body)
    res.json(updated)
  } catch (error) {
    next(error)
  }
}

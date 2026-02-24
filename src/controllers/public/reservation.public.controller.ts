import { Request, Response, NextFunction } from 'express'
import * as reservationService from '../../services/dashboard/reservation.dashboard.service'
import * as availabilityService from '../../services/dashboard/reservationAvailability.service'
import { getReservationSettings } from '../../services/dashboard/reservationSettings.service'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ReservationStatus } from '@prisma/client'

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
          where: { active: true, type: { in: ['APPOINTMENTS_SERVICE', 'EVENT', 'CLASS'] } },
          select: { id: true, name: true, price: true, duration: true, eventCapacity: true, type: true, maxParticipants: true },
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
    const tz = venue.timezone || 'America/Mexico_City'

    // Check if requesting availability for a CLASS product
    if (productId) {
      const product = await prisma.product.findFirst({
        where: { id: productId, venueId: venue.id, active: true },
        select: { type: true },
      })

      if (product?.type === 'CLASS') {
        const onlinePercent = settings.scheduling?.onlineCapacityPercent ?? 100
        const classSlots = await availabilityService.getClassSessionSlots(venue.id, productId, date, onlinePercent, tz)
        return res.json({
          date,
          slots: classSlots.map(s => ({
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            available: s.available,
            classSessionId: s.classSessionId,
            capacity: s.capacity,
            enrolled: s.enrolled,
            remaining: s.remaining,
          })),
        })
      }
    }

    // Default: operating-hours-based availability (APPOINTMENTS_SERVICE, EVENT)
    const slots = await availabilityService.getAvailableSlots(
      venue.id,
      date,
      { duration: duration ? Number(duration) : undefined, partySize: partySize ? Number(partySize) : undefined, productId },
      settings,
      tz,
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

    // If productId points to a CLASS product, classSessionId is mandatory
    if (req.body.productId && !req.body.classSessionId) {
      const product = await prisma.product.findFirst({
        where: { id: req.body.productId, venueId: venue.id },
        select: { type: true },
      })
      if (product?.type === 'CLASS') {
        throw new BadRequestError('classSessionId es requerido para reservar una clase')
      }
    }

    // CLASS bookings use a dedicated code path with ClassSession capacity checks
    if (req.body.classSessionId) {
      const reservation = await createClassReservation(venue.id, req.body, settings)
      return res.status(201).json({
        confirmationCode: reservation.confirmationCode,
        cancelSecret: reservation.cancelSecret,
        startsAt: reservation.startsAt,
        endsAt: reservation.endsAt,
        status: reservation.status,
        depositRequired: false,
        depositAmount: null,
      })
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

// ==========================================
// CLASS Reservation — Serializable transaction with capacity check
// ==========================================

async function createClassReservation(
  venueId: string,
  body: {
    classSessionId: string
    guestName: string
    guestPhone: string
    guestEmail?: string
    partySize?: number
    specialRequests?: string
  },
  moduleConfig: any,
) {
  const requestedPartySize = body.partySize ?? 1
  const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const autoConfirm = moduleConfig?.scheduling?.autoConfirm ?? true
  const initialStatus: ReservationStatus = autoConfirm ? 'CONFIRMED' : 'PENDING'

  return reservationService.withSerializableRetry(async tx => {
    // Lock the ClassSession row and verify it exists + belongs to venue
    const sessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${body.classSessionId}
        AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (sessions.length === 0) {
      throw new NotFoundError('Sesion de clase no encontrada')
    }
    const session = sessions[0]

    if (session.status !== 'SCHEDULED') {
      throw new BadRequestError('Esta sesion de clase ya no acepta reservaciones')
    }

    // Verify the product is CLASS and active
    const product = await tx.product.findFirst({
      where: { id: session.productId, venueId },
      select: { type: true, active: true },
    })
    if (!product || product.type !== 'CLASS') {
      throw new BadRequestError('El producto asociado no es una clase valida')
    }
    if (!product.active) {
      throw new BadRequestError('Este servicio ya no esta disponible')
    }

    // Sum enrolled from active reservations
    // Note: FOR UPDATE cannot be used with aggregate functions in PostgreSQL.
    // The ClassSession row lock above + SERIALIZABLE isolation is sufficient.
    const enrolledResult = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("partySize"), 0) as total
      FROM "Reservation"
      WHERE "classSessionId" = ${body.classSessionId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    `
    const enrolled = Number(enrolledResult[0].total)
    const effectiveCapacity = Math.floor((session.capacity * onlinePercent) / 100)

    if (enrolled + requestedPartySize > effectiveCapacity) {
      throw new ConflictError(
        `No hay suficientes lugares disponibles. Disponibles: ${effectiveCapacity - enrolled}, solicitados: ${requestedPartySize}`,
      )
    }

    const confirmationCode = reservationService.generateConfirmationCode()

    // Ensure uniqueness
    const existing = await tx.reservation.findUnique({
      where: { venueId_confirmationCode: { venueId, confirmationCode } },
      select: { id: true },
    })
    const finalCode = existing ? reservationService.generateConfirmationCode() : confirmationCode

    const reservation = await tx.reservation.create({
      data: {
        venueId,
        confirmationCode: finalCode,
        classSessionId: body.classSessionId,
        productId: session.productId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        duration: session.duration,
        status: initialStatus,
        channel: 'WEB',
        guestName: body.guestName,
        guestPhone: body.guestPhone,
        guestEmail: body.guestEmail ?? null,
        partySize: requestedPartySize,
        specialRequests: body.specialRequests ?? null,
        confirmedAt: autoConfirm ? new Date() : null,
        statusLog: [{ status: initialStatus, at: new Date().toISOString(), by: null }],
      },
    })

    logger.info(
      `✅ [CLASS BOOKING] Created ${reservation.confirmationCode} | venue=${venueId} session=${body.classSessionId} party=${requestedPartySize} enrolled=${enrolled}→${enrolled + requestedPartySize}/${effectiveCapacity}`,
    )

    return reservation
  })
}

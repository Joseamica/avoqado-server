import { Request, Response, NextFunction } from 'express'
import * as classSessionService from '../../services/dashboard/classSession.dashboard.service'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// ==========================================
// CLASS SESSION DASHBOARD CONTROLLER
// ==========================================

function resolveVenueId(req: Request): string {
  const venueId = req.params.venueId
  if (!venueId) throw new BadRequestError('Venue ID requerido en la ruta')
  return venueId
}

async function getVenueTz(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone ?? 'America/Mexico_City'
}

/**
 * GET /venues/:venueId/class-sessions
 */
export async function getClassSessions(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const tz = await getVenueTz(venueId)
    const sessions = await classSessionService.getClassSessions(venueId, req.query as any, tz)
    res.json(sessions)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/class-sessions
 */
export async function createClassSession(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const session = await classSessionService.createClassSession(venueId, req.body, userId)
    res.status(201).json(session)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/class-sessions/bulk
 */
export async function createClassSessionsBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { userId } = (req as any).authContext
    const tz = await getVenueTz(venueId)
    const result = await classSessionService.createClassSessionsBulk(venueId, req.body, userId, tz)
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /venues/:venueId/class-sessions/:sessionId
 */
export async function getClassSession(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { sessionId } = req.params
    const session = await classSessionService.getClassSession(venueId, sessionId)
    res.json(session)
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /venues/:venueId/class-sessions/:sessionId
 */
export async function updateClassSession(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { sessionId } = req.params
    const session = await classSessionService.updateClassSession(venueId, sessionId, req.body)
    res.json(session)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/class-sessions/:sessionId/cancel
 */
export async function cancelClassSession(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { sessionId } = req.params
    const session = await classSessionService.cancelClassSession(venueId, sessionId)
    res.json(session)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /venues/:venueId/class-sessions/:sessionId/attendees
 *
 * Response shape is intentionally polymorphic to preserve backward
 * compatibility with existing dashboard clients:
 * - Default (no `checkInImmediately`) → flat Reservation object as before.
 * - With `checkInImmediately: true` → `{ reservation, orderId }` so the
 *   walk-in caller (Android POS) can deep-link to PaymentFlowScreen.
 */
export async function addAttendee(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { sessionId } = req.params
    const { userId } = (req as any).authContext
    const result = await classSessionService.addAttendee(venueId, sessionId, req.body, userId)
    if (req.body?.checkInImmediately) {
      res.status(201).json({ reservation: result.reservation, orderId: result.orderId })
    } else {
      res.status(201).json(result.reservation)
    }
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /venues/:venueId/class-sessions/:sessionId/attendees/:reservationId
 */
export async function removeAttendee(req: Request, res: Response, next: NextFunction) {
  try {
    const venueId = resolveVenueId(req)
    const { sessionId, reservationId } = req.params
    await classSessionService.removeAttendee(venueId, sessionId, reservationId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

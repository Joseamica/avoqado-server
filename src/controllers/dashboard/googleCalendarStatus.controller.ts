/**
 * Google Calendar Sync — Dashboard status / ops controllers (Phase 3).
 *
 * Three venue-scoped endpoints used by the dashboard UI:
 *   - GET  /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks
 *       Visualize ExternalBusyBlock rows in the reservation calendar overlay.
 *   - GET  /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter
 *       List CalendarSyncOutbox rows stuck in DEAD_LETTER (banner + drilldown).
 *   - POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry
 *       Reset a DEAD_LETTER row to PENDING so the sweeper picks it back up.
 *
 * Permission gates are applied at the route layer via `checkPermission`.
 * - Read endpoints: `calendar:view_status`.
 * - Retry endpoint: `calendar:manage_venue` (mutational).
 */
import { NextFunction, Request, Response } from 'express'

import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import { AuthContext } from '@/security'
import prisma from '@/utils/prismaClient'

const MAX_RANGE_DAYS = 90
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000
const MAX_DEAD_LETTER_LIMIT = 100
const DEFAULT_DEAD_LETTER_LIMIT = 50

function getAuthContext(req: Request): AuthContext {
  const ctx = (req as any).authContext as AuthContext | undefined
  if (!ctx || !ctx.userId) {
    throw new UnauthorizedError('Autenticación requerida')
  }
  return ctx
}

function parseIsoDate(value: unknown, fieldName: string): Date {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`El parámetro ${fieldName} es requerido (ISO 8601)`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`El parámetro ${fieldName} no es una fecha ISO 8601 válida`)
  }
  return parsed
}

/**
 * GET /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks
 *
 * Query params:
 *   - from (ISO 8601, required)
 *   - to   (ISO 8601, required) — range MUST be <= 90 days
 *   - staffId (optional) — when set, ORs in staff-personal blocks for the staff
 *
 * Per spec §11, staff-personal blocks belong to that staff regardless of venue,
 * so we OR them in unfiltered by venueId. Venue-master blocks are always scoped
 * to the route's :venueId.
 */
export async function listBusyBlocks(req: Request, res: Response, next: NextFunction) {
  try {
    getAuthContext(req)
    const venueId = String(req.params.venueId ?? '')
    if (!venueId) throw new BadRequestError('Falta el parámetro venueId')

    const from = parseIsoDate(req.query.from, 'from')
    const to = parseIsoDate(req.query.to, 'to')

    if (to.getTime() <= from.getTime()) {
      throw new BadRequestError('El parámetro to debe ser posterior a from')
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestError(`El rango máximo permitido es de ${MAX_RANGE_DAYS} días`)
    }

    const staffId = typeof req.query.staffId === 'string' && req.query.staffId.length > 0 ? req.query.staffId : null

    const where: any = {
      OR: [
        { venueId, startsAt: { lt: to }, endsAt: { gt: from } }, // venue-master overlap
        ...(staffId ? [{ staffId, startsAt: { lt: to }, endsAt: { gt: from } }] : []),
      ],
    }

    const rows = await prisma.externalBusyBlock.findMany({
      where,
      include: {
        connection: { select: { id: true, googleAccountEmail: true, scope: true } },
      },
      orderBy: { startsAt: 'asc' },
    })

    const blocks = rows.map(row => ({
      id: row.id,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: row.allDay,
      title: row.isPrivate ? null : row.title,
      isPrivate: row.isPrivate,
      source: row.externalSource,
      connection: row.connection
        ? {
            id: row.connection.id,
            googleAccountEmail: row.connection.googleAccountEmail,
            scope: row.connection.scope,
          }
        : null,
    }))

    res.status(200).json({ blocks })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter
 *
 * Query params:
 *   - limit  (default 50, max 100)
 *   - cursor (row id for keyset pagination — `id` from a previous `nextCursor`)
 *
 * Returns DEAD_LETTER outbox rows scoped to the venue, with enough source +
 * target context for the dashboard banner / drilldown UI.
 */
export async function listDeadLetterOutbox(req: Request, res: Response, next: NextFunction) {
  try {
    getAuthContext(req)
    const venueId = String(req.params.venueId ?? '')
    if (!venueId) throw new BadRequestError('Falta el parámetro venueId')

    let limit = DEFAULT_DEAD_LETTER_LIMIT
    if (typeof req.query.limit === 'string') {
      const parsed = Number.parseInt(req.query.limit, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new BadRequestError('El parámetro limit debe ser un entero positivo')
      }
      limit = Math.min(parsed, MAX_DEAD_LETTER_LIMIT)
    }

    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : null

    // Fetch limit+1 to know if there's a next page without an extra count() call.
    const rows = await prisma.calendarSyncOutbox.findMany({
      where: { venueId, status: 'DEAD_LETTER' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        reservation: {
          select: {
            id: true,
            confirmationCode: true,
            startsAt: true,
            guestName: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        },
        classSession: {
          select: {
            id: true,
            startsAt: true,
            product: { select: { name: true } },
          },
        },
        targetConnection: {
          select: { id: true, googleAccountEmail: true, scope: true },
        },
      },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows

    const mapped = pageRows.map(row => {
      let source: {
        kind: 'reservation' | 'classSession' | 'unknown'
        id: string | null
        confirmationCode?: string | null
        displayName?: string | null
        startsAt?: Date | null
        title?: string | null
      }

      if (row.reservation) {
        const r = row.reservation
        const customerName = r.customer ? `${r.customer.firstName ?? ''} ${r.customer.lastName ?? ''}`.trim() : ''
        const displayName = (r.guestName && r.guestName.trim().length > 0 ? r.guestName : customerName) || null
        source = {
          kind: 'reservation',
          id: r.id,
          confirmationCode: r.confirmationCode ?? null,
          displayName,
          startsAt: r.startsAt,
        }
      } else if (row.classSession) {
        const c = row.classSession
        source = {
          kind: 'classSession',
          id: c.id,
          title: c.product?.name ?? null,
          startsAt: c.startsAt,
        }
      } else {
        source = { kind: 'unknown', id: null }
      }

      return {
        id: row.id,
        operation: row.operation,
        createdAt: row.createdAt,
        attempts: row.attempts,
        lastError: row.lastError,
        source,
        target: row.targetConnection
          ? {
              connectionId: row.targetConnection.id,
              googleAccountEmail: row.targetConnection.googleAccountEmail,
              scope: row.targetConnection.scope,
            }
          : null,
      }
    })

    res.status(200).json({
      rows: mapped,
      nextCursor: hasMore ? pageRows[pageRows.length - 1].id : null,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry
 *
 * Resets a single DEAD_LETTER row back to PENDING with attempts=0 so the
 * push sweeper picks it up on its next tick. Refuses to act on rows in any
 * other status (caller could only have observed DEAD_LETTER via the list
 * endpoint anyway — anything else is a stale UI race).
 */
export async function retryDeadLetterOutbox(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = getAuthContext(req)
    const venueId = String(req.params.venueId ?? '')
    const rowId = String(req.params.rowId ?? '')
    if (!venueId) throw new BadRequestError('Falta el parámetro venueId')
    if (!rowId) throw new BadRequestError('Falta el parámetro rowId')

    const row = await prisma.calendarSyncOutbox.findUnique({ where: { id: rowId } })
    if (!row || row.venueId !== venueId) {
      throw new NotFoundError('Fila del outbox no encontrada')
    }
    if (row.status !== 'DEAD_LETTER') {
      throw new ConflictError(`Solo filas en DEAD_LETTER pueden reintentarse (actual: ${row.status})`)
    }

    const updated = await prisma.calendarSyncOutbox.update({
      where: { id: rowId },
      data: {
        status: 'PENDING',
        attempts: 0,
        scheduledAt: new Date(),
        lastError: null,
      },
    })

    logger.info('gcal outbox row retry requested', {
      rowId,
      venueId,
      userId: ctx.userId,
    })

    res.status(200).json({
      row: {
        id: updated.id,
        status: updated.status,
        attempts: updated.attempts,
        scheduledAt: updated.scheduledAt,
        lastError: updated.lastError,
      },
    })
  } catch (error) {
    next(error)
  }
}

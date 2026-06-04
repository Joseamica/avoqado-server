import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { rescheduleAppointmentReservation } from '@/services/dashboard/reservation.dashboard.service'

export function registerReservationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'reservations',
    'Reservations across your venues (or one venue): when, party size, guest, status, confirmation code. Upcoming only by default, soonest first. Pass venueId to focus one venue; pass includePast to also see recent reservations that already started.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      includePast: z.boolean().default(false).describe('Include reservations that already started (default: only upcoming)'),
      limit: z.number().int().min(1).max(50).default(15).describe('Max reservations to return'),
    },
    async ({ venueId, includePast, limit }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const timeFilter = includePast ? {} : { startsAt: { gte: new Date() } }
      const reservations = await prisma.reservation.findMany({
        where: { ...where, ...timeFilter },
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          startsAt: true,
          partySize: true,
          guestName: true,
          guestPhone: true,
          venue: { select: { name: true } },
        },
        orderBy: { startsAt: includePast ? 'desc' : 'asc' },
        take: limit,
      })
      return text({ count: reservations.length, upcoming: !includePast, reservations })
    },
  )

  server.tool(
    'reschedule_reservation',
    'Move an APPOINTMENT reservation to a new date/time of the same service. Identify it by confirmationCode (e.g. RES-PK6JHD) within a venue you can access. Re-validates availability (pacing, overlap) and notifies the customer (WhatsApp + email). Class reservations are not supported here — use the dashboard.',
    {
      venueId: z.string().describe('Venue that owns the reservation (must be in your scope)'),
      confirmationCode: z.string().min(1).describe('Reservation confirmation code, e.g. RES-PK6JHD'),
      newStartsAt: z.string().min(1).describe('New start time, ISO 8601 (e.g. 2026-06-15T16:00:00.000Z)'),
    },
    async ({ venueId, confirmationCode, newStartsAt }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const reservation = await prisma.reservation.findFirst({
        where: { ...where, confirmationCode },
        select: { id: true, venueId: true, classSessionId: true, status: true },
      })
      if (!reservation) {
        return text({ ok: false, error: `No encontré la reservación ${confirmationCode} en ese venue.` })
      }
      if (reservation.classSessionId) {
        return text({ ok: false, error: 'Esta es una reserva de clase. Cámbiala desde el dashboard (cambio de sesión).' })
      }
      const parsed = new Date(newStartsAt)
      if (Number.isNaN(parsed.getTime())) {
        return text({ ok: false, error: 'newStartsAt inválido. Usa ISO 8601, ej. 2026-06-15T16:00:00.000Z' })
      }
      try {
        const updated = await rescheduleAppointmentReservation({
          venueId: reservation.venueId,
          reservationId: reservation.id,
          newStartsAt: parsed,
          // Ops/MCP path: no hold → the service re-checks pacing inline (excl. self).
          rescheduledBy: 'SYSTEM', // normalized to null staffId by ACTOR_SENTINELS
        })
        return text({ ok: true, reservation: updated })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}

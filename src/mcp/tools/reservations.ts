import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import {
  rescheduleAppointmentReservation,
  cancelReservation,
  confirmReservation,
  checkInReservation,
  completeReservation,
  markNoShow,
} from '@/services/dashboard/reservation.dashboard.service'
import { auditMcpWrite } from '../audit'

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
      guard.requirePermission('reservations:update', venueId) // write gate (per-venue role) — no low-role rescheduling
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
        await auditMcpWrite(scope, {
          action: 'RESERVATION_RESCHEDULED',
          entity: 'Reservation',
          entityId: reservation.id,
          venueId: reservation.venueId,
          data: { confirmationCode, newStartsAt: parsed.toISOString() },
        })
        return text({ ok: true, reservation: updated })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'cancel_reservation',
    'Cancel a reservation in a venue you can access. Identify it by confirmationCode (e.g. RES-PK6JHD); optionally pass a reason. This WRITES — it cancels the booking (the service handles status transition + notifications); requires reservations:cancel.',
    {
      venueId: z.string().describe('Venue that owns the reservation (must be in your scope)'),
      confirmationCode: z.string().min(1).describe('Reservation confirmation code, e.g. RES-PK6JHD'),
      reason: z.string().optional().describe('Optional cancellation reason'),
    },
    async ({ venueId, confirmationCode, reason }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      guard.requirePermission('reservations:cancel', venueId) // write gate (per-venue role)
      const reservation = await prisma.reservation.findFirst({
        where: { ...where, confirmationCode },
        select: { id: true, venueId: true, status: true },
      })
      if (!reservation) {
        return text({ ok: false, error: `No encontré la reservación ${confirmationCode} en ese venue.` })
      }
      if (reservation.status === 'CANCELLED') {
        return text({ ok: false, error: 'Esa reservación ya está cancelada.' })
      }
      try {
        const updated = await cancelReservation(reservation.venueId, reservation.id, 'SYSTEM', reason)
        await auditMcpWrite(scope, {
          action: 'RESERVATION_CANCELLED',
          entity: 'Reservation',
          entityId: reservation.id,
          venueId: reservation.venueId,
          data: { confirmationCode, reason },
        })
        return text({ ok: true, reservation: updated })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'set_reservation_status',
    'Advance a reservation through its lifecycle in a venue you can access: confirm it, check it in (guest arrived/seated), complete it, or mark a no-show. Identify it by confirmationCode (e.g. RES-PK6JHD). This WRITES — it changes the reservation status (the service validates the transition + handles notifications); requires reservations:update. To cancel, use cancel_reservation instead.',
    {
      venueId: z.string().describe('Venue that owns the reservation (must be in your scope)'),
      confirmationCode: z.string().min(1).describe('Reservation confirmation code, e.g. RES-PK6JHD'),
      status: z
        .enum(['confirmed', 'checked_in', 'completed', 'no_show'])
        .describe("New status: 'confirmed', 'checked_in' (guest arrived/seated), 'completed' (service delivered), or 'no_show'"),
    },
    async ({ venueId, confirmationCode, status }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('reservations:update', venueId) // write gate (per-venue role)
      const reservation = await prisma.reservation.findFirst({
        where: { ...where, confirmationCode },
        select: { id: true, venueId: true, status: true },
      })
      if (!reservation) {
        return text({ ok: false, error: `No encontré la reservación ${confirmationCode} en ese venue.` })
      }
      try {
        // 'SYSTEM' actor → recorded in the reservation's JSON statusLog (not a staff FK);
        // the service validates the transition and throws on an illegal one.
        let updated
        switch (status) {
          case 'confirmed':
            updated = await confirmReservation(reservation.venueId, reservation.id, 'SYSTEM')
            break
          case 'checked_in':
            updated = await checkInReservation(reservation.venueId, reservation.id, 'SYSTEM')
            break
          case 'completed':
            updated = await completeReservation(reservation.venueId, reservation.id)
            break
          case 'no_show':
            updated = await markNoShow(reservation.venueId, reservation.id, 'SYSTEM')
            break
        }
        await auditMcpWrite(scope, {
          action: `RESERVATION_${status.toUpperCase()}`,
          entity: 'Reservation',
          entityId: reservation.id,
          venueId: reservation.venueId,
          data: { confirmationCode, from: reservation.status, to: status },
        })
        return text({ ok: true, reservation: updated })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import {
  createReservation,
  rescheduleAppointmentReservation,
  cancelReservation,
  confirmReservation,
  checkInReservation,
  completeReservation,
  markNoShow,
  updateReservation,
  type UpdateReservationInput,
} from '@/services/dashboard/reservation.dashboard.service'
import { auditMcpWrite } from '../audit'

export function registerReservationTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'create_reservation',
    'Create a NEW reservation in a venue you can access. Give the start date/time (ISO 8601) and party size; optionally the guest name/phone/email, a duration, a service/product to book, and special requests. The service re-validates availability (table/staff overlap, pacing, external calendar) and auto-confirms when no deposit is required. This WRITES — requires reservations:create. Returns the new reservation + its confirmation code. To change/cancel it afterwards use reschedule_reservation / set_reservation_status / cancel_reservation.',
    {
      venueId: z.string().describe('Venue for the reservation (must be in your scope)'),
      startsAt: z.string().min(1).describe('Start date/time, ISO 8601 (e.g. 2026-06-06T19:00:00.000Z)'),
      partySize: z.number().int().positive().max(100).describe('Number of guests'),
      durationMinutes: z.number().int().positive().max(1440).optional().describe('Duration in minutes (default 90)'),
      guestName: z.string().optional().describe('Guest name'),
      guestPhone: z.string().optional().describe('Guest phone'),
      guestEmail: z.string().optional().describe('Guest email'),
      productId: z.string().optional().describe('Service/product to book (appointment venues; omit for a table reservation)'),
      specialRequests: z.string().optional().describe('Special requests / notes'),
    },
    async ({ venueId, startsAt, partySize, durationMinutes, guestName, guestPhone, guestEmail, productId, specialRequests }) => {
      guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('reservations:create', venueId) // write gate (per-venue role)
      const start = new Date(startsAt)
      if (Number.isNaN(start.getTime())) {
        return text({ ok: false, error: 'startsAt inválido. Usa ISO 8601, ej. 2026-06-06T19:00:00.000Z' })
      }
      const duration = durationMinutes ?? 90
      const endsAt = new Date(start.getTime() + duration * 60_000)
      try {
        const reservation = await createReservation(
          venueId,
          { startsAt: start, endsAt, duration, partySize, guestName, guestPhone, guestEmail, productId, specialRequests },
          scope.staffId,
        )
        await auditMcpWrite(scope, {
          action: 'RESERVATION_CREATED',
          entity: 'Reservation',
          entityId: reservation.id,
          venueId,
          data: { confirmationCode: reservation.confirmationCode, startsAt: start.toISOString(), partySize, guestName },
        })
        return text({
          ok: true,
          reservation: {
            id: reservation.id,
            confirmationCode: reservation.confirmationCode,
            status: reservation.status,
            startsAt: start.toISOString(),
            partySize,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

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

  server.tool(
    'reservation_detail',
    'Full detail of ONE reservation in a venue you can access, by its confirmation code: status, when (start/end), party size, guest (name/phone/email), the table or the service booked, deposit (amount, status, paid-at), check-in / no-show timestamps, special requests and internal notes. The drill-down after the reservations list. Answers "dame los detalles de la reserva ABC123". Does NOT expose payment-processor references. Pass venueId + confirmationCode.',
    {
      venueId: z.string().describe('Venue that owns the reservation (must be in your scope)'),
      confirmationCode: z.string().min(1).describe('The reservation confirmation code'),
    },
    async ({ venueId, confirmationCode }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const r = await prisma.reservation.findFirst({
        where: { ...where, confirmationCode },
        select: {
          confirmationCode: true,
          status: true,
          startsAt: true,
          endsAt: true,
          partySize: true,
          guestName: true,
          guestPhone: true,
          guestEmail: true,
          specialRequests: true,
          internalNotes: true,
          depositAmount: true,
          depositStatus: true,
          depositPaidAt: true,
          checkedInAt: true,
          noShowAt: true,
          createdAt: true,
          table: { select: { number: true } },
          product: { select: { name: true } },
        },
      })
      if (!r) return text({ found: false, error: `No encontré una reserva con código "${confirmationCode}" en este local.` })
      return text({
        found: true,
        reservation: {
          confirmationCode: r.confirmationCode,
          status: r.status,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          partySize: r.partySize,
          guest: { name: r.guestName, phone: r.guestPhone, email: r.guestEmail },
          table: r.table?.number ?? null,
          service: r.product?.name ?? null, // booked service (appointment venues)
          deposit:
            r.depositAmount != null
              ? { amount: Number(r.depositAmount), status: r.depositStatus, paidAt: r.depositPaidAt?.toISOString() ?? null }
              : null,
          checkedInAt: r.checkedInAt?.toISOString() ?? null,
          noShowAt: r.noShowAt?.toISOString() ?? null,
          specialRequests: r.specialRequests,
          internalNotes: r.internalNotes,
          createdAt: r.createdAt.toISOString(),
        },
      })
    },
  )

  server.tool(
    'update_reservation',
    'Edit the editable details of a PENDING or CONFIRMED reservation in a venue you can access, by confirmation code: party size, guest contact (name/phone/email), special requests, and internal notes. Capacity is re-checked when party size changes. To change the TIME use reschedule_reservation; to cancel use cancel_reservation. This WRITES — requires reservations:update. Pass venueId + confirmationCode + only the fields you want to change.',
    {
      venueId: z.string().describe('Venue that owns the reservation (must be in your scope)'),
      confirmationCode: z.string().min(1).describe('The reservation confirmation code'),
      partySize: z.number().int().positive().optional().describe('New party size (capacity is re-checked)'),
      guestName: z.string().optional().describe('Guest name'),
      guestPhone: z.string().optional().describe('Guest phone'),
      guestEmail: z.string().optional().describe('Guest email'),
      specialRequests: z.string().optional().describe('Special requests / notes for staff'),
      internalNotes: z.string().optional().describe('Internal notes'),
    },
    async ({ venueId, confirmationCode, partySize, guestName, guestPhone, guestEmail, specialRequests, internalNotes }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:update', venueId) // write gate (per-venue role)
      const reservation = await prisma.reservation.findFirst({ where: { ...where, confirmationCode }, select: { id: true, venueId: true } })
      if (!reservation) return text({ ok: false, error: `No encontré una reserva con código "${confirmationCode}" en este local.` })

      const data: UpdateReservationInput = {}
      if (partySize !== undefined) data.partySize = partySize
      if (guestName !== undefined) data.guestName = guestName
      if (guestPhone !== undefined) data.guestPhone = guestPhone
      if (guestEmail !== undefined) data.guestEmail = guestEmail
      if (specialRequests !== undefined) data.specialRequests = specialRequests
      if (internalNotes !== undefined) data.internalNotes = internalNotes
      if (Object.keys(data).length === 0) return text({ ok: false, error: 'No pasaste ningún campo para actualizar.' })

      try {
        const updated = await updateReservation(reservation.venueId, reservation.id, data, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'RESERVATION_UPDATED',
          entity: 'Reservation',
          entityId: reservation.id,
          venueId: reservation.venueId,
          data: { confirmationCode, fields: Object.keys(data) },
        })
        return text({ ok: true, reservation: updated })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}

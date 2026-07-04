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
import { getReservationSettings, updateReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { getClassSession } from '@/services/dashboard/classSession.dashboard.service'
import { getWaitlist, addToWaitlist } from '@/services/dashboard/reservationWaitlist.service'
import { auditMcpWrite } from '../audit'
import { planGateMessage } from '../planGate'
import { hasPermission } from '@/services/access/access.service'
import { fromZonedTime } from 'date-fns-tz'
import { ClassSessionStatus, WaitlistStatus, type ReservationStatus } from '@prisma/client'

const RESERVATIONS_GATE = ['RESERVATIONS', 'Las reservaciones'] as const

// Reservation statuses that occupy a seat in a class — mirrors classSession.dashboard.service
// (a CANCELLED / NO_SHOW booking frees its seat, so it must NOT count toward enrolled).
const OCCUPYING_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as ReservationStatus[]

const CLASS_STATUS_MAP: Record<string, ClassSessionStatus> = {
  scheduled: ClassSessionStatus.SCHEDULED,
  cancelled: ClassSessionStatus.CANCELLED,
  completed: ClassSessionStatus.COMPLETED,
}

const WAITLIST_STATUS_MAP: Record<string, WaitlistStatus> = {
  waiting: WaitlistStatus.WAITING,
  notified: WaitlistStatus.NOTIFIED,
  promoted: WaitlistStatus.PROMOTED,
  expired: WaitlistStatus.EXPIRED,
  cancelled: WaitlistStatus.CANCELLED,
}

// Human labels for the configure_reservations preview, so the operator can verify
// each change (current → new) in plain Spanish BEFORE confirming — and catch a
// misread command at the gate instead of after the write.
const RESERVATION_FIELD_LABELS: Record<string, string> = {
  slotIntervalMin: 'Intervalo de slots (min)',
  defaultDurationMin: 'Duración predeterminada (min)',
  autoConfirm: 'Confirmar automáticamente',
  maxAdvanceDays: 'Días máximos de anticipación',
  minNoticeMin: 'Aviso mínimo (min)',
  noShowGraceMin: 'Gracia para no-show (min)',
  pacingMaxPerSlot: 'Máximo por slot',
  onlineCapacityPercent: 'Capacidad online (%)',
  depositMode: 'Modo de depósito',
  depositFixedAmount: 'Depósito fijo ($)',
  depositPercentage: 'Depósito (% del total)',
  depositPartySizeGte: 'Depósito si party ≥',
  depositPaymentWindow: 'Ventana de pago del depósito (h)',
  appointmentUpfrontDefault: 'Cobro adelantado en citas',
  classUpfrontDefault: 'Cobro adelantado en clases',
  allowCustomerCancel: 'Permitir cancelación por cliente',
  allowCustomerReschedule: 'Permitir cambio de horario',
  minHoursBeforeCancel: 'Horas mínimas antes de cancelar',
  forfeitDeposit: 'Perder depósito al cancelar',
  noShowFeePercent: 'Cargo por no-show (%)',
  creditRefundMode: 'Política de reembolso de créditos',
  creditFreeRefundHoursBefore: 'Reembolso 100% si cancela con (h)',
  creditLateRefundPercent: '% de reembolso si cancela tarde',
  creditNoShowRefund: 'Devolver créditos en no-show',
  waitlistEnabled: 'Lista de espera habilitada',
  waitlistMaxSize: 'Tamaño máximo de lista de espera',
  waitlistPriorityMode: 'Modo de prioridad de lista de espera',
  waitlistNotifyWindow: 'Ventana de notificación (min)',
  publicBookingEnabled: 'Reservaciones online habilitadas',
  requirePhone: 'Requerir teléfono',
  requireEmail: 'Requerir email',
  requireAccount: 'Requerir cuenta',
  remindersEnabled: 'Enviar recordatorios',
  reminderChannels: 'Canales de recordatorio',
  reminderMinBefore: 'Minutos antes de recordar',
}
// Prisma Decimal → number for display; everything else passes through unchanged.
const displayValue = (v: unknown): unknown =>
  v != null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { toNumber?: unknown }).toNumber === 'function'
    ? (v as { toNumber: () => number }).toNumber()
    : v

/**
 * Parse an operator-supplied reservation datetime. WHY: an LLM translating "resérvame hoy 7pm"
 * typically emits a NAIVE datetime ("2026-07-05T19:00:00", no Z). Bare `new Date()` parses that
 * in the Node HOST tz → in prod (host=UTC) it booked 1:00 PM venue-local, 6h early (invisible in
 * dev where host=Mexico). Rule: if the string carries an explicit tz (Z or ±HH:MM), respect it as
 * an absolute instant; otherwise interpret the wall-clock as VENUE-LOCAL via fromZonedTime.
 * Returns null on an unparseable value.
 */
export function parseReservationDateTime(input: string, venueTz: string): Date | null {
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(input.trim())
  const d = hasTz ? new Date(input) : fromZonedTime(input, venueTz)
  return Number.isNaN(d.getTime()) ? null : d
}

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
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      // Venue-local aware parse: a naive "…T19:00:00" means 7pm AT THE VENUE, not 7pm UTC.
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const start = parseReservationDateTime(startsAt, tz)
      if (!start) {
        return text({
          ok: false,
          error: 'startsAt inválido. Usa ISO 8601 (ej. 2026-06-06T19:00:00); si no pones zona, se toma hora local del local.',
        })
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
      // WHY: this list is multi-venue (venueId optional) and exposes guest names/phones. Mirror
      // daily_sales — single venue → hard-deny if the role lacks reservations:read; all-venues →
      // restrict to the venues where the caller actually holds it (never leak guest PII org-wide).
      const readable = venueId
        ? (guard.venueFilter(venueId), guard.requirePermission('reservations:read', venueId), [venueId])
        : scope.allowedVenueIds.filter(v => {
            const access = scope.perVenueAccess.get(v)
            return !!access && hasPermission(access, 'reservations:read')
          })
      const where = { venueId: { in: readable } }
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
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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
      // Venue-local aware parse: a naive "…T16:00:00" means 4pm AT THE VENUE, not 4pm UTC.
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const parsed = parseReservationDateTime(newStartsAt, tz)
      if (!parsed) {
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
      confirm: z.boolean().optional().describe('Required to actually cancel; without it you get a preview of what will be cancelled'),
    },
    async ({ venueId, confirmationCode, reason, confirm }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      guard.requirePermission('reservations:cancel', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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
      // Confirm-gate (M3): cancelling notifies the customer immediately and can release/forfeit their
      // deposit — hard to reverse once the notification goes out. Preview first.
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { confirmationCode, currentStatus: reservation.status, reason: reason ?? null },
          message: `Vas a CANCELAR la reservación ${confirmationCode} (estado actual: ${reservation.status}). Esto notifica al cliente al instante y puede liberar o penalizar su depósito. Confirma con confirm:true.`,
        })
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
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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
      guard.requirePermission('reservations:read', venueId) // WHY: mirror the dashboard's reservations:read gate — detail exposes guest email/phone + internal notes
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
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
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

  server.tool(
    'reservation_settings',
    'Read the WHOLE reservation-engine configuration for a venue you can access — everything on the "Configuración de Reservaciones" screen: scheduling (slot interval, default duration, max advance days, min notice, no-show grace, auto-confirm), pacing (max per slot, online capacity %), deposits (mode + amount/percentage + party-size threshold + payment window), type-aware upfront payment defaults (appointments vs classes), cancellation policy (who can cancel/reschedule, min hours, forfeit deposit, no-show fee), class credit-refund policy, waitlist (size + priority mode + notify window), public online booking toggles, reminders (channels + when), and Google Calendar sync. Use this FIRST when an operator wants to change reservation settings: show them the current values, ask what they want, then call configure_reservations with ONLY the fields to change. Pass venueId. PRO feature (RESERVATIONS).',
    {
      venueId: z.string().describe('Venue whose reservation settings to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:read', venueId)
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const settings = await getReservationSettings(venueId)
      return text({ venueId, settings })
    },
  )

  server.tool(
    'configure_reservations',
    'Change the reservation-engine configuration for a venue you can access — set any subset of the settings shown by reservation_settings. ALWAYS read reservation_settings first, ask the operator what they want for each thing, then call this with ONLY the fields to change (everything omitted stays as-is). By DEFAULT this only PREVIEWS the change; call again with confirm:true to save. This WRITES — requires reservations:update. PRO feature (RESERVATIONS).',
    {
      venueId: z.string().describe('Venue to configure (must be in your scope)'),
      // Scheduling
      slotIntervalMin: z.number().int().positive().optional().describe('Minutes between bookable slots (e.g. 15, 30)'),
      defaultDurationMin: z.number().int().positive().optional().describe('Default reservation/appointment length in minutes'),
      autoConfirm: z.boolean().optional().describe('Auto-confirm new bookings instead of leaving them PENDING'),
      maxAdvanceDays: z.number().int().positive().optional().describe('How many days ahead guests can book'),
      minNoticeMin: z.number().int().min(0).optional().describe('Minimum minutes of notice before a booking start'),
      noShowGraceMin: z.number().int().min(0).optional().describe('Grace minutes before a booking counts as a no-show'),
      pacingMaxPerSlot: z.number().int().positive().nullable().optional().describe('Max bookings per slot; null = no limit'),
      onlineCapacityPercent: z.number().int().min(0).max(100).optional().describe('% of capacity exposed to online booking (e.g. 100, 50)'),
      // Deposits
      depositMode: z
        .enum(['none', 'card_hold', 'deposit', 'prepaid'])
        .optional()
        .describe('Deposit handling (needs Stripe for anything but none)'),
      depositFixedAmount: z.number().min(0).nullable().optional().describe('Fixed deposit amount in pesos (or null)'),
      depositPercentage: z.number().min(0).max(100).nullable().optional().describe('Deposit as % of total (or null)'),
      depositPartySizeGte: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Only require a deposit when party size ≥ this (or null)'),
      depositPaymentWindow: z.number().int().positive().nullable().optional().describe('Hours the guest has to pay the deposit (or null)'),
      // Type-aware upfront payment
      appointmentUpfrontDefault: z
        .enum(['required', 'at_venue', 'optional'])
        .optional()
        .describe('Default upfront payment for appointments'),
      classUpfrontDefault: z.enum(['required', 'at_venue', 'optional']).optional().describe('Default upfront payment for classes'),
      // Cancellation
      allowCustomerCancel: z.boolean().optional().describe('Allow the guest to cancel'),
      allowCustomerReschedule: z.boolean().optional().describe('Allow the guest to reschedule'),
      minHoursBeforeCancel: z.number().int().min(0).nullable().optional().describe('Min hours before start to cancel/reschedule (or null)'),
      forfeitDeposit: z.boolean().optional().describe('Forfeit the deposit when the guest cancels'),
      noShowFeePercent: z.number().min(0).max(100).nullable().optional().describe('No-show fee as % (or null = no fee)'),
      // Class credit refunds
      creditRefundMode: z.enum(['NEVER', 'ALWAYS', 'TIME_BASED']).optional().describe('How class credits are refunded on cancel'),
      creditFreeRefundHoursBefore: z.number().int().min(0).optional().describe('Full credit refund if cancelled ≥ this many hours before'),
      creditLateRefundPercent: z.number().min(0).max(100).optional().describe('% credit refunded for a late cancel'),
      creditNoShowRefund: z.boolean().optional().describe('Refund credits on a no-show'),
      // Waitlist
      waitlistEnabled: z.boolean().optional().describe('Enable the waitlist'),
      waitlistMaxSize: z.number().int().positive().optional().describe('Max people on the waitlist'),
      waitlistPriorityMode: z.enum(['fifo', 'party_size', 'broadcast']).optional().describe('Waitlist priority strategy'),
      waitlistNotifyWindow: z.number().int().positive().optional().describe('Minutes a notified guest has to claim a freed slot'),
      // Public online booking
      publicBookingEnabled: z.boolean().optional().describe('Enable online (public) booking'),
      requirePhone: z.boolean().optional().describe('Require phone for online booking'),
      requireEmail: z.boolean().optional().describe('Require email for online booking'),
      requireAccount: z.boolean().optional().describe('Require an account for online booking'),
      // Reminders
      remindersEnabled: z.boolean().optional().describe('Send booking reminders'),
      reminderChannels: z
        .array(z.enum(['email', 'sms', 'whatsapp']))
        .optional()
        .describe('Reminder channels'),
      reminderMinBefore: z.array(z.number().int().positive()).optional().describe('Minutes-before to send each reminder, e.g. [120, 1440]'),
      confirm: z.boolean().optional().describe('Must be true to actually save; without it you get a preview of the changes'),
    },
    async ({ venueId, confirm, ...fields }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:update', venueId) // write gate (per-venue role)
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      // Only the fields the operator actually set (undefined = leave as-is). null is a real value (clears).
      const update = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      if (Object.keys(update).length === 0) {
        return text({
          ok: false,
          error: 'No indicaste ningún ajuste a cambiar. Pasa al menos un campo (lee reservation_settings para ver las opciones).',
        })
      }

      if (!confirm) {
        // Show each change as label + CURRENT → NEW so the operator can catch a
        // misread instruction before anything is written. Read the current row flat
        // (same column names as the update keys); null/absent → '(predeterminado)'.
        const current = (await prisma.reservationSettings.findUnique({ where: { venueId } })) as Record<string, unknown> | null
        const changes = Object.entries(update).map(([field, to]) => ({
          field,
          label: RESERVATION_FIELD_LABELS[field] ?? field,
          from: current ? (displayValue(current[field]) ?? null) : null,
          to,
        }))
        return text({
          ok: false,
          requiresConfirmation: true,
          changes,
          message: `Vas a cambiar ${changes.length} ajuste(s):\n${changes
            .map(c => `• ${c.label}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
            .join('\n')}\n\nConfirma con el operador que esto es lo que pidió; luego vuelve a llamar con confirm:true.`,
        })
      }

      try {
        await updateReservationSettings(venueId, update)
        await auditMcpWrite(scope, {
          action: 'RESERVATION_SETTINGS_UPDATED',
          entity: 'ReservationSettings',
          entityId: venueId,
          venueId,
          data: { fields: Object.keys(update) },
        })
        const settings = await getReservationSettings(venueId) // return the fresh, full config
        return text({ ok: true, changed: Object.keys(update), settings })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'list_class_sessions',
    'Group classes / scheduled sessions of a venue you can access (e.g. yoga 6pm, spinning) — each with its class name, when (start/end), duration, capacity, how many are ENROLLED and how many seats are AVAILABLE, the assigned instructor, and status (scheduled/cancelled/completed). Upcoming only by default, soonest first. Answers "¿qué clases tengo hoy/esta semana? ¿cuántos inscritos en la de las 6? ¿hay cupo?". Pass venueId. For the actual roster (who is enrolled) use class_session_detail.',
    {
      venueId: z.string().describe('Venue whose class sessions to read (must be in your scope)'),
      includePast: z.boolean().default(false).describe('Include sessions that already started (default: only upcoming)'),
      status: z.enum(['scheduled', 'cancelled', 'completed']).optional().describe('Filter by session status'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max sessions to return'),
    },
    async ({ venueId, includePast, status, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier — mirrors checkFeatureAccess('RESERVATIONS') on the route
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const sessions = await prisma.classSession.findMany({
        where: {
          ...where,
          ...(includePast ? {} : { startsAt: { gte: new Date() } }),
          ...(status ? { status: CLASS_STATUS_MAP[status] } : {}),
        },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          duration: true,
          capacity: true,
          status: true,
          product: { select: { name: true } },
          assignedStaff: { select: { firstName: true, lastName: true } },
          // Only seat-occupying bookings count toward enrolled (same filter as the dashboard service).
          reservations: { where: { status: { in: OCCUPYING_STATUSES } }, select: { partySize: true } },
        },
        orderBy: { startsAt: includePast ? 'desc' : 'asc' },
        take: limit,
      })

      return text({
        venueId,
        count: sessions.length,
        upcoming: !includePast,
        sessions: sessions.map(s => {
          const enrolled = s.reservations.reduce((sum, r) => sum + r.partySize, 0)
          return {
            sessionId: s.id,
            className: s.product?.name ?? null,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            durationMin: s.duration,
            capacity: s.capacity,
            enrolled,
            available: s.capacity - enrolled,
            instructor: s.assignedStaff ? `${s.assignedStaff.firstName} ${s.assignedStaff.lastName}`.trim() : null,
            status: s.status, // SCHEDULED | CANCELLED | COMPLETED
          }
        }),
      })
    },
  )

  server.tool(
    'class_session_detail',
    'The roster of ONE class session in a venue you can access, by its sessionId (from list_class_sessions): the class, when, capacity / enrolled / available, the instructor, and the list of ATTENDEES (name, party size, status, confirmation code). Answers "¿quién está inscrito en la clase de las 6?". Pass venueId + sessionId.',
    {
      venueId: z.string().describe('Venue that owns the session (must be in your scope)'),
      sessionId: z.string().min(1).describe('Class session id (from list_class_sessions)'),
    },
    async ({ venueId, sessionId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:read', venueId) // WHY: mirror the dashboard's reservations:read gate — class rosters expose attendee names/phones
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      try {
        // Service scopes by venueId (own venues only — already proven by venueFilter) and computes enrolled/available.
        const s = await getClassSession(venueId, sessionId)
        return text({
          found: true,
          session: {
            sessionId: s.id,
            className: s.product?.name ?? null,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            durationMin: s.duration,
            capacity: s.capacity,
            enrolled: s.enrolled,
            available: s.available,
            instructor: s.assignedStaff ? `${s.assignedStaff.firstName} ${s.assignedStaff.lastName}`.trim() : null,
            status: s.status,
          },
          attendees: s.reservations.map(r => ({
            name: r.customer ? `${r.customer.firstName ?? ''} ${r.customer.lastName ?? ''}`.trim() || null : (r.guestName ?? null),
            phone: r.customer?.phone ?? r.guestPhone ?? null,
            partySize: r.partySize,
            status: r.status, // PENDING | CONFIRMED | CHECKED_IN
            confirmationCode: r.confirmationCode,
          })),
        })
      } catch {
        return text({ found: false, error: `No encontré la sesión "${sessionId}" en este local.` })
      }
    },
  )

  server.tool(
    'list_waitlist',
    'The reservation/appointment WAITLIST (lista de espera) of a venue you can access: each entry in queue order with its position, the guest (name/phone or linked customer), party size, the desired date/time, status (waiting/notified/promoted/expired/cancelled) and — if it was converted — the resulting reservation code. Defaults to the live queue (waiting + notified). Answers "¿quién está en lista de espera? ¿a qué hora quería?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose waitlist to read (must be in your scope)'),
      status: z
        .enum(['waiting', 'notified', 'promoted', 'expired', 'cancelled'])
        .optional()
        .describe('Filter by status (default: the live queue — waiting + notified)'),
    },
    async ({ venueId, status }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:read', venueId) // WHY: mirror the dashboard's reservations:read gate — waitlist exposes customer names/phones
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      // Service scopes by venueId; default (no status) returns the live WAITING+NOTIFIED queue.
      const entries = await getWaitlist(venueId, status ? WAITLIST_STATUS_MAP[status] : undefined)
      return text({
        venueId,
        count: entries.length,
        waitlist: entries.map(e => ({
          position: e.position,
          name: e.customer ? `${e.customer.firstName ?? ''} ${e.customer.lastName ?? ''}`.trim() || null : (e.guestName ?? null),
          phone: e.customer?.phone ?? e.guestPhone ?? null,
          partySize: e.partySize,
          desiredStartAt: e.desiredStartAt.toISOString(),
          status: e.status, // WAITING | NOTIFIED | PROMOTED | EXPIRED | CANCELLED
          promotedReservation: e.promotedReservation?.confirmationCode ?? null,
        })),
      })
    },
  )

  server.tool(
    'add_to_waitlist',
    'Add someone to the reservation/appointment WAITLIST (lista de espera) of a venue you can access — e.g. "mete a María a la lista de espera para hoy 8pm". Either link a known customer (pass `search` by name/email/phone) OR a walk-in (pass guestName + guestPhone). Give the desired date/time and party size. The service assigns the queue position and refuses if the waitlist is disabled or full. This WRITES — requires reservations:create.',
    {
      venueId: z.string().describe('Venue whose waitlist to add to (must be in your scope)'),
      desiredStartAt: z.string().min(1).describe('Desired date/time, ISO 8601 (e.g. 2026-06-29T20:00:00.000Z)'),
      partySize: z.number().int().positive().max(100).optional().describe('Party size (default 1)'),
      search: z.string().optional().describe('Link a KNOWN customer by name/email/phone (partial). Omit for a walk-in guest.'),
      guestName: z.string().optional().describe('Walk-in guest name (use instead of search)'),
      guestPhone: z.string().optional().describe('Walk-in guest phone'),
      notes: z.string().optional().describe('Optional notes'),
    },
    async ({ venueId, desiredStartAt, partySize, search, guestName, guestPhone, notes }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('reservations:create', venueId) // write gate (per-venue role) — mirrors POST /waitlist
      const gate = await planGateMessage(venueId, ...RESERVATIONS_GATE) // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      // Venue-local aware parse: a naive "…T20:00:00" means 8pm AT THE VENUE, not 8pm UTC.
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const start = parseReservationDateTime(desiredStartAt, tz)
      if (!start) return text({ ok: false, error: 'desiredStartAt inválido. Usa ISO 8601, ej. 2026-06-29T20:00:00' })

      // Either link a known customer (resolve-don't-guess) or take a walk-in guest.
      let customerId: string | undefined
      let who: string
      if (search) {
        const matches = await prisma.customer.findMany({
          where: {
            ...base,
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search } },
            ],
          },
          select: { id: true, firstName: true, lastName: true },
          orderBy: { totalSpent: 'desc' },
          take: 5,
        })
        if (matches.length === 0)
          return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
        if (matches.length > 1) {
          return text({
            ok: false,
            ambiguous: true,
            error: `"${search}" coincide con varios clientes — sé más específico o usa guestName.`,
            matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
          })
        }
        customerId = matches[0].id
        who = `${matches[0].firstName ?? ''} ${matches[0].lastName ?? ''}`.trim() || '(cliente)'
      } else if (guestName) {
        who = guestName
      } else {
        return text({ ok: false, error: 'Pasa "search" (cliente existente) o "guestName" (invitado de paso).' })
      }

      try {
        const settings = await getReservationSettings(venueId) // waitlist enabled/maxSize/priority config
        const entry = await addToWaitlist(
          venueId,
          {
            ...(customerId ? { customerId } : { guestName, guestPhone }),
            partySize: partySize ?? 1,
            desiredStartAt: start,
            ...(notes ? { notes } : {}),
          },
          settings,
        )
        await auditMcpWrite(scope, {
          action: 'WAITLIST_ADDED',
          entity: 'ReservationWaitlistEntry',
          entityId: (entry as { id: string }).id,
          venueId,
          data: { who, partySize: partySize ?? 1, desiredStartAt: start.toISOString() },
        })
        return text({
          ok: true,
          waitlistEntry: {
            who,
            position: (entry as { position: number }).position,
            partySize: (entry as { partySize: number }).partySize,
            desiredStartAt: start.toISOString(),
            status: (entry as { status: string }).status,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}

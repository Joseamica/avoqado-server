import crypto from 'crypto'
import prisma from '../../utils/prismaClient'
import { fromZonedTime } from 'date-fns-tz'
import { DateTime } from 'luxon'
import { NotFoundError, BadRequestError, ConflictError } from '../../errors/AppError'
import type {
  CreateClassSessionDto,
  UpdateClassSessionDto,
  AddAttendeeDto,
  ListClassSessionsQuery,
  CreateClassSessionBulkDto,
} from '../../schemas/dashboard/classSession.schema'
import { ReservationStatus } from '@prisma/client'
import { withSerializableRetry } from './reservation.dashboard.service'
import { logAction } from './activity-log.service'

// ==========================================
// CLASS SESSION SERVICE
// ==========================================

const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateConfirmationCode(): string {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARSET[bytes[i] % CODE_CHARSET.length]
  }
  return `RES-${code}`
}

const SESSION_INCLUDE = {
  product: { select: { id: true, name: true, price: true, duration: true, maxParticipants: true } },
  assignedStaff: { select: { id: true, firstName: true, lastName: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  reservations: {
    where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as ReservationStatus[] } },
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      partySize: true,
      guestName: true,
      guestPhone: true,
      guestEmail: true,
      specialRequests: true,
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  },
}

// ---- List ----

export async function getClassSessions(venueId: string, query: ListClassSessionsQuery, tz: string) {
  const fromISO = (query.dateFrom as Date).toISOString().slice(0, 10)
  const toISO = (query.dateTo as Date).toISOString().slice(0, 10)
  const from = fromZonedTime(`${fromISO}T00:00:00`, tz)
  const to = fromZonedTime(`${toISO}T23:59:59.999`, tz)

  const sessions = await prisma.classSession.findMany({
    where: {
      venueId,
      startsAt: { gte: from, lte: to },
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    include: SESSION_INCLUDE,
    orderBy: { startsAt: 'asc' },
  })

  return sessions.map(s => ({
    ...s,
    enrolled: s.reservations.reduce((sum, r) => sum + r.partySize, 0),
    available: s.capacity - s.reservations.reduce((sum, r) => sum + r.partySize, 0),
  }))
}

// ---- Get one ----

export async function getClassSession(venueId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, venueId },
    include: SESSION_INCLUDE,
  })
  if (!session) throw new NotFoundError('Sesión no encontrada')

  const enrolled = session.reservations.reduce((sum, r) => sum + r.partySize, 0)
  return { ...session, enrolled, available: session.capacity - enrolled }
}

// ---- Create ----

export async function createClassSession(venueId: string, data: CreateClassSessionDto, createdById: string) {
  const product = await prisma.product.findFirst({
    where: { id: data.productId, venueId },
    select: { id: true, type: true, maxParticipants: true },
  })
  if (!product) throw new NotFoundError('Producto no encontrado')
  if (product.type !== 'CLASS') throw new BadRequestError('El producto debe ser de tipo Clase')

  // Validate assignedStaffId belongs to this venue
  if (data.assignedStaffId) {
    const staffVenue = await prisma.staffVenue.findFirst({
      where: { staffId: data.assignedStaffId, venueId },
      select: { id: true },
    })
    if (!staffVenue) throw new BadRequestError('El staff asignado no pertenece a este negocio')
  }

  const startsAt = new Date(data.startsAt)
  const endsAt = new Date(data.endsAt)
  const duration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)

  // Reject scheduling in the past (small grace window for clock skew)
  if (startsAt.getTime() < Date.now() - 60_000) {
    throw new BadRequestError('No se puede agendar una clase en el pasado')
  }

  const session = await prisma.classSession.create({
    data: {
      venueId,
      productId: data.productId,
      startsAt,
      endsAt,
      duration,
      capacity: data.capacity,
      assignedStaffId: data.assignedStaffId ?? null,
      internalNotes: data.internalNotes ?? null,
      createdById,
    },
    include: SESSION_INCLUDE,
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'CLASS_SESSION_CREATED',
    entity: 'ClassSession',
    entityId: session.id,
  })

  return session
}

// ---- Bulk create (recurring) ----

const MAX_BULK_OCCURRENCES = 104 // ~2 years of weekly classes

export async function createClassSessionsBulk(
  venueId: string,
  data: CreateClassSessionBulkDto,
  createdById: string,
  venueTimezone: string,
) {
  const product = await prisma.product.findFirst({
    where: { id: data.productId, venueId },
    select: { id: true, type: true },
  })
  if (!product) throw new NotFoundError('Producto no encontrado')
  if (product.type !== 'CLASS') throw new BadRequestError('El producto debe ser de tipo Clase')

  if (data.assignedStaffId) {
    const staffVenue = await prisma.staffVenue.findFirst({
      where: { staffId: data.assignedStaffId, venueId },
      select: { id: true },
    })
    if (!staffVenue) throw new BadRequestError('El staff asignado no pertenece a este negocio')
  }

  // Expand recurrence rule into concrete (date, startsAt, endsAt) instances.
  // ALL date arithmetic happens in the venue's local timezone via Luxon — using JS
  // Date.getDay() would return weekdays in the Node process timezone, off-by-one
  // when Node runs in UTC and the venue is UTC-N.
  const weekdaySet = new Set(data.weekdays)
  const startCursor = DateTime.fromISO(data.startDate, { zone: venueTimezone })
  if (!startCursor.isValid) throw new BadRequestError('startDate inválida')
  const endCursor = data.endDate ? DateTime.fromISO(data.endDate, { zone: venueTimezone }) : null
  if (data.endDate && (!endCursor || !endCursor.isValid)) throw new BadRequestError('endDate inválida')

  // Luxon weekday: 1=Mon..7=Sun. Our schema uses JS convention 0=Sun..6=Sat — translate.
  const luxonWeekday = (jsDay: number) => (jsDay === 0 ? 7 : jsDay)
  const wantedLuxonWeekdays = new Set(Array.from(weekdaySet).map(luxonWeekday))

  const instances: { startsAt: Date; endsAt: Date; duration: number; localDate: string }[] = []
  let cursor = startCursor
  let occurrencesCreated = 0
  const cap = data.occurrences ?? MAX_BULK_OCCURRENCES
  const hardLimit = endCursor ? Math.ceil(endCursor.diff(startCursor, 'days').days) + 7 : MAX_BULK_OCCURRENCES * 7

  for (let i = 0; i < hardLimit && occurrencesCreated < cap; i++) {
    if (endCursor && cursor > endCursor) break
    if (wantedLuxonWeekdays.has(cursor.weekday)) {
      const localDate = cursor.toISODate()! // YYYY-MM-DD in venue tz
      const startsAt = fromZonedTime(`${localDate}T${data.startTime}:00`, venueTimezone)
      const endsAt = fromZonedTime(`${localDate}T${data.endTime}:00`, venueTimezone)
      const duration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)
      // Skip past instances silently — useful when startDate is today and weekdays
      // include today but we already passed the time.
      if (startsAt.getTime() >= Date.now() - 60_000) {
        instances.push({ startsAt, endsAt, duration, localDate })
        occurrencesCreated++
      }
    }
    cursor = cursor.plus({ days: 1 })
  }

  if (instances.length === 0) {
    throw new BadRequestError('La regla de recurrencia no genera ninguna sesión válida')
  }

  // Find existing sessions on those dates so we can skip conflicts.
  const allStarts = instances.map(i => i.startsAt)
  const earliest = new Date(Math.min(...allStarts.map(d => d.getTime())))
  const latest = new Date(Math.max(...allStarts.map(d => d.getTime())))
  const existing = await prisma.classSession.findMany({
    where: {
      venueId,
      productId: data.productId,
      startsAt: { gte: earliest, lte: latest },
    },
    select: { startsAt: true },
  })
  const existingTimestamps = new Set(existing.map(e => e.startsAt.getTime()))

  const toCreate = instances.filter(i => !existingTimestamps.has(i.startsAt.getTime()))
  const skipped = instances.length - toCreate.length

  // Single transaction so partial failures roll back. Each row is independent so we
  // don't need SERIALIZABLE — REPEATABLE READ is enough; rely on default.
  const created = await prisma.$transaction(
    toCreate.map(i =>
      prisma.classSession.create({
        data: {
          venueId,
          productId: data.productId,
          startsAt: i.startsAt,
          endsAt: i.endsAt,
          duration: i.duration,
          capacity: data.capacity,
          assignedStaffId: data.assignedStaffId ?? null,
          internalNotes: data.internalNotes ?? null,
          createdById,
        },
        select: { id: true, startsAt: true, endsAt: true },
      }),
    ),
  )

  logAction({
    staffId: createdById,
    venueId,
    action: 'CLASS_SESSION_BULK_CREATED',
    entity: 'ClassSession',
    entityId: data.productId,
    data: { created: created.length, skipped, weekdays: data.weekdays },
  })

  return { created, count: created.length, skipped }
}

// ---- Update ----

export async function updateClassSession(venueId: string, sessionId: string, data: UpdateClassSessionDto) {
  const session = await prisma.classSession.findFirst({ where: { id: sessionId, venueId } })
  if (!session) throw new NotFoundError('Sesión no encontrada')
  if (session.status === 'CANCELLED') throw new BadRequestError('No se puede modificar una sesión cancelada')

  // If reducing capacity, ensure it doesn't go below current enrollment
  if (data.capacity !== undefined) {
    const enrolled = await prisma.reservation.aggregate({
      where: { classSessionId: sessionId, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
      _sum: { partySize: true },
    })
    const currentEnrolled = enrolled._sum.partySize ?? 0
    if (data.capacity < currentEnrolled) {
      throw new BadRequestError(`No se puede reducir la capacidad a ${data.capacity} — hay ${currentEnrolled} asistentes inscritos`)
    }
  }

  // Validate assignedStaffId belongs to this venue
  if (data.assignedStaffId) {
    const staffVenue = await prisma.staffVenue.findFirst({
      where: { staffId: data.assignedStaffId, venueId },
      select: { id: true },
    })
    if (!staffVenue) throw new BadRequestError('El staff asignado no pertenece a este negocio')
  }

  const updateData: any = {}
  const newStartsAt = data.startsAt ? new Date(data.startsAt) : null
  const newEndsAt = data.endsAt ? new Date(data.endsAt) : null
  if (newStartsAt) updateData.startsAt = newStartsAt
  if (newEndsAt) updateData.endsAt = newEndsAt
  // Recalculate duration whenever either time field changes
  if (newStartsAt || newEndsAt) {
    const effectiveStart = newStartsAt || session.startsAt
    const effectiveEnd = newEndsAt || session.endsAt
    if (effectiveEnd <= effectiveStart) {
      throw new BadRequestError('La hora de inicio debe ser anterior a la hora de fin')
    }
    updateData.duration = Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / 60000)
  }
  if (data.capacity !== undefined) updateData.capacity = data.capacity
  if ('assignedStaffId' in data) updateData.assignedStaffId = data.assignedStaffId ?? null
  if ('internalNotes' in data) updateData.internalNotes = data.internalNotes ?? null

  const updated = await prisma.classSession.update({
    where: { id: sessionId },
    data: updateData,
    include: SESSION_INCLUDE,
  })

  logAction({
    venueId,
    action: 'CLASS_SESSION_UPDATED',
    entity: 'ClassSession',
    entityId: sessionId,
  })

  return updated
}

// ---- Cancel ----

export async function cancelClassSession(venueId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({ where: { id: sessionId, venueId } })
  if (!session) throw new NotFoundError('Sesión no encontrada')
  if (session.status === 'CANCELLED') throw new ConflictError('La sesión ya está cancelada')

  const cancelled = await prisma.$transaction(async tx => {
    // Cancel all active reservations for this session
    await tx.reservation.updateMany({
      where: {
        classSessionId: sessionId,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: 'SYSTEM',
        cancellationReason: 'Sesión cancelada por el establecimiento',
      },
    })

    return tx.classSession.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED' },
      include: SESSION_INCLUDE,
    })
  })

  logAction({
    venueId,
    action: 'CLASS_SESSION_CANCELLED',
    entity: 'ClassSession',
    entityId: sessionId,
  })

  return cancelled
}

// ---- Add attendee ----

export async function addAttendee(venueId: string, sessionId: string, data: AddAttendeeDto, staffId: string) {
  const partySize = data.partySize ?? 1

  // Validate customerId belongs to this venue
  if (data.customerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, venueId },
      select: { id: true },
    })
    if (!customer) throw new BadRequestError('El cliente no pertenece a este negocio')
  }

  // Use serializable transaction to prevent race conditions on capacity
  return withSerializableRetry(async tx => {
    // Lock the ClassSession row and verify it exists + belongs to venue
    const sessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${sessionId}
        AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (sessions.length === 0) throw new NotFoundError('Sesión no encontrada')
    const session = sessions[0]

    if (session.status !== 'SCHEDULED') {
      throw new BadRequestError('Solo se pueden añadir asistentes a sesiones programadas')
    }

    // Sum enrolled from active reservations
    // Note: FOR UPDATE cannot be used with aggregate functions in PostgreSQL.
    // The ClassSession row lock above + SERIALIZABLE isolation is sufficient.
    const enrolledResult = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("partySize"), 0) as total
      FROM "Reservation"
      WHERE "classSessionId" = ${sessionId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    `
    const enrolled = Number(enrolledResult[0].total)

    if (enrolled + partySize > session.capacity) {
      throw new ConflictError(`Sin capacidad suficiente — disponibles: ${session.capacity - enrolled}, solicitadas: ${partySize}`)
    }

    const confirmationCode = generateConfirmationCode()

    return tx.reservation.create({
      data: {
        venueId,
        confirmationCode,
        classSessionId: sessionId,
        productId: session.productId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        duration: session.duration,
        status: 'CONFIRMED',
        channel: 'DASHBOARD',
        guestName: data.guestName,
        guestPhone: data.guestPhone ?? null,
        guestEmail: data.guestEmail ?? null,
        partySize,
        specialRequests: data.specialRequests ?? null,
        customerId: data.customerId ?? null,
        createdById: staffId,
        confirmedAt: new Date(),
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    })
  })
}

// ---- Remove attendee ----

export async function removeAttendee(venueId: string, sessionId: string, reservationId: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId, classSessionId: sessionId },
  })
  if (!reservation) throw new NotFoundError('Asistente no encontrado en esta sesión')
  if (['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(reservation.status)) {
    throw new BadRequestError('Esta reservación ya no puede ser cancelada')
  }

  return prisma.reservation.update({
    where: { id: reservationId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: 'STAFF',
    },
  })
}

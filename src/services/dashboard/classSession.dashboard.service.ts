import crypto from 'crypto'
import prisma from '../../utils/prismaClient'
import { fromZonedTime } from 'date-fns-tz'
import { NotFoundError, BadRequestError, ConflictError } from '../../errors/AppError'
import type {
  CreateClassSessionDto,
  UpdateClassSessionDto,
  AddAttendeeDto,
  ListClassSessionsQuery,
} from '../../schemas/dashboard/classSession.schema'
import { ReservationStatus } from '@prisma/client'

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

  const startsAt = new Date(data.startsAt)
  const endsAt = new Date(data.endsAt)
  const duration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60000)

  return prisma.classSession.create({
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

  const updateData: any = {}
  if (data.startsAt) updateData.startsAt = new Date(data.startsAt)
  if (data.endsAt) updateData.endsAt = new Date(data.endsAt)
  if (data.startsAt && data.endsAt) {
    updateData.duration = Math.round((new Date(data.endsAt).getTime() - new Date(data.startsAt).getTime()) / 60000)
  }
  if (data.capacity !== undefined) updateData.capacity = data.capacity
  if ('assignedStaffId' in data) updateData.assignedStaffId = data.assignedStaffId ?? null
  if ('internalNotes' in data) updateData.internalNotes = data.internalNotes ?? null

  return prisma.classSession.update({
    where: { id: sessionId },
    data: updateData,
    include: SESSION_INCLUDE,
  })
}

// ---- Cancel ----

export async function cancelClassSession(venueId: string, sessionId: string) {
  const session = await prisma.classSession.findFirst({ where: { id: sessionId, venueId } })
  if (!session) throw new NotFoundError('Sesión no encontrada')
  if (session.status === 'CANCELLED') throw new ConflictError('La sesión ya está cancelada')

  return prisma.$transaction(async tx => {
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
}

// ---- Add attendee ----

export async function addAttendee(venueId: string, sessionId: string, data: AddAttendeeDto, staffId: string) {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, venueId },
    include: {
      product: { select: { id: true, name: true } },
      reservations: {
        where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as ReservationStatus[] } },
        select: { partySize: true },
      },
    },
  })
  if (!session) throw new NotFoundError('Sesión no encontrada')
  if (session.status !== 'SCHEDULED') throw new BadRequestError('Solo se pueden añadir asistentes a sesiones programadas')

  const enrolled = session.reservations.reduce((sum, r) => sum + r.partySize, 0)
  const partySize = data.partySize ?? 1
  if (enrolled + partySize > session.capacity) {
    throw new ConflictError(`Sin capacidad suficiente — disponibles: ${session.capacity - enrolled}, solicitadas: ${partySize}`)
  }

  const confirmationCode = generateConfirmationCode()

  return prisma.reservation.create({
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

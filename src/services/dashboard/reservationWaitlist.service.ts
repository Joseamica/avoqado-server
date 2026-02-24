import { WaitlistStatus } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ==========================================
// WAITLIST SERVICE — Queue management + auto-promote
// ==========================================

export interface AddToWaitlistInput {
  customerId?: string
  guestName?: string
  guestPhone?: string
  partySize?: number
  desiredStartAt: Date
  desiredEndAt?: Date
  notes?: string
}

export async function addToWaitlist(venueId: string, data: AddToWaitlistInput, moduleConfig?: any) {
  if (moduleConfig?.waitlist?.enabled === false) {
    throw new BadRequestError('La lista de espera no esta habilitada')
  }

  const maxSize = moduleConfig?.waitlist?.maxSize ?? 50

  // Check waitlist is not full
  const currentCount = await prisma.reservationWaitlistEntry.count({
    where: { venueId, status: 'WAITING' },
  })
  if (currentCount >= maxSize) {
    throw new ConflictError('La lista de espera esta llena')
  }

  // Calculate position based on priority mode
  const priorityMode = moduleConfig?.waitlist?.priorityMode ?? 'fifo'
  const position = await calculatePosition(venueId, data.partySize ?? 1, data.desiredStartAt, priorityMode)

  const entry = await prisma.reservationWaitlistEntry.create({
    data: {
      venueId,
      customerId: data.customerId,
      guestName: data.guestName,
      guestPhone: data.guestPhone,
      partySize: data.partySize ?? 1,
      desiredStartAt: data.desiredStartAt,
      desiredEndAt: data.desiredEndAt,
      position,
      notes: data.notes,
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  })

  logger.info(`✅ [WAITLIST] Added entry ${entry.id} | venue=${venueId} position=${position} partySize=${data.partySize ?? 1}`)

  return entry
}

async function calculatePosition(
  venueId: string,
  partySize: number,
  desiredStartAt: Date,
  priorityMode: 'fifo' | 'party_size' | 'broadcast',
): Promise<number> {
  if (priorityMode === 'fifo') {
    // Simple: next position after current max
    const maxEntry = await prisma.reservationWaitlistEntry.findFirst({
      where: { venueId, status: 'WAITING' },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    return (maxEntry?.position ?? 0) + 1
  }

  if (priorityMode === 'party_size') {
    // Smaller parties get higher priority (easier to seat)
    // Position = partySize * 100 + sequential within that size
    const sameSize = await prisma.reservationWaitlistEntry.count({
      where: { venueId, status: 'WAITING', partySize },
    })
    return partySize * 100 + sameSize + 1
  }

  // broadcast: all notified simultaneously, no ordering
  return 0
}

export async function getWaitlist(venueId: string, status?: WaitlistStatus) {
  return prisma.reservationWaitlistEntry.findMany({
    where: {
      venueId,
      ...(status ? { status } : { status: { in: ['WAITING', 'NOTIFIED'] } }),
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      promotedReservation: { select: { id: true, confirmationCode: true, status: true } },
    },
    orderBy: { position: 'asc' },
  })
}

export async function getWaitlistEntry(venueId: string, entryId: string) {
  const entry = await prisma.reservationWaitlistEntry.findFirst({
    where: { id: entryId, venueId },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  })
  if (!entry) throw new NotFoundError('Entrada de lista de espera no encontrada')
  return entry
}

export async function removeFromWaitlist(venueId: string, entryId: string) {
  const entry = await prisma.reservationWaitlistEntry.findFirst({
    where: { id: entryId, venueId },
  })
  if (!entry) throw new NotFoundError('Entrada de lista de espera no encontrada')

  if (!['WAITING', 'NOTIFIED'].includes(entry.status)) {
    throw new BadRequestError(`No se puede eliminar una entrada con estado ${entry.status}`)
  }

  return prisma.reservationWaitlistEntry.update({
    where: { id: entryId },
    data: { status: 'CANCELLED' },
  })
}

export async function promoteWaitlistEntry(venueId: string, entryId: string, reservationId: string) {
  const entry = await prisma.reservationWaitlistEntry.findFirst({
    where: { id: entryId, venueId },
  })
  if (!entry) throw new NotFoundError('Entrada de lista de espera no encontrada')

  if (!['WAITING', 'NOTIFIED'].includes(entry.status)) {
    throw new BadRequestError(`No se puede promover una entrada con estado ${entry.status}`)
  }

  // Validate reservation belongs to the same venue (prevent cross-venue linking)
  if (reservationId) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, venueId },
      select: { id: true },
    })
    if (!reservation) throw new NotFoundError('Reservacion no encontrada en este negocio')
  }

  return prisma.reservationWaitlistEntry.update({
    where: { id: entryId },
    data: {
      status: 'PROMOTED',
      promotedReservationId: reservationId,
    },
  })
}

/**
 * Find waitlist entries that could fill a cancelled/completed slot.
 * Matches by party size (not pure FIFO) per Codex critique.
 */
export async function findMatchingWaitlistEntries(
  venueId: string,
  slotStartsAt: Date,
  maxPartySize: number,
  priorityMode: 'fifo' | 'party_size' | 'broadcast',
) {
  const where: any = {
    venueId,
    status: 'WAITING',
    partySize: { lte: maxPartySize },
    desiredStartAt: {
      gte: new Date(slotStartsAt.getTime() - 2 * 60 * 60 * 1000), // within 2 hours before
      lte: new Date(slotStartsAt.getTime() + 2 * 60 * 60 * 1000), // within 2 hours after
    },
  }

  if (priorityMode === 'broadcast') {
    // Notify all matching entries simultaneously
    return prisma.reservationWaitlistEntry.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  // fifo or party_size: return ordered by position
  return prisma.reservationWaitlistEntry.findMany({
    where,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
    orderBy: { position: 'asc' },
    take: 5, // Notify top 5 candidates
  })
}

export async function notifyWaitlistEntry(venueId: string, entryId: string, responseWindowMin: number) {
  return prisma.reservationWaitlistEntry.update({
    where: { id: entryId },
    data: {
      status: 'NOTIFIED',
      notifiedAt: new Date(),
      responseDeadline: new Date(Date.now() + responseWindowMin * 60 * 1000),
    },
  })
}

export async function expireWaitlistEntry(entryId: string) {
  return prisma.reservationWaitlistEntry.update({
    where: { id: entryId },
    data: { status: 'EXPIRED' },
  })
}

import crypto from 'crypto'
import { Prisma, ReservationStatus, ReservationChannel } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from './activity-log.service'
import { getReservationSettings } from './reservationSettings.service'
import { sendReservationRescheduleWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
// creditPack.public.service is imported lazily inside cancelReservation/markNoShow to avoid
// the circular import — creditPack imports `withSerializableRetry` from this module.

// ==========================================
// RESERVATION SERVICE — Core CRUD + State Machine
// ==========================================

// ---- State Machine ----

const VALID_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
}

function validateTransition(current: ReservationStatus, target: ReservationStatus): void {
  const allowed = VALID_TRANSITIONS[current]
  if (!allowed || !allowed.includes(target)) {
    throw new BadRequestError(`No se puede cambiar de ${current} a ${target}. Transiciones validas: ${allowed?.join(', ') || 'ninguna'}`)
  }
}

// ---- Confirmation Code ----

const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // No 0/O/1/I confusion

export function generateConfirmationCode(): string {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARSET[bytes[i] % CODE_CHARSET.length]
  }
  return `RES-${code}`
}

// ---- Status Log ----

type StatusLogEntry = {
  status: ReservationStatus
  at: string
  by: string | null
  reason?: string
}

function appendStatusLog(
  currentLog: Prisma.JsonValue | null,
  status: ReservationStatus,
  by: string | null,
  reason?: string,
): StatusLogEntry[] {
  const entries = Array.isArray(currentLog) ? (currentLog as StatusLogEntry[]) : []
  return [
    ...entries,
    {
      status,
      at: new Date().toISOString(),
      by,
      ...(reason ? { reason } : {}),
    },
  ]
}

// ---- P2034 Retry ----

const MAX_RETRIES = 5

export async function withSerializableRetry<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, timeoutMs = 10000): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
      })
    } catch (error: any) {
      if (error.code === 'P2034' && attempt < MAX_RETRIES) {
        logger.warn(`⚠️ [RESERVATION] Serialization conflict, retrying... (attempt ${attempt}/${MAX_RETRIES})`)
        await new Promise(r => setTimeout(r, 50 * Math.pow(2, attempt - 1)))
        continue
      }
      if (error.code === 'P2034') {
        throw new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      }
      throw error
    }
  }
  throw new ConflictError('Conflicto de concurrencia persistente')
}

// ---- Deposit Calculation ----

interface DepositConfig {
  enabled: boolean
  mode: 'none' | 'card_hold' | 'deposit' | 'prepaid'
  percentageOfTotal: number | null
  fixedAmount: number | null
  requiredForPartySizeGte: number | null
}

function calculateDepositAmount(
  config: DepositConfig,
  partySize: number,
  servicePrice?: number | null,
): { required: boolean; amount: Prisma.Decimal | null } {
  if (!config.enabled || config.mode === 'none') {
    return { required: false, amount: null }
  }

  // Check party size threshold
  if (config.requiredForPartySizeGte && partySize < config.requiredForPartySizeGte) {
    return { required: false, amount: null }
  }

  if (config.fixedAmount) {
    return { required: true, amount: new Prisma.Decimal(config.fixedAmount) }
  }

  if (config.percentageOfTotal && servicePrice) {
    const amount = (servicePrice * config.percentageOfTotal) / 100
    return { required: true, amount: new Prisma.Decimal(amount) }
  }

  return { required: false, amount: null }
}

interface ValidatedResources {
  product: { id: string; price: Prisma.Decimal | null; eventCapacity: number | null } | null
}

async function validateResourceOwnership(
  tx: Prisma.TransactionClient,
  venueId: string,
  resources: {
    tableId?: string | null
    productId?: string | null
    assignedStaffId?: string | null
  },
): Promise<ValidatedResources> {
  if (resources.tableId) {
    const table = await tx.table.findFirst({
      where: { id: resources.tableId, venueId },
      select: { id: true },
    })
    if (!table) {
      throw new BadRequestError('La mesa seleccionada no pertenece a este negocio')
    }
  }

  let product: ValidatedResources['product'] = null
  if (resources.productId) {
    product = await tx.product.findFirst({
      where: { id: resources.productId, venueId },
      select: { id: true, price: true, eventCapacity: true },
    })
    if (!product) {
      throw new BadRequestError('El servicio seleccionado no pertenece a este negocio')
    }
  }

  if (resources.assignedStaffId) {
    const staffVenue = await tx.staffVenue.findFirst({
      where: { staffId: resources.assignedStaffId, venueId, active: true },
      select: { id: true },
    })
    if (!staffVenue) {
      throw new BadRequestError('El miembro del equipo seleccionado no pertenece a este negocio')
    }
  }

  return { product }
}

// ---- Core Service Methods ----

export interface CreateReservationInput {
  startsAt: Date
  endsAt: Date
  duration: number
  channel?: ReservationChannel
  customerId?: string
  guestName?: string
  guestPhone?: string
  guestEmail?: string
  partySize?: number
  tableId?: string
  productId?: string
  assignedStaffId?: string
  specialRequests?: string
  internalNotes?: string
  tags?: string[]
}

export async function createReservation(venueId: string, data: CreateReservationInput, createdById?: string, moduleConfig?: any) {
  // Defense-in-depth: validate time invariants at service level
  if (data.endsAt <= data.startsAt) {
    throw new BadRequestError('La fecha de fin debe ser posterior a la fecha de inicio')
  }

  const confirmationCode = generateConfirmationCode()
  const autoConfirm = moduleConfig?.scheduling?.autoConfirm ?? true
  const initialStatus: ReservationStatus = autoConfirm ? 'CONFIRMED' : 'PENDING'
  const requestedPartySize = data.partySize ?? 1

  const reservation = await withSerializableRetry(async tx => {
    const { product } = await validateResourceOwnership(tx, venueId, {
      tableId: data.tableId,
      productId: data.productId,
      assignedStaffId: data.assignedStaffId,
    })

    // Calculate deposit with validated product price (if configured as percentage)
    let depositAmount: Prisma.Decimal | null = null
    let depositStatus: string | null = null
    if (moduleConfig?.deposits) {
      const deposit = calculateDepositAmount(moduleConfig.deposits, requestedPartySize, product?.price ? Number(product.price) : null)
      if (deposit.required && deposit.amount) {
        depositAmount = deposit.amount
        depositStatus = 'PENDING'
      }
    }

    // Layer 1: Check table overlap (FOR UPDATE NOWAIT)
    if (data.tableId) {
      const tableConflicts = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Reservation"
        WHERE "venueId" = ${venueId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND "startsAt" < ${data.endsAt}
        AND "endsAt" > ${data.startsAt}
        AND "tableId" = ${data.tableId}
        FOR UPDATE NOWAIT
      `
      if (tableConflicts.length > 0) {
        throw new ConflictError('Este horario ya esta reservado para esta mesa')
      }
    }

    // Layer 1b: Check staff overlap
    if (data.assignedStaffId) {
      const staffConflicts = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Reservation"
        WHERE "venueId" = ${venueId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND "startsAt" < ${data.endsAt}
        AND "endsAt" > ${data.startsAt}
        AND "assignedStaffId" = ${data.assignedStaffId}
        FOR UPDATE NOWAIT
      `
      if (staffConflicts.length > 0) {
        throw new ConflictError('Este horario ya esta reservado para este miembro del equipo')
      }
    }

    // Layer 3: Product capacity gate
    if (data.productId && product?.eventCapacity) {
      const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
      const effectiveCapacity = Math.floor((product.eventCapacity * onlinePercent) / 100)

      const overlappingProductReservations = await tx.$queryRaw<{ partySize: number }[]>`
          SELECT "partySize"
          FROM "Reservation"
          WHERE "venueId" = ${venueId}
            AND "productId" = ${data.productId}
            AND "startsAt" < ${data.endsAt}
            AND "endsAt" > ${data.startsAt}
            AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          FOR UPDATE
        `

      const occupiedSeats = overlappingProductReservations.reduce((sum, r) => sum + (r.partySize ?? 1), 0)
      if (occupiedSeats + requestedPartySize > effectiveCapacity) {
        throw new ConflictError('No hay espacio disponible para este servicio en el horario seleccionado')
      }
    }

    // Ensure confirmation code is unique within venue
    let finalCode = confirmationCode
    const existing = await tx.reservation.findUnique({
      where: { venueId_confirmationCode: { venueId, confirmationCode: finalCode } },
      select: { id: true },
    })
    if (existing) {
      finalCode = generateConfirmationCode() // Retry once
    }

    const statusLog = appendStatusLog(null, initialStatus, createdById ?? null)

    const reservation = await tx.reservation.create({
      data: {
        venueId,
        confirmationCode: finalCode,
        status: initialStatus,
        channel: data.channel ?? 'DASHBOARD',
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        duration: data.duration,
        customerId: data.customerId,
        guestName: data.guestName,
        guestPhone: data.guestPhone,
        guestEmail: data.guestEmail,
        partySize: requestedPartySize,
        tableId: data.tableId,
        productId: data.productId,
        assignedStaffId: data.assignedStaffId,
        depositAmount,
        depositStatus: depositStatus as any,
        createdById,
        confirmedAt: autoConfirm ? new Date() : null,
        specialRequests: data.specialRequests,
        internalNotes: data.internalNotes,
        tags: data.tags ?? [],
        statusLog,
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        table: { select: { id: true, number: true, capacity: true } },
        product: { select: { id: true, name: true, price: true } },
        assignedStaff: { select: { id: true, firstName: true, lastName: true } },
      },
    })

    logger.info(
      `✅ [RESERVATION] Created ${finalCode} | venue=${venueId} status=${initialStatus} table=${data.tableId ?? 'none'} staff=${data.assignedStaffId ?? 'none'}`,
    )

    return reservation
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'RESERVATION_CREATED',
    entity: 'Reservation',
    entityId: reservation.id,
    data: { status: reservation.status, confirmationCode: reservation.confirmationCode },
  })

  return reservation
}

// ---- List / Get ----

export interface ReservationFilters {
  status?: ReservationStatus | ReservationStatus[]
  dateFrom?: Date
  dateTo?: Date
  tableId?: string
  staffId?: string
  productId?: string
  // Channel accepts single value or array (multi-select)
  channel?: ReservationChannel | ReservationChannel[]
  search?: string // name, phone, confirmation code
}

const RESERVATION_INCLUDE = {
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
  table: { select: { id: true, number: true, capacity: true } },
  product: { select: { id: true, name: true, price: true } },
  assignedStaff: { select: { id: true, firstName: true, lastName: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} as const

export async function getReservations(venueId: string, filters: ReservationFilters, page = 1, pageSize = 50) {
  const where: Prisma.ReservationWhereInput = { venueId }

  if (filters.status) {
    where.status = Array.isArray(filters.status) ? { in: filters.status } : filters.status
  }
  if (filters.dateFrom || filters.dateTo) {
    where.startsAt = {}
    if (filters.dateFrom) where.startsAt.gte = filters.dateFrom
    if (filters.dateTo) where.startsAt.lte = filters.dateTo
  }
  if (filters.tableId) where.tableId = filters.tableId
  if (filters.staffId) where.assignedStaffId = filters.staffId
  if (filters.productId) where.productId = filters.productId
  if (filters.channel) {
    where.channel = Array.isArray(filters.channel) ? { in: filters.channel } : filters.channel
  }
  if (filters.search) {
    where.OR = [
      { guestName: { contains: filters.search, mode: 'insensitive' } },
      { guestPhone: { contains: filters.search } },
      { confirmationCode: { contains: filters.search, mode: 'insensitive' } },
      { customer: { firstName: { contains: filters.search, mode: 'insensitive' } } },
      { customer: { lastName: { contains: filters.search, mode: 'insensitive' } } },
      { customer: { phone: { contains: filters.search } } },
    ]
  }

  const skip = (page - 1) * pageSize

  const [data, total] = await prisma.$transaction([
    prisma.reservation.findMany({
      where,
      include: RESERVATION_INCLUDE,
      orderBy: { startsAt: 'asc' },
      skip,
      take: pageSize,
    }),
    prisma.reservation.count({ where }),
  ])

  return {
    data,
    meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function getReservationById(venueId: string, reservationId: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    include: RESERVATION_INCLUDE,
  })
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')
  return reservation
}

export async function getReservationByCancelSecret(venueId: string, cancelSecret: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { cancelSecret, venue: { slug: venueId } }, // venueId here is actually venueSlug for public routes
    include: {
      table: { select: { id: true, number: true } },
      product: { select: { id: true, name: true, price: true } },
      assignedStaff: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')
  return reservation
}

// ---- Stats ----

export async function getReservationStats(venueId: string, dateFrom: Date, dateTo: Date) {
  const [total, byStatus, byChannel] = await prisma.$transaction([
    prisma.reservation.count({
      where: { venueId, startsAt: { gte: dateFrom, lte: dateTo } },
    }),
    prisma.reservation.groupBy({
      by: ['status'],
      _count: { _all: true },
      orderBy: { status: 'asc' },
      where: { venueId, startsAt: { gte: dateFrom, lte: dateTo } },
    }),
    prisma.reservation.groupBy({
      by: ['channel'],
      _count: { _all: true },
      orderBy: { channel: 'asc' },
      where: { venueId, startsAt: { gte: dateFrom, lte: dateTo } },
    }),
  ])

  const statusMap = Object.fromEntries(byStatus.map(s => [s.status, (s._count as any)?._all ?? 0]))
  const channelMap = Object.fromEntries(byChannel.map(c => [c.channel, (c._count as any)?._all ?? 0]))
  const noShowRate = total > 0 ? ((statusMap['NO_SHOW'] ?? 0) / total) * 100 : 0

  return { total, byStatus: statusMap, byChannel: channelMap, noShowRate: Math.round(noShowRate * 10) / 10 }
}

// ---- State Transition Methods ----

async function transitionReservation(
  venueId: string,
  reservationId: string,
  targetStatus: ReservationStatus,
  by: string | null,
  reason?: string,
  extraData?: Partial<Prisma.ReservationUpdateInput>,
) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
  })
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')

  validateTransition(reservation.status, targetStatus)

  const statusLog = appendStatusLog(reservation.statusLog, targetStatus, by, reason)

  const timestampField: Record<string, string> = {
    CONFIRMED: 'confirmedAt',
    CHECKED_IN: 'checkedInAt',
    COMPLETED: 'completedAt',
    CANCELLED: 'cancelledAt',
    NO_SHOW: 'noShowAt',
  }

  const updateData: Prisma.ReservationUpdateInput = {
    status: targetStatus,
    statusLog,
    ...(timestampField[targetStatus] ? { [timestampField[targetStatus]]: new Date() } : {}),
    ...extraData,
  }

  // RACE GUARD: only update if the row is still in the source status we just read.
  // Two concurrent cancel requests would both pass validateTransition above (since
  // they both saw `CONFIRMED`), then both run the unguarded `update`, both succeed,
  // both fire downstream side-effects (refund, notifications). The conditional
  // updateMany makes exactly one of them succeed (rowsAffected=1) and the rest get
  // rowsAffected=0 → we throw the same error the validator would.
  const guarded = await prisma.reservation.updateMany({
    where: { id: reservationId, status: reservation.status },
    data: updateData as any, // updateMany accepts the same scalar fields as update
  })
  if (guarded.count === 0) {
    throw new BadRequestError('La reservacion ya fue modificada por otro proceso. Recarga e intenta de nuevo.')
  }

  const updated = await prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: RESERVATION_INCLUDE,
  })

  logger.info(`✅ [RESERVATION] ${reservation.confirmationCode} transitioned ${reservation.status} → ${targetStatus} by=${by ?? 'system'}`)

  const STATUS_TO_ACTION: Partial<Record<ReservationStatus, string>> = {
    CONFIRMED: 'RESERVATION_CONFIRMED',
    CHECKED_IN: 'RESERVATION_CHECKED_IN',
    COMPLETED: 'RESERVATION_COMPLETED',
    NO_SHOW: 'RESERVATION_NO_SHOW',
    CANCELLED: 'RESERVATION_CANCELLED',
  }
  const logActionName = STATUS_TO_ACTION[targetStatus]
  if (logActionName) {
    logAction({
      staffId: by ?? undefined,
      venueId,
      action: logActionName,
      entity: 'Reservation',
      entityId: updated.id,
      data: { status: updated.status, confirmationCode: updated.confirmationCode },
    })
  }

  return updated
}

export async function confirmReservation(venueId: string, reservationId: string, confirmedById: string) {
  return transitionReservation(venueId, reservationId, 'CONFIRMED', confirmedById)
}

export async function checkInReservation(venueId: string, reservationId: string, checkedInBy: string) {
  return transitionReservation(venueId, reservationId, 'CHECKED_IN', checkedInBy)
}

export async function completeReservation(venueId: string, reservationId: string) {
  return transitionReservation(venueId, reservationId, 'COMPLETED', null)
}

export async function markNoShow(venueId: string, reservationId: string, markedBy: string) {
  const updated = await transitionReservation(venueId, reservationId, 'NO_SHOW', markedBy)

  // Optional: refund credits on no-show if the venue policy says so.
  try {
    const settings = await getReservationSettings(venueId)
    if (settings.cancellation.creditNoShowRefund) {
      const creditPackService = await import('./creditPack.public.service')
      await creditPackService.refundCreditsForReservation({
        venueId,
        reservationId: updated.id,
        startsAt: updated.startsAt,
        // ALWAYS so noShow refund is full when the toggle is on
        policy: { creditRefundMode: 'ALWAYS', creditFreeRefundHoursBefore: 0, creditLateRefundPercent: 100 },
        reasonPrefix: 'No-show refund',
      })
    }
  } catch (err) {
    logger.error(`❌ [CREDIT REFUND] No-show refund failed for ${updated.confirmationCode}`, err)
  }

  return updated
}

export async function cancelReservation(
  venueId: string,
  reservationId: string,
  cancelledBy: string, // Staff ID, "CUSTOMER", or "SYSTEM"
  reason?: string,
) {
  const updated = await transitionReservation(venueId, reservationId, 'CANCELLED', cancelledBy, reason, {
    cancelledBy,
    cancellationReason: reason,
  })

  // Apply venue cancellation policy: refund credits if applicable.
  // Wrapped in try/catch — a refund failure must never block the cancellation itself
  // (the reservation IS cancelled regardless; refund is a best-effort follow-up).
  let refundResult: { creditsRefunded: number; policyApplied: string } = {
    creditsRefunded: 0,
    policyApplied: 'no-credits-used',
  }
  try {
    const settings = await getReservationSettings(venueId)
    const creditPackService = await import('./creditPack.public.service')
    refundResult = await creditPackService.refundCreditsForReservation({
      venueId,
      reservationId: updated.id,
      startsAt: updated.startsAt,
      policy: {
        creditRefundMode: settings.cancellation.creditRefundMode,
        creditFreeRefundHoursBefore: settings.cancellation.creditFreeRefundHoursBefore,
        creditLateRefundPercent: settings.cancellation.creditLateRefundPercent,
      },
      reasonPrefix: cancelledBy === 'CUSTOMER' ? 'Customer cancellation' : 'Staff cancellation',
    })
  } catch (err) {
    logger.error(`❌ [CREDIT REFUND] Failed for reservation ${updated.confirmationCode}`, err)
  }

  return Object.assign(updated, refundResult)
}

// ---- Update ----

export interface UpdateReservationInput {
  startsAt?: Date
  endsAt?: Date
  duration?: number
  guestName?: string
  guestPhone?: string
  guestEmail?: string | null
  partySize?: number
  tableId?: string | null
  productId?: string | null
  assignedStaffId?: string | null
  specialRequests?: string | null
  internalNotes?: string | null
  tags?: string[]
}

export async function updateReservation(
  venueId: string,
  reservationId: string,
  data: UpdateReservationInput,
  updatedById: string,
  moduleConfig?: any,
) {
  const updated = await withSerializableRetry(async tx => {
    const reservation = await tx.reservation.findFirst({
      where: { id: reservationId, venueId },
    })
    if (!reservation) throw new NotFoundError('Reservacion no encontrada')

    // Only allow updates on PENDING or CONFIRMED reservations
    if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) {
      throw new BadRequestError(`No se puede modificar una reservacion con estado ${reservation.status}`)
    }

    const newStartsAt = data.startsAt ?? reservation.startsAt
    const newEndsAt = data.endsAt ?? reservation.endsAt
    const newTableId = data.tableId !== undefined ? data.tableId : reservation.tableId
    const newStaffId = data.assignedStaffId !== undefined ? data.assignedStaffId : reservation.assignedStaffId
    const newProductId = data.productId !== undefined ? data.productId : reservation.productId
    const newPartySize = data.partySize ?? reservation.partySize

    if (newEndsAt <= newStartsAt) {
      throw new BadRequestError('La fecha de fin debe ser posterior a la fecha de inicio')
    }

    const calculatedDuration = Math.round((newEndsAt.getTime() - newStartsAt.getTime()) / 60000)
    if (data.duration !== undefined && Math.abs(calculatedDuration - data.duration) > 1) {
      throw new BadRequestError('La duracion no coincide con el rango de fechas')
    }
    const finalDuration =
      data.duration !== undefined
        ? data.duration
        : data.startsAt !== undefined || data.endsAt !== undefined
          ? calculatedDuration
          : reservation.duration

    const { product } = await validateResourceOwnership(tx, venueId, {
      tableId: newTableId,
      productId: newProductId,
      assignedStaffId: newStaffId,
    })

    if (newTableId) {
      const tableConflicts = await tx.$queryRaw<{ id: string; confirmationCode: string }[]>`
        SELECT id, "confirmationCode"
        FROM "Reservation"
        WHERE "venueId" = ${venueId}
          AND "tableId" = ${newTableId}
          AND id <> ${reservationId}
          AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND "startsAt" < ${newEndsAt}
          AND "endsAt" > ${newStartsAt}
        FOR UPDATE NOWAIT
      `
      if (tableConflicts.length > 0) {
        throw new ConflictError(`Mesa tiene conflicto con reservacion ${tableConflicts[0].confirmationCode}`)
      }
    }

    if (newStaffId) {
      const staffConflicts = await tx.$queryRaw<{ id: string; confirmationCode: string }[]>`
        SELECT id, "confirmationCode"
        FROM "Reservation"
        WHERE "venueId" = ${venueId}
          AND "assignedStaffId" = ${newStaffId}
          AND id <> ${reservationId}
          AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND "startsAt" < ${newEndsAt}
          AND "endsAt" > ${newStartsAt}
        FOR UPDATE NOWAIT
      `
      if (staffConflicts.length > 0) {
        throw new ConflictError(`Staff tiene conflicto con reservacion ${staffConflicts[0].confirmationCode}`)
      }
    }

    if (newProductId && product?.eventCapacity) {
      const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
      const effectiveCapacity = Math.floor((product.eventCapacity * onlinePercent) / 100)

      const overlappingProductReservations = await tx.$queryRaw<{ partySize: number }[]>`
        SELECT "partySize"
        FROM "Reservation"
        WHERE "venueId" = ${venueId}
          AND "productId" = ${newProductId}
          AND id <> ${reservationId}
          AND "startsAt" < ${newEndsAt}
          AND "endsAt" > ${newStartsAt}
          AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        FOR UPDATE
      `
      const occupiedSeats = overlappingProductReservations.reduce((sum, r) => sum + (r.partySize ?? 1), 0)

      if (occupiedSeats + newPartySize > effectiveCapacity) {
        throw new ConflictError('No hay espacio disponible para este servicio en el horario seleccionado')
      }
    }

    const updated = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
        ...(data.endsAt !== undefined && { endsAt: data.endsAt }),
        duration: finalDuration,
        ...(data.guestName !== undefined && { guestName: data.guestName }),
        ...(data.guestPhone !== undefined && { guestPhone: data.guestPhone }),
        ...(data.guestEmail !== undefined && { guestEmail: data.guestEmail }),
        ...(data.partySize !== undefined && { partySize: data.partySize }),
        ...(data.tableId !== undefined && { tableId: data.tableId }),
        ...(data.productId !== undefined && { productId: data.productId }),
        ...(data.assignedStaffId !== undefined && { assignedStaffId: data.assignedStaffId }),
        ...(data.specialRequests !== undefined && { specialRequests: data.specialRequests }),
        ...(data.internalNotes !== undefined && { internalNotes: data.internalNotes }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
      include: RESERVATION_INCLUDE,
    })

    logger.info(`✅ [RESERVATION] Updated ${reservation.confirmationCode} by=${updatedById}`)

    return updated
  })

  logAction({
    staffId: updatedById,
    venueId,
    action: 'RESERVATION_UPDATED',
    entity: 'Reservation',
    entityId: updated.id,
    data: { confirmationCode: updated.confirmationCode },
  })

  return updated
}

// ---- Reschedule ----

export type RescheduleNotification = {
  notificationChannel?: 'push' | 'whatsapp' | 'email' | 'sms' | 'none'
  customMessage?: string
}

export async function rescheduleReservation(
  venueId: string,
  reservationId: string,
  newStartsAt: Date,
  newEndsAt: Date,
  rescheduledBy: string,
  moduleConfig?: any,
  notification?: RescheduleNotification,
) {
  const duration = Math.round((newEndsAt.getTime() - newStartsAt.getTime()) / 60000)

  // Capture pre-update snapshot so we can show "old → new" in notifications and
  // pull venue/customer fields without a second round-trip after the update.
  const original = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    include: {
      customer: { select: { firstName: true, lastName: true, phone: true, email: true } },
      product: { select: { name: true } },
      venue: { select: { name: true, timezone: true } },
    },
  })
  if (!original) throw new NotFoundError('Reservacion no encontrada')
  const originalStartsAt = original.startsAt

  const rescheduled = await updateReservation(
    venueId,
    reservationId,
    { startsAt: newStartsAt, endsAt: newEndsAt, duration },
    rescheduledBy,
    moduleConfig,
  )

  const channel = notification?.notificationChannel
  if (channel && channel !== 'none' && channel !== 'push') {
    const customerName =
      [original.customer?.firstName, original.customer?.lastName].filter(Boolean).join(' ').trim() || rescheduled.guestName || 'cliente'
    const phone = original.customer?.phone || rescheduled.guestPhone
    const email = original.customer?.email || rescheduled.guestEmail
    const venueName = original.venue?.name || 'Avoqado'
    const tz = original.venue?.timezone || 'America/Mexico_City'

    const formatDate = (d: Date) =>
      new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(d)
    const formatTime = (d: Date) =>
      new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d)

    if (channel === 'whatsapp') {
      if (phone) {
        try {
          await sendReservationRescheduleWhatsApp(phone, {
            customerName,
            venueName,
            date: formatDate(newStartsAt),
            time: formatTime(newStartsAt),
            message: notification?.customMessage,
          })
          logger.info(`✅ [RESERVATION] WhatsApp reschedule sent for ${rescheduled.confirmationCode} → ${phone}`)
        } catch (err) {
          logger.error(`❌ [RESERVATION] WhatsApp reschedule failed for ${rescheduled.confirmationCode}: ${(err as Error).message}`)
        }
      } else {
        logger.warn(`[RESERVATION] WhatsApp reschedule requested for ${rescheduled.confirmationCode} but customer has no phone — skipped`)
      }
    } else if (channel === 'email') {
      if (email) {
        try {
          await emailService.sendReservationRescheduledEmail(email, {
            customerName,
            venueName,
            serviceName: original.product?.name,
            oldDateTime: `${formatDate(originalStartsAt)}, ${formatTime(originalStartsAt)}`,
            newDateTime: `${formatDate(newStartsAt)}, ${formatTime(newStartsAt)}`,
            confirmationCode: rescheduled.confirmationCode,
            customMessage: notification?.customMessage,
          })
          logger.info(`✅ [RESERVATION] Email reschedule sent for ${rescheduled.confirmationCode} → ${email}`)
        } catch (err) {
          logger.error(`❌ [RESERVATION] Email reschedule failed for ${rescheduled.confirmationCode}: ${(err as Error).message}`)
        }
      } else {
        logger.warn(`[RESERVATION] Email reschedule requested for ${rescheduled.confirmationCode} but customer has no email — skipped`)
      }
    } else if (channel === 'sms') {
      logger.warn(`[RESERVATION] SMS reschedule requested for ${rescheduled.confirmationCode} but SMS infra is not configured — skipped`)
    }
  }

  logAction({
    staffId: rescheduledBy,
    venueId,
    action: 'RESERVATION_RESCHEDULED',
    entity: 'Reservation',
    entityId: rescheduled.id,
    data: {
      startsAt: newStartsAt,
      endsAt: newEndsAt,
      confirmationCode: rescheduled.confirmationCode,
      notificationChannel: channel ?? null,
      customMessage: notification?.customMessage ?? null,
    },
  })

  return rescheduled
}

// ---- Class Reservation Reschedule (public-facing) ----

/**
 * Move a class reservation to a different ClassSession of the SAME product.
 *
 * "Same product only" by design (v1):
 *   - No credit refund/redeem — the same N credits stay attached to the same product.
 *   - No price diff to settle.
 *   - Mirrors the Mindbody/ClassPass default behaviour.
 *
 * Atomic via serializable transaction + capacity check + the same race-guarded updateMany
 * we use for cancel transitions, so two simultaneous reschedule requests can't double-book.
 *
 * Spot collision: if the product has a layout and `newSpotIds` is provided, we validate
 * against the layout AND against currently active reservations on the new session.
 */
export async function rescheduleClassReservation(args: {
  venueId: string
  reservationId: string
  newClassSessionId: string
  newSpotIds?: string[]
  rescheduledBy: string // 'CUSTOMER' or staff id
  reason?: string
}) {
  const { venueId, reservationId, newClassSessionId, rescheduledBy, reason } = args
  const requestedSpotIds = args.newSpotIds ?? []

  return withSerializableRetry(async tx => {
    // 1. Load + validate the existing reservation
    const reservation = await tx.reservation.findFirst({
      where: { id: reservationId, venueId },
    })
    if (!reservation) throw new NotFoundError('Reservacion no encontrada')
    if (!reservation.classSessionId) {
      throw new BadRequestError('Solo puedes cambiar el horario de una reserva de clase')
    }
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
      throw new BadRequestError(`No puedes cambiar el horario de una reserva ${reservation.status}`)
    }

    // 2. No-op: same session — return as-is
    if (reservation.classSessionId === newClassSessionId) {
      return tx.reservation.findUniqueOrThrow({
        where: { id: reservationId },
        include: RESERVATION_INCLUDE,
      })
    }

    // 3. Lock the NEW session row so capacity math is consistent under contention
    const newSessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${newClassSessionId} AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (newSessions.length === 0) throw new NotFoundError('La nueva sesion no existe')
    const newSession = newSessions[0]
    if (newSession.status !== 'SCHEDULED') {
      throw new BadRequestError('Esta sesion ya no acepta reservaciones')
    }

    // 4. v1: same product only. Cross-class swap would require credit refund/redeem.
    if (newSession.productId !== reservation.productId) {
      throw new BadRequestError('Solo puedes cambiar a otro horario de la misma clase. Para cambiar de clase, cancela y reserva de nuevo.')
    }

    // 5. Capacity in the new session must accommodate this party — and we must NOT count
    //    our own reservation if it had previously been reserved in the same target session
    //    (defensive: technically we'd return at step 2, but kept for safety).
    const enrolledResult = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("partySize"), 0) AS total
      FROM "Reservation"
      WHERE "classSessionId" = ${newClassSessionId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND id <> ${reservationId}
    `
    const enrolled = Number(enrolledResult[0].total)
    if (enrolled + reservation.partySize > newSession.capacity) {
      throw new ConflictError(
        `No hay cupo en el nuevo horario. Disponibles: ${newSession.capacity - enrolled}, necesitas: ${reservation.partySize}`,
      )
    }

    // 6. Spot validation if the product has a layout and the user picked specific spots
    if (requestedSpotIds.length > 0) {
      const product = await tx.product.findFirst({
        where: { id: reservation.productId!, venueId },
        select: { layoutConfig: true },
      })
      const layout = product?.layoutConfig as { spots?: { id: string; enabled: boolean }[] } | null
      if (layout?.spots) {
        const validSpotIds = new Set(layout.spots.filter(s => s.enabled).map(s => s.id))
        for (const spotId of requestedSpotIds) {
          if (!validSpotIds.has(spotId)) {
            throw new BadRequestError(`Lugar "${spotId}" no es valido`)
          }
        }
      }
      const taken = await tx.reservation.findMany({
        where: {
          classSessionId: newClassSessionId,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          id: { not: reservationId },
          spotIds: { hasSome: requestedSpotIds },
        },
        select: { spotIds: true },
      })
      if (taken.length > 0) {
        const conflicts = taken.flatMap(r => r.spotIds).filter(id => requestedSpotIds.includes(id))
        throw new ConflictError(`Los lugares ${conflicts.join(', ')} ya estan reservados`)
      }
    }

    const newDuration = Math.round((newSession.endsAt.getTime() - newSession.startsAt.getTime()) / 60000)
    const statusLog = appendStatusLog(reservation.statusLog, reservation.status, rescheduledBy, reason ?? 'Reservation rescheduled')

    // 7. Race-guarded update: only proceed if status hasn't changed under us.
    const guarded = await tx.reservation.updateMany({
      where: { id: reservationId, status: reservation.status, classSessionId: reservation.classSessionId },
      data: {
        classSessionId: newClassSessionId,
        startsAt: newSession.startsAt,
        endsAt: newSession.endsAt,
        duration: newDuration,
        spotIds: requestedSpotIds.length > 0 ? requestedSpotIds : reservation.spotIds,
        statusLog,
      },
    })
    if (guarded.count === 0) {
      throw new BadRequestError('La reservacion ya fue modificada por otro proceso. Recarga e intenta de nuevo.')
    }

    const updated = await tx.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: RESERVATION_INCLUDE,
    })

    logger.info(`🔄 [RESCHEDULE] ${updated.confirmationCode} ${reservation.classSessionId} → ${newClassSessionId} by=${rescheduledBy}`)
    logAction({
      staffId: rescheduledBy === 'CUSTOMER' ? undefined : rescheduledBy,
      venueId,
      action: 'RESERVATION_RESCHEDULED',
      entity: 'Reservation',
      entityId: updated.id,
      data: {
        confirmationCode: updated.confirmationCode,
        from: reservation.classSessionId,
        to: newClassSessionId,
        by: rescheduledBy,
      },
    })

    return updated
  })
}

// ---- Calendar View ----

export async function getReservationsCalendar(venueId: string, dateFrom: Date, dateTo: Date, groupBy?: 'table' | 'staff') {
  const reservations = await prisma.reservation.findMany({
    where: {
      venueId,
      startsAt: { gte: dateFrom, lte: dateTo },
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
    },
    include: RESERVATION_INCLUDE,
    orderBy: { startsAt: 'asc' },
  })

  if (!groupBy) return { reservations }

  const grouped: Record<string, typeof reservations> = {}
  for (const r of reservations) {
    const key = groupBy === 'table' ? (r.tableId ?? 'unassigned') : (r.assignedStaffId ?? 'unassigned')
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(r)
  }

  return { reservations, grouped }
}

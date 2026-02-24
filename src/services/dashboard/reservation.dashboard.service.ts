import crypto from 'crypto'
import { Prisma, ReservationStatus, ReservationChannel } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

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

  return withSerializableRetry(async tx => {
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
}

// ---- List / Get ----

export interface ReservationFilters {
  status?: ReservationStatus | ReservationStatus[]
  dateFrom?: Date
  dateTo?: Date
  tableId?: string
  staffId?: string
  productId?: string
  channel?: ReservationChannel
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
  if (filters.channel) where.channel = filters.channel
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

  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: updateData,
    include: RESERVATION_INCLUDE,
  })

  logger.info(`✅ [RESERVATION] ${reservation.confirmationCode} transitioned ${reservation.status} → ${targetStatus} by=${by ?? 'system'}`)

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
  return transitionReservation(venueId, reservationId, 'NO_SHOW', markedBy)
}

export async function cancelReservation(
  venueId: string,
  reservationId: string,
  cancelledBy: string, // Staff ID, "CUSTOMER", or "SYSTEM"
  reason?: string,
) {
  return transitionReservation(venueId, reservationId, 'CANCELLED', cancelledBy, reason, {
    cancelledBy,
    cancellationReason: reason,
  })
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
  return withSerializableRetry(async tx => {
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
}

// ---- Reschedule ----

export async function rescheduleReservation(
  venueId: string,
  reservationId: string,
  newStartsAt: Date,
  newEndsAt: Date,
  rescheduledBy: string,
  moduleConfig?: any,
) {
  const duration = Math.round((newEndsAt.getTime() - newStartsAt.getTime()) / 60000)

  return updateReservation(venueId, reservationId, { startsAt: newStartsAt, endsAt: newEndsAt, duration }, rescheduledBy, moduleConfig)
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

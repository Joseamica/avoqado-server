import crypto from 'crypto'
import { Prisma, ReservationStatus, ReservationChannel } from '@prisma/client'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from './activity-log.service'
import { getReservationSettings, isStaffAware, type ReservationConfig } from './reservationSettings.service'
import { countAppointmentOccupancy, effectiveAppointmentPacing } from './reservationAvailability.service'
import { sendReservationRescheduleWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
import { getProvider } from '../payments/provider-registry'
import { checkExternalBusyBlock } from '../reservation/external-busy-block.service'
import { resolveModifierSelections, type ResolvedModifierRow } from '@/services/reservation/resolveModifierSelections'
import { createOrderFromReservation } from '@/services/reservation/createOrderFromReservation'
import {
  buildSyncKey,
  collapseSupersededOps,
  enqueuePush,
  resolveClassSessionPushTargets,
  resolveReservationPushTargets,
} from '@/services/google-calendar/outbox.service'
import { publishPushNotification } from '@/communication/rabbitmq/gcal-push-consumer'
import { withSerializableRetry } from '@/utils/serializableRetry'
import {
  assertLegacyAppointmentDurationFloor,
  normalizeBookedProductIds,
  reservationBookedProductIds,
  resolveAppointmentWindow,
} from '@/services/reservation/resolveAppointmentWindow'
import {
  assertLegacyStaffEligible,
  assertOrganizationStaffAvailability,
  assertStaffEligible,
  assertStaffEligibleForPersistedProducts,
  lockAppointmentVenue,
  resolveStaffAssignment,
  shouldAutoAssign,
} from './appointmentStaffAssignment.service'
import { enforceBookingWindow } from '@/services/reservation/bookingWindow.service'
import {
  lockAndValidateNormalAppointmentHold,
  lockAndValidateRescheduleAppointmentHold,
  lockReservationForReschedule,
  lockTaggedRescheduleSiblings,
} from '@/services/reservation/appointmentSlotHold.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

export { enforceBookingWindow } from '@/services/reservation/bookingWindow.service'
// creditPack.public.service is imported lazily inside cancelReservation/markNoShow.

// ==========================================
// RESERVATION SERVICE — Core CRUD + State Machine
// ==========================================

// ---- State Machine ----

// PENDING → NO_SHOW is allowed: the auto-no-show worker (and dashboard staff) need
// to be able to mark a reservation as no-show even when it never advanced past
// PENDING — e.g. autoConfirm=false venues where staff never confirmed, or deposit-
// required reservations where the customer never paid. In both cases the customer
// didn't arrive, which is the business definition of "no-show". The no-show fee
// path in the job (depositStatus='PAID'-gated) prevents accidental fee capture
// on unpaid PENDING reservations.
const VALID_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
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

// ---- Deposit Calculation ----

interface DepositConfig {
  enabled: boolean
  mode: 'none' | 'card_hold' | 'deposit' | 'prepaid'
  percentageOfTotal: number | null
  fixedAmount: number | null
  requiredForPartySizeGte: number | null
}

export function calculateDepositAmount(
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
  product: { id: string; price: Prisma.Decimal | null; eventCapacity: number | null; type?: string } | null
  products: { id: string; price: Prisma.Decimal | null; eventCapacity: number | null; type?: string }[]
}

async function validateResourceOwnership(
  tx: Prisma.TransactionClient,
  venueId: string,
  resources: {
    tableId?: string | null
    productId?: string | null
    bookedProductIds?: string[]
    leadProductId?: string
    productIdsWasProvided?: boolean
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

  let products: ValidatedResources['products'] = []
  let product: ValidatedResources['product'] = null
  const bookedProductIds = resources.bookedProductIds ?? []
  const leadProductId = resources.leadProductId ?? resources.productId ?? undefined
  if (resources.productIdsWasProvided && bookedProductIds.length > 0) {
    products = await tx.product.findMany({
      where: { id: { in: bookedProductIds }, venueId },
      select: { id: true, price: true, eventCapacity: true, type: true },
    })
    if (products.length !== bookedProductIds.length) {
      throw new BadRequestError('Uno o más servicios seleccionados no pertenecen a este negocio')
    }
    if (products.some(selected => selected.type === 'CLASS')) {
      throw new BadRequestError('Los productos de tipo clase usan classSessionId, no productIds')
    }
    const byId = new Map(products.map(selected => [selected.id, selected]))
    product = leadProductId ? (byId.get(leadProductId) ?? null) : null
  } else if (leadProductId) {
    product = await tx.product.findFirst({
      where: { id: leadProductId, venueId },
      select: { id: true, price: true, eventCapacity: true, type: true },
    })
    if (!product) {
      throw new BadRequestError('El servicio seleccionado no pertenece a este negocio')
    }
    products = [product]
  }

  return { product, products }
}

async function validateLegacyStaffMembership(
  tx: Prisma.TransactionClient,
  venueId: string,
  staffId: string,
): Promise<{ organizationId: string }> {
  const staffVenue = await tx.staffVenue.findFirst({
    where: { staffId, venueId, active: true, staff: { active: true } },
    select: { venue: { select: { organizationId: true } } },
  })
  if (!staffVenue) {
    throw new BadRequestError('El miembro del equipo seleccionado no pertenece a este negocio')
  }
  return { organizationId: staffVenue.venue.organizationId }
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
  productIds?: string | string[]
  assignedStaffId?: string
  specialRequests?: string
  internalNotes?: string
  tags?: string[]
  modifierSelections?: { productId: string; modifierId: string; quantity?: number }[]
}

export type WriteOrigin = 'PUBLIC' | 'CONSUMER' | 'DASHBOARD' | 'MCP'

export interface ReservationWriteContext {
  writeOrigin: WriteOrigin
  allowOverCapacity?: boolean
  windowSemantics?: 'base'
  /** Tenant/live-preflighted candidate token; all identity and authorization is repeated under row lock. */
  appointmentHoldId?: string
  /**
   * Trusted server-derived bridge for the public payment preflight. It may
   * replace deposits only; scheduling and every other policy remain bound to
   * the settings row read in the current transaction attempt.
   */
  paymentPolicyOverride?: {
    deposits: ReservationConfig['deposits']
  }
}

/**
 * Enforce booking-window settings (`maxAdvanceDays`, `minNoticeMin`) from
 * ReservationSettings. Throws ValidationError (422) when the requested start
 * falls outside the allowed window. Null/undefined values short-circuit so
 * unconfigured policies stay permissive.
 *
 * Math is timezone-agnostic: both `now` and `startsAt` are UTC instants, and
 * "X days from now" / "X minutes from now" are absolute offsets, so we don't
 * need the venue timezone here — only date-of-day comparisons would.
 */
export async function createReservation(
  venueId: string,
  data: CreateReservationInput,
  context: ReservationWriteContext,
  createdById?: string,
) {
  const {
    productIds: bookedProductIds,
    leadProductId,
    productIdsWasProvided,
  } = normalizeBookedProductIds({ productId: data.productId, productIds: data.productIds })

  // Defense-in-depth: validate time invariants at service level
  if (data.endsAt <= data.startsAt) {
    throw new BadRequestError('La fecha de fin debe ser posterior a la fecha de inicio')
  }
  if (context.windowSemantics !== 'base' && (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 480)) {
    throw new BadRequestError('La duración debe estar entre 1 y 480 minutos')
  }

  const confirmationCode = generateConfirmationCode()
  const requestedPartySize = data.partySize ?? 1
  const depositIdempotencyKey = `reservation:${crypto.randomUUID()}:deposit:v1`

  const reservation = await withSerializableRetry(async tx => {
    const persistedSettings = await getReservationSettings(venueId, tx)
    const settings: ReservationConfig =
      context.writeOrigin === 'PUBLIC' && context.paymentPolicyOverride
        ? { ...persistedSettings, deposits: context.paymentPolicyOverride.deposits }
        : persistedSettings

    // WALK_IN está EXENTO: la persona ya está parada en el mostrador — exigirle
    // "N minutos de anticipación" (o rechazar que empezó hace unos minutos)
    // hacía imposible registrar walk-ins con aviso mínimo configurado.
    if (data.channel !== 'WALK_IN') {
      enforceBookingWindow(data.startsAt, settings.scheduling)
    }

    const autoConfirm = settings.scheduling.autoConfirm
    const { product, products } = await validateResourceOwnership(tx, venueId, {
      tableId: data.tableId,
      bookedProductIds,
      leadProductId,
      productIdsWasProvided,
    })
    const isAppointment =
      bookedProductIds.length > 0 &&
      products.length === bookedProductIds.length &&
      products.every(selected => selected.type === 'APPOINTMENTS_SERVICE')
    if (context.appointmentHoldId && !isAppointment) {
      throw new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.')
    }

    let modifierRows: ResolvedModifierRow[]
    let modifierDelta: Prisma.Decimal
    let finalEndsAt: Date
    let finalDuration: number

    if (context.windowSemantics === 'base') {
      const resolvedWindow = await resolveAppointmentWindow(tx, {
        venueId,
        productIds: bookedProductIds,
        startsAt: data.startsAt,
        baseEndsAt: data.endsAt,
        modifierSelections: data.modifierSelections ?? [],
        settings,
      })
      modifierRows = resolvedWindow.modifierRows
      modifierDelta = resolvedWindow.modifierPriceDelta
      finalEndsAt = resolvedWindow.finalEndsAt
      finalDuration = resolvedWindow.finalDurationMin
    } else {
      if (isAppointment && isStaffAware(settings)) {
        const rawIntervalDurationMin = (data.endsAt.getTime() - data.startsAt.getTime()) / 60_000
        await assertLegacyAppointmentDurationFloor(tx, {
          venueId,
          productIds: bookedProductIds,
          rawDurationMin: Math.min(data.duration, rawIntervalDurationMin),
          settings,
        })
      }

      const modifiers = await resolveModifierSelections(tx, bookedProductIds, data.modifierSelections ?? [])
      modifierRows = modifiers.persistRows
      modifierDelta = modifiers.totalDelta
      finalDuration = data.duration + modifiers.totalDurationDelta
      if (!Number.isInteger(finalDuration) || finalDuration < 1 || finalDuration > 1_440) {
        throw new BadRequestError('La duración final debe estar entre 1 y 1440 minutos')
      }
      finalEndsAt =
        modifiers.totalDurationDelta === 0 ? data.endsAt : new Date(data.endsAt.getTime() + modifiers.totalDurationDelta * 60_000)
    }

    let effectiveAssignedStaffId = data.assignedStaffId ?? null
    let overCapacity = false
    const selfServiceStaffSelection = context.writeOrigin === 'PUBLIC' || context.writeOrigin === 'CONSUMER'
    let consumedAppointmentHoldId: string | null = null

    if (isAppointment) {
      // The final appointment window is read-only-resolved above. From this
      // point onward every authorizing conflict/count/write is serialized by
      // the same venue-scoped advisory lock and post-lock clock.
      await lockAppointmentVenue(tx, venueId)
      const staffAware = isStaffAware(settings)
      const requestedStaffWasProvided = data.assignedStaffId !== undefined
      const lockedHold = context.appointmentHoldId
        ? await lockAndValidateNormalAppointmentHold(tx, {
            venueId,
            holdId: context.appointmentHoldId,
            startsAt: data.startsAt,
            rawEndsAt: data.endsAt,
            finalEndsAt,
            productIds: bookedProductIds,
            requestedStaffId: data.assignedStaffId,
            requestedStaffWasProvided,
            windowSemantics: context.windowSemantics,
          })
        : null
      const checkedAt = lockedHold?.checkedAt ?? new Date()
      if (lockedHold) {
        consumedAppointmentHoldId = lockedHold.id
        effectiveAssignedStaffId = requestedStaffWasProvided ? (data.assignedStaffId ?? null) : lockedHold.staffId
      }

      if (selfServiceStaffSelection && effectiveAssignedStaffId && settings.publicBooking.showStaffPicker !== true && !lockedHold) {
        throw new BadRequestError('La selección de profesionista no está habilitada para este negocio')
      }

      if (lockedHold && (staffAware || lockedHold.staffId !== null)) {
        if (!effectiveAssignedStaffId) {
          throw new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.')
        }
        await assertStaffEligible(tx, {
          venueId,
          staffId: effectiveAssignedStaffId,
          productIds: bookedProductIds,
          startsAt: data.startsAt,
          endsAt: finalEndsAt,
          checkedAt,
          settings,
          excludeHoldId: lockedHold.id,
        })
      } else if (!lockedHold && staffAware && (effectiveAssignedStaffId || shouldAutoAssign(true, settings))) {
        effectiveAssignedStaffId = await resolveStaffAssignment(tx, {
          venueId,
          productIds: bookedProductIds,
          startsAt: data.startsAt,
          endsAt: finalEndsAt,
          checkedAt,
          settings,
          requestedStaffId: effectiveAssignedStaffId ?? undefined,
          excludeHoldId: undefined,
        })
      } else if (!lockedHold && effectiveAssignedStaffId) {
        const membership = await validateLegacyStaffMembership(tx, venueId, effectiveAssignedStaffId)
        await assertOrganizationStaffAvailability(tx, {
          organizationId: membership.organizationId,
          staffId: effectiveAssignedStaffId,
          startsAt: data.startsAt,
          endsAt: finalEndsAt,
          checkedAt,
          excludeHoldId: undefined,
        })
      }

      const globalLimit = staffAware
        ? (settings.scheduling.pacingMaxPerSlot ?? null)
        : context.writeOrigin === 'DASHBOARD'
          ? null
          : effectiveAppointmentPacing(settings.scheduling.pacingMaxPerSlot)

      if (!lockedHold && globalLimit !== null) {
        const { reservations, holds } = await countAppointmentOccupancy(tx, {
          venueId,
          startsAt: data.startsAt,
          endsAt: finalEndsAt,
          checkedAt,
        })
        const occupancy = reservations + holds
        if (occupancy >= globalLimit) {
          if (staffAware && context.writeOrigin === 'DASHBOARD') {
            if (!context.allowOverCapacity) {
              throw new ConflictError('El horario está lleno. Confirma si deseas sobre-agendar.', 'OVER_CAPACITY_CONFIRMATION_REQUIRED', {
                preview: { startsAt: data.startsAt, endsAt: finalEndsAt, occupancy, limit: globalLimit },
              })
            }
            overCapacity = true
          } else {
            throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
          }
        }
      }
    } else if (effectiveAssignedStaffId) {
      if (selfServiceStaffSelection && settings.publicBooking.showStaffPicker !== true) {
        throw new BadRequestError('La selección de profesionista no está habilitada para este negocio')
      }
      const checkedAt = new Date()
      const membership = await validateLegacyStaffMembership(tx, venueId, effectiveAssignedStaffId)
      await assertOrganizationStaffAvailability(tx, {
        organizationId: membership.organizationId,
        staffId: effectiveAssignedStaffId,
        startsAt: data.startsAt,
        endsAt: finalEndsAt,
        checkedAt,
      })
    }

    // Calculate deposit with validated product price (if configured as percentage)
    let depositAmount: Prisma.Decimal | null = null
    let depositStatus: string | null = null
    let depositExpiresAt: Date | null = null
    if (settings.deposits) {
      const deposit = calculateDepositAmount(
        settings.deposits,
        requestedPartySize,
        product?.price ? Number(new Prisma.Decimal(product.price).add(modifierDelta)) : null,
      )
      if (deposit.required && deposit.amount) {
        depositAmount = deposit.amount
        depositStatus = 'PENDING'
        const requestedWindowMin = settings.deposits.paymentWindowHrs ?? 30
        const effectiveWindowMin = Math.min(Math.max(requestedWindowMin, 30), 1440)
        depositExpiresAt = new Date(Date.now() + effectiveWindowMin * 60_000)
      }
    }
    const initialStatus: ReservationStatus = depositAmount ? 'PENDING' : autoConfirm ? 'CONFIRMED' : 'PENDING'

    // Layer 0: External calendar busy-block check (Google Calendar et al.).
    // Runs BEFORE table/staff overlap checks so a Google event blocking the
    // venue or staff member rejects the request with a clear domain-specific
    // error instead of the generic "horario ya reservado" message.
    const externalBlock = await checkExternalBusyBlock(tx, {
      venueId,
      staffId: effectiveAssignedStaffId,
      startsAt: data.startsAt,
      endsAt: finalEndsAt,
    })
    if (externalBlock) {
      throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
    }

    // Layer 1: Check table overlap (FOR UPDATE NOWAIT)
    if (data.tableId) {
      const tableConflicts = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Reservation"
        WHERE "venueId" = ${venueId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND "startsAt" < ${finalEndsAt}
        AND "endsAt" > ${data.startsAt}
        AND "tableId" = ${data.tableId}
        FOR UPDATE NOWAIT
      `
      if (tableConflicts.length > 0) {
        throw new ConflictError('Este horario ya esta reservado para esta mesa')
      }
    }

    // Layer 1b: Check staff overlap
    if (effectiveAssignedStaffId) {
      const staffConflicts = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Reservation"
        WHERE "venueId" = ${venueId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
        AND "startsAt" < ${finalEndsAt}
        AND "endsAt" > ${data.startsAt}
        AND "assignedStaffId" = ${effectiveAssignedStaffId}
        FOR UPDATE NOWAIT
      `
      if (staffConflicts.length > 0) {
        throw new ConflictError('Este horario ya esta reservado para este miembro del equipo')
      }
    }

    // Layer 3: Product capacity gate
    if (!isAppointment && leadProductId && product?.eventCapacity) {
      const onlinePercent = settings.scheduling.onlineCapacityPercent
      const effectiveCapacity = Math.floor((product.eventCapacity * onlinePercent) / 100)

      const overlappingProductReservations = await tx.$queryRaw<{ partySize: number }[]>`
          SELECT "partySize"
          FROM "Reservation"
          WHERE "venueId" = ${venueId}
            AND "productId" = ${leadProductId}
            AND "startsAt" < ${finalEndsAt}
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
        endsAt: finalEndsAt,
        duration: finalDuration,
        customerId: data.customerId,
        guestName: data.guestName,
        guestPhone: data.guestPhone,
        guestEmail: data.guestEmail,
        partySize: requestedPartySize,
        tableId: data.tableId,
        productId: leadProductId,
        productIds: productIdsWasProvided ? bookedProductIds : [],
        assignedStaffId: effectiveAssignedStaffId,
        depositAmount,
        depositStatus: depositStatus as any,
        depositExpiresAt,
        idempotencyKey: depositAmount ? depositIdempotencyKey : undefined,
        createdById,
        confirmedAt: initialStatus === 'CONFIRMED' ? new Date() : null,
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

    if (modifierRows.length > 0) {
      await tx.reservationModifier.createMany({
        data: modifierRows.map(r => ({
          reservationId: reservation.id,
          productId: r.productId,
          modifierId: r.modifierId,
          name: r.name,
          quantity: r.quantity,
          price: r.price,
        })),
      })
    }

    // ---- Google Calendar push outbox (Phase 2) ----
    // Co-commit one outbox row per target connection so the push is atomic
    // with the reservation INSERT. Class reservations don't flow through this
    // path — they're created in `createClassReservation` (public controller)
    // which handles roster-update push semantics (spec §14.2).
    const targets = await resolveReservationPushTargets(tx, {
      venueId,
      assignedStaffId: reservation.assignedStaffId ?? null,
    })
    const pushRowIds =
      targets.length > 0
        ? await enqueuePush(tx, {
            source: { kind: 'reservation', reservationId: reservation.id },
            venueId,
            operation: 'CREATE',
            targetConnectionIds: targets.map(t => t.id),
          })
        : []

    if (consumedAppointmentHoldId) {
      await tx.slotHold.deleteMany({ where: { id: consumedAppointmentHoldId, venueId } })
    }

    return { reservation, pushRowIds, overCapacity }
  })

  logger.info(
    `✅ [RESERVATION] Created ${reservation.reservation.confirmationCode} | venue=${venueId} status=${reservation.reservation.status} table=${data.tableId ?? 'none'} staff=${reservation.reservation.assignedStaffId ?? 'none'}`,
  )

  // Fire-and-forget RMQ publish AFTER the transaction commits. Sweeper is the
  // retry path if RMQ is down; we never block the request on this.
  if (reservation.pushRowIds.length > 0) {
    publishPushNotification(reservation.pushRowIds).catch(err =>
      logger.warn('gcal push publish failed after createReservation (sweeper will retry)', {
        err,
        rowIds: reservation.pushRowIds,
        reservationId: reservation.reservation.id,
      }),
    )
  }

  logAction({
    staffId: createdById,
    venueId,
    action: 'RESERVATION_CREATED',
    entity: 'Reservation',
    entityId: reservation.reservation.id,
    data: { status: reservation.reservation.status, confirmationCode: reservation.reservation.confirmationCode },
  })

  return reservation.overCapacity ? { ...reservation.reservation, overCapacity: true as const } : reservation.reservation
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
  // Picked modifiers — surfaced so the dashboard reservation detail / TPV
  // shows the full breakdown and the cashier charges the correct total.
  modifiers: {
    select: { id: true, productId: true, name: true, quantity: true, price: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
} as const

interface ReservationService {
  id: string
  name: string
  price: Prisma.Decimal | null
  duration: number | null
}

type ServiceResolvable = { productId: string | null; productIds: string[] }

/**
 * The ORDERED product ids a reservation booked. Multi-service appointments
 * (Square pattern) store the lead service in `productId` and the full ordered
 * list in the `productIds` text[]; single-service/legacy rows only have
 * `productId`. Returns [] for table-only reservations.
 */
function reservationServiceIds(r: ServiceResolvable): string[] {
  return r.productIds?.length ? r.productIds : r.productId ? [r.productId] : []
}

/**
 * Resolve the full ORDERED list of booked services for a reservation.
 *
 * `productIds` is a scalar text[], NOT a relation, so Prisma cannot `include`
 * it. Without this the reservation views only ever surfaced the lead `product`,
 * so a booking like "Baby Boomer + Manicure/Pedicure/Spa" looked like a single
 * service and its 2nd service silently disappeared from the UI. We fetch the
 * products here and attach them as `services`, preserving booking order.
 */
async function attachServices<T extends ServiceResolvable>(reservation: T) {
  const [withServices] = await attachServicesMany([reservation])
  return withServices
}

/**
 * Batched `attachServices` for lists (calendar, etc.) — ONE product query for
 * the whole page instead of one per reservation. Order is preserved per row.
 */
async function attachServicesMany<T extends ServiceResolvable>(reservations: T[]): Promise<(T & { services: ReservationService[] })[]> {
  const allIds = new Set<string>()
  for (const r of reservations) for (const id of reservationServiceIds(r)) allIds.add(id)

  const products = allIds.size
    ? await prisma.product.findMany({
        where: { id: { in: [...allIds] } },
        select: { id: true, name: true, price: true, duration: true },
      })
    : []
  const byId = new Map(products.map(p => [p.id, p]))

  return reservations.map(r => ({
    ...r,
    // Map back over the id list (not `products`) to keep booking order intact.
    services: reservationServiceIds(r)
      .map(id => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map(p => ({ id: p.id, name: p.name, price: p.price, duration: p.duration })),
  }))
}

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
    // Same treatment the detail and calendar views get: a multi-service
    // appointment must list EVERY service here too. Without this the list only
    // ever showed the lead service, so staff could not tell what was actually
    // booked without opening each row.
    data: await attachServicesMany(data),
    meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function getReservationById(venueId: string, reservationId: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    include: RESERVATION_INCLUDE,
  })
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')
  return attachServices(reservation)
}

export async function getReservationByCancelSecret(venueId: string, cancelSecret: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { cancelSecret, venue: { slug: venueId } }, // venueId here is actually venueSlug for public routes
    include: {
      table: { select: { id: true, number: true } },
      product: { select: { id: true, name: true, price: true } },
      assignedStaff: { select: { id: true, firstName: true, lastName: true } },
      venue: { select: { name: true, slug: true, timezone: true } },
      modifiers: {
        select: { id: true, productId: true, name: true, quantity: true, price: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
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

  // Wrap update + outbox enqueue in a single transaction so the gcal push row
  // commits atomically with the status change. Without this, a crash between
  // updateMany and enqueuePush would leave the reservation cancelled but
  // Google still showing the event.
  const { updated, pushRowIds } = await prisma.$transaction(async tx => {
    // RACE GUARD: only update if the row is still in the source status we just read.
    // Two concurrent cancel requests would both pass validateTransition above (since
    // they both saw `CONFIRMED`), then both run the unguarded `update`, both succeed,
    // both fire downstream side-effects (refund, notifications). The conditional
    // updateMany makes exactly one of them succeed (rowsAffected=1) and the rest get
    // rowsAffected=0 → we throw the same error the validator would.
    const guarded = await tx.reservation.updateMany({
      where: { id: reservationId, status: reservation.status },
      data: updateData as any, // updateMany accepts the same scalar fields as update
    })
    if (guarded.count === 0) {
      throw new BadRequestError('La reservacion ya fue modificada por otro proceso. Recarga e intenta de nuevo.')
    }

    const updated = await tx.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: RESERVATION_INCLUDE,
    })

    // ---- Google Calendar push outbox (Phase 2) ----
    // Only CANCELLED transitions need a gcal push from this code path. Other
    // state changes (CONFIRMED, CHECKED_IN, COMPLETED, NO_SHOW) don't mutate
    // the calendar event — the event was created at CREATE time and is
    // updated via `updateReservation` when time/staff change.
    let pushRowIds: string[] = []
    if (targetStatus === 'CANCELLED') {
      if (updated.classSessionId) {
        // Attendee cancel: bump the class's roster event, don't emit per-attendee CANCEL.
        const classSession = await tx.classSession.findUnique({
          where: { id: updated.classSessionId },
          select: { assignedStaffId: true },
        })
        if (classSession) {
          const classTargets = await resolveClassSessionPushTargets(tx, {
            venueId,
            assignedStaffId: classSession.assignedStaffId ?? null,
          })
          if (classTargets.length > 0) {
            await enqueuePush(tx, {
              source: { kind: 'class', classSessionId: updated.classSessionId },
              venueId,
              operation: 'UPDATE_ROSTER',
              targetConnectionIds: classTargets.map(t => t.id),
              debounceUntil: new Date(Date.now() + 30_000),
            })
            // Roster rows are intentionally debounced — sweeper picks them up.
          }
        }
      } else {
        const targets = await resolveReservationPushTargets(tx, {
          venueId,
          assignedStaffId: updated.assignedStaffId ?? null,
        })
        if (targets.length > 0) {
          // Collapse any earlier PENDING CREATE/UPDATE rows for this syncKey
          // BEFORE enqueuing the CANCEL so the worker sees a clean state.
          const now = new Date()
          for (const target of targets) {
            const syncKey = buildSyncKey({
              kind: 'reservation',
              reservationId: updated.id,
              connectionId: target.id,
            })
            await collapseSupersededOps(tx, syncKey, now)
          }
          pushRowIds = await enqueuePush(tx, {
            source: { kind: 'reservation', reservationId: updated.id },
            venueId,
            operation: 'CANCEL',
            targetConnectionIds: targets.map(t => t.id),
          })
        }
      }
    }

    return { updated, pushRowIds }
  })

  if (pushRowIds.length > 0) {
    publishPushNotification(pushRowIds).catch(err =>
      logger.warn('gcal push publish failed after transitionReservation (sweeper will retry)', {
        err,
        rowIds: pushRowIds,
        reservationId,
      }),
    )
  }

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
    // `by` can be a real Staff ID OR a sentinel string ('SYSTEM' for the
    // auto-no-show job, 'CUSTOMER' for self-service cancel). Only pass it
    // through as staffId when it looks like an actual ID — otherwise the
    // ActivityLog_staffId_fkey would fail. logAction normalizes these too,
    // but keeping the intent explicit here makes the audit trail readable.
    const isRealStaff = !!by && by !== 'SYSTEM' && by !== 'CUSTOMER' && by !== 'PUBLIC' && by !== 'WEBHOOK'
    logAction({
      staffId: isRealStaff ? by : undefined,
      venueId,
      action: logActionName,
      entity: 'Reservation',
      entityId: updated.id,
      data: {
        status: updated.status,
        confirmationCode: updated.confirmationCode,
        ...(!isRealStaff && by ? { actor: by } : {}),
      },
    })
  }

  return updated
}

export async function confirmReservation(venueId: string, reservationId: string, confirmedById: string) {
  return transitionReservation(venueId, reservationId, 'CONFIRMED', confirmedById)
}

export async function checkInReservation(venueId: string, reservationId: string, checkedInBy: string) {
  const transitioned = await transitionReservation(venueId, reservationId, 'CHECKED_IN', checkedInBy)
  // Auto-create the TPV order so the cashier sees the booked services +
  // picked modifiers pre-populated. Idempotent — re-check-in of an already
  // converted reservation returns the existing order. Wrapped in a single
  // SERIALIZABLE tx so the check-in + conversion either both happen or
  // neither does.
  let orderId: string | null = null
  try {
    const result = await withSerializableRetry(async tx =>
      createOrderFromReservation(tx, {
        reservationId,
        venueId,
        createdByStaffId: checkedInBy === 'CUSTOMER' || checkedInBy === 'SYSTEM' ? null : checkedInBy,
      }),
    )
    orderId = result?.orderId ?? null
  } catch (err) {
    // Order auto-creation must NEVER block check-in. The reservation IS
    // checked in; if conversion fails, the cashier creates the order
    // manually like before.
    logger.error(`[CHECK_IN] Order auto-create failed for reservation ${reservationId}: ${(err as Error).message}`)
  }
  // Surface the full booked services[] (Square-pattern multi-service bookings
  // store the lead service in `product` but the ordered list in `productIds`)
  // so the POS can print one kitchen/service comanda per booked service.
  // Reuses the same helper getReservationById/getReservationsCalendar use —
  // purely additive, `orderId` and every other field are preserved.
  const withServices = await attachServices(transitioned)
  return Object.assign(withServices, { orderId })
}

export async function completeReservation(venueId: string, reservationId: string) {
  return transitionReservation(venueId, reservationId, 'COMPLETED', null)
}

export async function markNoShow(venueId: string, reservationId: string, markedBy: string) {
  const updated = await transitionReservation(venueId, reservationId, 'NO_SHOW', markedBy)

  // Deposit forfeit (Escenario A) — when the venue keeps deposits on no-show
  // (`forfeitDeposit`), keep the already-captured deposit instead of leaving it
  // in limbo. Best-effort; never blocks the NO_SHOW transition.
  await handleNoShowDepositForfeit(updated.id, venueId)

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

  await handleReservationDepositCancellation(updated.id, venueId)

  return Object.assign(updated, refundResult)
}

async function handleReservationDepositCancellation(reservationId: string, venueId: string): Promise<void> {
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    select: {
      id: true,
      confirmationCode: true,
      startsAt: true,
      depositStatus: true,
      depositProcessorRef: true,
      refundStatus: true,
      ecommerceMerchantId: true,
    },
  })
  if (
    !reservation ||
    reservation.depositStatus !== 'PAID' ||
    !reservation.depositProcessorRef ||
    reservation.refundStatus === 'SUCCEEDED'
  ) {
    return
  }

  const settings = await getReservationSettings(venueId)
  const minHoursBeforeStart = settings.cancellation.minHoursBeforeStart ?? 0
  const hoursUntilStart = (reservation.startsAt.getTime() - Date.now()) / 3_600_000
  const shouldForfeit = settings.cancellation.forfeitDeposit && hoursUntilStart < minHoursBeforeStart

  if (shouldForfeit) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { depositStatus: 'FORFEITED' },
    })
    logger.info(`💰 [RESERVATION DEPOSIT] Forfeited deposit for ${reservation.confirmationCode}`)
    return
  }

  // Refunds MUST originate from the SAME connected account that captured the
  // charge — Stripe rejects refunds routed through a different account with
  // "the source has already been charged" errors. Use the merchant pinned on
  // the reservation row at checkout-mint time. Legacy rows (pre-migration)
  // lack the pin, so fall back to the "newest active" merchant + log so ops
  // can spot venues that need backfilling.
  let merchant = reservation.ecommerceMerchantId
    ? await prisma.ecommerceMerchant.findFirst({
        where: { id: reservation.ecommerceMerchantId, provider: { code: 'STRIPE_CONNECT' } },
        include: { provider: true },
      })
    : null
  if (!merchant) {
    if (reservation.ecommerceMerchantId) {
      logger.warn(
        `⚠️ [RESERVATION DEPOSIT] Pinned merchant ${reservation.ecommerceMerchantId} not found for ${reservation.confirmationCode}; falling back to latest active`,
      )
    } else {
      logger.warn(
        `⚠️ [RESERVATION DEPOSIT] No pinned merchant on ${reservation.confirmationCode} (legacy row); falling back to latest active`,
      )
    }
    merchant = await prisma.ecommerceMerchant.findFirst({
      where: {
        venueId,
        active: true,
        provider: { code: 'STRIPE_CONNECT', active: true },
      },
      include: { provider: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  if (!merchant) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        refundStatus: 'FAILED',
        refundRequestedAt: new Date(),
        refundFailedReason: 'No active Stripe Connect merchant found for reservation deposit refund',
      },
    })
    logger.error(`❌ [RESERVATION DEPOSIT] Refund failed for ${reservation.confirmationCode}: missing Stripe merchant`)
    return
  }

  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      refundStatus: 'PENDING',
      refundRequestedAt: new Date(),
      refundFailedReason: null,
    },
  })

  try {
    const provider = getProvider(merchant)
    const refund = await provider.refund(merchant, {
      paymentIntentId: reservation.depositProcessorRef,
      refundApplicationFee: true,
      reason: 'requested_by_customer',
      idempotencyKey: `reservation-deposit-refund:${reservation.id}:v1`,
      metadata: {
        type: 'reservation_deposit_refund',
        reservationId: reservation.id,
        venueId,
        confirmationCode: reservation.confirmationCode,
      },
    })

    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        refundStatus: refund.status,
        refundProcessorRef: refund.refundId,
        refundFailedReason: null,
        ...(refund.status === 'SUCCEEDED'
          ? {
              depositStatus: 'REFUNDED',
              depositRefundedAt: new Date(),
            }
          : {}),
      },
    })
  } catch (error: any) {
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        refundStatus: 'FAILED',
        refundFailedReason: error?.message ?? 'Stripe refund failed',
        refundRetryCount: { increment: 1 },
      },
    })
    logger.error(`❌ [RESERVATION DEPOSIT] Refund failed for ${reservation.confirmationCode}`, error)
  }
}

/**
 * No-show deposit handling (Escenario A — "no-show keeps the deposit").
 *
 * When a reservation is marked NO_SHOW and the venue opted into keeping the
 * deposit (`forfeitDeposit`), the already-captured deposit is forfeited: we
 * mark it FORFEITED and do NOT refund. No Stripe call is needed because the
 * funds were captured at booking time (Checkout `mode: 'payment'`) — forfeit
 * is simply "don't return the money".
 *
 * Gated strictly on `forfeitDeposit`. When the venue did NOT opt in, we leave
 * the deposit untouched (today's behavior) — we never auto-refund on no-show,
 * since a no-show is the customer's fault, not a cancellation.
 *
 * Note: partial no-show fees (`noShowFeePercent` < 100) would require a partial
 * Stripe refund of the remainder, which the current refund path doesn't support
 * (it refunds in full). That stays a separate, deliberate payments feature; this
 * handles the binary "keep the whole deposit" case only.
 *
 * Best-effort: never throws — a forfeit-bookkeeping failure must not block the
 * NO_SHOW transition itself.
 */
export async function handleNoShowDepositForfeit(reservationId: string, venueId: string): Promise<void> {
  try {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, venueId },
      select: { id: true, confirmationCode: true, depositStatus: true },
    })
    // Only a paid deposit can be forfeited. Anything else (no deposit, pending,
    // already refunded/forfeited) → nothing to do.
    if (!reservation || reservation.depositStatus !== 'PAID') return

    const settings = await getReservationSettings(venueId)
    if (!settings.cancellation.forfeitDeposit) return

    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { depositStatus: 'FORFEITED' },
    })
    logger.info(`💰 [RESERVATION NO-SHOW] Forfeited deposit for ${reservation.confirmationCode}`)
  } catch (error) {
    logger.error(`❌ [RESERVATION NO-SHOW] Deposit forfeit failed for reservation ${reservationId}`, error)
  }
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

interface UpdateReservationOptions {
  fixedDuration?: 'staff-aware-appointments' | 'always'
  requireAppointment?: boolean
  enforceLegacyAppointmentPacing?: boolean
}

type ReservationHoldIdentity = {
  startsAt: number
  endsAt: number
  duration: number
  productId: string | null
  productIds: string[]
  assignedStaffId: string | null
}

function updateHasHoldIdentityCandidate(data: UpdateReservationInput): boolean {
  return (
    data.startsAt !== undefined ||
    data.endsAt !== undefined ||
    data.duration !== undefined ||
    data.productId !== undefined ||
    data.assignedStaffId !== undefined
  )
}

function reservationHoldIdentity(input: {
  startsAt: Date
  endsAt: Date
  duration: number
  productId: string | null
  productIds: string[]
  assignedStaffId: string | null
}): ReservationHoldIdentity {
  return {
    startsAt: input.startsAt.getTime(),
    endsAt: input.endsAt.getTime(),
    duration: input.duration,
    productId: input.productId,
    productIds: [...input.productIds],
    assignedStaffId: input.assignedStaffId,
  }
}

function sameOrderedProductIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameReservationHoldIdentity(left: ReservationHoldIdentity, right: ReservationHoldIdentity): boolean {
  return (
    left.startsAt === right.startsAt &&
    left.endsAt === right.endsAt &&
    left.duration === right.duration &&
    left.productId === right.productId &&
    sameOrderedProductIds(left.productIds, right.productIds) &&
    left.assignedStaffId === right.assignedStaffId
  )
}

function synchronizeUpdatedProductIdentity(
  reservation: { productId: string | null; productIds: string[] },
  requestedProductId: string | null | undefined,
): { productId: string | null; productIds: string[]; changed: boolean } {
  if (requestedProductId === undefined || requestedProductId === reservation.productId) {
    return { productId: reservation.productId, productIds: [...reservation.productIds], changed: false }
  }
  if (reservation.productIds.length > 1) {
    throw new BadRequestError(
      'No se puede cambiar el servicio principal de una reservación con varios servicios. Cancela y crea una nueva.',
    )
  }
  if (requestedProductId === null) {
    return { productId: null, productIds: [], changed: true }
  }
  return {
    productId: requestedProductId,
    productIds: reservation.productIds.length === 1 ? [requestedProductId] : [],
    changed: true,
  }
}

export async function updateReservation(
  venueId: string,
  reservationId: string,
  data: UpdateReservationInput,
  context: ReservationWriteContext,
  updatedById: string,
  options: UpdateReservationOptions = {},
) {
  const updated = await withSerializableRetry(async tx => {
    const settings = await getReservationSettings(venueId, tx)
    const hasHoldIdentityCandidate = updateHasHoldIdentityCandidate(data)
    if (hasHoldIdentityCandidate) {
      await lockAppointmentVenue(tx, venueId)
    }
    const reservation = await lockReservationForReschedule(tx, { venueId, reservationId })

    // Only allow updates on PENDING or CONFIRMED reservations
    if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) {
      throw new BadRequestError(`No se puede modificar una reservacion con estado ${reservation.status}`)
    }

    const newStartsAt = data.startsAt ?? reservation.startsAt
    const newTableId = data.tableId !== undefined ? data.tableId : reservation.tableId
    const newStaffId = data.assignedStaffId !== undefined ? data.assignedStaffId : reservation.assignedStaffId
    const productIdentity = synchronizeUpdatedProductIdentity(reservation, data.productId)
    const newProductId = productIdentity.productId
    const newProductIds = productIdentity.productIds
    const newPartySize = data.partySize ?? reservation.partySize

    const { product } = await validateResourceOwnership(tx, venueId, {
      tableId: newTableId,
      productId: newProductId,
    })
    let oldProductType: string | undefined
    if (reservation.productId === newProductId) {
      oldProductType = product?.type
    } else if (reservation.productId) {
      const oldProduct = await tx.product.findFirst({
        where: { id: reservation.productId, venueId },
        select: { type: true },
      })
      oldProductType = oldProduct?.type
    }
    const oldIsAppointment = reservation.classSessionId === null && oldProductType === 'APPOINTMENTS_SERVICE'
    const newIsAppointment = reservation.classSessionId === null && product?.type === 'APPOINTMENTS_SERVICE'
    const isAppointmentReservation = oldIsAppointment || newIsAppointment
    const staffAware = isStaffAware(settings)

    if (options.requireAppointment && !newIsAppointment) {
      throw new BadRequestError('Esta función es solo para citas. Las clases se reagendan por sesión.')
    }

    const useLockedDuration =
      options.fixedDuration === 'always' || (options.fixedDuration === 'staff-aware-appointments' && isAppointmentReservation && staffAware)
    let newEndsAt = data.endsAt ?? reservation.endsAt
    let finalDuration: number
    if (useLockedDuration) {
      finalDuration = reservation.duration
      newEndsAt = new Date(newStartsAt.getTime() + finalDuration * 60_000)
    } else {
      const calculatedDuration = Math.round((newEndsAt.getTime() - newStartsAt.getTime()) / 60_000)
      finalDuration =
        data.duration !== undefined
          ? data.duration
          : data.startsAt !== undefined || data.endsAt !== undefined
            ? calculatedDuration
            : reservation.duration
    }

    if (!Number.isFinite(newStartsAt.getTime()) || !Number.isFinite(newEndsAt.getTime()) || newEndsAt <= newStartsAt) {
      throw new BadRequestError('La fecha de fin debe ser posterior a la fecha de inicio')
    }
    const effectiveIntervalMs = newEndsAt.getTime() - newStartsAt.getTime()
    if (!Number.isInteger(finalDuration) || finalDuration < 1 || finalDuration > 1_440) {
      throw new BadRequestError('La duracion debe estar entre 1 y 1440 minutos')
    }
    if (effectiveIntervalMs > 1_440 * 60_000) {
      throw new BadRequestError('El rango de fechas no puede exceder 1440 minutos')
    }
    if (Math.abs(effectiveIntervalMs - finalDuration * 60_000) > 60_000) {
      throw new BadRequestError('La duracion no coincide con el rango de fechas')
    }

    const identityChanged = !sameReservationHoldIdentity(
      reservationHoldIdentity(reservation),
      reservationHoldIdentity({
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        duration: finalDuration,
        productId: newProductId,
        productIds: newProductIds,
        assignedStaffId: newStaffId,
      }),
    )

    if (identityChanged) {
      await lockTaggedRescheduleSiblings(tx, { venueId, reservationId: reservation.id })
    }

    if (productIdentity.changed && isAppointmentReservation && staffAware) {
      throw new BadRequestError('No se pueden cambiar los servicios de una cita con profesionistas activos. Cancela y crea una nueva.')
    }

    const maxAllowed = isAppointmentReservation && staffAware ? 1_440 : Math.max(480, reservation.duration)
    if (finalDuration > maxAllowed) {
      throw new BadRequestError(`La duracion no puede exceder ${maxAllowed} minutos`)
    }

    const windowChanged =
      reservation.startsAt.getTime() !== newStartsAt.getTime() ||
      reservation.endsAt.getTime() !== newEndsAt.getTime() ||
      reservation.duration !== finalDuration
    const staffChanged = reservation.assignedStaffId !== newStaffId
    const checkedAt = new Date()
    let overCapacity = false

    if (isAppointmentReservation && staffAware && (windowChanged || staffChanged)) {
      if (!newStaffId) {
        throw new ConflictError('La cita necesita un profesionista disponible para ese horario')
      }
      await assertStaffEligibleForPersistedProducts(tx, {
        venueId,
        staffId: newStaffId,
        productIds: reservationBookedProductIds({ productId: newProductId, productIds: newProductIds }),
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        checkedAt,
        settings,
        excludeReservationId: reservation.id,
      })
    } else if (newStaffId && (windowChanged || staffChanged)) {
      const membership = await validateLegacyStaffMembership(tx, venueId, newStaffId)
      await assertOrganizationStaffAvailability(tx, {
        organizationId: membership.organizationId,
        staffId: newStaffId,
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        checkedAt,
        excludeReservationId: reservation.id,
      })
    }

    const pacingLimit = staffAware
      ? settings.scheduling.pacingMaxPerSlot
      : options.enforceLegacyAppointmentPacing
        ? effectiveAppointmentPacing(settings.scheduling.pacingMaxPerSlot)
        : null
    if (isAppointmentReservation && windowChanged && pacingLimit !== null) {
      const limit = pacingLimit
      const occupancyResult = await countAppointmentOccupancy(tx, {
        venueId,
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        checkedAt,
        excludeReservationId: reservation.id,
      })
      const occupancy = occupancyResult.reservations + occupancyResult.holds
      if (occupancy >= limit) {
        if (!staffAware || context.writeOrigin !== 'DASHBOARD') {
          throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
        }
        if (!context.allowOverCapacity) {
          throw new ConflictError('El horario está lleno. Confirma si deseas sobre-agendar.', 'OVER_CAPACITY_CONFIRMATION_REQUIRED', {
            preview: { startsAt: newStartsAt, endsAt: newEndsAt, occupancy, limit },
          })
        }
        overCapacity = true
      }
    }

    // Layer 0: External calendar busy-block check against the NEW (target)
    // values. We always check, even when time/staff are unchanged — an
    // `ExternalBusyBlock` may have been inserted AFTER this reservation was
    // originally created, and the update is still a chance to surface it.
    const externalBlock = await checkExternalBusyBlock(tx, {
      venueId,
      staffId: newStaffId,
      startsAt: newStartsAt,
      endsAt: newEndsAt,
    })
    if (externalBlock) {
      throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
    }

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

    if (!isAppointmentReservation && newProductId && product?.eventCapacity) {
      const onlinePercent = settings.scheduling.onlineCapacityPercent
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

    if (identityChanged) {
      await tx.slotHold.deleteMany({
        where: { venueId, heldForReservationId: reservation.id },
      })
    }

    const updated = await tx.reservation.update({
      where: { id: reservationId },
      data: {
        ...(data.startsAt !== undefined && { startsAt: newStartsAt }),
        ...((data.endsAt !== undefined || useLockedDuration) && { endsAt: newEndsAt }),
        duration: finalDuration,
        ...(data.guestName !== undefined && { guestName: data.guestName }),
        ...(data.guestPhone !== undefined && { guestPhone: data.guestPhone }),
        ...(data.guestEmail !== undefined && { guestEmail: data.guestEmail }),
        ...(data.partySize !== undefined && { partySize: data.partySize }),
        ...(data.tableId !== undefined && { tableId: data.tableId }),
        ...(data.productId !== undefined && { productId: newProductId, productIds: newProductIds }),
        ...(data.assignedStaffId !== undefined && { assignedStaffId: data.assignedStaffId }),
        ...(data.specialRequests !== undefined && { specialRequests: data.specialRequests }),
        ...(data.internalNotes !== undefined && { internalNotes: data.internalNotes }),
        ...(data.tags !== undefined && { tags: data.tags }),
      },
      include: RESERVATION_INCLUDE,
    })

    // ---- Google Calendar push outbox (Phase 2) ----
    // Re-resolve targets against the NEW state. If `assignedStaffId` changed,
    // the new staff's calendar receives the UPDATE (which the worker promotes
    // to CREATE if no mapping exists for that connection). Skip pushing for
    // reservations attached to a ClassSession — the class itself is the
    // pushed event; per-attendee row edits don't change the class event.
    // TODO Phase 3: when assignedStaffId moves A → B, the event remains in
    // staff A's calendar (stale mapping). Add a cleanup-orphan-mapping
    // pass that emits CANCEL against the previous target.
    let pushRowIds: string[] = []
    if (!updated.classSessionId) {
      const targets = await resolveReservationPushTargets(tx, {
        venueId,
        assignedStaffId: updated.assignedStaffId ?? null,
      })
      if (targets.length > 0) {
        pushRowIds = await enqueuePush(tx, {
          source: { kind: 'reservation', reservationId: updated.id },
          venueId,
          operation: 'UPDATE',
          targetConnectionIds: targets.map(t => t.id),
        })
      }
    }

    return { updated, pushRowIds, overCapacity }
  })

  logger.info(`✅ [RESERVATION] Updated ${updated.updated.confirmationCode} by=${updatedById} origin=${context.writeOrigin}`)

  if (updated.pushRowIds.length > 0) {
    publishPushNotification(updated.pushRowIds).catch(err =>
      logger.warn('gcal push publish failed after updateReservation (sweeper will retry)', {
        err,
        rowIds: updated.pushRowIds,
        reservationId: updated.updated.id,
      }),
    )
  }

  logAction({
    staffId: updatedById,
    venueId,
    action: 'RESERVATION_UPDATED',
    entity: 'Reservation',
    entityId: updated.updated.id,
    data: { confirmationCode: updated.updated.confirmationCode },
  })

  return updated.overCapacity ? { ...updated.updated, overCapacity: true as const } : updated.updated
}

// ---- Reschedule ----

export type RescheduleNotification = {
  notificationChannel?: 'push' | 'whatsapp' | 'email' | 'sms' | 'none'
  customMessage?: string
}

export interface RescheduleReservationInput extends RescheduleNotification {
  startsAt: Date
  endsAt: Date
}

export async function rescheduleReservation(
  venueId: string,
  reservationId: string,
  data: RescheduleReservationInput,
  context: ReservationWriteContext,
  rescheduledBy: string,
) {
  const { startsAt: newStartsAt, endsAt: newEndsAt } = data
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
    context,
    rescheduledBy,
    { fixedDuration: 'staff-aware-appointments' },
  )

  const channel = data.notificationChannel
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
            message: data.customMessage,
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
            customMessage: data.customMessage,
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
      customMessage: data.customMessage ?? null,
    },
  })

  return rescheduled
}

/**
 * Move an APPOINTMENT reservation to a new date/time of the SAME service.
 *
 * Customer-facing self-service (magic link, no login) + ops/MCP. Mirrors
 * `rescheduleClassReservation` but for appointment products (productId, no
 * classSessionId). Duration is fixed (same service + same modifiers) so the new
 * endsAt is derived from the existing `duration` — the caller never sets it.
 *
 * Pacing protection (two paths):
 *   - Customer path (`holdId`): a SlotHold already reserved the target slot
 *     (created via createRescheduleHold, pacing-checked excluding self). Validated here.
 *   - Ops/MCP path (no `holdId`): re-check pacing inline, excluding self.
 *
 *        old slot                         new slot
 *   ┌──────────────┐                 ┌──────────────┐
 *   │ reservation  │   move (same    │ reservation  │   one transaction locks and
 *   │ (productId)  │ ─ duration) ──▶ │ (productId)  │   consumes the hold, updates R,
 *   └──────────────┘                 └──────────────┘   and writes the GCal outbox
 */
async function rescheduleAppointmentWithHold(args: {
  venueId: string
  reservationId: string
  newStartsAt: Date
  holdId: string
  rescheduledBy: string
  writeOrigin: WriteOrigin
}) {
  const { venueId, reservationId, newStartsAt, holdId, rescheduledBy, writeOrigin } = args
  if (!(await venueHasFeatureAccess(venueId, 'RESERVATIONS'))) {
    throw new ForbiddenError('Este negocio no tiene reservaciones en línea disponibles por el momento.', 'PLAN_REQUIRED')
  }

  const result = await withSerializableRetry(async tx => {
    const settings = await getReservationSettings(venueId, tx)
    await lockAppointmentVenue(tx, venueId)
    const reservation = await lockReservationForReschedule(tx, { venueId, reservationId })
    const original = await tx.reservation.findUnique({
      where: { id: reservation.id },
      include: {
        customer: { select: { firstName: true, lastName: true, phone: true, email: true } },
        product: { select: { name: true } },
        venue: { select: { name: true, timezone: true } },
      },
    })
    if (!original || original.venueId !== venueId) throw new NotFoundError('Reservacion no encontrada')

    const lockedHold = await lockAndValidateRescheduleAppointmentHold(tx, {
      venueId,
      holdId,
      reservation,
      requestedStartsAt: newStartsAt,
      settings,
    })

    if (isStaffAware(settings)) {
      if (!lockedHold.staffId) {
        throw new ConflictError('Tu reserva temporal ya no es válida. Selecciona el horario de nuevo.')
      }
      await assertStaffEligibleForPersistedProducts(tx, {
        venueId,
        staffId: lockedHold.staffId,
        productIds: lockedHold.productIds,
        startsAt: newStartsAt,
        endsAt: lockedHold.endsAt,
        checkedAt: lockedHold.checkedAt,
        settings,
        excludeReservationId: reservation.id,
        excludeHoldId: lockedHold.id,
      })
    } else if (lockedHold.staffId) {
      await assertLegacyStaffEligible(tx, {
        venueId,
        staffId: lockedHold.staffId,
        startsAt: newStartsAt,
        endsAt: lockedHold.endsAt,
        checkedAt: lockedHold.checkedAt,
        excludeReservationId: reservation.id,
        excludeHoldId: lockedHold.id,
      })
    } else {
      const externalBlock = await checkExternalBusyBlock(tx, {
        venueId,
        staffId: null,
        startsAt: newStartsAt,
        endsAt: lockedHold.endsAt,
      })
      if (externalBlock) {
        throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
      }
    }

    if (reservation.tableId) {
      const tableConflicts = await tx.$queryRaw<{ id: string; confirmationCode: string }[]>`
        SELECT id, "confirmationCode"
        FROM "Reservation"
        WHERE "venueId" = ${venueId}
          AND "tableId" = ${reservation.tableId}
          AND id <> ${reservation.id}
          AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
          AND "startsAt" < ${lockedHold.endsAt}
          AND "endsAt" > ${newStartsAt}
        FOR UPDATE NOWAIT
      `
      if (tableConflicts.length > 0) {
        throw new ConflictError(`Mesa tiene conflicto con reservacion ${tableConflicts[0].confirmationCode}`)
      }
    }

    const updated = await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        startsAt: newStartsAt,
        endsAt: lockedHold.endsAt,
        duration: reservation.duration,
      },
      include: RESERVATION_INCLUDE,
    })

    let pushRowIds: string[] = []
    const targets = await resolveReservationPushTargets(tx, {
      venueId,
      assignedStaffId: updated.assignedStaffId ?? null,
    })
    if (targets.length > 0) {
      pushRowIds = await enqueuePush(tx, {
        source: { kind: 'reservation', reservationId: updated.id },
        venueId,
        operation: 'UPDATE',
        targetConnectionIds: targets.map(target => target.id),
      })
    }

    await tx.slotHold.deleteMany({
      where: {
        venueId,
        OR: [{ id: lockedHold.id }, { heldForReservationId: reservation.id }],
      },
    })

    return { reservation, original, updated, pushRowIds }
  })

  if (result.pushRowIds.length > 0) {
    publishPushNotification(result.pushRowIds).catch(err =>
      logger.warn('gcal push publish failed after rescheduleAppointmentReservation (sweeper will retry)', {
        err,
        rowIds: result.pushRowIds,
        reservationId: result.updated.id,
      }),
    )
  }

  const customerName =
    [result.original.customer?.firstName, result.original.customer?.lastName].filter(Boolean).join(' ').trim() ||
    result.updated.guestName ||
    'cliente'
  const phone = result.original.customer?.phone || result.updated.guestPhone
  const email = result.original.customer?.email || result.updated.guestEmail
  const venueName = result.original.venue?.name || 'Avoqado'
  const timezone = result.original.venue?.timezone || 'America/Mexico_City'
  const formatDate = (value: Date) =>
    new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone }).format(value)
  const formatTime = (value: Date) =>
    new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(value)

  if (phone) {
    try {
      await sendReservationRescheduleWhatsApp(phone, {
        customerName,
        venueName,
        date: formatDate(newStartsAt),
        time: formatTime(newStartsAt),
      })
    } catch (err) {
      logger.warn(`[RESERVATION] WhatsApp reschedule failed for ${result.updated.confirmationCode}: ${(err as Error).message}`)
    }
  }
  if (email) {
    try {
      await emailService.sendReservationRescheduledEmail(email, {
        customerName,
        venueName,
        serviceName: result.original.product?.name,
        oldDateTime: `${formatDate(result.reservation.startsAt)}, ${formatTime(result.reservation.startsAt)}`,
        newDateTime: `${formatDate(newStartsAt)}, ${formatTime(newStartsAt)}`,
        confirmationCode: result.updated.confirmationCode,
      })
    } catch (err) {
      logger.warn(`[RESERVATION] Email reschedule failed for ${result.updated.confirmationCode}: ${(err as Error).message}`)
    }
  }

  logAction({
    staffId: rescheduledBy,
    venueId,
    action: 'RESERVATION_RESCHEDULED',
    entity: 'Reservation',
    entityId: result.updated.id,
    data: {
      startsAt: newStartsAt,
      endsAt: result.updated.endsAt,
      confirmationCode: result.updated.confirmationCode,
      by: rescheduledBy,
      origin: writeOrigin,
    },
  })

  return {
    confirmationCode: result.updated.confirmationCode,
    status: result.updated.status,
    startsAt: result.updated.startsAt,
    endsAt: result.updated.endsAt,
  }
}

export async function rescheduleAppointmentReservation(args: {
  venueId: string
  reservationId: string
  newStartsAt: Date
  holdId?: string
  rescheduledBy: string // 'CUSTOMER' or actor id — normalized by logAction sentinels
  writeOrigin: WriteOrigin
  allowOverCapacity?: boolean
}) {
  const { venueId, reservationId, newStartsAt, holdId, rescheduledBy, writeOrigin, allowOverCapacity } = args

  if (holdId) {
    return rescheduleAppointmentWithHold({ venueId, reservationId, newStartsAt, holdId, rescheduledBy, writeOrigin })
  }

  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, venueId },
    include: {
      customer: { select: { firstName: true, lastName: true, phone: true, email: true } },
      product: { select: { name: true } },
      venue: { select: { name: true, timezone: true } },
    },
  })
  if (!reservation) throw new NotFoundError('Reservacion no encontrada')

  const originalStartsAt = reservation.startsAt

  // The pre-read above is presentation-only. Status, appointment type,
  // historical duration and capacity are all authoritative from the locked row.
  const updated = await updateReservation(
    venueId,
    reservationId,
    { startsAt: newStartsAt },
    { writeOrigin, allowOverCapacity },
    rescheduledBy,
    { fixedDuration: 'always', requireAppointment: true, enforceLegacyAppointmentPacing: true },
  )

  // Notify the customer of the new time — WhatsApp + email, both best-effort.
  const customerName =
    [reservation.customer?.firstName, reservation.customer?.lastName].filter(Boolean).join(' ').trim() || updated.guestName || 'cliente'
  const phone = reservation.customer?.phone || updated.guestPhone
  const email = reservation.customer?.email || updated.guestEmail
  const venueName = reservation.venue?.name || 'Avoqado'
  const tz = reservation.venue?.timezone || 'America/Mexico_City'
  const fmtDate = (d: Date) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(d)
  const fmtTime = (d: Date) =>
    new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d)

  if (phone) {
    try {
      await sendReservationRescheduleWhatsApp(phone, {
        customerName,
        venueName,
        date: fmtDate(newStartsAt),
        time: fmtTime(newStartsAt),
      })
    } catch (err) {
      logger.warn(`[RESERVATION] WhatsApp reschedule failed for ${updated.confirmationCode}: ${(err as Error).message}`)
    }
  }
  if (email) {
    try {
      await emailService.sendReservationRescheduledEmail(email, {
        customerName,
        venueName,
        serviceName: reservation.product?.name,
        oldDateTime: `${fmtDate(originalStartsAt)}, ${fmtTime(originalStartsAt)}`,
        newDateTime: `${fmtDate(newStartsAt)}, ${fmtTime(newStartsAt)}`,
        confirmationCode: updated.confirmationCode,
      })
    } catch (err) {
      logger.warn(`[RESERVATION] Email reschedule failed for ${updated.confirmationCode}: ${(err as Error).message}`)
    }
  }

  logAction({
    staffId: rescheduledBy,
    venueId,
    action: 'RESERVATION_RESCHEDULED',
    entity: 'Reservation',
    entityId: updated.id,
    data: { startsAt: updated.startsAt, endsAt: updated.endsAt, confirmationCode: updated.confirmationCode, by: rescheduledBy },
  })

  return {
    confirmationCode: updated.confirmationCode,
    status: updated.status,
    startsAt: updated.startsAt,
    endsAt: updated.endsAt,
  }
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

    // ---- Google Calendar push outbox (Phase 2) ----
    // Both the OLD class (attendee removed) and the NEW class (attendee added)
    // need their roster events bumped. Debounce 30s so the worker coalesces.
    for (const classSessionId of [reservation.classSessionId, newClassSessionId]) {
      if (!classSessionId) continue
      const cs = await tx.classSession.findUnique({
        where: { id: classSessionId },
        select: { assignedStaffId: true },
      })
      if (!cs) continue
      const classTargets = await resolveClassSessionPushTargets(tx, {
        venueId,
        assignedStaffId: cs.assignedStaffId ?? null,
      })
      if (classTargets.length === 0) continue
      await enqueuePush(tx, {
        source: { kind: 'class', classSessionId },
        venueId,
        operation: 'UPDATE_ROSTER',
        targetConnectionIds: classTargets.map(t => t.id),
        debounceUntil: new Date(Date.now() + 30_000),
      })
    }

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
  const rows = await prisma.reservation.findMany({
    where: {
      venueId,
      startsAt: { gte: dateFrom, lte: dateTo },
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
    },
    include: RESERVATION_INCLUDE,
    orderBy: { startsAt: 'asc' },
  })
  // Resolve the FULL service list per booking (multi-service appointments) in a
  // single batched query so the calendar block can list every service.
  const reservations = await attachServicesMany(rows)

  if (!groupBy) return { reservations }

  const grouped: Record<string, typeof reservations> = {}
  for (const r of reservations) {
    const key = groupBy === 'table' ? (r.tableId ?? 'unassigned') : (r.assignedStaffId ?? 'unassigned')
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(r)
  }

  return { reservations, grouped }
}

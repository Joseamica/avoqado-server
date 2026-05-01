import { Request, Response, NextFunction } from 'express'
import * as reservationService from '../../services/dashboard/reservation.dashboard.service'
import * as availabilityService from '../../services/dashboard/reservationAvailability.service'
import { getReservationSettings } from '../../services/dashboard/reservationSettings.service'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { CreditPurchaseStatus, ReservationStatus } from '@prisma/client'
import { calculateApplicationFee, toStripeAmount } from '../../services/payments/providers/money'
import { getProvider } from '../../services/payments/provider-registry'

// ==========================================
// PUBLIC RESERVATION CONTROLLER (Unauthenticated)
// For booking widget + public booking page
// ==========================================

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      type: true,
      timezone: true,
    },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

async function resolveActiveStripeMerchant(venueId: string) {
  return prisma.ecommerceMerchant.findFirst({
    where: {
      venueId,
      active: true,
      chargesEnabled: true,
      provider: { code: 'STRIPE_CONNECT', active: true },
    },
    include: { provider: true },
    orderBy: { createdAt: 'desc' },
  })
}

async function previewDepositRequirement(venueId: string, body: any, settings: any) {
  if (!settings.deposits?.enabled || settings.deposits.mode === 'none') {
    return { required: false, amount: null as any }
  }

  if (settings.deposits.mode === 'card_hold') {
    throw new BadRequestError('El modo card_hold aun no esta soportado para reservas publicas')
  }

  let servicePrice: number | null = null
  if (body.productId) {
    const product = await prisma.product.findFirst({
      where: { id: body.productId, venueId, active: true },
      select: { price: true },
    })
    servicePrice = product?.price ? Number(product.price) : null
  }

  return reservationService.calculateDepositAmount(settings.deposits, body.partySize ?? 1, servicePrice)
}

function getStripeChargeBounds() {
  return {
    min: Number(process.env.STRIPE_MIN_CHARGE_MXN_CENTS ?? 1000),
    max: Number(process.env.STRIPE_MAX_CHARGE_MXN_CENTS ?? 5000000),
  }
}

/**
 * GET /public/venues/:venueSlug/info
 */
export async function getVenueInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    // Get public-safe venue info
    const venueInfo = await prisma.venue.findUnique({
      where: { id: venue.id },
      select: {
        name: true,
        slug: true,
        logo: true,
        type: true,
        address: true,
        phone: true,
        products: {
          where: { active: true, type: { in: ['APPOINTMENTS_SERVICE', 'EVENT', 'CLASS'] } },
          select: {
            id: true,
            name: true,
            price: true,
            duration: true,
            eventCapacity: true,
            type: true,
            maxParticipants: true,
            layoutConfig: true,
            requireCreditForBooking: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    })

    const settings = await getReservationSettings(venue.id)

    res.json({
      ...venueInfo,
      timezone: venue.timezone || 'America/Mexico_City',
      publicBooking: settings.publicBooking,
      operatingHours: settings.operatingHours,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/availability
 */
export async function getAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { date, duration, partySize, productId } = req.query as any

    const settings = await getReservationSettings(venue.id)
    const tz = venue.timezone || 'America/Mexico_City'

    // Check if requesting availability for a CLASS product
    if (productId) {
      const product = await prisma.product.findFirst({
        where: { id: productId, venueId: venue.id, active: true },
        select: { type: true },
      })

      if (product?.type === 'CLASS') {
        const onlinePercent = settings.scheduling?.onlineCapacityPercent ?? 100
        const classSlots = await availabilityService.getClassSessionSlots(venue.id, productId, date, onlinePercent, tz)
        return res.json({
          date,
          slots: classSlots.map(s => ({
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            available: s.available,
            classSessionId: s.classSessionId,
            capacity: s.capacity,
            enrolled: s.enrolled,
            remaining: s.remaining,
            takenSpotIds: s.takenSpotIds ?? [],
            instructor: s.instructor ?? null,
          })),
        })
      }
    }

    // Default: operating-hours-based availability (APPOINTMENTS_SERVICE, EVENT)
    const slots = await availabilityService.getAvailableSlots(
      venue.id,
      date,
      { duration: duration ? Number(duration) : undefined, partySize: partySize ? Number(partySize) : undefined, productId },
      settings,
      tz,
    )

    // Public response: simplified (no internal table/staff IDs)
    res.json({
      date,
      slots: slots.map(s => ({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        available: true,
      })),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations
 */
export async function createReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    const settings = await getReservationSettings(venue.id)

    // Check public booking is enabled
    if (!settings.publicBooking.enabled) {
      throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
    }

    // Validate required fields based on config
    if (settings.publicBooking.requirePhone && !req.body.guestPhone) {
      throw new BadRequestError('El telefono es requerido')
    }
    if (settings.publicBooking.requireEmail && !req.body.guestEmail) {
      throw new BadRequestError('El email es requerido')
    }

    // If productId points to a CLASS product, classSessionId is mandatory
    if (req.body.productId && !req.body.classSessionId) {
      const product = await prisma.product.findFirst({
        where: { id: req.body.productId, venueId: venue.id },
        select: { type: true },
      })
      if (product?.type === 'CLASS') {
        throw new BadRequestError('classSessionId es requerido para reservar una clase')
      }
    }

    // CLASS bookings use a dedicated code path with ClassSession capacity checks
    if (req.body.classSessionId) {
      const reservation = await createClassReservation(venue.id, req.body, settings)
      return res.status(201).json({
        confirmationCode: reservation.confirmationCode,
        cancelSecret: reservation.cancelSecret,
        startsAt: reservation.startsAt,
        endsAt: reservation.endsAt,
        status: reservation.status,
        depositRequired: false,
        depositAmount: null,
        creditRedeemed: reservation.creditRedeemed || false,
        creditsUsed: reservation.creditsUsed || 0,
      })
    }

    const depositPreview = await previewDepositRequirement(venue.id, req.body, settings)
    const stripeMerchant = depositPreview.required ? await resolveActiveStripeMerchant(venue.id) : null

    if (depositPreview.required && !stripeMerchant) {
      throw new BadRequestError('Este negocio aun no tiene pagos en linea configurados')
    }

    if (depositPreview.required && depositPreview.amount) {
      const stripeAmount = toStripeAmount(depositPreview.amount)
      const bounds = getStripeChargeBounds()
      if (stripeAmount < bounds.min) {
        throw new BadRequestError('El deposito es menor al minimo permitido por Stripe')
      }
      if (stripeAmount > bounds.max) {
        throw new BadRequestError('El deposito excede el maximo permitido por transaccion')
      }
    }

    const reservation = await reservationService.createReservation(
      venue.id,
      {
        ...req.body,
        channel: 'WEB' as const,
      },
      undefined, // no createdById for public bookings
      settings,
    )

    let checkoutUrl: string | null = null
    if (reservation.depositAmount && stripeMerchant) {
      const stripeAmount = toStripeAmount(reservation.depositAmount)
      const applicationFeeAmount = calculateApplicationFee(stripeAmount, stripeMerchant.platformFeeBps)
      const provider = getProvider(stripeMerchant)
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
      const session = await provider.createCheckoutSession(stripeMerchant, {
        amount: stripeAmount,
        currency: 'mxn',
        applicationFeeAmount,
        successUrl: `${frontendUrl}/book/${venueSlug}?payment=success&reservationId=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${frontendUrl}/book/${venueSlug}?payment=cancelled&reservationId=${reservation.id}`,
        expiresAt: reservation.depositExpiresAt ?? new Date(Date.now() + 30 * 60_000),
        customerEmail: reservation.guestEmail ?? undefined,
        metadata: {
          type: 'reservation_deposit',
          reservationId: reservation.id,
          venueId: venue.id,
          confirmationCode: reservation.confirmationCode,
        },
        description: `Reserva ${venue.name}`,
        statementDescriptorSuffix: 'RESERVA',
        idempotencyKey: reservation.idempotencyKey ?? `reservation:${reservation.id}:deposit:v1`,
        paymentMethodTypes: ['card'],
      })

      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { checkoutSessionId: session.id },
      })
      checkoutUrl = session.url
    }

    // Return only public-safe data + cancelSecret
    res.status(201).json({
      confirmationCode: reservation.confirmationCode,
      cancelSecret: reservation.cancelSecret,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      status: reservation.status,
      depositRequired: !!reservation.depositAmount,
      depositAmount: reservation.depositAmount,
      checkoutUrl,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/reservations/:cancelSecret
 */
export async function getReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Compute the cancellation/refund preview so the widget can show
    // "if you cancel now, you'll get N credits back" before confirming.
    const settings = await getReservationSettings(reservation.venueId)
    const cancellationPreview = computeCancellationPreview({
      startsAt: reservation.startsAt,
      cancellationPolicy: settings.cancellation,
    })

    // Look up how many credits this reservation actually consumed (if any),
    // so we can multiply the policy percent against a real number for the UI.
    const prisma = (await import('../../utils/prismaClient')).default
    const redeems = await prisma.creditTransaction.findMany({
      where: { venueId: reservation.venueId, reservationId: reservation.id, type: 'REDEEM' },
      select: { quantity: true },
    })
    const creditsUsed = redeems.reduce((sum, t) => sum + Math.abs(t.quantity), 0)
    const creditsRefundable = Math.floor((creditsUsed * cancellationPreview.refundPercent) / 100)

    res.json({
      confirmationCode: reservation.confirmationCode,
      status: reservation.status,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      duration: reservation.duration,
      partySize: reservation.partySize,
      guestName: reservation.guestName,
      product: reservation.product,
      assignedStaff: reservation.assignedStaff
        ? {
            firstName: reservation.assignedStaff.firstName,
            lastName: reservation.assignedStaff.lastName,
          }
        : null,
      table: reservation.table ? { number: reservation.table.number } : null,
      specialRequests: reservation.specialRequests,
      depositAmount: reservation.depositAmount,
      depositStatus: reservation.depositStatus,
      cancellation: {
        allowed: settings.cancellation.allowCustomerCancel,
        minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
        creditsUsed,
        creditsRefundable,
        refundPercent: cancellationPreview.refundPercent,
        policyLabel: cancellationPreview.label,
      },
      // Reschedule eligibility — same window as cancel, plus the venue toggle.
      // Only meaningful for class reservations (`classSessionId` present).
      reschedule: {
        allowed:
          settings.cancellation.allowCustomerReschedule &&
          !!(reservation as any).classSessionId &&
          (reservation.status === 'CONFIRMED' || reservation.status === 'PENDING') &&
          isWithinWindow(reservation.startsAt, settings.cancellation.minHoursBeforeStart),
        minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
        productId: (reservation as any).productId ?? null,
      },
    })
  } catch (error) {
    next(error)
  }
}

function isWithinWindow(startsAt: Date, minHoursBefore: number | null): boolean {
  if (minHoursBefore == null) return true
  const hoursUntilStart = (startsAt.getTime() - Date.now()) / 3_600_000
  return hoursUntilStart >= minHoursBefore
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/reschedule
 *
 * Body: { classSessionId: string, spotIds?: string[] }
 *
 * Same-product swap of a class reservation. Mirrors the venue's cancellation window
 * for the time check. Credit transactions are NOT touched (same product = same N
 * credits stay attached). For class swap to a different product, the customer must
 * cancel and re-book.
 */
export async function rescheduleReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const { classSessionId, spotIds } = req.body as { classSessionId: string; spotIds?: string[] }

    if (!classSessionId) {
      throw new BadRequestError('classSessionId es requerido')
    }

    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)
    const settings = await getReservationSettings(reservation.venueId)

    if (!settings.cancellation.allowCustomerReschedule) {
      throw new BadRequestError('Este negocio no permite cambiar horarios en línea. Contacta al negocio directamente.')
    }
    if (settings.cancellation.minHoursBeforeStart != null) {
      const hoursUntilStart = (reservation.startsAt.getTime() - Date.now()) / 3_600_000
      if (hoursUntilStart < settings.cancellation.minHoursBeforeStart) {
        throw new BadRequestError(
          `No puedes cambiar el horario con menos de ${settings.cancellation.minHoursBeforeStart} horas de anticipacion.`,
        )
      }
    }

    const updated = await reservationService.rescheduleClassReservation({
      venueId: reservation.venueId,
      reservationId: reservation.id,
      newClassSessionId: classSessionId,
      newSpotIds: Array.isArray(spotIds) ? spotIds : undefined,
      rescheduledBy: 'CUSTOMER',
      reason: req.body?.reason,
    })

    res.json({
      confirmationCode: updated.confirmationCode,
      status: updated.status,
      startsAt: updated.startsAt,
      endsAt: updated.endsAt,
      partySize: updated.partySize,
      spotIds: updated.spotIds,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Pure helper: given a reservation startsAt + venue cancellation policy, compute the
 * refund percent that WOULD apply if cancelled right now. Used both by the GET
 * preview and shown in the widget before the confirm step.
 */
function computeCancellationPreview(args: {
  startsAt: Date
  cancellationPolicy: {
    creditRefundMode: 'NEVER' | 'ALWAYS' | 'TIME_BASED'
    creditFreeRefundHoursBefore: number
    creditLateRefundPercent: number
  }
}): { refundPercent: number; label: string } {
  const { creditRefundMode, creditFreeRefundHoursBefore, creditLateRefundPercent } = args.cancellationPolicy
  if (creditRefundMode === 'NEVER') return { refundPercent: 0, label: 'NEVER' }
  if (creditRefundMode === 'ALWAYS') return { refundPercent: 100, label: 'ALWAYS' }
  const hoursUntilStart = (args.startsAt.getTime() - Date.now()) / 3_600_000
  if (hoursUntilStart >= creditFreeRefundHoursBefore) {
    return { refundPercent: 100, label: `TIME_BASED:free` }
  }
  return { refundPercent: Math.max(0, Math.min(100, creditLateRefundPercent)), label: `TIME_BASED:late` }
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/cancel
 */
export async function cancelReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Check if venue allows customer cancellation
    const settings = await getReservationSettings(reservation.venueId)
    if (!settings.cancellation.allowCustomerCancel) {
      throw new BadRequestError('La cancelacion en linea no esta permitida. Contacta al negocio directamente.')
    }

    // Check cancellation time window
    if (settings.cancellation.minHoursBeforeStart) {
      const minHours = settings.cancellation.minHoursBeforeStart
      const hoursUntilStart = (reservation.startsAt.getTime() - Date.now()) / (1000 * 60 * 60)
      if (hoursUntilStart < minHours) {
        throw new BadRequestError(`No se puede cancelar con menos de ${minHours} horas de anticipacion. Contacta al negocio directamente.`)
      }
    }

    const cancelled = await reservationService.cancelReservation(reservation.venueId, reservation.id, 'CUSTOMER', req.body?.reason)

    res.json({
      confirmationCode: cancelled.confirmationCode,
      status: cancelled.status,
      cancelledAt: cancelled.cancelledAt,
      depositStatus: cancelled.depositStatus,
      creditsRefunded: (cancelled as any).creditsRefunded ?? 0,
      refundPolicy: (cancelled as any).policyApplied ?? null,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// CLASS Reservation — Serializable transaction with capacity check
// ==========================================

async function createClassReservation(
  venueId: string,
  body: {
    classSessionId: string
    guestName: string
    guestPhone: string
    guestEmail?: string
    partySize?: number
    spotIds?: string[]
    specialRequests?: string
    creditItemBalanceId?: string
  },
  moduleConfig: any,
) {
  const requestedSpotIds = body.spotIds ?? []
  // If spotIds provided, partySize = number of spots selected
  const requestedPartySize = requestedSpotIds.length > 0 ? requestedSpotIds.length : (body.partySize ?? 1)
  const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const autoConfirm = moduleConfig?.scheduling?.autoConfirm ?? true
  const initialStatus: ReservationStatus = autoConfirm ? 'CONFIRMED' : 'PENDING'

  return reservationService.withSerializableRetry(async tx => {
    // Lock the ClassSession row and verify it exists + belongs to venue
    const sessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${body.classSessionId}
        AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (sessions.length === 0) {
      throw new NotFoundError('Sesion de clase no encontrada')
    }
    const session = sessions[0]

    if (session.status !== 'SCHEDULED') {
      throw new BadRequestError('Esta sesion de clase ya no acepta reservaciones')
    }

    // Verify the product is CLASS and active
    const product = await tx.product.findFirst({
      where: { id: session.productId, venueId },
      select: { type: true, active: true, layoutConfig: true, requireCreditForBooking: true },
    })
    if (!product || product.type !== 'CLASS') {
      throw new BadRequestError('El producto asociado no es una clase valida')
    }
    if (!product.active) {
      throw new BadRequestError('Este servicio ya no esta disponible')
    }

    // Block booking if product requires credit and none provided
    if (product.requireCreditForBooking && !body.creditItemBalanceId) {
      throw new BadRequestError('Este servicio requiere un credito para reservar. Compra un paquete de creditos primero.')
    }

    // Sum enrolled from active reservations
    // Note: FOR UPDATE cannot be used with aggregate functions in PostgreSQL.
    // The ClassSession row lock above + SERIALIZABLE isolation is sufficient.
    const enrolledResult = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("partySize"), 0) as total
      FROM "Reservation"
      WHERE "classSessionId" = ${body.classSessionId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    `
    const enrolled = Number(enrolledResult[0].total)
    const effectiveCapacity = Math.floor((session.capacity * onlinePercent) / 100)

    if (enrolled + requestedPartySize > effectiveCapacity) {
      throw new ConflictError(
        `No hay suficientes lugares disponibles. Disponibles: ${effectiveCapacity - enrolled}, solicitados: ${requestedPartySize}`,
      )
    }

    // Validate spotIds against product layout (if layout exists and spots were selected)
    if (requestedSpotIds.length > 0 && product.layoutConfig) {
      const layout = product.layoutConfig as { spots?: { id: string; enabled: boolean }[] }
      const validSpotIds = new Set((layout.spots ?? []).filter(s => s.enabled).map(s => s.id))

      for (const spotId of requestedSpotIds) {
        if (!validSpotIds.has(spotId)) {
          throw new BadRequestError(`Lugar "${spotId}" no es valido`)
        }
      }

      // Check that requested spots are not already taken
      const takenReservations = await tx.reservation.findMany({
        where: {
          classSessionId: body.classSessionId,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          spotIds: { hasSome: requestedSpotIds },
        },
        select: { spotIds: true },
      })
      if (takenReservations.length > 0) {
        const takenIds = takenReservations.flatMap(r => r.spotIds).filter(id => requestedSpotIds.includes(id))
        throw new ConflictError(`Los lugares ${takenIds.join(', ')} ya estan reservados`)
      }
    }

    const confirmationCode = reservationService.generateConfirmationCode()

    // Ensure uniqueness
    const existing = await tx.reservation.findUnique({
      where: { venueId_confirmationCode: { venueId, confirmationCode } },
      select: { id: true },
    })
    const finalCode = existing ? reservationService.generateConfirmationCode() : confirmationCode

    const reservation = await tx.reservation.create({
      data: {
        venueId,
        confirmationCode: finalCode,
        classSessionId: body.classSessionId,
        productId: session.productId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        duration: session.duration,
        status: initialStatus,
        channel: 'WEB',
        guestName: body.guestName,
        guestPhone: body.guestPhone,
        guestEmail: body.guestEmail ?? null,
        partySize: requestedPartySize,
        spotIds: requestedSpotIds,
        specialRequests: body.specialRequests ?? null,
        confirmedAt: autoConfirm ? new Date() : null,
        statusLog: [{ status: initialStatus, at: new Date().toISOString(), by: null }],
      },
    })

    // ---- Credit redemption (if creditItemBalanceId provided) ----
    // Charges N credits where N = requestedPartySize (one credit per seat).
    let creditRedeemed = false
    let creditsUsed = 0
    if (body.creditItemBalanceId) {
      // Find customer by email/phone
      const customer = await tx.customer.findFirst({
        where: {
          venueId,
          OR: [...(body.guestEmail ? [{ email: body.guestEmail }] : []), ...(body.guestPhone ? [{ phone: body.guestPhone }] : [])],
        },
      })

      if (!customer) {
        throw new BadRequestError('No se encontro el cliente para canjear creditos')
      }

      // Lock and verify balance
      const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
        SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
        FROM "CreditItemBalance"
        WHERE id = ${body.creditItemBalanceId}
        FOR UPDATE
      `

      if (balances.length === 0) {
        throw new BadRequestError('Balance de credito no encontrado')
      }

      const balance = balances[0]

      if (balance.productId !== session.productId) {
        throw new BadRequestError('El credito no corresponde al producto de esta clase')
      }

      if (balance.remainingQuantity < requestedPartySize) {
        throw new BadRequestError(
          `No tienes suficientes creditos. Disponibles: ${balance.remainingQuantity}, necesarios: ${requestedPartySize}. Compra mas creditos para continuar.`,
        )
      }

      // Verify purchase is active and not expired
      const purchase = await tx.creditPackPurchase.findUnique({
        where: { id: balance.creditPackPurchaseId },
        select: { status: true, expiresAt: true, customerId: true },
      })

      if (!purchase || purchase.customerId !== customer.id) {
        throw new BadRequestError('Credito no valido para este cliente')
      }

      if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
        throw new BadRequestError('Los creditos ya no estan activos')
      }

      if (purchase.expiresAt && purchase.expiresAt < new Date()) {
        throw new BadRequestError('Los creditos han expirado')
      }

      // Decrement balance by partySize (one credit per seat)
      await tx.creditItemBalance.update({
        where: { id: body.creditItemBalanceId },
        data: { remainingQuantity: { decrement: requestedPartySize } },
      })

      // Create single credit transaction with negative quantity = seats
      await tx.creditTransaction.create({
        data: {
          venueId,
          customerId: customer.id,
          creditPackPurchaseId: balance.creditPackPurchaseId,
          creditItemBalanceId: body.creditItemBalanceId,
          type: 'REDEEM',
          quantity: -requestedPartySize,
          reservationId: reservation.id,
          reason: requestedPartySize > 1 ? `Reserva de ${requestedPartySize} lugares` : null,
        },
      })

      // Check if purchase is exhausted
      const remainingBalances = await tx.creditItemBalance.findMany({
        where: {
          creditPackPurchaseId: balance.creditPackPurchaseId,
          remainingQuantity: { gt: 0 },
        },
      })

      if (remainingBalances.length === 0) {
        await tx.creditPackPurchase.update({
          where: { id: balance.creditPackPurchaseId },
          data: { status: CreditPurchaseStatus.EXHAUSTED },
        })
      }

      creditRedeemed = true
      creditsUsed = requestedPartySize
      logger.info(
        `✅ [CREDIT REDEEM] ${requestedPartySize} credit(s) redeemed for reservation ${reservation.confirmationCode} | balance=${body.creditItemBalanceId}`,
      )
    }

    logger.info(
      `✅ [CLASS BOOKING] Created ${reservation.confirmationCode} | venue=${venueId} session=${body.classSessionId} party=${requestedPartySize} enrolled=${enrolled}→${enrolled + requestedPartySize}/${effectiveCapacity}${creditRedeemed ? ` (${creditsUsed} credit${creditsUsed > 1 ? 's' : ''})` : ''}`,
    )

    return { ...reservation, creditRedeemed, creditsUsed }
  })
}

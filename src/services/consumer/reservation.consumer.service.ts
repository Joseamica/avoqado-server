import { CreditPurchaseStatus, ReservationChannel, ReservationStatus, VenueStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { calculateApplicationFee, toStripeAmount } from '@/services/payments/providers/money'
import { getProvider } from '@/services/payments/provider-registry'
import logger from '@/config/logger'

type ConsumerReservationInput = {
  startsAt?: Date
  endsAt?: Date
  duration?: number
  guestName?: string
  guestPhone?: string
  guestEmail?: string
  partySize?: number
  productId?: string
  classSessionId?: string
  spotIds?: string[]
  specialRequests?: string
  creditItemBalanceId?: string
}

function displayName(consumer: { firstName: string | null; lastName: string | null; email: string | null }) {
  const name = [consumer.firstName, consumer.lastName].filter(Boolean).join(' ').trim()
  return name || consumer.email || 'Cliente Avoqado'
}

async function resolveVenue(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: {
      slug: venueSlug,
      active: true,
      status: { notIn: [VenueStatus.SUSPENDED, VenueStatus.ADMIN_SUSPENDED, VenueStatus.CLOSED] },
    },
    select: { id: true, slug: true, name: true },
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

async function previewDepositRequirement(venueId: string, input: ConsumerReservationInput, settings: any) {
  if (!settings.deposits?.enabled || settings.deposits.mode === 'none') {
    return { required: false, amount: null as any }
  }

  if (settings.deposits.mode === 'card_hold') {
    throw new BadRequestError('El modo card_hold aun no esta soportado para reservas en la app')
  }

  let servicePrice: number | null = null
  if (input.productId) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, venueId, active: true },
      select: { price: true },
    })
    servicePrice = product?.price ? Number(product.price) : null
  }

  return reservationService.calculateDepositAmount(settings.deposits, input.partySize ?? 1, servicePrice)
}

function getStripeChargeBounds() {
  return {
    min: Number(process.env.STRIPE_MIN_CHARGE_MXN_CENTS ?? 1000),
    max: Number(process.env.STRIPE_MAX_CHARGE_MXN_CENTS ?? 5000000),
  }
}

function buildConsumerPaymentReturnUrl(path: 'success' | 'cancelled', venueSlug: string, reservationId: string) {
  const baseUrl = (process.env.CONSUMER_APP_RETURN_URL || 'avoqado://payment-result').replace(/\/$/, '')
  const params = new URLSearchParams({
    payment: path,
    venueSlug,
    reservationId,
  })
  const checkoutSessionParam = path === 'success' ? '&session_id={CHECKOUT_SESSION_ID}' : ''
  return `${baseUrl}?${params.toString()}${checkoutSessionParam}`
}

async function ensureVenueCustomer(venueId: string, consumerId: string) {
  const consumer = await prisma.consumer.findUnique({
    where: { id: consumerId },
    select: { id: true, email: true, phone: true, firstName: true, lastName: true, active: true },
  })
  if (!consumer || !consumer.active) throw new BadRequestError('Cuenta de consumidor no disponible')

  const existingByConsumer = await prisma.customer.findFirst({
    where: { venueId, consumerId },
  })
  if (existingByConsumer) return { consumer, customer: existingByConsumer }

  const existingByEmail = consumer.email
    ? await prisma.customer.findUnique({
        where: { venueId_email: { venueId, email: consumer.email } },
      })
    : null

  if (existingByEmail) {
    const customer = await prisma.customer.update({
      where: { id: existingByEmail.id },
      data: {
        consumerId,
        ...(consumer.firstName && !existingByEmail.firstName ? { firstName: consumer.firstName } : {}),
        ...(consumer.lastName && !existingByEmail.lastName ? { lastName: consumer.lastName } : {}),
        ...(consumer.phone && !existingByEmail.phone ? { phone: consumer.phone } : {}),
      },
    })
    return { consumer, customer }
  }

  const existingByPhone = consumer.phone
    ? await prisma.customer.findUnique({
        where: { venueId_phone: { venueId, phone: consumer.phone } },
      })
    : null

  if (existingByPhone) {
    const customer = await prisma.customer.update({
      where: { id: existingByPhone.id },
      data: {
        consumerId,
        ...(consumer.email && !existingByPhone.email ? { email: consumer.email } : {}),
        ...(consumer.firstName && !existingByPhone.firstName ? { firstName: consumer.firstName } : {}),
        ...(consumer.lastName && !existingByPhone.lastName ? { lastName: consumer.lastName } : {}),
      },
    })
    return { consumer, customer }
  }

  const customer = await prisma.customer.create({
    data: {
      venueId,
      consumerId,
      email: consumer.email,
      phone: consumer.phone,
      firstName: consumer.firstName,
      lastName: consumer.lastName,
      provider: 'EMAIL',
    },
  })

  return { consumer, customer }
}

export async function createReservationForConsumer(consumerId: string, venueSlug: string, input: ConsumerReservationInput) {
  const venue = await resolveVenue(venueSlug)
  const settings = await getReservationSettings(venue.id)

  if (!settings.publicBooking.enabled) {
    throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
  }

  const { consumer, customer } = await ensureVenueCustomer(venue.id, consumerId)
  const guestName = input.guestName ?? displayName(consumer)
  const guestEmail = input.guestEmail ?? consumer.email ?? undefined
  const guestPhone = input.guestPhone ?? consumer.phone ?? undefined

  if (settings.publicBooking.requirePhone && !guestPhone) {
    throw new BadRequestError('Agrega un telefono a tu perfil para reservar este negocio')
  }
  if (settings.publicBooking.requireEmail && !guestEmail) {
    throw new BadRequestError('Agrega un correo a tu perfil para reservar este negocio')
  }

  if (input.classSessionId) {
    const reservation = await createClassReservationForConsumer(
      venue.id,
      {
        classSessionId: input.classSessionId,
        guestName,
        guestPhone: guestPhone ?? '',
        guestEmail,
        partySize: input.partySize,
        spotIds: input.spotIds,
        specialRequests: input.specialRequests,
        creditItemBalanceId: input.creditItemBalanceId,
        customerId: customer.id,
      },
      settings,
    )

    return {
      confirmationCode: reservation.confirmationCode,
      cancelSecret: reservation.cancelSecret,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      status: reservation.status,
      depositRequired: false,
      depositAmount: null,
      creditRedeemed: reservation.creditRedeemed || false,
      creditsUsed: reservation.creditsUsed || 0,
    }
  }

  if (!input.startsAt || !input.endsAt || !input.duration) {
    throw new BadRequestError('startsAt, endsAt y duration son requeridos')
  }

  const depositPreview = await previewDepositRequirement(venue.id, input, settings)
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
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      duration: input.duration,
      channel: ReservationChannel.APP,
      customerId: customer.id,
      guestName,
      guestPhone,
      guestEmail,
      partySize: input.partySize,
      productId: input.productId,
      specialRequests: input.specialRequests,
    },
    undefined,
    settings,
  )

  let checkoutUrl: string | null = null
  if (reservation.depositAmount && stripeMerchant) {
    const stripeAmount = toStripeAmount(reservation.depositAmount)
    const applicationFeeAmount = calculateApplicationFee(stripeAmount, stripeMerchant.platformFeeBps)
    const provider = getProvider(stripeMerchant)
    const session = await provider.createCheckoutSession(stripeMerchant, {
      amount: stripeAmount,
      currency: 'mxn',
      applicationFeeAmount,
      successUrl: buildConsumerPaymentReturnUrl('success', venue.slug, reservation.id),
      cancelUrl: buildConsumerPaymentReturnUrl('cancelled', venue.slug, reservation.id),
      expiresAt: reservation.depositExpiresAt ?? new Date(Date.now() + 30 * 60_000),
      customerEmail: reservation.guestEmail ?? undefined,
      metadata: {
        type: 'reservation_deposit',
        source: 'consumer_app',
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

  return {
    confirmationCode: reservation.confirmationCode,
    cancelSecret: reservation.cancelSecret,
    startsAt: reservation.startsAt,
    endsAt: reservation.endsAt,
    status: reservation.status,
    depositRequired: !!reservation.depositAmount,
    depositAmount: reservation.depositAmount ? Number(reservation.depositAmount) : null,
    checkoutUrl,
  }
}

export async function getConsumerReservations(consumerId: string) {
  const customers = await prisma.customer.findMany({
    where: { consumerId },
    select: { id: true },
  })
  const customerIds = customers.map(customer => customer.id)
  if (customerIds.length === 0) {
    return { upcoming: [], past: [] }
  }

  const now = new Date()
  const [upcoming, past] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        customerId: { in: customerIds },
        startsAt: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: reservationSelect,
      orderBy: { startsAt: 'asc' },
      take: 50,
    }),
    prisma.reservation.findMany({
      where: {
        customerId: { in: customerIds },
        startsAt: { lt: now },
      },
      select: reservationSelect,
      orderBy: { startsAt: 'desc' },
      take: 50,
    }),
  ])

  return { upcoming, past }
}

const reservationSelect = {
  confirmationCode: true,
  cancelSecret: true,
  status: true,
  startsAt: true,
  endsAt: true,
  duration: true,
  partySize: true,
  spotIds: true,
  guestName: true,
  venue: { select: { name: true, slug: true, logo: true, timezone: true } },
  product: { select: { id: true, name: true, price: true, type: true } },
} as const

async function createClassReservationForConsumer(
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
    customerId: string
  },
  moduleConfig: any,
) {
  const requestedSpotIds = body.spotIds ?? []
  const requestedPartySize = requestedSpotIds.length > 0 ? requestedSpotIds.length : (body.partySize ?? 1)
  const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const autoConfirm = moduleConfig?.scheduling?.autoConfirm ?? true
  const initialStatus: ReservationStatus = autoConfirm ? 'CONFIRMED' : 'PENDING'

  return reservationService.withSerializableRetry(async tx => {
    const sessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${body.classSessionId}
        AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (sessions.length === 0) throw new NotFoundError('Sesion de clase no encontrada')

    const session = sessions[0]
    if (session.status !== 'SCHEDULED') {
      throw new BadRequestError('Esta sesion de clase ya no acepta reservaciones')
    }

    const product = await tx.product.findFirst({
      where: { id: session.productId, venueId },
      select: { type: true, active: true, layoutConfig: true, requireCreditForBooking: true },
    })
    if (!product || product.type !== 'CLASS') throw new BadRequestError('El producto asociado no es una clase valida')
    if (!product.active) throw new BadRequestError('Este servicio ya no esta disponible')
    if (product.requireCreditForBooking && !body.creditItemBalanceId) {
      throw new BadRequestError('Este servicio requiere un credito para reservar. Compra un paquete de creditos primero.')
    }

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

    if (requestedSpotIds.length > 0 && product.layoutConfig) {
      const layout = product.layoutConfig as { spots?: { id: string; enabled: boolean }[] }
      const validSpotIds = new Set((layout.spots ?? []).filter(s => s.enabled).map(s => s.id))

      for (const spotId of requestedSpotIds) {
        if (!validSpotIds.has(spotId)) throw new BadRequestError(`Lugar "${spotId}" no es valido`)
      }

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
        channel: ReservationChannel.APP,
        customerId: body.customerId,
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

    let creditRedeemed = false
    let creditsUsed = 0
    if (body.creditItemBalanceId) {
      const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
        SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
        FROM "CreditItemBalance"
        WHERE id = ${body.creditItemBalanceId}
        FOR UPDATE
      `
      if (balances.length === 0) throw new BadRequestError('Balance de credito no encontrado')

      const balance = balances[0]
      if (balance.productId !== session.productId) throw new BadRequestError('El credito no corresponde al producto de esta clase')
      if (balance.remainingQuantity < requestedPartySize) {
        throw new BadRequestError(
          `No tienes suficientes creditos. Disponibles: ${balance.remainingQuantity}, necesarios: ${requestedPartySize}. Compra mas creditos para continuar.`,
        )
      }

      const purchase = await tx.creditPackPurchase.findUnique({
        where: { id: balance.creditPackPurchaseId },
        select: { status: true, expiresAt: true, customerId: true },
      })
      if (!purchase || purchase.customerId !== body.customerId) throw new BadRequestError('Credito no valido para este cliente')
      if (purchase.status !== CreditPurchaseStatus.ACTIVE) throw new BadRequestError('Los creditos ya no estan activos')
      if (purchase.expiresAt && purchase.expiresAt < new Date()) throw new BadRequestError('Los creditos han expirado')

      await tx.creditItemBalance.update({
        where: { id: body.creditItemBalanceId },
        data: { remainingQuantity: { decrement: requestedPartySize } },
      })

      await tx.creditTransaction.create({
        data: {
          venueId,
          customerId: body.customerId,
          creditPackPurchaseId: balance.creditPackPurchaseId,
          creditItemBalanceId: body.creditItemBalanceId,
          type: 'REDEEM',
          quantity: -requestedPartySize,
          reservationId: reservation.id,
          reason: requestedPartySize > 1 ? `Reserva de ${requestedPartySize} lugares` : null,
        },
      })

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
    }

    logger.info(
      `✅ [CONSUMER CLASS BOOKING] Created ${reservation.confirmationCode} | venue=${venueId} session=${body.classSessionId} party=${requestedPartySize}`,
    )

    return { ...reservation, creditRedeemed, creditsUsed }
  })
}

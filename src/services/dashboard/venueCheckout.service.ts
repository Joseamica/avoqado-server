/**
 * Venue Checkout Service
 *
 * Powers the embeddable checkout widget (`<avoqado-checkout data-venue="...">`).
 * Charges go directly to a VENUE's connected processor (Stripe Connect / Mercado
 * Pago) for a host- or customer-provided amount — WITHOUT a payment link.
 *
 * The data model already supports this: `CheckoutSession.paymentLinkId` is
 * optional and the session is anchored on `ecommerceMerchantId`. These sessions
 * carry `metadata.type = 'venue_checkout'` so the Stripe webhook routes them to
 * `finalizeVenueCheckout` (Order + Payment, no link-specific steps). Mercado
 * Pago sessions are finalized by the existing generic IPN handler, which keys
 * off `external_reference` + merchant and is link-agnostic.
 *
 * Reuses the venue-level primitives the payment-link service already relies on:
 * the connected `EcommerceMerchant`, `platformFeeBps`, branding, and the money
 * helpers — so fee math and Stripe/MP integration stay identical to links.
 *
 * @module services/dashboard/venueCheckout
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { nanoid } from 'nanoid'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '@/services/payments/providers/money'
import { getVatRateBps } from '@/services/superadmin/platformSettings.service'
import {
  getPaymentLinkBranding,
  mapStripeMethodToPaymentMethod,
  mapStripeCardBrandToEnum,
  finalizeMercadoPagoCheckout,
} from '@/services/dashboard/paymentLink.service'

// Same Stripe charge bounds as the payment-link flow (MXN cents). Defaults:
// $10 min, $50,000 max per transaction.
function getStripeChargeBounds() {
  return {
    min: Number(process.env.STRIPE_MIN_CHARGE_MXN_CENTS ?? 1000),
    max: Number(process.env.STRIPE_MAX_CHARGE_MXN_CENTS ?? 5000000),
  }
}

const DEFAULT_CURRENCY = 'MXN'

type ResolvedMerchant = {
  id: string
  chargesEnabled: boolean
  platformFeeBps: number
  providerCredentials: unknown
  providerMerchantId: string | null
  venueId: string
  provider: { code: string } | null
}

/**
 * Resolve a venue (by public slug) and its single active inline checkout
 * merchant. Stripe Connect is preferred over Mercado Pago when both are active,
 * so `checkout-info` and the charge endpoints can never disagree about which
 * account gets the money.
 */
async function resolveVenueAndMerchant(venueSlug: string): Promise<{
  venue: { id: string; name: string; slug: string; logo: string | null }
  merchant: ResolvedMerchant | null
}> {
  const venue = await prisma.venue.findUnique({
    where: { slug: venueSlug },
    select: { id: true, name: true, slug: true, logo: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const select = {
    id: true,
    chargesEnabled: true,
    platformFeeBps: true,
    providerCredentials: true,
    providerMerchantId: true,
    venueId: true,
    provider: { select: { code: true } },
  } as const

  const stripe = await prisma.ecommerceMerchant.findFirst({
    where: { venueId: venue.id, active: true, provider: { code: 'STRIPE_CONNECT' } },
    select,
  })
  const merchant =
    stripe ??
    (await prisma.ecommerceMerchant.findFirst({
      where: { venueId: venue.id, active: true, provider: { code: 'MERCADO_PAGO' } },
      select,
    }))

  return { venue, merchant: (merchant as ResolvedMerchant | null) ?? null }
}

function paymentMethodForProvider(code: string | undefined): 'STRIPE_HOSTED' | 'MERCADO_PAGO_BRICKS' | 'INLINE_CARD' {
  if (code === 'STRIPE_CONNECT') return 'STRIPE_HOSTED'
  if (code === 'MERCADO_PAGO') return 'MERCADO_PAGO_BRICKS'
  return 'INLINE_CARD'
}

/**
 * GET /public/venues/:venueSlug/checkout-info
 *
 * Returns the venue's branding + which inline method is available. When the
 * venue has no active Stripe/MP merchant (or Stripe charges aren't enabled
 * yet) it returns `canTransact:false` with a reason — the widget/dashboard
 * surface "you can't charge until you connect a processor".
 */
export async function getVenueCheckoutInfo(venueSlug: string) {
  const { venue, merchant } = await resolveVenueAndMerchant(venueSlug)
  const branding = await getPaymentLinkBranding(venue.id)
  const base = { venue: { name: venue.name, slug: venue.slug, logo: venue.logo }, branding, currency: DEFAULT_CURRENCY }

  if (!merchant) {
    return { ...base, canTransact: false as const, reason: 'NO_PROCESSOR' as const }
  }

  const code = merchant.provider?.code
  if (code === 'STRIPE_CONNECT' && !merchant.chargesEnabled) {
    return { ...base, canTransact: false as const, reason: 'CHARGES_DISABLED' as const }
  }

  return {
    ...base,
    canTransact: true as const,
    paymentMethod: paymentMethodForProvider(code),
  }
}

/** Validate a host/customer-provided amount (major units). */
function requireAmount(amount: number | undefined): number {
  if (!amount || amount <= 0 || !Number.isFinite(amount)) {
    throw new BadRequestError('El monto es requerido y debe ser mayor a cero')
  }
  return amount
}

/**
 * POST /public/venues/:venueSlug/checkout/payment-intent
 * Stripe Elements (inline) — creates a PaymentIntent on the venue's connected
 * account with Avoqado's application_fee and a CheckoutSession (no link).
 */
export async function createStripePaymentIntentForVenue(venueSlug: string, input: { amount?: number; customerEmail?: string }) {
  const { venue, merchant } = await resolveVenueAndMerchant(venueSlug)
  if (!merchant || merchant.provider?.code !== 'STRIPE_CONNECT') {
    throw new BadRequestError('Este venue no tiene Stripe Connect activo para cobrar en línea')
  }
  if (!merchant.chargesEnabled) {
    throw new BadRequestError('La cuenta de Stripe del comercio aún no está activa')
  }
  const connectAccountId = (merchant.providerCredentials as { connectAccountId?: string } | null)?.connectAccountId
  if (!connectAccountId) {
    throw new BadRequestError('La cuenta Stripe Connect del comercio no está configurada')
  }

  const chargeAmount = requireAmount(input.amount)
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  const bounds = getStripeChargeBounds()
  if (stripeAmount < bounds.min) throw new BadRequestError('El monto es menor al mínimo permitido por Stripe')
  if (stripeAmount > bounds.max) throw new BadRequestError('El monto excede el máximo permitido por transacción')

  const vatRateBps = await getVatRateBps()
  const applicationFeeAmount = calculateApplicationFeeWithVAT(stripeAmount, merchant.platformFeeBps, vatRateBps)

  const description = `Pago a ${venue.name}`
  const metadata: Record<string, string> = {
    type: 'venue_checkout',
    venueId: venue.id,
    venueSlug: venue.slug,
    ecommerceMerchantId: merchant.id,
    flow: 'stripe_elements',
  }

  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-02-25.clover' as any })

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: stripeAmount,
      currency: DEFAULT_CURRENCY.toLowerCase(),
      application_fee_amount: applicationFeeAmount,
      automatic_payment_methods: { enabled: true },
      receipt_email: input.customerEmail,
      description,
      statement_descriptor_suffix: 'AVOQADO',
      metadata,
    },
    {
      stripeAccount: connectAccountId,
      idempotencyKey: `venueCheckout:${venue.id}:pi:${nanoid(10)}`,
    },
  )

  await prisma.checkoutSession.create({
    data: {
      sessionId: paymentIntent.id,
      ecommerceMerchantId: merchant.id,
      // No paymentLinkId — this is a direct venue checkout.
      amount: new Prisma.Decimal(chargeAmount),
      currency: DEFAULT_CURRENCY,
      description,
      customerEmail: input.customerEmail,
      applicationFeeCents: applicationFeeAmount,
      metadata: {
        type: 'venue_checkout',
        applicationFeeCents: applicationFeeAmount,
        platformFeeBps: merchant.platformFeeBps,
        vatRateBps,
        provider: 'STRIPE_CONNECT',
        flow: 'stripe_elements',
        venueId: venue.id,
      } as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  })

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    logger.error('STRIPE_PUBLISHABLE_KEY env var is not set — venue checkout cannot render Stripe Elements', { venueSlug })
    throw new BadRequestError('El procesador de pagos está mal configurado (falta clave publicable). Contacta a soporte de Avoqado.')
  }

  logger.info('Stripe PaymentIntent created for venue checkout', {
    paymentIntentId: paymentIntent.id,
    venueId: venue.id,
    venueSlug,
    amountCents: stripeAmount,
    applicationFeeCents: applicationFeeAmount,
  })

  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    publishableKey,
    connectAccountId,
    amount: chargeAmount,
    currency: DEFAULT_CURRENCY,
    applicationFeeCents: applicationFeeAmount,
  }
}

/**
 * POST /public/venues/:venueSlug/checkout/mp-payment-intent
 * Mercado Pago Bricks (inline) — returns the seller publicKey + sessionId so
 * the Brick can tokenize the card. Mirrors the payment-link MP flow.
 */
export async function createMercadoPagoPaymentIntentForVenue(venueSlug: string, input: { amount?: number; customerEmail?: string }) {
  const { loadCredentials } = await import('@/services/mercado-pago/connection.service')

  const { venue, merchant } = await resolveVenueAndMerchant(venueSlug)
  if (!merchant || merchant.provider?.code !== 'MERCADO_PAGO') {
    throw new BadRequestError('Este venue no tiene Mercado Pago activo para cobrar en línea')
  }

  const creds = await loadCredentials(merchant.id)
  if (!creds) throw new BadRequestError('La cuenta de Mercado Pago del comercio no está conectada')
  if (creds.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError('El token de Mercado Pago expiró. El comercio debe reconectar.')
  }

  const chargeAmount = requireAmount(input.amount)

  // MercadoPago Mexico rejects amounts below its platform minimum (~$10 MXN)
  // with a generic 2072 at payment time. Fail fast with a clear message.
  const mpMinMxn = Number(process.env.MP_MIN_CHARGE_MXN ?? 5)
  if (chargeAmount < mpMinMxn) {
    throw new BadRequestError(`El monto mínimo para pagar con Mercado Pago es $${mpMinMxn} MXN`)
  }

  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  const vatRateBps = await getVatRateBps()
  const applicationFeeCents = calculateApplicationFeeWithVAT(stripeAmount, merchant.platformFeeBps, vatRateBps)

  const description = `Pago a ${venue.name}`
  const sessionId = `cs_mp_${nanoid(16)}`

  await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: merchant.id,
      amount: new Prisma.Decimal(chargeAmount),
      currency: DEFAULT_CURRENCY,
      description,
      customerEmail: input.customerEmail,
      applicationFeeCents,
      metadata: {
        type: 'venue_checkout',
        applicationFeeCents,
        platformFeeBps: merchant.platformFeeBps,
        vatRateBps,
        provider: 'MERCADO_PAGO',
        flow: 'mp_bricks',
        venueId: venue.id,
      } as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  })

  logger.info('MP Bricks payment intent created for venue checkout', {
    sessionId,
    venueId: venue.id,
    venueSlug,
    amountMxn: chargeAmount,
    applicationFeeCents,
  })

  return {
    sessionId,
    publicKey: creds.publicKey,
    mpUserId: creds.mpUserId,
    amountMxn: chargeAmount,
    applicationFeeMxn: applicationFeeCents / 100,
    currency: DEFAULT_CURRENCY,
    description,
  }
}

/**
 * POST /public/venues/:venueSlug/checkout/mp-pay
 * Brick onSubmit callback — creates the MP payment on the seller's account.
 * Authoritative status arrives later via the generic IPN handler.
 */
export async function executeMercadoPagoPaymentForVenue(
  venueSlug: string,
  sessionId: string,
  input: {
    token: string
    paymentMethodId: string
    installments: number
    issuerId?: string
    payer: { email: string; firstName?: string; lastName?: string; identification?: { type: string; number: string } }
  },
) {
  const { loadCredentials } = await import('@/services/mercado-pago/connection.service')
  const { createPayment } = await import('@/services/mercado-pago/payment.service')

  const venue = await prisma.venue.findUnique({ where: { slug: venueSlug }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    include: { ecommerceMerchant: { include: { provider: { select: { code: true } } } } },
  })
  if (!session) throw new NotFoundError('Sesión de pago no encontrada')
  if (session.status !== 'PENDING') throw new BadRequestError(`Esta sesión ya fue procesada (status=${session.status})`)
  if (session.ecommerceMerchant.venueId !== venue.id) {
    throw new BadRequestError('La sesión no pertenece a este venue')
  }
  if (session.ecommerceMerchant.provider?.code !== 'MERCADO_PAGO') {
    throw new BadRequestError('Esta sesión no usa Mercado Pago')
  }

  const creds = await loadCredentials(session.ecommerceMerchantId)
  if (!creds) throw new BadRequestError('Credenciales de Mercado Pago no disponibles')

  const payment = await createPayment({
    accessToken: creds.accessToken,
    token: input.token,
    paymentMethodId: input.paymentMethodId,
    installments: input.installments,
    issuerId: input.issuerId,
    orderId: session.sessionId,
    amountMxn: Number(session.amount),
    applicationFeeMxn: (session.applicationFeeCents ?? 0) / 100,
    description: session.description ?? 'Pago',
    payerEmail: input.payer.email,
    payerFirstName: input.payer.firstName,
    payerLastName: input.payer.lastName,
    payerIdentificationType: input.payer.identification?.type,
    payerIdentificationNumber: input.payer.identification?.number,
    idempotencyKey: session.sessionId,
  })

  const optimisticStatus =
    payment.status === 'approved' || payment.status === 'authorized'
      ? 'COMPLETED'
      : payment.status === 'rejected' || payment.status === 'cancelled'
        ? 'CANCELLED'
        : 'PENDING'

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      mpPaymentId: String(payment.id),
      status: optimisticStatus,
      completedAt: optimisticStatus === 'COMPLETED' ? new Date() : null,
    },
  })

  // Record Order + Payment on approval (idempotent; IPN also calls this).
  if (optimisticStatus === 'COMPLETED') {
    await finalizeMercadoPagoCheckout({ sessionId, mpPaymentId: payment.id }).catch(err =>
      logger.error('finalizeMercadoPagoCheckout failed (venue optimistic path)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  logger.info('MP Bricks payment created for venue checkout', { sessionId, paymentId: payment.id, status: payment.status })

  return {
    paymentId: payment.id,
    status: payment.status,
    statusDetail: payment.status_detail,
    threeDsRedirectUrl: payment.three_ds_redirect_url,
  }
}

/**
 * GET /public/venues/:venueSlug/checkout/session/:sessionId
 * Poll session status. Validates the session belongs to the venue (no
 * cross-venue info leak) and exposes receipt/card details once COMPLETED.
 */
export async function getVenueCheckoutSessionStatus(venueSlug: string, sessionId: string) {
  const venue = await prisma.venue.findUnique({ where: { slug: venueSlug }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      status: true,
      amount: true,
      currency: true,
      completedAt: true,
      errorMessage: true,
      ecommerceMerchant: { select: { venueId: true } },
    },
  })
  if (!session) throw new NotFoundError('Sesión de pago no encontrada')
  if (session.ecommerceMerchant.venueId !== venue.id) {
    throw new NotFoundError('Sesión de pago no encontrada')
  }

  let payment: { receiptUrl: string | null; cardBrand: string | null; last4: string | null } | null = null
  if (session.status === 'COMPLETED') {
    const p = await prisma.payment.findFirst({
      where: { processorId: sessionId },
      select: { receiptUrl: true, cardBrand: true, maskedPan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (p) {
      payment = {
        receiptUrl: p.receiptUrl,
        cardBrand: p.cardBrand,
        last4: p.maskedPan ? p.maskedPan.replace(/^[*]+/, '').slice(-4) : null,
      }
    }
  }

  return {
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    completedAt: session.completedAt,
    errorMessage: session.errorMessage,
    payment,
  }
}

/**
 * Webhook finalizer for `metadata.type === 'venue_checkout'` Stripe sessions.
 * Records an Order (MANUAL_ENTRY, source WEB, no staff) + a Payment against the
 * venue. Deliberately skips every payment-link-specific step (no link counters,
 * no commission attribution, no ITEM order, no inventory). Idempotent: a session
 * already COMPLETED is a no-op (webhook retry).
 *
 * Mirrors the Payment-recording half of `finalizePaymentLinkCheckout`.
 */
export async function finalizeVenueCheckout(args: {
  stripeSessionId: string
  paymentIntentId?: string | null
  amountPaidCents?: number | null
  stripePaymentMethodType?: string | null
}) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: args.stripeSessionId },
    include: {
      ecommerceMerchant: {
        select: { id: true, venueId: true, providerCredentials: true, provider: { select: { code: true } } },
      },
    },
  })

  if (!session) {
    logger.warn('⚠️ [STRIPE VENUE-CHECKOUT WEBHOOK] No session found', { stripeSessionId: args.stripeSessionId })
    return
  }
  if (session.status === 'COMPLETED') return // webhook retry — no-op

  const venueId = session.ecommerceMerchant.venueId

  // Best-effort charge details (card brand / last4 / receipt URL) from Stripe.
  const chargeDetails: { cardBrand: string | null; last4: string | null; receiptUrl: string | null } = {
    cardBrand: null,
    last4: null,
    receiptUrl: null,
  }
  const connectAccountId = (session.ecommerceMerchant.providerCredentials as { connectAccountId?: string } | null)?.connectAccountId
  if (connectAccountId && args.paymentIntentId && session.ecommerceMerchant.provider?.code === 'STRIPE_CONNECT') {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-02-25.clover' as any })
      const pi = await stripe.paymentIntents.retrieve(
        args.paymentIntentId,
        { expand: ['latest_charge'] },
        { stripeAccount: connectAccountId },
      )
      const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null
      if (charge) {
        chargeDetails.receiptUrl = charge.receipt_url ?? null
        const card = (charge.payment_method_details as { card?: { brand?: string; last4?: string } } | null)?.card
        chargeDetails.cardBrand = card?.brand ?? null
        chargeDetails.last4 = card?.last4 ?? null
      }
    } catch (err) {
      logger.warn('Failed to fetch Stripe charge details for venue checkout (non-fatal)', {
        paymentIntentId: args.paymentIntentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const metadata = (session.metadata ?? {}) as Record<string, any>
  const stripePaymentIntentId = args.paymentIntentId ?? null
  const gross = session.amount
  const feeAmount = session.applicationFeeCents ? new Prisma.Decimal(session.applicationFeeCents).div(100) : new Prisma.Decimal(0)
  const netAmount = gross.sub(feeAmount).gte(0) ? gross.sub(feeAmount) : new Prisma.Decimal(0)
  const feePercentage = gross.gt(0) ? feeAmount.div(gross).toDecimalPlaces(4) : new Prisma.Decimal(0)
  const method = mapStripeMethodToPaymentMethod(args.stripePaymentMethodType)

  await prisma.$transaction(async tx => {
    await tx.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        metadata: {
          ...metadata,
          stripePaymentIntentId,
          ...(args.amountPaidCents != null ? { stripeAmountPaidCents: args.amountPaidCents } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    })

    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber: `VC-${Date.now()}`,
        type: 'MANUAL_ENTRY',
        source: 'WEB',
        customerEmail: session.customerEmail,
        subtotal: gross,
        discountAmount: 0,
        taxAmount: 0,
        tipAmount: 0,
        total: gross,
        paidAmount: gross,
        remainingBalance: 0,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        completedAt: new Date(),
      },
    })

    await tx.payment.create({
      data: {
        venueId,
        orderId: order.id,
        ecommerceMerchantId: session.ecommerceMerchant.id,
        amount: gross,
        tipAmount: 0,
        method,
        source: 'WEB',
        status: 'COMPLETED',
        type: 'FAST',
        processor: 'stripe',
        processorId: stripePaymentIntentId,
        feePercentage,
        feeAmount,
        netAmount,
        cardBrand: mapStripeCardBrandToEnum(chargeDetails.cardBrand),
        maskedPan: chargeDetails.last4 ? `************${chargeDetails.last4}` : undefined,
        receiptUrl: chargeDetails.receiptUrl ?? undefined,
        idempotencyKey: stripePaymentIntentId ?? undefined,
      },
    })
  })

  logger.info('Stripe venue checkout finalized', {
    stripeSessionId: args.stripeSessionId,
    venueId,
    amount: gross.toString(),
  })
}

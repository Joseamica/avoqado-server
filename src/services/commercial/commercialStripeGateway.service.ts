import Stripe from 'stripe'
import AppError from '@/errors/AppError'
import type { CommercialStripeGateway } from '@/services/commercial/commercialStripeCheckout.service'
import type { CommercialQuoteLineV1, CommercialQuoteV1 } from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'

interface CommercialBillingContext {
  venueId: string
  venueName: string
  venueSlug: string
  organizationId: string
  billingEmail: string | null
  stripeCustomerId: string | null
}

interface CommercialStripeClient {
  taxRates: {
    create(params: Stripe.TaxRateCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>
  }
  coupons: {
    create(params: Stripe.CouponCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string }>
  }
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<{ id: string; url: string | null }>
    }
  }
}

interface CommercialStripeGatewayDependencies {
  stripe: CommercialStripeClient
  loadBillingContext(acceptanceId: string): Promise<CommercialBillingContext | null>
  frontendUrl: string
}

function gatewayError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function assertMinor(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada contiene importes inválidos.', 500)
  }
}

function sum(lines: CommercialQuoteLineV1[], field: keyof CommercialQuoteLineV1): number {
  return lines.reduce((total, line) => total + (line[field] as number), 0)
}

function validateFrozenQuote(value: unknown, quoteId: string): CommercialQuoteV1 {
  if (!value || typeof value !== 'object') {
    throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada no es válida.', 500)
  }
  const quote = value as CommercialQuoteV1
  if (
    quote.schemaVersion !== 1 ||
    quote.quoteId !== quoteId ||
    quote.market !== 'MX' ||
    quote.currency !== 'MXN' ||
    !Array.isArray(quote.lines) ||
    quote.lines.length === 0 ||
    !quote.totals ||
    !quote.renewal
  ) {
    throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada no coincide con la aceptación.', 500)
  }

  const money = [
    quote.totals.listSubtotalMinor,
    quote.totals.discountMinor,
    quote.totals.subtotalMinor,
    quote.totals.taxMinor,
    quote.totals.totalMinor,
    quote.renewal.subtotalMinor,
    quote.renewal.taxMinor,
    quote.renewal.totalMinor,
  ]
  for (const valueMinor of money) assertMinor(valueMinor)
  for (const line of quote.lines) {
    if (line.currency !== 'MXN' || !['VENUE_MONTH', 'VENUE_YEAR'].includes(line.billingUnit)) {
      throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada contiene una línea incompatible.', 500)
    }
    for (const valueMinor of [
      line.listSubtotalMinor,
      line.discountMinor,
      line.subtotalMinor,
      line.taxMinor,
      line.totalMinor,
      line.renewalSubtotalMinor,
      line.renewalTaxMinor,
      line.renewalTotalMinor,
    ])
      assertMinor(valueMinor)
    if (
      line.totalMinor !== line.subtotalMinor + line.taxMinor ||
      line.renewalTotalMinor !== line.renewalSubtotalMinor + line.renewalTaxMinor
    ) {
      throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada no reconcilia sus líneas.', 500)
    }
  }
  if (
    quote.totals.listSubtotalMinor !== sum(quote.lines, 'listSubtotalMinor') ||
    quote.totals.discountMinor !== sum(quote.lines, 'discountMinor') ||
    quote.totals.subtotalMinor !== sum(quote.lines, 'subtotalMinor') ||
    quote.totals.taxMinor !== sum(quote.lines, 'taxMinor') ||
    quote.totals.totalMinor !== sum(quote.lines, 'totalMinor') ||
    quote.renewal.subtotalMinor !== sum(quote.lines, 'renewalSubtotalMinor') ||
    quote.renewal.taxMinor !== sum(quote.lines, 'renewalTaxMinor') ||
    quote.renewal.totalMinor !== sum(quote.lines, 'renewalTotalMinor') ||
    quote.renewal.totalMinor < quote.totals.totalMinor ||
    quote.renewal.totalMinor < 1
  ) {
    throw gatewayError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada no reconcilia sus totales.', 500)
  }
  return quote
}

function representableTerms(quote: CommercialQuoteV1): {
  interval: 'month' | 'year'
  promotionalCycles: number | null
  taxRateBasisPoints: 0 | 1600
} {
  const paidLines = quote.lines.filter(line => line.renewalTotalMinor > 0)
  const billingUnits = new Set(paidLines.map(line => line.billingUnit))
  const promotionCycles = new Set(paidLines.map(line => line.promotionalCycles).filter((cycles): cycles is number => cycles !== null))
  const taxRates = new Set(paidLines.map(line => line.taxRateBasisPoints))
  if (billingUnits.size !== 1 || promotionCycles.size > 1 || taxRates.size !== 1) {
    throw gatewayError(
      'COMMERCIAL_STRIPE_QUOTE_NOT_REPRESENTABLE',
      'La cotización mezcla términos que Stripe no puede cobrar de forma idéntica.',
    )
  }
  const promotionalCycles = [...promotionCycles][0] ?? null
  if (quote.renewal.totalMinor > quote.totals.totalMinor && promotionalCycles === null) {
    throw gatewayError('COMMERCIAL_STRIPE_QUOTE_NOT_REPRESENTABLE', 'El descuento no tiene una duración de renovación válida.')
  }
  return {
    interval: [...billingUnits][0] === 'VENUE_YEAR' ? 'year' : 'month',
    promotionalCycles,
    taxRateBasisPoints: [...taxRates][0] as 0 | 1600,
  }
}

function checkoutUrls(frontendUrl: string, venueSlug: string): { successUrl: string; cancelUrl: string } {
  const base = new URL(`/venues/${encodeURIComponent(venueSlug)}/settings/billing/subscriptions`, frontendUrl)
  const success = new URL(base)
  success.searchParams.set('commercialCheckout', 'success')
  const cancel = new URL(base)
  cancel.searchParams.set('commercialCheckout', 'canceled')
  return {
    successUrl: `${success.toString()}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: cancel.toString(),
  }
}

export function createCommercialStripeGateway(dependencies: CommercialStripeGatewayDependencies): CommercialStripeGateway {
  return {
    async createCheckoutSession(input) {
      const quote = validateFrozenQuote(input.frozenQuote, input.quoteId)
      const terms = representableTerms(quote)
      const billing = await dependencies.loadBillingContext(input.acceptanceId)
      if (!billing || billing.organizationId !== input.organizationId || billing.venueId !== input.venueId) {
        throw gatewayError('COMMERCIAL_STRIPE_BILLING_SCOPE_MISMATCH', 'La cuenta de cobro no coincide con la aceptación.', 500)
      }
      if (!billing.stripeCustomerId && !billing.billingEmail) {
        throw gatewayError('COMMERCIAL_STRIPE_BILLING_EMAIL_REQUIRED', 'La organización necesita un correo de facturación.')
      }

      const metadata = {
        type: 'commercial_subscription_v1',
        acceptanceId: input.acceptanceId,
        quoteId: input.quoteId,
        organizationId: input.organizationId,
        venueId: input.venueId,
        catalogPublicationId: quote.catalogPublicationId,
        campaignVersionId: quote.campaignVersionId ?? '',
      }
      const taxRate =
        terms.taxRateBasisPoints === 1600
          ? await dependencies.stripe.taxRates.create(
              {
                display_name: 'IVA',
                description: 'IVA México 16%',
                jurisdiction: 'México',
                country: 'MX',
                percentage: 16,
                inclusive: true,
                metadata: { acceptanceId: input.acceptanceId, quoteId: input.quoteId },
              },
              { idempotencyKey: `${input.idempotencyKey}:tax-rate` },
            )
          : null

      const discountMinor = quote.renewal.totalMinor - quote.totals.totalMinor
      const coupon =
        discountMinor > 0
          ? await dependencies.stripe.coupons.create(
              {
                amount_off: discountMinor,
                currency: 'mxn',
                duration: terms.promotionalCycles === 1 ? 'once' : 'repeating',
                ...(terms.promotionalCycles && terms.promotionalCycles > 1
                  ? { duration_in_months: terms.interval === 'year' ? terms.promotionalCycles * 12 : terms.promotionalCycles }
                  : {}),
                name: `Oferta Avoqado · ${terms.promotionalCycles ?? 1} ciclo(s)`,
                metadata: { acceptanceId: input.acceptanceId, quoteId: input.quoteId },
              },
              { idempotencyKey: `${input.idempotencyKey}:coupon` },
            )
          : null

      const urls = checkoutUrls(dependencies.frontendUrl, billing.venueSlug)
      const customer = billing.stripeCustomerId ? { customer: billing.stripeCustomerId } : { customer_email: billing.billingEmail! }
      const session = await dependencies.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          ...customer,
          allow_promotion_codes: false,
          discounts: coupon ? [{ coupon: coupon.id }] : undefined,
          billing_address_collection: 'auto',
          locale: 'es',
          line_items: [
            {
              quantity: 1,
              ...(taxRate ? { tax_rates: [taxRate.id] } : {}),
              price_data: {
                currency: 'mxn',
                unit_amount: quote.renewal.totalMinor,
                tax_behavior: 'inclusive',
                recurring: { interval: terms.interval, interval_count: 1 },
                product_data: {
                  name: `Avoqado · ${billing.venueName}`.slice(0, 250),
                  description: `Suscripción según cotización ${quote.quoteId}. IVA incluido cuando aplica.`,
                  metadata: { acceptanceId: input.acceptanceId, quoteId: input.quoteId },
                },
              },
            },
          ],
          metadata,
          subscription_data: { metadata, description: `Avoqado · ${billing.venueName}`.slice(0, 500) },
          success_url: urls.successUrl,
          cancel_url: urls.cancelUrl,
        },
        { idempotencyKey: `${input.idempotencyKey}:session` },
      )
      if (!session.url) {
        throw gatewayError('COMMERCIAL_STRIPE_SESSION_URL_MISSING', 'Stripe creó la sesión sin una URL de checkout.', 502)
      }
      return { checkoutSessionId: session.id, checkoutUrl: session.url }
    },
  }
}

export async function loadPrismaCommercialBillingContext(acceptanceId: string): Promise<CommercialBillingContext | null> {
  const acceptance = await prisma.commercialQuoteAcceptance.findUnique({
    where: { id: acceptanceId },
    select: {
      organizationId: true,
      venueId: true,
      organization: { select: { billingEmail: true, email: true } },
      venue: { select: { name: true, slug: true, email: true, stripeCustomerId: true } },
    },
  })
  if (!acceptance) return null
  return {
    organizationId: acceptance.organizationId,
    venueId: acceptance.venueId,
    venueName: acceptance.venue.name,
    venueSlug: acceptance.venue.slug,
    billingEmail: acceptance.organization.billingEmail ?? acceptance.venue.email ?? acceptance.organization.email,
    stripeCustomerId: acceptance.venue.stripeCustomerId,
  }
}

let liveGateway: CommercialStripeGateway | null = null

export const commercialStripeGateway: CommercialStripeGateway = {
  async createCheckoutSession(input) {
    if (!liveGateway) {
      const secretKey = process.env.STRIPE_SECRET_KEY
      if (!secretKey) {
        throw gatewayError('COMMERCIAL_STRIPE_NOT_CONFIGURED', 'Stripe no está configurado para suscripciones comerciales.', 503)
      }
      liveGateway = createCommercialStripeGateway({
        stripe: new Stripe(secretKey),
        loadBillingContext: loadPrismaCommercialBillingContext,
        frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
      })
    }
    return liveGateway.createCheckoutSession(input)
  },
}

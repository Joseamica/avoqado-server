import Stripe from 'stripe'
import axios, { AxiosInstance } from 'axios'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import logger from '@/config/logger'
import { ProviderCapabilityError } from './not-implemented.error'
import {
  AuthorizeCardPaymentParams,
  AuthorizationState,
  AuthorizeCardPaymentResult,
  CaptureParams,
  CheckoutSession,
  CreateAuthorizationCheckoutParams,
  CreateCheckoutParams,
  EcommerceMerchantWithProvider,
  IEcommerceProvider,
  OnboardingLink,
  OnboardingStatus,
  PaymentStatus,
  RefundParams,
  RefundResult,
  RefundState,
  TokenizeCardParams,
  TokenizeCardResult,
  VerifiedWebhookEvent,
  VoidParams,
} from './provider.interface'
import { fromStripeAmount, getStripeChargeBoundsCents } from './money'

const PROVIDER_CODE = 'STRIPE_CONNECT'
export const STRIPE_API_VERSION = '2026-02-25.clover'
const STRIPE_ACCOUNTS_V2_VERSION = process.env.STRIPE_ACCOUNTS_V2_VERSION || '2026-04-22.preview'

// Stripe error codes that mean "this account isn't reachable via the v2 Accounts
// API — use the v1 (Express) endpoints instead". Either the platform doesn't have
// v2 access enabled, or the specific account was created on v1 (legacy Express)
// and v2 endpoints reject it.
const V1_FALLBACK_ERROR_CODES = new Set(['non_connect_platform_accounts_v2_access_blocked', 'v1_account_instead_of_v2_account'])

// Stripe `requirements.disabled_reason` values that mean "we (Stripe) are
// reviewing — the merchant can't act, they just have to wait". Mapping these
// to a distinct status (PENDING_VERIFICATION) keeps users from poking the
// "Continue onboarding" button uselessly while Stripe processes their docs.
const PENDING_VERIFICATION_REASONS = new Set(['requirements.pending_verification', 'under_review', 'listed'])

/**
 * Resolve onboarding status from a normalized Stripe account snapshot.
 * Order of checks matters: rejection beats verification beats restriction
 * beats progress. Exported so the provider stays the single source of truth.
 */
function resolveOnboardingStatus(args: {
  chargesEnabled: boolean
  payoutsEnabled: boolean
  requirementsDue: string[]
  disabledReason: string | null | undefined
}): 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'COMPLETED' | 'RESTRICTED' | 'REJECTED' {
  const { chargesEnabled, payoutsEnabled, requirementsDue, disabledReason } = args
  // Stripe prefixes terminal rejections with `rejected.` (e.g. `rejected.fraud`,
  // `rejected.terms_of_service`, `rejected.listed`). Terminal — needs support.
  if (disabledReason?.startsWith('rejected.')) return 'REJECTED'
  // Fully active: card_payments capability enabled AND no outstanding requirements.
  if (chargesEnabled && payoutsEnabled) return 'COMPLETED'
  // Things the user owes Stripe → user must act → "RESTRICTED".
  if (requirementsDue.length > 0) return 'RESTRICTED'
  // No outstanding requirements but Stripe is reviewing manually → wait.
  if (disabledReason && PENDING_VERIFICATION_REASONS.has(disabledReason)) return 'PENDING_VERIFICATION'
  // Default: still moving through the flow.
  return 'IN_PROGRESS'
}

type StripeConnectCredentials = {
  connectAccountId?: string
  businessType?: 'company' | 'individual'
}

type AccountsV2Account = {
  id: string
  requirements?: {
    currently_due?: string[]
    past_due?: string[]
    disabled_reason?: string | null
  } | null
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: {
          status?: string
          requested?: boolean
        }
      }
    }
  } | null
  defaults?: {
    responsibilities?: {
      fees_collector?: string
      losses_collector?: string
    }
  } | null
  dashboard?: string | null
}

function normalizeRequirements(requirements: Stripe.Account.Requirements | null | undefined): AccountsV2Account['requirements'] {
  if (!requirements) return null
  return {
    currently_due: requirements.currently_due ?? [],
    past_due: requirements.past_due ?? [],
    disabled_reason: requirements.disabled_reason ?? null,
  }
}

/** `requires_action` (y cualquier estado nuevo) es «sin desenlace»: `PENDING`. */
function toRefundState(r: Stripe.Refund): RefundState {
  const status =
    r.status === 'succeeded' ? 'SUCCEEDED' : r.status === 'failed' ? 'FAILED' : r.status === 'canceled' ? 'CANCELED' : 'PENDING'
  return { refundId: r.id, status, amountCents: r.amount, failureReason: r.failure_reason ?? null }
}

/** La llave con que habla el servidor con Stripe: de ella sale el modo real (live/test) de todo lo que este proveedor hace. */
const serverStripeKey = () => process.env.STRIPE_SECRET_KEY || ''

/**
 * r2 R3: el modo REAL del proveedor (el de la llave del servidor). `EcommerceMerchant.sandboxMode` no lo decide: este proveedor no
 * lo lee. Lo usan los avisos de Stripe para saber si un aviso es del mismo modo.
 */
export const stripeServerLivemode = (apiKey: string = serverStripeKey()): boolean => /^(sk|rk)_live_/.test(apiKey)

export class StripeConnectProvider implements IEcommerceProvider {
  private readonly stripe: Stripe
  private readonly accountsV2Client: AxiosInstance

  constructor(apiKey = serverStripeKey()) {
    this.stripe = new Stripe(apiKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    })

    this.accountsV2Client = axios.create({
      baseURL: 'https://api.stripe.com',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': STRIPE_ACCOUNTS_V2_VERSION,
        'Content-Type': 'application/json',
      },
      // Stripe v2 rejects bracket-array query syntax (`include[]=x`). It requires
      // indexed form: `include[0]=x&include[1]=y`. Axios defaults to bracket
      // syntax, so we opt into indexed serialization here.
      paramsSerializer: { indexes: true },
    })
  }

  async createOnboardingLink(merchant: EcommerceMerchantWithProvider, returnPath?: string): Promise<OnboardingLink> {
    let connectAccountId = this.getCredentials(merchant).connectAccountId

    if (!connectAccountId) {
      const account = await this.createConnectedAccount(merchant)
      connectAccountId = account.id
      await this.persistConnectAccountId(merchant, connectAccountId)
    }

    const publicDashboardUrl = process.env.PUBLIC_DASHBOARD_URL || process.env.FRONTEND_URL
    if (!publicDashboardUrl) {
      throw new BadRequestError('PUBLIC_DASHBOARD_URL no está configurado')
    }

    // `returnPath` is the page the user came from on the dashboard (e.g.
    // `/venues/avoqado-full/edit/integrations`). When provided, Stripe will
    // redirect back to that exact page after onboarding — so the user lands
    // where they started instead of the legacy ecommerce-merchants admin page.
    const dashboardReturnUrl = returnPath
      ? `${publicDashboardUrl}${returnPath.startsWith('/') ? '' : '/'}${returnPath}`
      : await this.getOnboardingDashboardUrl(merchant)
    const link = await this.stripe.accountLinks.create({
      account: connectAccountId,
      return_url: `${dashboardReturnUrl}?status=success&merchantId=${merchant.id}`,
      refresh_url: `${dashboardReturnUrl}?status=retry&merchantId=${merchant.id}`,
      type: 'account_onboarding',
    })

    await prisma.ecommerceMerchant.update({
      where: { id: merchant.id },
      data: {
        onboardingLinkUrl: link.url,
        onboardingLinkExpiry: new Date(link.expires_at * 1000),
        onboardingStatus: 'IN_PROGRESS',
      },
    })

    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) }
  }

  async getOnboardingStatus(merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus> {
    const connectAccountId = this.getCredentials(merchant).connectAccountId
    if (!connectAccountId) {
      return {
        status: 'NOT_STARTED',
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
        disabledReason: null,
      }
    }

    const account = await this.retrieveConnectedAccount(connectAccountId)
    const requirementsDue = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])]
    const cardPaymentsStatus = account.configuration?.merchant?.capabilities?.card_payments?.status
    const chargesEnabled = cardPaymentsStatus === 'active'
    const payoutsEnabled = chargesEnabled && requirementsDue.length === 0
    const disabledReason = account.requirements?.disabled_reason ?? null
    const status = resolveOnboardingStatus({ chargesEnabled, payoutsEnabled, requirementsDue, disabledReason })

    await prisma.ecommerceMerchant.update({
      where: { id: merchant.id },
      data: {
        chargesEnabled,
        payoutsEnabled,
        requirementsDue,
        disabledReason,
        onboardingStatus: status,
      },
    })

    return { status, chargesEnabled, payoutsEnabled, requirementsDue, disabledReason }
  }

  async createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession> {
    const connectAccountId = this.getCredentials(merchant).connectAccountId
    if (!connectAccountId) {
      throw new BadRequestError('La cuenta Stripe Connect no esta configurada para este negocio')
    }

    if (!params.idempotencyKey) {
      throw new BadRequestError('idempotencyKey es requerido para crear Checkout Session')
    }

    if (params.amount <= 0) {
      throw new BadRequestError('El monto de pago debe ser mayor a cero')
    }

    if (params.applicationFeeAmount < 0 || params.applicationFeeAmount > params.amount) {
      throw new BadRequestError('La comision de plataforma no puede exceder el monto de pago')
    }

    const metadata = Object.fromEntries(Object.entries(params.metadata).map(([key, value]) => [key, String(value)]))
    const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
      application_fee_amount: params.applicationFeeAmount,
      metadata,
      description: params.description,
    }

    if (params.statementDescriptorSuffix) {
      paymentIntentData.statement_descriptor_suffix = params.statementDescriptorSuffix
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: params.paymentMethodTypes as Stripe.Checkout.SessionCreateParams.PaymentMethodType[],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: params.currency.toLowerCase(),
              unit_amount: params.amount,
              product_data: {
                name: params.description,
                metadata,
              },
            },
          },
        ],
        payment_intent_data: paymentIntentData,
        customer_email: params.customerEmail,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        expires_at: Math.floor(params.expiresAt.getTime() / 1000),
        metadata,
      },
      {
        stripeAccount: connectAccountId,
        idempotencyKey: params.idempotencyKey,
      },
    )

    if (!session.url) {
      throw new BadRequestError('Stripe no devolvio URL de Checkout')
    }

    return {
      id: session.id,
      url: session.url,
      expiresAt: new Date((session.expires_at ?? Math.floor(params.expiresAt.getTime() / 1000)) * 1000),
    }
  }

  async getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus> {
    const connectAccountId = this.getCredentials(merchant).connectAccountId
    if (!connectAccountId) {
      throw new BadRequestError('La cuenta Stripe Connect no esta configurada para este negocio')
    }

    const session = await this.stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ['payment_intent'] },
      { stripeAccount: connectAccountId },
    )

    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
    const amountTotal = session.amount_total ?? 0

    return {
      status:
        session.payment_status === 'paid'
          ? 'PAID'
          : session.status === 'expired'
            ? 'EXPIRED'
            : session.status === 'complete'
              ? 'PAID'
              : 'PENDING',
      paidAt: session.payment_status === 'paid' ? new Date() : undefined,
      paymentIntentId: paymentIntent,
      amountPaid: fromStripeAmount(amountTotal).toNumber(),
    }
  }

  async refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult> {
    const connectAccountId = this.getCredentials(merchant).connectAccountId
    if (!connectAccountId) {
      throw new BadRequestError('La cuenta Stripe Connect no esta configurada para este negocio')
    }

    const refund = await this.stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        refund_application_fee: params.refundApplicationFee,
        reason: params.reason,
        metadata: params.metadata,
      },
      {
        stripeAccount: connectAccountId,
        idempotencyKey: params.idempotencyKey,
      },
    )

    return {
      refundId: refund.id,
      amount: refund.amount,
      status: refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'failed' ? 'FAILED' : 'PENDING',
    }
  }

  async verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
    endpoint: 'platform' | 'connect',
  ): Promise<VerifiedWebhookEvent> {
    const secret = endpoint === 'connect' ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET : process.env.STRIPE_PLATFORM_WEBHOOK_SECRET
    if (!secret) {
      throw new ProviderCapabilityError(PROVIDER_CODE, `verifyWebhookSignature:${endpoint}:missing_secret`)
    }

    const event = this.stripe.webhooks.constructEvent(payload, signature, secret)
    return {
      id: event.id,
      type: event.type,
      account: event.account,
      data: event.data.object,
      livemode: event.livemode,
    }
  }

  async tokenizeCard(_merchant: EcommerceMerchantWithProvider, _params: TokenizeCardParams): Promise<TokenizeCardResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'tokenizeCard')
  }

  async authorizeCardPayment(
    _merchant: EcommerceMerchantWithProvider,
    _params: AuthorizeCardPaymentParams,
  ): Promise<AuthorizeCardPaymentResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'authorizeCardPayment')
  }

  // ────────────────────────────────────────────────────────────────────────
  // Apartar ahora, cobrar después (capture_method: 'manual'). La comisión de
  // plataforma (application_fee_amount) viaja SÓLO al cobrar, con el monto final.
  // ────────────────────────────────────────────────────────────────────────

  async createAuthorizationCheckout(
    merchant: EcommerceMerchantWithProvider,
    params: CreateAuthorizationCheckoutParams,
  ): Promise<CheckoutSession> {
    const connectAccountId = this.requireConnectAccountId(merchant)

    if (!params.idempotencyKey) {
      throw new BadRequestError('idempotencyKey es requerido para crear Checkout Session')
    }

    const bounds = getStripeChargeBoundsCents()
    if (!Number.isInteger(params.amountCents) || params.amountCents < bounds.min || params.amountCents > bounds.max) {
      throw new BadRequestError('El monto a apartar esta fuera de los limites permitidos')
    }

    const metadata = Object.fromEntries(Object.entries(params.metadata).map(([key, value]) => [key, String(value)]))

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: params.currency.toLowerCase(),
              unit_amount: params.amountCents,
              product_data: { name: params.description },
            },
          },
        ],
        payment_intent_data: {
          capture_method: 'manual',
          metadata,
          description: params.description,
        },
        customer_email: params.customerEmail,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        expires_at: Math.floor(params.expiresAt.getTime() / 1000),
        metadata,
      },
      { stripeAccount: connectAccountId, idempotencyKey: params.idempotencyKey },
    )

    if (!session.url) {
      throw new BadRequestError('Stripe no devolvio URL de Checkout')
    }

    return {
      id: session.id,
      url: session.url,
      expiresAt: new Date((session.expires_at ?? Math.floor(params.expiresAt.getTime() / 1000)) * 1000),
    }
  }

  async getAuthorization(
    merchant: EcommerceMerchantWithProvider,
    ref: { checkoutSessionId: string } | { paymentIntentId: string },
  ): Promise<AuthorizationState> {
    const connectAccountId = this.requireConnectAccountId(merchant)

    if ('checkoutSessionId' in ref) {
      const session = await this.stripe.checkout.sessions.retrieve(
        ref.checkoutSessionId,
        { expand: ['payment_intent.latest_charge'] },
        { stripeAccount: connectAccountId },
      )
      const pi = typeof session.payment_intent === 'object' ? session.payment_intent : null
      return this.toAuthorizationState(pi, session.status ?? null)
    }

    return this.toAuthorizationState(await this.retrievePaymentIntent(connectAccountId, ref.paymentIntentId), null)
  }

  async capture(merchant: EcommerceMerchantWithProvider, params: CaptureParams): Promise<AuthorizationState> {
    const connectAccountId = this.requireConnectAccountId(merchant)

    if (!params.idempotencyKey) {
      throw new BadRequestError('idempotencyKey es requerido para cobrar')
    }
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new BadRequestError('El monto a cobrar debe ser mayor a cero')
    }
    if (
      !Number.isInteger(params.applicationFeeCents) ||
      params.applicationFeeCents < 0 ||
      params.applicationFeeCents > params.amountCents
    ) {
      throw new BadRequestError('La comision de plataforma no puede exceder el monto a cobrar')
    }

    try {
      const pi = await this.stripe.paymentIntents.capture(
        params.paymentIntentId,
        { amount_to_capture: params.amountCents, application_fee_amount: params.applicationFeeCents, expand: ['latest_charge'] },
        { stripeAccount: connectAccountId, idempotencyKey: params.idempotencyKey },
      )
      return this.toAuthorizationState(pi, null)
    } catch (error) {
      return this.recoverIfAlready('succeeded', connectAccountId, params.paymentIntentId, error, {
        amountCents: params.amountCents,
        applicationFeeCents: params.applicationFeeCents,
      })
    }
  }

  async voidAuthorization(merchant: EcommerceMerchantWithProvider, params: VoidParams): Promise<AuthorizationState> {
    const connectAccountId = this.requireConnectAccountId(merchant)

    if (!params.idempotencyKey) {
      throw new BadRequestError('idempotencyKey es requerido para liberar')
    }

    try {
      const pi = await this.stripe.paymentIntents.cancel(
        params.paymentIntentId,
        { expand: ['latest_charge'] },
        { stripeAccount: connectAccountId, idempotencyKey: params.idempotencyKey },
      )
      return this.toAuthorizationState(pi, null)
    } catch (error) {
      return this.recoverIfAlready('canceled', connectAccountId, params.paymentIntentId, error)
    }
  }

  /** Fase 2 (T10): una devolución leída de la cuenta conectada (la del cargo). */
  async getRefund(merchant: EcommerceMerchantWithProvider, refundId: string): Promise<RefundState> {
    const connectAccountId = this.requireConnectAccountId(merchant)
    return toRefundState(await this.stripe.refunds.retrieve(refundId, {}, { stripeAccount: connectAccountId }))
  }

  /** Fase 2 (T10): todas las devoluciones del PaymentIntent, todas las páginas (tope 1000: un cobro real trae un puñado). */
  async listRefunds(
    merchant: EcommerceMerchantWithProvider,
    paymentIntentId: string,
  ): Promise<Array<RefundState & { metadata: Record<string, string> }>> {
    const connectAccountId = this.requireConnectAccountId(merchant)
    const refunds = await this.stripe.refunds
      .list({ payment_intent: paymentIntentId, limit: 100 }, { stripeAccount: connectAccountId })
      .autoPagingToArray({ limit: 1000 })
    return refunds.map(r => ({ ...toRefundState(r), metadata: (r.metadata ?? {}) as Record<string, string> }))
  }

  /**
   * Fase 2 (T10): lo que Stripe ya devolvió de la comisión de la plataforma de ese cobro (no se calcula: Stripe no documenta el
   * redondeo de la devolución proporcional). El cargo vive en la cuenta conectada; la comisión es de la plataforma: si la expansión
   * no la trae como objeto, se lee con la llave de la plataforma.
   */
  async getApplicationFeeRefundedCents(merchant: EcommerceMerchantWithProvider, paymentIntentId: string): Promise<number> {
    const connectAccountId = this.requireConnectAccountId(merchant)
    const pi = await this.stripe.paymentIntents.retrieve(
      paymentIntentId,
      { expand: ['latest_charge.application_fee'] },
      { stripeAccount: connectAccountId },
    )
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null
    const fee = charge?.application_fee
    if (!fee) return 0
    if (typeof fee === 'object') return fee.amount_refunded
    return (await this.stripe.applicationFees.retrieve(fee)).amount_refunded
  }

  /**
   * Tras un error de Stripe en cobrar/liberar (timeout, reintento, estado ya cambiado) se lee el PaymentIntent:
   * si ya quedó como se buscaba es éxito; si no, o si la lectura también falla, se relanza el error ORIGINAL.
   * Sólo se intenta con errores de Stripe. Al cobrar, "succeeded" sólo cuenta si el monto y la comisión cobrados son
   * los pedidos (otro cobro con otro monto no es el nuestro).
   */
  private async recoverIfAlready(
    wanted: 'succeeded' | 'canceled',
    connectAccountId: string,
    paymentIntentId: string,
    originalError: unknown,
    expected?: { amountCents: number; applicationFeeCents: number },
  ): Promise<AuthorizationState> {
    if (!(originalError as { type?: string } | null)?.type?.startsWith('Stripe')) throw originalError
    let pi: Stripe.PaymentIntent
    try {
      pi = await this.retrievePaymentIntent(connectAccountId, paymentIntentId)
    } catch {
      throw originalError
    }
    if (pi.status !== wanted) throw originalError
    if (expected && (pi.amount_received !== expected.amountCents || (pi.application_fee_amount ?? 0) !== expected.applicationFeeCents)) {
      throw originalError
    }
    return this.toAuthorizationState(pi, null)
  }

  private retrievePaymentIntent(connectAccountId: string, paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }, { stripeAccount: connectAccountId })
  }

  private toAuthorizationState(pi: Stripe.PaymentIntent | null, sessionStatus: AuthorizationState['sessionStatus']): AuthorizationState {
    const charge = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null
    const details = charge?.payment_method_details
    const card = details?.card
    const captureBefore = card?.capture_before

    return {
      sessionStatus,
      paymentIntentId: pi?.id ?? null,
      piStatus: (pi?.status as AuthorizationState['piStatus']) ?? null,
      amountCapturableCents: pi?.amount_capturable ?? 0,
      amountReceivedCents: pi?.amount_received ?? 0,
      captureBefore: captureBefore ? new Date(captureBefore * 1000) : null,
      card: card
        ? {
            brand: card.brand ?? null,
            last4: card.last4 ?? null,
            funding: (card.funding as 'credit' | 'debit' | 'prepaid' | 'unknown') ?? null,
          }
        : null,
      paymentMethodType: details?.type ?? null,
      applicationFeeCents: pi?.application_fee_amount ?? 0,
    }
  }

  private requireConnectAccountId(merchant: EcommerceMerchantWithProvider): string {
    const connectAccountId = this.getCredentials(merchant).connectAccountId
    if (!connectAccountId) {
      throw new BadRequestError('La cuenta Stripe Connect no esta configurada para este negocio')
    }
    return connectAccountId
  }

  private getCredentials(merchant: EcommerceMerchantWithProvider): StripeConnectCredentials {
    return (merchant.providerCredentials ?? {}) as StripeConnectCredentials
  }

  private async createConnectedAccount(merchant: EcommerceMerchantWithProvider): Promise<AccountsV2Account> {
    const credentials = this.getCredentials(merchant)
    if (!credentials.businessType) {
      throw new BadRequestError('El tipo de persona fiscal es requerido para onboarding de Stripe')
    }
    if (!merchant.contactEmail) {
      throw new BadRequestError('El email de contacto del merchant es requerido para onboarding de Stripe')
    }

    try {
      const response = await this.accountsV2Client.post<AccountsV2Account>('/v2/core/accounts', {
        contact_email: merchant.contactEmail,
        display_name: merchant.businessName || merchant.channelName || 'Avoqado Venue',
        dashboard: 'full',
        identity: {
          business_details: {
            registered_name: merchant.businessName || merchant.channelName || undefined,
          },
          country: 'mx',
          entity_type: credentials.businessType,
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
            },
          },
        },
        defaults: {
          currency: 'mxn',
          responsibilities: {
            fees_collector: 'stripe',
            losses_collector: 'stripe',
          },
          locales: ['es-419'],
        },
        include: ['configuration.merchant', 'identity', 'requirements', 'defaults'],
      })

      return response.data
    } catch (error: any) {
      if (!V1_FALLBACK_ERROR_CODES.has(error?.response?.data?.error?.code)) {
        throw error
      }

      logger.warn('⚠️ [STRIPE CONNECT] Accounts v2 is not enabled; falling back to v1 Express account creation')
      const account = await this.stripe.accounts.create({
        type: 'express',
        country: 'MX',
        email: merchant.contactEmail,
        business_type: credentials.businessType,
        business_profile: {
          name: merchant.businessName || merchant.channelName || 'Avoqado Venue',
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          venueId: merchant.venueId ?? '',
          channelName: merchant.channelName ?? '',
          accountsApiFallback: 'v1_express',
        },
      })

      return {
        id: account.id,
        requirements: normalizeRequirements(account.requirements),
        configuration: {
          merchant: {
            capabilities: {
              card_payments: {
                requested: true,
                status: account.charges_enabled ? 'active' : 'inactive',
              },
            },
          },
        },
      }
    }
  }

  private async retrieveConnectedAccount(connectAccountId: string): Promise<AccountsV2Account> {
    try {
      const response = await this.accountsV2Client.get<AccountsV2Account>(`/v2/core/accounts/${connectAccountId}`, {
        params: {
          include: ['configuration.merchant', 'identity', 'requirements', 'defaults'],
        },
      })

      return response.data
    } catch (error: any) {
      if (!V1_FALLBACK_ERROR_CODES.has(error?.response?.data?.error?.code)) {
        throw error
      }

      const account = await this.stripe.accounts.retrieve(connectAccountId)
      return {
        id: account.id,
        requirements: normalizeRequirements(account.requirements),
        configuration: {
          merchant: {
            capabilities: {
              card_payments: {
                requested: true,
                status: account.charges_enabled ? 'active' : 'inactive',
              },
            },
          },
        },
      }
    }
  }

  private async persistConnectAccountId(merchant: EcommerceMerchantWithProvider, connectAccountId: string): Promise<void> {
    const providerCredentials = {
      ...((merchant.providerCredentials ?? {}) as Record<string, unknown>),
      connectAccountId,
    } as Prisma.InputJsonObject

    await prisma.ecommerceMerchant.update({
      where: { id: merchant.id },
      data: {
        providerCredentials,
        providerMerchantId: connectAccountId,
      },
    })
  }

  private async getOnboardingDashboardUrl(merchant: EcommerceMerchantWithProvider): Promise<string> {
    const publicDashboardUrl = process.env.PUBLIC_DASHBOARD_URL || process.env.FRONTEND_URL
    if (!publicDashboardUrl) {
      throw new BadRequestError('PUBLIC_DASHBOARD_URL no está configurado')
    }

    let venueSlug: string | null = null
    if (merchant.venueId) {
      const venue = await prisma.venue.findUnique({
        where: { id: merchant.venueId },
        select: { slug: true },
      })
      venueSlug = venue?.slug ?? null
    }

    return venueSlug ? `${publicDashboardUrl}/venues/${venueSlug}/ecommerce-merchants` : publicDashboardUrl
  }
}

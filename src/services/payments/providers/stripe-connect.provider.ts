import Stripe from 'stripe'
import axios, { AxiosInstance } from 'axios'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import logger from '@/config/logger'
import { ProviderCapabilityError } from './not-implemented.error'
import {
  AuthorizeCardPaymentParams,
  AuthorizeCardPaymentResult,
  CheckoutSession,
  CreateCheckoutParams,
  EcommerceMerchantWithProvider,
  IEcommerceProvider,
  OnboardingLink,
  OnboardingStatus,
  PaymentStatus,
  RefundParams,
  RefundResult,
  TokenizeCardParams,
  TokenizeCardResult,
  VerifiedWebhookEvent,
} from './provider.interface'
import { fromStripeAmount } from './money'

const PROVIDER_CODE = 'STRIPE_CONNECT'
export const STRIPE_API_VERSION = '2026-02-25.clover'
const STRIPE_ACCOUNTS_V2_VERSION = process.env.STRIPE_ACCOUNTS_V2_VERSION || '2026-04-22.preview'

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

export class StripeConnectProvider implements IEcommerceProvider {
  private readonly stripe: Stripe
  private readonly accountsV2Client: AxiosInstance

  constructor(apiKey = process.env.STRIPE_SECRET_KEY || '') {
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
    })
  }

  async createOnboardingLink(merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink> {
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

    const dashboardReturnUrl = await this.getOnboardingDashboardUrl(merchant)
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
      }
    }

    const account = await this.retrieveConnectedAccount(connectAccountId)
    const requirementsDue = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])]
    const cardPaymentsStatus = account.configuration?.merchant?.capabilities?.card_payments?.status
    const chargesEnabled = cardPaymentsStatus === 'active'
    const payoutsEnabled = chargesEnabled && requirementsDue.length === 0
    const status: OnboardingStatus['status'] =
      chargesEnabled && payoutsEnabled ? 'COMPLETED' : requirementsDue.length > 0 ? 'RESTRICTED' : 'IN_PROGRESS'

    await prisma.ecommerceMerchant.update({
      where: { id: merchant.id },
      data: {
        chargesEnabled,
        payoutsEnabled,
        requirementsDue,
        onboardingStatus: status,
      },
    })

    return { status, chargesEnabled, payoutsEnabled, requirementsDue }
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
      if (error?.response?.data?.error?.code !== 'non_connect_platform_accounts_v2_access_blocked') {
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
      if (error?.response?.data?.error?.code !== 'non_connect_platform_accounts_v2_access_blocked') {
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

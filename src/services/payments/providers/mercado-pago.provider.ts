/**
 * MercadoPagoProvider — IEcommerceProvider implementation for MP marketplace
 * (Split Payments via Checkout Bricks).
 *
 * Money convention: the IEcommerceProvider interface uses centavos
 * (Stripe-style minor units) because that's what `paymentLink.service.ts`
 * and `reservation.consumer.service.ts` pass via `toStripeAmount`. MP API
 * expects MAJOR units (MXN decimal). This class converts `/100` and `*100`
 * at the API boundary (createCheckoutSession reads amount/applicationFeeAmount,
 * refund accepts/returns amounts).
 *
 * Wiring:
 *   - createOnboardingLink → oauth.service (signState + buildAuthUrl)
 *   - getOnboardingStatus  → connection.service (loadCredentials check)
 *   - createCheckoutSession → returns metadata for the frontend Brick to bootstrap.
 *                            The ACTUAL MP /v1/payments call happens later from
 *                            the public Brick endpoint (Phase 7 Task 22).
 *   - getPaymentStatus     → reads mpPaymentId from CheckoutSession, then
 *                            hits payment.service.getPayment if available.
 *   - refund               → payment.service.refundPayment with money adapter.
 *   - tokenizeCard / authorizeCardPayment → not applicable. Bricks tokenizes
 *                            the card in-iframe on the frontend.
 *   - verifyWebhookSignature → handled directly by the webhook controller,
 *                              not via the provider interface (the interface
 *                              signature doesn't include `requestId`, which
 *                              MP's HMAC manifest needs).
 */
import { BadRequestError } from '@/errors/AppError'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { ProviderCapabilityError } from './not-implemented.error'
import * as connectionService from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as paymentService from '@/services/mercado-pago/payment.service'
import type {
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
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

const PROVIDER_CODE = 'MERCADO_PAGO'

/** Maps MP's payment.status string to our IEcommerceProvider PaymentStatus enum. */
function mapMpStatus(mpStatus: string): PaymentStatus['status'] {
  switch (mpStatus) {
    case 'approved':
    case 'authorized':
      return 'PAID'
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'PENDING'
    case 'refunded':
      return 'REFUNDED'
    case 'charged_back':
      return 'DISPUTED'
    case 'rejected':
    case 'cancelled':
    default:
      return 'FAILED'
  }
}

export class MercadoPagoProvider implements IEcommerceProvider {
  async createOnboardingLink(merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink> {
    if (!merchant.venueId) {
      throw new BadRequestError('venueId es requerido para conectar Mercado Pago')
    }

    // staffId is set by the controller (it has authContext); the provider
    // doesn't have access to it. Passing empty here is safe because the
    // controller calls signState directly with the real staffId — this
    // provider method is mostly a fallback for callers that don't have
    // an authContext (e.g. internal admin scripts).
    const statePayload: MercadoPagoOAuthState = {
      intent: 'connect_merchant',
      ecommerceMerchantId: merchant.id,
      venueId: merchant.venueId,
      staffId: '',
    }
    const state = oauthService.signState(statePayload)
    const url = oauthService.buildAuthUrl(state)

    return {
      url,
      // JWT state TTL is 10 minutes; communicate that to the dashboard.
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }
  }

  async getOnboardingStatus(merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      return {
        status: 'NOT_STARTED',
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsDue: [],
        disabledReason: null,
      }
    }
    const expired = creds.expiresAt.getTime() <= Date.now()
    return {
      status: expired ? 'RESTRICTED' : 'COMPLETED',
      chargesEnabled: !expired,
      payoutsEnabled: !expired,
      requirementsDue: expired ? ['token_expired'] : [],
      disabledReason: expired ? 'token_expired' : null,
    }
  }

  /**
   * For MP Bricks, this returns the metadata the frontend Brick needs to
   * bootstrap (publicKey via separate public endpoint). The provider returns
   * a stable `id` = idempotencyKey so the caller can persist it as
   * CheckoutSession.sessionId and use it as MP's external_reference later.
   *
   * The actual MP /v1/payments call happens elsewhere (the public
   * mp-pay endpoint — Phase 7 Task 22) when the Brick submits the token.
   */
  async createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      throw new BadRequestError('Este negocio aún no ha conectado Mercado Pago')
    }
    if (params.amount <= 0) {
      throw new BadRequestError('El monto de pago debe ser mayor a cero')
    }
    if (params.applicationFeeAmount < 0 || params.applicationFeeAmount > params.amount) {
      throw new BadRequestError('La comisión de plataforma no puede exceder el monto de pago')
    }

    return {
      // Use the caller's idempotencyKey as the stable session id. The caller
      // (paymentLink.service.ts) will set CheckoutSession.sessionId = this id,
      // and we'll use the same id as external_reference when the Brick fires.
      id: params.idempotencyKey,
      // For MP Bricks the customer stays on pay.avoqado.io and the Brick
      // is rendered inline. There is no separate hosted URL to redirect to —
      // we hand back the successUrl's origin so legacy callers that expect
      // a "url" field have something sensible. The Brick mount happens at
      // the public checkout page (pay.avoqado.io/<shortCode>).
      url: params.successUrl,
      expiresAt: params.expiresAt,
    }
  }

  /**
   * Status flow:
   *   - Lookup CheckoutSession in our DB
   *   - If mpPaymentId not yet set (Brick hasn't submitted) → return from DB cache
   *   - If mpPaymentId set → hit MP API for authoritative status
   */
  async getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus> {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      select: { mpPaymentId: true, status: true, completedAt: true },
    })
    if (!session) {
      throw new BadRequestError('CheckoutSession no encontrada')
    }

    if (!session.mpPaymentId) {
      // No MP payment created yet (Brick hasn't submitted, or already cleared)
      return {
        status: session.status === 'COMPLETED' ? 'PAID' : 'PENDING',
        paidAt: session.completedAt ?? undefined,
        amountPaid: undefined,
      }
    }

    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      throw new BadRequestError('Credenciales de Mercado Pago no disponibles')
    }

    const payment = await paymentService.getPayment(creds.accessToken, session.mpPaymentId)
    return {
      status: mapMpStatus(payment.status),
      paidAt: payment.date_approved ? new Date(payment.date_approved) : undefined,
      paymentIntentId: String(payment.id),
      amountPaid: payment.transaction_amount,
      applicationFeeAmount: payment.application_fee,
    }
  }

  async refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult> {
    const creds = await connectionService.loadCredentials(merchant.id)
    if (!creds) {
      throw new BadRequestError('Credenciales de Mercado Pago no disponibles')
    }

    // Money adapter at the boundary: interface uses centavos, MP API uses MXN.
    // params.amount is centavos; convert to MXN by /100. Full refund (undefined)
    // passes through as undefined.
    const refund = await paymentService.refundPayment({
      accessToken: creds.accessToken,
      paymentId: params.paymentIntentId,
      amount: params.amount !== undefined ? params.amount / 100 : undefined,
      idempotencyKey: params.idempotencyKey,
    })

    logger.info('[MP] refund issued', {
      merchantId: merchant.id,
      paymentId: params.paymentIntentId,
      refundId: refund.id,
      amountMxn: refund.amount,
      status: refund.status,
    })

    return {
      refundId: String(refund.id),
      // Convert MP response back to centavos to honor the interface contract.
      amount: refund.amount * 100,
      status: refund.status === 'approved' ? 'SUCCEEDED' : refund.status === 'in_process' ? 'PENDING' : 'FAILED',
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Capability errors — MP Bricks doesn't go through these interface methods.
  // ────────────────────────────────────────────────────────────────────────

  async verifyWebhookSignature(
    _payload: string | Buffer,
    _signature: string,
    _endpoint: 'platform' | 'connect',
  ): Promise<VerifiedWebhookEvent> {
    throw new ProviderCapabilityError(
      PROVIDER_CODE,
      'verifyWebhookSignature: use mercadoPago webhook controller directly (it has access to x-request-id which the interface omits)',
    )
  }

  async tokenizeCard(_merchant: EcommerceMerchantWithProvider, _params: TokenizeCardParams): Promise<TokenizeCardResult> {
    throw new ProviderCapabilityError(
      PROVIDER_CODE,
      'tokenizeCard: MP Bricks tokenizes the card in-iframe on the frontend, never via backend',
    )
  }

  async authorizeCardPayment(
    _merchant: EcommerceMerchantWithProvider,
    _params: AuthorizeCardPaymentParams,
  ): Promise<AuthorizeCardPaymentResult> {
    throw new ProviderCapabilityError(
      PROVIDER_CODE,
      'authorizeCardPayment: use the public mp-pay endpoint instead (it accepts the Brick token + creates the MP payment)',
    )
  }
}

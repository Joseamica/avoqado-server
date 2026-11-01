import { EcommerceMerchant, PaymentProvider } from '@prisma/client'

export type EcommerceMerchantWithProvider = Pick<EcommerceMerchant, 'id' | 'providerCredentials' | 'sandboxMode'> & {
  venueId?: string
  channelName?: string
  businessName?: string
  contactEmail?: string
  provider?: Pick<PaymentProvider, 'code'> | null
}

export interface OnboardingLink {
  url: string
  expiresAt: Date
}

export interface OnboardingStatus {
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'COMPLETED' | 'RESTRICTED' | 'REJECTED'
  chargesEnabled: boolean
  payoutsEnabled: boolean
  requirementsDue: string[]
  /**
   * Raw `requirements.disabled_reason` from Stripe (or null). Lets the UI
   * surface the specific reason (e.g. `rejected.fraud`, `under_review`)
   * without re-querying Stripe.
   */
  disabledReason?: string | null
}

export interface CreateCheckoutParams {
  amount: number
  currency: string
  applicationFeeAmount: number
  successUrl: string
  cancelUrl: string
  expiresAt: Date
  customerEmail?: string
  metadata: Record<string, string>
  description: string
  statementDescriptorSuffix?: string
  idempotencyKey: string
  paymentMethodTypes: string[]
}

export interface CheckoutSession {
  id: string
  url: string
  expiresAt: Date
}

export interface PaymentStatus {
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'REFUNDED' | 'DISPUTED'
  paidAt?: Date
  paymentIntentId?: string
  amountPaid?: number
  applicationFeeAmount?: number
}

export interface RefundParams {
  paymentIntentId: string
  amount?: number
  refundApplicationFee: boolean
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface RefundResult {
  refundId: string
  amount: number
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED'
}

/** Fase 2 (T10): lo que Stripe dice HOY de una devolución (`requires_action` → `PENDING`). Centavos: sólo en la frontera. */
export interface RefundState {
  refundId: string
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'
  amountCents: number
  failureReason: string | null
}

export interface VerifiedWebhookEvent {
  id: string
  type: string
  account?: string
  data: unknown
  livemode: boolean
}

export interface TokenizeCardParams {
  pan: string
  cvv: string
  expMonth: string
  expYear: string
  holderName: string
  customerEmail?: string
  customerPhone?: string
}

export interface TokenizeCardResult {
  token: string
  maskedPan: string
  cardBrand: string
}

export interface AuthorizeCardPaymentParams {
  amount: number
  currency: string
  cardToken: string
  cvv: string
  orderId: string
  merchantId?: string
  reference?: string
}

export interface AuthorizeCardPaymentResult {
  transactionId: string
  authorizationId?: string
  status?: string
  authorizationCode?: string
}

/** Apartar ahora, cobrar después (captura manual). Dinero en centavos: sólo en la frontera con Stripe. */
export interface CreateAuthorizationCheckoutParams {
  amountCents: number
  currency: 'MXN'
  description: string
  successUrl: string
  cancelUrl: string
  expiresAt: Date
  customerEmail?: string
  metadata: Record<string, string>
  idempotencyKey: string
}

export interface AuthorizationState {
  sessionStatus: 'open' | 'complete' | 'expired' | null
  paymentIntentId: string | null
  piStatus:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'succeeded'
    | 'canceled'
    | null
  amountCapturableCents: number
  amountReceivedCents: number
  captureBefore: Date | null
  card: { brand: string | null; last4: string | null; funding: 'credit' | 'debit' | 'prepaid' | 'unknown' | null } | null
  paymentMethodType: string | null
  /** Codex r3 #3: la comisión de la plataforma que Stripe SÍ cobró (`application_fee_amount`); 0 si el cobro no la trae (p. ej. el
   *  dueño capturó a mano en su Stripe). Opcional: un lector que no la sabe deja la congelada del cargo. */
  applicationFeeCents?: number
}

export interface CaptureParams {
  paymentIntentId: string
  amountCents: number
  applicationFeeCents: number
  idempotencyKey: string
}

export interface VoidParams {
  paymentIntentId: string
  idempotencyKey: string
}

export interface IEcommerceProvider {
  createOnboardingLink(merchant: EcommerceMerchantWithProvider, returnPath?: string): Promise<OnboardingLink>
  getOnboardingStatus(merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus>
  createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession>
  getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus>
  refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult>
  verifyWebhookSignature(payload: string | Buffer, signature: string, endpoint: 'platform' | 'connect'): Promise<VerifiedWebhookEvent>

  tokenizeCard(merchant: EcommerceMerchantWithProvider, params: TokenizeCardParams): Promise<TokenizeCardResult>
  authorizeCardPayment(merchant: EcommerceMerchantWithProvider, params: AuthorizeCardPaymentParams): Promise<AuthorizeCardPaymentResult>

  createAuthorizationCheckout(merchant: EcommerceMerchantWithProvider, params: CreateAuthorizationCheckoutParams): Promise<CheckoutSession>
  getAuthorization(
    merchant: EcommerceMerchantWithProvider,
    ref: { checkoutSessionId: string } | { paymentIntentId: string },
  ): Promise<AuthorizationState>
  capture(merchant: EcommerceMerchantWithProvider, params: CaptureParams): Promise<AuthorizationState>
  voidAuthorization(merchant: EcommerceMerchantWithProvider, params: VoidParams): Promise<AuthorizationState>

  getRefund(merchant: EcommerceMerchantWithProvider, refundId: string): Promise<RefundState>
  /** Todas las devoluciones del PaymentIntent (todas las páginas, con tope), con su metadata. */
  listRefunds(
    merchant: EcommerceMerchantWithProvider,
    paymentIntentId: string,
  ): Promise<Array<RefundState & { metadata: Record<string, string> }>>
  /** Lo que Stripe ya devolvió de la comisión de la plataforma de ese cobro (`application_fee.amount_refunded`); 0 si no hay comisión. */
  getApplicationFeeRefundedCents(merchant: EcommerceMerchantWithProvider, paymentIntentId: string): Promise<number>
}

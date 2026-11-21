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

/**
 * D661 (Task 6, Ruling 28): lo que Stripe dice HOY que ya se devolvió de un cargo: `amount_refunded` del cargo (con las pendientes) y
 * todas sus devoluciones en cualquier estado, con su metadata. Centavos: sólo en la frontera.
 */
export interface ChargeRefunds {
  amountRefundedCents: number
  refunds: Array<RefundState & { metadata: Record<string, string> }>
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
  /** D661 (Ruling 10): la hora en que el PROVEEDOR autorizó (el cargo apartado), nunca la de Avoqado; ausente si no la trae. */
  authorizedAt?: Date
}

export interface CaptureParams {
  paymentIntentId: string
  amountCents: number
  applicationFeeCents: number
  idempotencyKey: string
}

/**
 * D661 (ronda codex-r2): límites de las peticiones de UNA llamada al proveedor (también su relectura de recuperación); sin ellos, los de
 * su cliente. En Stripe son las opciones por petición del SDK (`timeout` por intento, en ms, y `maxNetworkRetries`). Los usan la visita
 * temprana del conciliador (B, Rulings 42 y 51: lecturas y liberaciones), el reintento de una captura de «Nadie» (C, Ruling 43) y la
 * captura de quien abre (C, Ruling 52).
 */
export interface ProviderRequestLimits {
  timeoutMs?: number
  maxNetworkRetries?: number
  /**
   * D661 (Ruling 73): NUESTRO plazo duro de la llamada, en ms; el SDK no lo ve. Al cumplirse, la llamada se rechaza con `PlazoAgotado`
   * aunque el SDK siga esperando un cuerpo que no llega (`conPlazo`). Lo pasa sólo el job del conciliador: su límite por petición + 5 s
   * y, sin límite por petición, 120 s (la pasada y, ronda 2 de codex-r3, el recorrido de devoluciones).
   */
  plazoMs?: number
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
  refund(merchant: EcommerceMerchantWithProvider, params: RefundParams, limits?: ProviderRequestLimits): Promise<RefundResult>
  verifyWebhookSignature(payload: string | Buffer, signature: string, endpoint: 'platform' | 'connect'): Promise<VerifiedWebhookEvent>

  tokenizeCard(merchant: EcommerceMerchantWithProvider, params: TokenizeCardParams): Promise<TokenizeCardResult>
  authorizeCardPayment(merchant: EcommerceMerchantWithProvider, params: AuthorizeCardPaymentParams): Promise<AuthorizeCardPaymentResult>

  createAuthorizationCheckout(
    merchant: EcommerceMerchantWithProvider,
    params: CreateAuthorizationCheckoutParams,
    limits?: ProviderRequestLimits,
  ): Promise<CheckoutSession>
  getAuthorization(
    merchant: EcommerceMerchantWithProvider,
    ref: { checkoutSessionId: string } | { paymentIntentId: string },
    limits?: ProviderRequestLimits,
  ): Promise<AuthorizationState>
  capture(merchant: EcommerceMerchantWithProvider, params: CaptureParams, limits?: ProviderRequestLimits): Promise<AuthorizationState>
  voidAuthorization(
    merchant: EcommerceMerchantWithProvider,
    params: VoidParams,
    limits?: ProviderRequestLimits,
  ): Promise<AuthorizationState>
  /** S5: vence una página de pago abierta (el comensal la abandonó). El error del proveedor sale tal cual. */
  expireAuthorizationCheckout(merchant: EcommerceMerchantWithProvider, checkoutSessionId: string): Promise<void>

  getRefund(merchant: EcommerceMerchantWithProvider, refundId: string, limits?: ProviderRequestLimits): Promise<RefundState>
  /** Todas las devoluciones del PaymentIntent (todas las páginas, con tope), con su metadata. */
  listRefunds(
    merchant: EcommerceMerchantWithProvider,
    paymentIntentId: string,
    limits?: ProviderRequestLimits,
  ): Promise<Array<RefundState & { metadata: Record<string, string> }>>
  /** Lo que Stripe ya devolvió de la comisión de la plataforma de ese cobro (`application_fee.amount_refunded`); 0 si no hay comisión. */
  getApplicationFeeRefundedCents(
    merchant: EcommerceMerchantWithProvider,
    paymentIntentId: string,
    limits?: ProviderRequestLimits,
  ): Promise<number>
  /** D661: el cargo del PaymentIntent con lo ya devuelto y TODAS sus devoluciones (también las pendientes). El error sale tal cual. */
  getChargeRefunds(merchant: EcommerceMerchantWithProvider, paymentIntentId: string): Promise<ChargeRefunds>
}

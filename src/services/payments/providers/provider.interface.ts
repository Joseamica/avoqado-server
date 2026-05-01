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
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'RESTRICTED'
  chargesEnabled: boolean
  payoutsEnabled: boolean
  requirementsDue: string[]
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

export interface IEcommerceProvider {
  createOnboardingLink(merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink>
  getOnboardingStatus(merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus>
  createCheckoutSession(merchant: EcommerceMerchantWithProvider, params: CreateCheckoutParams): Promise<CheckoutSession>
  getPaymentStatus(merchant: EcommerceMerchantWithProvider, sessionId: string): Promise<PaymentStatus>
  refund(merchant: EcommerceMerchantWithProvider, params: RefundParams): Promise<RefundResult>
  verifyWebhookSignature(payload: string | Buffer, signature: string, endpoint: 'platform' | 'connect'): Promise<VerifiedWebhookEvent>

  tokenizeCard(merchant: EcommerceMerchantWithProvider, params: TokenizeCardParams): Promise<TokenizeCardResult>
  authorizeCardPayment(merchant: EcommerceMerchantWithProvider, params: AuthorizeCardPaymentParams): Promise<AuthorizeCardPaymentResult>
}

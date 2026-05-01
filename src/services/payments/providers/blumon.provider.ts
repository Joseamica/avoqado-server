import { BadRequestError } from '@/errors/AppError'
import { getBlumonEcommerceService } from '@/services/sdk/blumon-ecommerce.service'
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

const PROVIDER_CODE = 'BLUMON'

function getCredentials(merchant: EcommerceMerchantWithProvider): Record<string, any> {
  return (merchant.providerCredentials ?? {}) as Record<string, any>
}

function getAccessToken(merchant: EcommerceMerchantWithProvider): string {
  const accessToken = getCredentials(merchant).accessToken
  if (!accessToken || typeof accessToken !== 'string') {
    throw new BadRequestError('Configuración de pago incompleta para este venue')
  }

  return accessToken
}

export class BlumonProvider implements IEcommerceProvider {
  async createOnboardingLink(_merchant: EcommerceMerchantWithProvider): Promise<OnboardingLink> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'createOnboardingLink')
  }

  async getOnboardingStatus(_merchant: EcommerceMerchantWithProvider): Promise<OnboardingStatus> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'getOnboardingStatus')
  }

  async createCheckoutSession(_merchant: EcommerceMerchantWithProvider, _params: CreateCheckoutParams): Promise<CheckoutSession> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'createCheckoutSession')
  }

  async getPaymentStatus(_merchant: EcommerceMerchantWithProvider, _sessionId: string): Promise<PaymentStatus> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'getPaymentStatus')
  }

  async refund(_merchant: EcommerceMerchantWithProvider, _params: RefundParams): Promise<RefundResult> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'refund')
  }

  async verifyWebhookSignature(
    _payload: string | Buffer,
    _signature: string,
    _endpoint: 'platform' | 'connect',
  ): Promise<VerifiedWebhookEvent> {
    throw new ProviderCapabilityError(PROVIDER_CODE, 'verifyWebhookSignature')
  }

  async tokenizeCard(merchant: EcommerceMerchantWithProvider, params: TokenizeCardParams): Promise<TokenizeCardResult> {
    const service = getBlumonEcommerceService(merchant.sandboxMode)

    return service.tokenizeCard({
      accessToken: getAccessToken(merchant),
      pan: params.pan,
      cvv: params.cvv,
      expMonth: params.expMonth,
      expYear: params.expYear,
      holderName: params.holderName,
      customerEmail: params.customerEmail,
      customerPhone: params.customerPhone,
    })
  }

  async authorizeCardPayment(
    merchant: EcommerceMerchantWithProvider,
    params: AuthorizeCardPaymentParams,
  ): Promise<AuthorizeCardPaymentResult> {
    const service = getBlumonEcommerceService(merchant.sandboxMode)
    const result = await service.authorizePayment({
      accessToken: getAccessToken(merchant),
      amount: params.amount,
      currency: params.currency,
      cardToken: params.cardToken,
      cvv: params.cvv,
      orderId: params.orderId,
      merchantId: params.merchantId,
      reference: params.reference,
    })

    return {
      authorizationId: result.authorizationId,
      transactionId: result.transactionId,
      status: result.status,
      authorizationCode: result.authorizationCode,
    }
  }
}

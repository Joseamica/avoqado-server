import { BadRequestError } from '@/errors/AppError'
import { BlumonProvider } from './providers/blumon.provider'
import { MercadoPagoProvider } from './providers/mercado-pago.provider'
import { EcommerceMerchantWithProvider, IEcommerceProvider } from './providers/provider.interface'
import { StripeConnectProvider } from './providers/stripe-connect.provider'

export function getProvider(merchant: EcommerceMerchantWithProvider): IEcommerceProvider {
  const providerCode = merchant.provider?.code

  switch (providerCode) {
    case 'BLUMON':
      return new BlumonProvider()
    case 'STRIPE_CONNECT':
      return new StripeConnectProvider()
    case 'MERCADO_PAGO':
      return new MercadoPagoProvider()
    default:
      throw new BadRequestError(`Proveedor de pagos no soportado: ${providerCode || 'desconocido'}`)
  }
}

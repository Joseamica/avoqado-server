import AppError from '@/errors/AppError'

export type CommercialV2CheckoutMode = 'OFF' | 'SHADOW' | 'ALLOWLIST' | 'ACTIVE'

export function assertCommercialV2CheckoutActive(mode: CommercialV2CheckoutMode = 'OFF'): void {
  if (mode !== 'ACTIVE') {
    throw new AppError('El checkout comercial v2 no está habilitado.', 503, true, 'COMMERCIAL_V2_CHECKOUT_DISABLED')
  }
}

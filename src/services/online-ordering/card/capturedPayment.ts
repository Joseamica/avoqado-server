// src/services/online-ordering/card/capturedPayment.ts
/**
 * Fase 2 — el `Payment` de una tarjeta que Stripe ya cobró, armado igual en los dos caminos que lo registran: la captura al aceptar
 * (`finishCapture`) y la liberación que encuentra el cobro hecho a mano en Stripe (r2 R1, `release.service`).
 */
import { Prisma, type OnlineOrderCharge } from '@prisma/client'
import { fundsFlowForStripePayment, mapStripeCardBrandToEnum, metodoDeStripe } from '@/services/dashboard/paymentLink.service'
import type { AuthorizationState } from '@/services/payments/providers/provider.interface'

/** Clave idempotente de la captura; también es la llave del `Payment` de tarjeta del pedido (uno por pedido). */
export const captureKey = (orderId: string) => `online-order:${orderId}:capture`

/** Los datos del `Payment` de tarjeta: lo cobrado, la comisión congelada del cargo (Codex r1 #8) y débito/crédito de Stripe. */
export function cardPaymentData(
  charge: Pick<OnlineOrderCharge, 'venueId' | 'ecommerceMerchantId' | 'applicationFeeCents' | 'paymentIntentId'>,
  state: AuthorizationState,
  orderId: string,
  capturedAmount: Prisma.Decimal,
): Prisma.PaymentUncheckedCreateInput {
  const feeAmount = new Prisma.Decimal(charge.applicationFeeCents).div(100)
  const netAmount = Prisma.Decimal.max(capturedAmount.sub(feeAmount), 0)
  const feePercentage = capturedAmount.gt(0) ? feeAmount.div(capturedAmount).toDecimalPlaces(4) : new Prisma.Decimal(0)
  const sat = metodoDeStripe(state.paymentMethodType)
  // Codex r1 #7: Stripe dice débito o crédito en `funding`; el catálogo SAT ya mapea DEBIT_CARD → 28.
  const method = state.card?.funding === 'debit' ? 'DEBIT_CARD' : sat.method
  const last4 = state.card?.last4
  return {
    venueId: charge.venueId,
    orderId,
    fundsFlow: fundsFlowForStripePayment(state.paymentMethodType),
    ecommerceMerchantId: charge.ecommerceMerchantId,
    amount: capturedAmount,
    tipAmount: 0,
    method,
    tenderSatFormaPago: sat.tenderSatFormaPago,
    source: 'WEB',
    status: 'COMPLETED',
    type: 'REGULAR',
    processor: 'stripe',
    processorId: state.paymentIntentId ?? charge.paymentIntentId,
    feePercentage,
    feeAmount,
    netAmount,
    cardBrand: mapStripeCardBrandToEnum(state.card?.brand),
    maskedPan: last4 ? `************${last4}` : undefined,
    idempotencyKey: captureKey(orderId),
  }
}

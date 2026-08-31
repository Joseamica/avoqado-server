/**
 * Fase 2 de la unificación de caja: OXXO NO es efectivo del cajón.
 *
 * `mapStripeMethodToPaymentMethod('oxxo')` devuelve CASH porque así lo reporta el banco
 * — pero ese dinero lo cobró OXXO al cliente y lo depositó Stripe: NUNCA entró al cajón
 * del negocio. Sin `fundsFlow`, el fallback legacy (`method === 'CASH'`) lo contaba como
 * efectivo físico y el arqueo le exigía al cajero un dinero que jamás tuvo en la mano.
 *
 * La regla: TODO pago creado por un payment link lleva `fundsFlow` explícito, y para
 * cualquier método que venga de Stripe es AVOQADO_PROCESSED (lo liquida Stripe → nosotros),
 * nunca CASH_DRAWER. Medido en la auditoría del 27-ago (§2.2): era el caso más peligroso.
 */
import { paymentCountsAsDrawerCash, paymentIsAvoqadoSettled } from '@/services/shared/tenderSemantics'
import { fundsFlowForStripePayment, mapStripeMethodToPaymentMethod } from '@/services/dashboard/paymentLink.service'

describe('fase 2 · OXXO por payment link NO es efectivo del cajón', () => {
  it('🔴 OXXO se ledgea como CASH pero su fundsFlow es AVOQADO_PROCESSED', () => {
    expect(mapStripeMethodToPaymentMethod('oxxo')).toBe('CASH')
    expect(fundsFlowForStripePayment('oxxo')).toBe('AVOQADO_PROCESSED')
  })

  it('🔴 con ese fundsFlow, el cajón NO lo cuenta y available balance SÍ', () => {
    const pago = { method: 'CASH', fundsFlow: fundsFlowForStripePayment('oxxo') }
    expect(paymentCountsAsDrawerCash(pago)).toBe(false)
    expect(paymentIsAvoqadoSettled(pago)).toBe(true)
  })

  it('sin fundsFlow (fila vieja) el fallback SÍ lo contaba como caja — el bug que se corrige hacia adelante', () => {
    expect(paymentCountsAsDrawerCash({ method: 'CASH', fundsFlow: null })).toBe(true)
  })

  it.each(['card', 'customer_balance', 'apple_pay', 'oxxo', null])('cualquier método de Stripe (%s) → AVOQADO_PROCESSED', t => {
    expect(fundsFlowForStripePayment(t)).toBe('AVOQADO_PROCESSED')
  })
})

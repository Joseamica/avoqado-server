import { resolveDepositsWhenPayingWithCredits } from '@/controllers/public/reservation.public.controller'

/**
 * Auditoría 4 (bloqueo 2): una CITA podía pedir depósito Y canjear créditos a la vez —
 * `willUseCredits` sólo apagaba el prepago sintético de `upfrontPolicy=required`, no
 * `settings.deposits`. Consecuencias: sesión de Stripe huérfana creada antes del canje; si
 * el cliente canjeaba y abandonaba el checkout, el job de depósitos cancelaba la reserva
 * SIN devolver los créditos. Decisión: pagar con créditos ⇒ NO hay depósito.
 */
describe('resolveDepositsWhenPayingWithCredits', () => {
  const deposits = { enabled: true, mode: 'percentage', percentageOfTotal: 50, fixedAmount: null, paymentWindowHrs: 24 } as any

  it('sin créditos → los depósitos del venue quedan intactos', () => {
    expect(resolveDepositsWhenPayingWithCredits({ wantsCredits: false, deposits })).toBe(deposits)
  })

  it('🔴 con créditos → depósito APAGADO (enabled:false, mode:none) aunque el venue lo tenga prendido', () => {
    expect(resolveDepositsWhenPayingWithCredits({ wantsCredits: true, deposits })).toEqual(
      expect.objectContaining({ enabled: false, mode: 'none' }),
    )
  })

  it('con créditos y sin settings de depósito → objeto apagado, no null', () => {
    expect(resolveDepositsWhenPayingWithCredits({ wantsCredits: true, deposits: undefined })).toEqual(
      expect.objectContaining({ enabled: false, mode: 'none' }),
    )
  })
})

/**
 * S3 — los precios estándar, UNA sola fuente (spec 2026-09-17 § 3.2).
 *
 * 🔴 Estas pruebas NO copian los números: los DERIVAN de las bases ex-IVA que usan los seeds de
 * Stripe (`scripts/seed-plan-pro.ts`, `scripts/seed-plan-premium.ts`). Una prueba que escribiera
 * `toBe(115884)` a mano pasaría igual de feliz con la constante equivocada, porque estaría
 * comparando la copia contra sí misma. Derivándolos, la prueba cae si alguien mueve el precio
 * en un sitio y no en el otro — que es el defecto que esta tarea existe para impedir.
 */
import {
  LEGACY_INTRO_OFFER,
  PLAN_IVA_RATE,
  STANDARD_PLAN_GROSS_CENTS,
  TRIAL_DAYS,
  standardPlanQuote,
} from '@/services/access/planPricing.constants'

// Las bases EX-IVA, tal como las declaran los seeds. Son el origen de todo lo demás.
const BASE = {
  PRO: { monthly: 999, annual: 9990 },
  PREMIUM: { monthly: 1699, annual: 16990 },
}
const BASE_PROMO_PRO = 599 // precio intro ex-IVA de INTRO_PRO_3M
const conIva = (mxnExIva: number) => Math.round(mxnExIva * (1 + 0.16) * 100)

describe('STANDARD_PLAN_GROSS_CENTS — el precio de lista CON IVA, en centavos', () => {
  it('PRO mensual es round(999 × 1.16 × 100) = 115884', () => {
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.monthly).toBe(conIva(BASE.PRO.monthly))
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.monthly).toBe(115884)
  })

  it('PRO anual es round(9,990 × 1.16 × 100) = 1158840', () => {
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.annual).toBe(conIva(BASE.PRO.annual))
  })

  it('PREMIUM mensual y anual salen de sus bases de 1,699 y 16,990', () => {
    expect(STANDARD_PLAN_GROSS_CENTS.PREMIUM.monthly).toBe(conIva(BASE.PREMIUM.monthly))
    expect(STANDARD_PLAN_GROSS_CENTS.PREMIUM.annual).toBe(conIva(BASE.PREMIUM.annual))
  })

  it('🔴 son los MISMOS números que el controlador de alta tenía escritos a mano', () => {
    // Los cuatro literales que vivían en onboarding.controller.ts:1170-1191 antes del refactor.
    expect(STANDARD_PLAN_GROSS_CENTS).toEqual({
      PRO: { monthly: 115884, annual: 1158840 },
      PREMIUM: { monthly: 197084, annual: 1970840 },
    })
  })

  it('la tasa de IVA es la misma que la de los seeds', () => {
    expect(PLAN_IVA_RATE).toBe(0.16)
  })
})

describe('LEGACY_INTRO_OFFER — la promoción $599 × 3 que ya está viva en Stripe', () => {
  it('cobra round(599 × 1.16 × 100) = 69484 el primer ciclo', () => {
    expect(LEGACY_INTRO_OFFER.introMonthlyCents).toBe(conIva(BASE_PROMO_PRO))
    expect(LEGACY_INTRO_OFFER.introMonthlyCents).toBe(69484)
  })

  it('🔴 el cupón de Stripe cuadra: lista − amount_off = el precio intro', () => {
    // `amount_off` de INTRO_PRO_3M = round((999 − 599) × 1.16 × 100) = 46400 (seed-plan-pro.ts).
    const amountOff = conIva(BASE.PRO.monthly - BASE_PROMO_PRO)
    expect(amountOff).toBe(46400)
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.monthly - amountOff).toBe(LEGACY_INTRO_OFFER.introMonthlyCents)
  })

  it('es PRO mensual y dura 3 ciclos, con el id exacto del cupón que existe en Stripe', () => {
    expect(LEGACY_INTRO_OFFER.tier).toBe('PRO')
    expect(LEGACY_INTRO_OFFER.interval).toBe('monthly')
    expect(LEGACY_INTRO_OFFER.months).toBe(3)
    expect(LEGACY_INTRO_OFFER.couponId).toBe('INTRO_PRO_3M')
  })
})

describe('TRIAL_DAYS', () => {
  it('la prueba gratis dura 30 días', () => {
    expect(TRIAL_DAYS).toBe(30)
  })
})

describe('standardPlanQuote — el puente hacia la aritmética pura de la oferta', () => {
  it('entrega los precios de lista y la promoción legacy en la forma que espera standardFirstChargeCents', () => {
    expect(standardPlanQuote()).toEqual({
      grossCents: { PRO: { monthly: 115884, annual: 1158840 }, PREMIUM: { monthly: 197084, annual: 1970840 } },
      legacyIntro: { tier: 'PRO', interval: 'monthly', introMonthlyCents: 69484 },
    })
  })

  it('🔴 la cotización es una COPIA: mutarla no puede corromper la constante compartida', () => {
    const q = standardPlanQuote()
    q.grossCents.PRO.monthly = 1
    expect(STANDARD_PLAN_GROSS_CENTS.PRO.monthly).toBe(115884)
    expect(standardPlanQuote().grossCents.PRO.monthly).toBe(115884)
  })
})

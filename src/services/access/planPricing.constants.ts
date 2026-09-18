/**
 * S3 — precios estándar de los planes, UNA sola fuente (spec 2026-09-17 § 3.2).
 *
 * Antes de este archivo los mismos cuatro importes vivían escritos a mano dentro de
 * `onboarding.controller.ts` (:1170-1191), donde nadie los podía comparar contra los seeds de
 * Stripe que de verdad los fijan. Un cambio de precio tenía que acordarse en dos sitios a la vez,
 * y el que se olvidara cobraba un número y anunciaba otro en el correo de confirmación.
 *
 * 🔴 UNIDADES — excepción DECLARADA a la regla «la plataforma trabaja en PESOS 1:1»
 * (`.claude/rules/critical-warnings.md`): estos importes van en CENTAVOS enteros CON IVA
 * incluido, porque son literalmente `price.unit_amount` y `coupon.amount_off` de Stripe.
 *
 * 🔴 ORIGEN, y por qué son literales y no un cálculo: el precio verdadero es el que está creado
 * en Stripe (`plan_pro_monthly`, `plan_pro_annual`, `plan_premium_monthly`, `plan_premium_annual`)
 * por `scripts/seed-plan-pro.ts:36-45` y `scripts/seed-plan-premium.ts:33-39`. Estas constantes
 * son el ESPEJO de esos precios para poder hablar de dinero sin pedirle nada a la red (correos,
 * vistas, cotizaciones). Cuando el cobro real depende del número, se lee el precio de Stripe y se
 * COMPARA contra este espejo — nunca se cobra el espejo a ciegas.
 *
 *   PRO      $999 ex-IVA/mes · $9,990 ex-IVA/año
 *   PREMIUM  $1,699 ex-IVA/mes · $16,990 ex-IVA/año   (el anual son 2 meses gratis)
 */

/** La misma tasa que usan los seeds. El precio que se muestra ya la incluye (convención MX). */
export const PLAN_IVA_RATE = 0.16

export type PaidPlanTier = 'PRO' | 'PREMIUM'
export type PlanBillingInterval = 'monthly' | 'annual'

/** Precio de lista por ciclo, CON IVA, en centavos. Espejo de los precios vivos en Stripe. */
export const STANDARD_PLAN_GROSS_CENTS: Readonly<Record<PaidPlanTier, Readonly<Record<PlanBillingInterval, number>>>> = {
  PRO: { monthly: 115884, annual: 1158840 }, // round(999 × 1.16 × 100) · round(9990 × 1.16 × 100)
  PREMIUM: { monthly: 197084, annual: 1970840 }, // round(1699 × 1.16 × 100) · round(16990 × 1.16 × 100)
} as const

/**
 * La promoción comercial que YA está viva en Stripe: PRO mensual pagando hoy, 3 ciclos a
 * $694.84 con IVA ($599 + IVA). El cupón `INTRO_PRO_3M` descuenta 46400 sobre los 115884
 * de lista — `115884 − 46400 = 69484`, y esa resta la fija una prueba.
 *
 * 🔴 NO se derrama: aplica sólo a PRO **mensual**. Sin esa comprobación un PREMIUM anual
 * pagaría $694.84 su primer ciclo.
 */
export const LEGACY_INTRO_OFFER = {
  tier: 'PRO',
  interval: 'monthly',
  couponId: 'INTRO_PRO_3M',
  introMonthlyCents: 69484,
  months: 3,
} as const satisfies { tier: PaidPlanTier; interval: PlanBillingInterval; couponId: string; introMonthlyCents: number; months: number }

/** Días de prueba gratis cuando el cliente elige NO pagar hoy. */
export const TRIAL_DAYS = 30

/** La forma que `standardFirstChargeCents` (launchOfferMath) espera. */
export interface StandardPlanQuoteShape {
  grossCents: Record<PaidPlanTier, Record<PlanBillingInterval, number>>
  legacyIntro: { tier: PaidPlanTier; interval: PlanBillingInterval; introMonthlyCents: number } | null
}

/**
 * Cotización estándar, en la forma que consume la aritmética pura de la oferta.
 *
 * 🔴 Devuelve una COPIA profunda a propósito. Las constantes de arriba son `Readonly` para
 * TypeScript, pero eso no impide una mutación en tiempo de ejecución desde JavaScript sin tipos
 * (un test, un script): si se devolviera la referencia, un consumidor descuidado podría dejar el
 * precio de lista del proceso entero en otro número, y todos los cobros siguientes saldrían mal
 * sin un solo error. Hay prueba de esto.
 */
export function standardPlanQuote(): StandardPlanQuoteShape {
  return {
    grossCents: {
      PRO: { ...STANDARD_PLAN_GROSS_CENTS.PRO },
      PREMIUM: { ...STANDARD_PLAN_GROSS_CENTS.PREMIUM },
    },
    legacyIntro: {
      tier: LEGACY_INTRO_OFFER.tier,
      interval: LEGACY_INTRO_OFFER.interval,
      introMonthlyCents: LEGACY_INTRO_OFFER.introMonthlyCents,
    },
  }
}

/** ¿Este par tier+intervalo es el que trae la promoción legacy? */
export function isLegacyIntroEligible(tier: PaidPlanTier, interval: PlanBillingInterval, payNow: boolean): boolean {
  return payNow && tier === LEGACY_INTRO_OFFER.tier && interval === LEGACY_INTRO_OFFER.interval
}

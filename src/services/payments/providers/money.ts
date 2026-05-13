import { Prisma } from '@prisma/client'

export function toStripeAmount(decimal: Prisma.Decimal): number {
  const cents = decimal.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()

  if (!Number.isInteger(cents) || cents < 0 || cents > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid Stripe amount conversion: ${decimal.toString()} -> ${cents}`)
  }

  return cents
}

export function fromStripeAmount(cents: number): Prisma.Decimal {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Invalid Stripe cents value: ${cents}`)
  }

  return new Prisma.Decimal(cents).div(100)
}

export function calculateApplicationFee(stripeAmountCents: number, feeBps: number): number {
  if (!Number.isInteger(stripeAmountCents) || stripeAmountCents < 0 || stripeAmountCents > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid Stripe amount cents value: ${stripeAmountCents}`)
  }

  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 3000) {
    throw new Error(`Invalid platform fee bps value: ${feeBps}`)
  }

  return Math.round((stripeAmountCents * feeBps) / 10000)
}

/**
 * Same as `calculateApplicationFee` but adds VAT (IVA) on top.
 *
 * Mexican payments platforms (Mercado Pago, Stripe, Conekta, Rappi, Uber
 * Eats) all charge their commission as "X% + IVA" — the IVA is collected
 * by the platform and remitted to SAT. This helper computes the all-in
 * `application_fee_amount` to pass to Stripe so the connected account
 * (the venue) is charged the gross figure.
 *
 *     totalFeeCents = amount × (feeBps / 10000) × (1 + vatRateBps / 10000)
 *
 * Example: amount=10000 cents ($100 MXN), feeBps=100 (1%), vatRateBps=1600 (16%)
 *   1% of $100 = $1
 *   + 16% IVA = $0.16
 *   = $1.16 = 116 cents
 */
export function calculateApplicationFeeWithVAT(stripeAmountCents: number, feeBps: number, vatRateBps: number): number {
  if (!Number.isInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 5000) {
    // Cap at 50% to catch obvious unit mistakes — no jurisdiction charges
    // platform commission VAT anywhere near that. SAT MX is 1600 (16%).
    throw new Error(`Invalid VAT rate bps value: ${vatRateBps}`)
  }

  const netFee = calculateApplicationFee(stripeAmountCents, feeBps)
  if (vatRateBps === 0) return netFee
  return Math.round((netFee * (10000 + vatRateBps)) / 10000)
}

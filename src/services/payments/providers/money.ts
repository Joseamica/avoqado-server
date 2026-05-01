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

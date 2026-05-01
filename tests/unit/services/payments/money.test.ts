import { Prisma } from '@prisma/client'
import { calculateApplicationFee, fromStripeAmount, toStripeAmount } from '@/services/payments/providers/money'

describe('payment provider money helpers', () => {
  describe('toStripeAmount / fromStripeAmount', () => {
    it('round-trips all two-decimal MXN values in the MVP charge range', () => {
      for (let cents = 0; cents <= 5_000_000; cents += 137) {
        const decimal = new Prisma.Decimal(cents).div(100)

        expect(toStripeAmount(decimal)).toBe(cents)
        expect(fromStripeAmount(cents).toFixed(2)).toBe(decimal.toFixed(2))
      }
    })

    it('uses ROUND_HALF_UP when converting fractional centavos', () => {
      expect(toStripeAmount(new Prisma.Decimal('0.005'))).toBe(1)
      expect(toStripeAmount(new Prisma.Decimal('0.004'))).toBe(0)
    })

    it('rejects negative outbound amounts', () => {
      expect(() => toStripeAmount(new Prisma.Decimal('-1.00'))).toThrow('Invalid Stripe amount conversion')
    })

    it('rejects invalid inbound cent values', () => {
      expect(() => fromStripeAmount(-1)).toThrow('Invalid Stripe cents value')
      expect(() => fromStripeAmount(1.5)).toThrow('Invalid Stripe cents value')
    })
  })

  describe('calculateApplicationFee', () => {
    it('computes fees in centavos without float drift', () => {
      expect(calculateApplicationFee(100000, 100)).toBe(1000)
      expect(calculateApplicationFee(18518, 100)).toBe(185)
    })

    it('rejects invalid bps values', () => {
      expect(() => calculateApplicationFee(100000, -1)).toThrow('Invalid platform fee bps value')
      expect(() => calculateApplicationFee(100000, 3001)).toThrow('Invalid platform fee bps value')
    })
  })
})

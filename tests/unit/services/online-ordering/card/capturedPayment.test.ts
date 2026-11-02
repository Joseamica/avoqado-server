// tests/unit/services/online-ordering/card/capturedPayment.test.ts
import { Prisma } from '@prisma/client'
import { cardPaymentData } from '@/services/online-ordering/card/capturedPayment'

const charge = { venueId: 'v1', ecommerceMerchantId: 'em1', applicationFeeCents: 290, paymentIntentId: 'pi_1' }
const state = {
  sessionStatus: null,
  paymentIntentId: 'pi_1',
  piStatus: 'succeeded' as const,
  amountCapturableCents: 0,
  amountReceivedCents: 25_000,
  captureBefore: null,
  card: { brand: 'visa', last4: '4242', funding: 'credit' as const },
  paymentMethodType: 'card',
}

describe('cardPaymentData — la comisión del Payment de tarjeta', () => {
  it('Codex r3 #3: el dueño cobró a mano en Stripe sin comisión → comisión 0 y neto = lo cobrado (no la congelada del borrador)', () => {
    const data = cardPaymentData(charge, { ...state, applicationFeeCents: 0 }, 'ord1', new Prisma.Decimal('250.00'))
    expect(new Prisma.Decimal(data.feeAmount as Prisma.Decimal).toFixed(2)).toBe('0.00')
    expect(new Prisma.Decimal(data.netAmount as Prisma.Decimal).toFixed(2)).toBe('250.00')
    expect(new Prisma.Decimal(data.feePercentage as Prisma.Decimal).toFixed(4)).toBe('0.0000')
  })

  it('la captura de Avoqado (Stripe cobró la comisión) → la comisión que dice Stripe', () => {
    const data = cardPaymentData(charge, { ...state, applicationFeeCents: 290 }, 'ord1', new Prisma.Decimal('250.00'))
    expect(new Prisma.Decimal(data.feeAmount as Prisma.Decimal).toFixed(2)).toBe('2.90')
    expect(new Prisma.Decimal(data.netAmount as Prisma.Decimal).toFixed(2)).toBe('247.10')
  })

  it('un estado sin el dato (lector viejo) conserva la comisión congelada del cargo', () => {
    const data = cardPaymentData(charge, state, 'ord1', new Prisma.Decimal('250.00'))
    expect(new Prisma.Decimal(data.feeAmount as Prisma.Decimal).toFixed(2)).toBe('2.90')
  })
})

/**
 * D5 (5-nov-2026): «Tu plan» decía el precio de lista aunque el negocio pagara con cupón. El plan CLASSIC lleva ahora
 * `origin.discount` con lo que paga y hasta cuándo; `price` sigue siendo el de lista (los clientes viejos no cambian).
 */
const mockRetrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  retrievePlanSubscription: (...a: unknown[]) => mockRetrieve(...a),
}))
jest.mock('stripe')
import { prismaMock } from '../../../__helpers__/setup'
import { getPlanState } from '@/services/dashboard/planState.service'

const resumen = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: new Date('2026-12-05T17:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  hasActiveDiscount: true,
  pausedUntil: null,
  interval: 'month',
  grossAmountCents: 115884,
  descuento: { percentOff: 30, amountOffCents: null, duration: 'repeating', endsAt: new Date('2027-02-05T17:00:00Z') },
  ...over,
})

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'v1',
    stripeCustomerId: 'cus_1',
    seatCapExempt: false,
    organization: { seatCapExempt: false },
  } as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([
    {
      id: 'vf1',
      active: true,
      endDate: null,
      suspendedAt: null,
      gracePeriodEndsAt: null,
      monthlyPrice: { toNumber: () => 999 },
      stripeSubscriptionId: 'sub_1',
      updatedAt: new Date(),
      feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
    },
  ] as never)
})

describe('getPlanState — el precio con el cupón (D5)', () => {
  it('30 % por 3 meses → origin.discount con $811.19 y su fin; price sigue en la lista', async () => {
    mockRetrieve.mockResolvedValue(resumen())
    const plan = await getPlanState('v1')
    expect(plan.origin).toMatchObject({
      kind: 'CLASSIC',
      price: { gross: 1158.84 },
      discount: { gross: 811.19, percentOff: 30, duration: 'repeating', endsAt: '2027-02-05T17:00:00.000Z' },
    })
  })

  it('sin cupón → discount null (como antes)', async () => {
    mockRetrieve.mockResolvedValue(resumen({ descuento: null, hasActiveDiscount: false }))
    const plan = await getPlanState('v1')
    expect(plan.origin?.discount).toBeNull()
    expect(plan.origin?.price).toMatchObject({ gross: 1158.84 })
  })
})

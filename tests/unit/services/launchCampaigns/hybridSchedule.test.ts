import { buildHybridPhases } from '@/services/launchCampaigns/hybridSchedule'
const line = (id: string, cycles: number | null, renewal: 'REPRICE' | 'END' | 'SAME_PRICE') => ({
  publicationId: id,
  priceId: `price_${id}`,
  renewalPriceId: `price_${id}_renewal`,
  terms: { promotionCycles: cycles, renewal: renewal === 'REPRICE' ? { kind: renewal, price: 499 } : { kind: renewal } },
})
describe('one recurring schedule for a hybrid basket', () => {
  it('combines different campaign durations without recharging the first paid invoice', () => {
    expect(buildHybridPhases(1000, [line('a', 2, 'REPRICE'), line('b', 1, 'END')])).toEqual({
      end_behavior: 'release',
      phases: [
        {
          start_date: 1000,
          duration: { interval: 'month', interval_count: 1 },
          items: [
            { price: 'price_a', quantity: 1 },
            { price: 'price_b', quantity: 1 },
          ],
          proration_behavior: 'none',
        },
        { duration: { interval: 'month', interval_count: 1 }, items: [{ price: 'price_a', quantity: 1 }], proration_behavior: 'none' },
        {
          duration: { interval: 'month', interval_count: 1 },
          items: [{ price: 'price_a_renewal', quantity: 1 }],
          proration_behavior: 'none',
        },
      ],
    })
  })
  it('cancels after the last explicitly finite offer and never emits an empty phase', () => {
    const result = buildHybridPhases(1000, [line('a', 3, 'END'), line('b', 1, 'END')])
    expect(result.end_behavior).toBe('cancel')
    expect(result.phases).toHaveLength(2)
    expect(result.phases[1].duration?.interval_count).toBe(2)
  })
  it('does not schedule unlimited same-price renewals or accept missing renewal prices', () => {
    expect(buildHybridPhases(1000, [line('a', null, 'SAME_PRICE')]).phases).toHaveLength(0)
    expect(() => buildHybridPhases(1000, [{ ...line('a', 2, 'REPRICE'), renewalPriceId: null }])).toThrow()
  })
})

import { prismaMock } from '../../../__helpers__/setup'
const scheduleCreate = jest.fn(),
  scheduleUpdate = jest.fn(),
  scheduleRetrieve = jest.fn(),
  subRetrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptionSchedules: {
      create: (...args: unknown[]) => scheduleCreate(...args),
      update: (...args: unknown[]) => scheduleUpdate(...args),
      retrieve: (...args: unknown[]) => scheduleRetrieve(...args),
    },
    subscriptions: { retrieve: (...args: unknown[]) => subRetrieve(...args) },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
import { ensureHybridSchedule } from '@/services/launchCampaigns/hybridSchedule'
beforeEach(() => {
  scheduleCreate.mockReset()
  scheduleUpdate.mockReset()
  scheduleRetrieve.mockReset()
  subRetrieve.mockReset()
  prismaMock.hybridBillingOperation.upsert.mockImplementation(async ({ create: data }: any) => ({
    id: data.step,
    ...data,
    createdAt: new Date(),
    providerId: null,
  }))
  prismaMock.hybridBillingOperation.update.mockResolvedValue({})
})
it('prepares promotion changes durably and recovers a response lost after schedule creation', async () => {
  const purchase = {
    id: 'purchase',
    venueId: 'venue',
    stripeCustomerId: 'cus',
    quote: { lines: [{ publicationId: 'a', terms: line('a', 2, 'REPRICE').terms }] },
    contracts: [
      {
        startsAt: new Date(1000000),
        publicationId: 'a',
        publication: { stripePriceId: 'price_a', stripeRenewalPriceId: 'price_a_renewal' },
      },
    ],
  }
  const sub = { id: 'sub', customer: 'cus', schedule: 'sched' }
  const saved = { id: 'sched', customer: 'cus', subscription: 'sub', metadata: {}, phases: [] }
  scheduleRetrieve.mockResolvedValue(saved)
  subRetrieve.mockResolvedValue(sub)
  scheduleUpdate.mockImplementation(async (_id: string, params: any) => ({
    ...saved,
    ...params,
    phases: params.phases.map((phase: any) => ({ ...phase, items: phase.items })),
  }))
  await ensureHybridSchedule(purchase as any, sub as any)
  expect(scheduleCreate).not.toHaveBeenCalled()
  expect(scheduleUpdate).toHaveBeenCalledTimes(1)
  expect(prismaMock.hybridBillingOperation.upsert.mock.invocationCallOrder[0]).toBeLessThan(scheduleUpdate.mock.invocationCallOrder[0])
  expect(scheduleUpdate.mock.calls[0][1]).toMatchObject({
    proration_behavior: 'none',
    end_behavior: 'release',
    phases: expect.arrayContaining([expect.objectContaining({ discounts: '', automatic_tax: { enabled: false } })]),
  })
})

import { buildHybridCancellationPhases } from '@/services/launchCampaigns/hybridSchedule'
it('cancels one contract at the paid boundary while retaining other offers and their accepted renewal price', () => {
  const schedule = {
    end_behavior: 'release',
    phases: [
      {
        start_date: 100,
        end_date: 400,
        items: [
          { price: 'bundle', quantity: 1 },
          { price: 'extra', quantity: 1 },
        ],
      },
      {
        start_date: 400,
        end_date: 500,
        items: [
          { price: 'bundle_renew', quantity: 1 },
          { price: 'extra_renew', quantity: 1 },
        ],
      },
    ],
  }
  expect(buildHybridCancellationPhases(schedule as any, 150, 200, ['bundle', 'bundle_renew'])).toMatchObject({
    end_behavior: 'release',
    phases: [
      {
        start_date: 100,
        end_date: 200,
        items: [
          { price: 'bundle', quantity: 1 },
          { price: 'extra', quantity: 1 },
        ],
      },
      { start_date: 200, end_date: 400, items: [{ price: 'extra', quantity: 1 }] },
      { start_date: 400, end_date: 500, items: [{ price: 'extra_renew', quantity: 1 }] },
    ],
  })
  expect(
    buildHybridCancellationPhases(
      { ...schedule, phases: [{ start_date: 100, end_date: 200, items: [{ price: 'bundle', quantity: 1 }] }] } as any,
      150,
      200,
      ['bundle'],
    ),
  ).toMatchObject({ end_behavior: 'cancel', phases: [{ start_date: 100, end_date: 200 }] })
  expect(buildHybridCancellationPhases({ ...schedule, phases: [schedule.phases[0]] } as any, 150, 400, ['bundle'])).toMatchObject({
    end_behavior: 'release',
    phases: [
      expect.anything(),
      { start_date: 400, duration: { interval: 'month', interval_count: 1 }, items: [{ price: 'extra', quantity: 1 }] },
    ],
  })
})

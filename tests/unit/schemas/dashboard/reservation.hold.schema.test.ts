import { publicCreateHoldBodySchema } from '@/schemas/dashboard/reservation.schema'
import { consumerCreateReservationSchema } from '@/schemas/consumer.schema'

const startsAt = new Date('2026-08-21T15:00:00.000Z')

function appointmentHold(durationMin: number, extra: Record<string, unknown> = {}) {
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
    productId: 'product-1',
    ...extra,
  }
}

describe('publicCreateHoldBodySchema normal appointment protocol', () => {
  it('accepts staff, modifiers, and the base marker', () => {
    const parsed = publicCreateHoldBodySchema.parse(
      appointmentHold(60, {
        staffId: 'staff-1',
        modifierSelections: [{ productId: 'product-1', modifierId: 'modifier-1', quantity: 2 }],
        windowSemantics: 'base',
      }),
    )

    expect(parsed).toMatchObject({
      staffId: 'staff-1',
      modifierSelections: [{ productId: 'product-1', modifierId: 'modifier-1', quantity: 2 }],
      windowSemantics: 'base',
    })
  })

  it.each([5, 480])('accepts the legacy appointment boundary of %i minutes', durationMin => {
    expect(publicCreateHoldBodySchema.safeParse(appointmentHold(durationMin)).success).toBe(true)
  })

  it.each([4, 481])('rejects a legacy appointment interval of %i minutes', durationMin => {
    expect(publicCreateHoldBodySchema.safeParse(appointmentHold(durationMin)).success).toBe(false)
  })

  it.each([1, 1440])('accepts the base appointment boundary of %i minutes', durationMin => {
    expect(publicCreateHoldBodySchema.safeParse(appointmentHold(durationMin, { windowSemantics: 'base' })).success).toBe(true)
  })

  it.each([0, 1441])('rejects a base appointment interval of %i minutes', durationMin => {
    expect(publicCreateHoldBodySchema.safeParse(appointmentHold(durationMin, { windowSemantics: 'base' })).success).toBe(false)
  })

  it('keeps legacy class and generic hold shapes compatible', () => {
    expect(
      publicCreateHoldBodySchema.safeParse({
        startsAt,
        endsAt: new Date(startsAt.getTime() + 12 * 60 * 60_000),
        classSessionId: 'class-1',
        productId: 'class-product',
      }).success,
    ).toBe(true)
    expect(
      publicCreateHoldBodySchema.safeParse({
        startsAt,
        endsAt: new Date(startsAt.getTime() + 12 * 60 * 60_000),
        productIds: [],
      }).success,
    ).toBe(true)
  })
})

describe('consumer normal appointment hold contract', () => {
  it('accepts canonical products, modifiers, and a hold token', () => {
    const parsed = consumerCreateReservationSchema.parse({
      params: { venueSlug: 'venue' },
      body: {
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        duration: 60,
        productId: 'product-1',
        productIds: ['product-1'],
        modifierSelections: [{ productId: 'product-1', modifierId: 'modifier-1' }],
        holdId: 'hold-1',
        windowSemantics: 'base',
      },
    })

    expect(parsed.body).toMatchObject({
      productIds: ['product-1'],
      modifierSelections: [{ productId: 'product-1', modifierId: 'modifier-1' }],
      holdId: 'hold-1',
    })
  })

  it('keeps the consumer flow single-product and rejects holds on class or productless creates', () => {
    const common = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      duration: 60,
      holdId: 'hold-1',
    }

    expect(
      consumerCreateReservationSchema.safeParse({
        params: { venueSlug: 'venue' },
        body: { ...common, productId: 'product-1', productIds: ['product-1', 'product-2'] },
      }).success,
    ).toBe(false)
    expect(
      consumerCreateReservationSchema.safeParse({
        params: { venueSlug: 'venue' },
        body: { classSessionId: 'class-1', holdId: 'hold-1' },
      }).success,
    ).toBe(false)
    expect(
      consumerCreateReservationSchema.safeParse({
        params: { venueSlug: 'venue' },
        body: common,
      }).success,
    ).toBe(false)
  })
})

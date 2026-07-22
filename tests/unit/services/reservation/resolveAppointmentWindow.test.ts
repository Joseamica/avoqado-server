import type { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '../../../../src/errors/AppError'
import type { ReservationConfig } from '../../../../src/services/dashboard/reservationSettings.service'
import {
  assertLegacyAppointmentDurationFloor,
  normalizeBookedProductIds,
  reservationBookedProductIds,
  resolveAppointmentWindow,
  resolveCanonicalAppointmentDuration,
} from '../../../../src/services/reservation/resolveAppointmentWindow'
import { resolveModifierSelections } from '../../../../src/services/reservation/resolveModifierSelections'

jest.mock('../../../../src/services/reservation/resolveModifierSelections', () => ({
  resolveModifierSelections: jest.fn(),
}))

const resolveModifiersMock = resolveModifierSelections as jest.MockedFunction<typeof resolveModifierSelections>

function settings(overrides: { capacityMode?: 'pacing' | 'per_staff'; showStaffPicker?: boolean; defaultDurationMin?: number } = {}) {
  return {
    scheduling: {
      defaultDurationMin: overrides.defaultDurationMin ?? 30,
      capacityMode: overrides.capacityMode ?? 'pacing',
    },
    publicBooking: { showStaffPicker: overrides.showStaffPicker ?? false },
  } as ReservationConfig
}

function productDb(rows: Array<{ id: string; duration: number | null; durationMinutes: number | null }>) {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  } as unknown as Prisma.TransactionClient
}

function modifiers(delta: number) {
  resolveModifiersMock.mockResolvedValue({
    persistRows: [],
    totalDelta: { toString: () => '0' } as never,
    totalDurationDelta: delta,
  })
}

describe('normalizeBookedProductIds', () => {
  it('normalizes legacy scalar and explicit CSV/array shapes with stable dedupe', () => {
    expect(normalizeBookedProductIds({ productId: 'a' })).toEqual({
      productIds: ['a'],
      leadProductId: 'a',
      productIdsWasProvided: false,
    })
    expect(normalizeBookedProductIds({ productId: 'a', productIds: ' a, b, a ' }).productIds).toEqual(['a', 'b'])
    expect(normalizeBookedProductIds({ productId: ' a ', productIds: 'a,b' }).productIds).toEqual(['a', 'b'])
    expect(normalizeBookedProductIds({ productIds: [' a,b ', ' c ', '', 'b'] }).productIds).toEqual(['a', 'b', 'c'])
  })

  it.each([
    { productId: 'a', productIds: [] },
    { productId: 'a', productIds: '' },
    { productId: 'b', productIds: ['a'] },
  ])('rejects mismatched scalar and explicit list %#', input => {
    expect(() => normalizeBookedProductIds(input)).toThrow(/coincidir/i)
  })

  it('rejects more than twenty distinct products but permits an explicit empty list without a scalar', () => {
    expect(() => normalizeBookedProductIds({ productIds: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toThrow(/20/)
    expect(normalizeBookedProductIds({ productIds: [] })).toEqual({
      productIds: [],
      leadProductId: undefined,
      productIdsWasProvided: true,
    })
  })
})

describe('reservationBookedProductIds', () => {
  it('falls back to the legacy scalar only when the persisted list is empty', () => {
    expect(reservationBookedProductIds({ productId: 'a', productIds: [] })).toEqual(['a'])
    expect(reservationBookedProductIds({ productId: null, productIds: [] })).toEqual([])
    expect(reservationBookedProductIds({ productId: 'a', productIds: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('canonicalizes a nonempty persisted list without changing its stable lead order', () => {
    expect(reservationBookedProductIds({ productId: 'a', productIds: [' a ', '', 'a', ' b,a '] })).toEqual(['a', 'b'])
  })

  it.each([
    { productId: 'b', productIds: ['a'] },
    { productId: 'a', productIds: ['', '  ', ','] },
    { productId: null, productIds: ['', '  '] },
    { productId: 'p0', productIds: Array.from({ length: 21 }, (_, index) => `p${index}`) },
  ])('fails closed for malformed persisted products %#', reservation => {
    expect(() => reservationBookedProductIds(reservation)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' }),
    )
  })
})

describe('resolveCanonicalAppointmentDuration', () => {
  it('uses one exact venue/type query, restores request order, and applies nullish duration precedence', async () => {
    const db = productDb([
      { id: 'b', duration: null, durationMinutes: 20 },
      { id: 'a', duration: 40, durationMinutes: 99 },
      { id: 'c', duration: null, durationMinutes: null },
    ])

    await expect(
      resolveCanonicalAppointmentDuration(db, {
        venueId: 'venue-1',
        productIds: ['a', 'b', 'c'],
        settings: settings({ defaultDurationMin: 15 }),
      }),
    ).resolves.toEqual({ productIds: ['a', 'b', 'c'], canonicalBaseDurationMin: 75 })

    expect(db.product.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] }, venueId: 'venue-1', type: 'APPOINTMENTS_SERVICE' },
      select: { id: true, duration: true, durationMinutes: true },
    })
  })

  it.each([
    ['missing product', ['a', 'b'], [{ id: 'a', duration: 60, durationMinutes: null }]],
    ['zero products', [], []],
  ])('rejects %s instead of trusting an incomplete catalog read', async (_label, productIds, rows) => {
    const db = productDb(rows as Array<{ id: string; duration: number | null; durationMinutes: number | null }>)
    await expect(resolveCanonicalAppointmentDuration(db, { venueId: 'venue-1', productIds, settings: settings() })).rejects.toBeInstanceOf(
      BadRequestError,
    )
  })
})

describe('resolveAppointmentWindow', () => {
  beforeEach(() => modifiers(0))

  it('rejects a stale five-minute base request with actionable canonical details', async () => {
    const db = productDb([{ id: 'a', duration: 60, durationMinutes: null }])

    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T17:00:00.000Z'),
        baseEndsAt: new Date('2026-07-21T17:05:00.000Z'),
        modifierSelections: [],
        settings: settings(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPOINTMENT_WINDOW_CHANGED',
      details: {
        expectedBaseDurationMin: 60,
        expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
      },
    })
  })

  it('accepts one minute of base-window tolerance and adds modifier duration exactly once', async () => {
    const db = productDb([{ id: 'a', duration: 60, durationMinutes: null }])
    const modifierRows = [{ productId: 'a', modifierId: 'm1', name: 'Extra', quantity: 1, price: '25' }] as never
    const modifierPriceDelta = { toString: () => '25' } as never
    resolveModifiersMock.mockResolvedValue({
      persistRows: modifierRows,
      totalDelta: modifierPriceDelta,
      totalDurationDelta: 15,
    })

    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T17:00:00.000Z'),
        baseEndsAt: new Date('2026-07-21T18:01:00.000Z'),
        modifierSelections: [{ productId: 'a', modifierId: 'm1' }],
        settings: settings(),
      }),
    ).resolves.toMatchObject({
      canonicalBaseDurationMin: 60,
      modifierDurationDelta: 15,
      finalDurationMin: 75,
      finalEndsAt: new Date('2026-07-21T18:15:00.000Z'),
      modifierRows,
      modifierPriceDelta,
    })
    expect(resolveModifiersMock).toHaveBeenCalledTimes(1)
  })

  it('permits a 1,440-minute final window and rejects 1,441 or a non-positive final window', async () => {
    const db = productDb([{ id: 'a', duration: 1430, durationMinutes: null }])
    modifiers(10)
    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T00:00:00.000Z'),
        baseEndsAt: new Date('2026-07-21T23:50:00.000Z'),
        modifierSelections: [],
        settings: settings(),
      }),
    ).resolves.toMatchObject({ finalDurationMin: 1440 })

    modifiers(11)
    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T00:00:00.000Z'),
        baseEndsAt: new Date('2026-07-21T23:50:00.000Z'),
        modifierSelections: [],
        settings: settings(),
      }),
    ).rejects.toBeInstanceOf(BadRequestError)

    const shortDb = productDb([{ id: 'a', duration: 10, durationMinutes: null }])
    modifiers(-10)
    await expect(
      resolveAppointmentWindow(shortDb, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T00:00:00.000Z'),
        baseEndsAt: new Date('2026-07-21T00:10:00.000Z'),
        modifierSelections: [],
        settings: settings(),
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('rejects a base duration above 1,440 even when a negative modifier would shrink the final window', async () => {
    const db = productDb([{ id: 'a', duration: 1441, durationMinutes: null }])
    modifiers(-1)

    await expect(
      resolveAppointmentWindow(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        startsAt: new Date('2026-07-21T00:00:00.000Z'),
        baseEndsAt: new Date('2026-07-22T00:01:00.000Z'),
        modifierSelections: [],
        settings: settings(),
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })
})

describe('assertLegacyAppointmentDurationFloor', () => {
  it('keeps default settings byte-compatible without querying the catalog', async () => {
    const db = productDb([{ id: 'a', duration: 60, durationMinutes: null }])

    await expect(
      assertLegacyAppointmentDurationFloor(db, {
        venueId: 'venue-1',
        productIds: ['a'],
        rawDurationMin: 5,
        settings: settings(),
      }),
    ).resolves.toBeUndefined()
    expect(db.product.findMany).not.toHaveBeenCalled()
  })

  it.each([settings({ capacityMode: 'per_staff' }), settings({ showStaffPicker: true })])(
    'fails closed for a staff-aware stale legacy duration',
    async staffAwareSettings => {
      const db = productDb([{ id: 'a', duration: 60, durationMinutes: null }])

      await expect(
        assertLegacyAppointmentDurationFloor(db, {
          venueId: 'venue-1',
          productIds: ['a'],
          rawDurationMin: 5,
          settings: staffAwareSettings,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' } satisfies Partial<ConflictError>)
    },
  )
})

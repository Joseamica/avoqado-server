import {
  createReservationBodySchema,
  getAvailabilityQuerySchema,
  publicCreateHoldBodySchema,
  publicCreateReservationBodySchema,
  rescheduleHoldBodySchema,
  updateReservationBodySchema,
} from '@/schemas/dashboard/reservation.schema'
import { consumerCreateReservationSchema } from '@/schemas/consumer.schema'
import { normalizeBookedProductIds } from '@/services/reservation/resolveAppointmentWindow'

function messages(input: unknown): string[] {
  const result = getAvailabilityQuerySchema.safeParse(input)
  return result.success ? [] : result.error.issues.map(issue => issue.message)
}

describe('getAvailabilityQuerySchema — staff-aware query contract', () => {
  const date = '2026-08-21'

  it('accepts the legacy scalar product and canonicalizes CSV/repeated product keys at the shared boundary', () => {
    const scalar = getAvailabilityQuerySchema.parse({ date, productId: 'product-a' })
    expect(normalizeBookedProductIds(scalar)).toEqual({
      productIds: ['product-a'],
      leadProductId: 'product-a',
      productIdsWasProvided: false,
    })

    const csv = getAvailabilityQuerySchema.parse({ date, productIds: ' product-a, product-b, product-a ' })
    expect(normalizeBookedProductIds(csv).productIds).toEqual(['product-a', 'product-b'])

    const repeated = getAvailabilityQuerySchema.parse({ date, productIds: ['product-a,product-b', 'product-c'] })
    expect(normalizeBookedProductIds(repeated).productIds).toEqual(['product-a', 'product-b', 'product-c'])
  })

  it('accepts matching scalar/list input and rejects a mismatching lead through the shared normalizer', () => {
    const matching = getAvailabilityQuerySchema.parse({ date, productId: 'product-a', productIds: ['product-a', 'product-b'] })
    expect(normalizeBookedProductIds(matching).productIds).toEqual(['product-a', 'product-b'])

    const mismatch = getAvailabilityQuerySchema.parse({ date, productId: 'product-b', productIds: 'product-a,product-b' })
    expect(() => normalizeBookedProductIds(mismatch)).toThrow(/coincidir/i)
  })

  it('parses includeFull strictly so the string false never becomes true', () => {
    expect(getAvailabilityQuerySchema.parse({ date, includeFull: 'true' }).includeFull).toBe(true)
    expect(getAvailabilityQuerySchema.parse({ date, includeFull: 'false' }).includeFull).toBe(false)
    expect(getAvailabilityQuerySchema.safeParse({ date, includeFull: '1' }).success).toBe(false)
    expect(getAvailabilityQuerySchema.safeParse({ date, includeFull: 'yes' }).success).toBe(false)
  })

  it('keeps the legacy 480-minute cap and permits up to 1440 only with base semantics', () => {
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '480' }).success).toBe(true)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '481' }).success).toBe(false)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '1440', windowSemantics: 'base' }).success).toBe(true)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '1441', windowSemantics: 'base' }).success).toBe(false)
  })

  it('permits one-minute base windows while keeping the five-minute legacy minimum', () => {
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '1', windowSemantics: 'base' }).success).toBe(true)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '4', windowSemantics: 'base' }).success).toBe(true)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '4' }).success).toBe(false)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '5' }).success).toBe(true)
  })

  it('localizes the absolute one-minute floor in Spanish', () => {
    expect(messages({ date, duration: '0', windowSemantics: 'base' })).toContain('La duracion minima es 1 minuto')
  })

  it('localizes every new wrong-type and enum failure in Spanish', () => {
    expect(messages({ date, productIds: 7 })).toContain('Los IDs de productos deben ser texto o una lista de textos')
    expect(messages({ date, productIds: ['product-a', 7] })).toContain('Cada ID de producto debe ser texto')
    expect(messages({ date, includeFull: 1 })).toContain('includeFull debe ser true o false')
    expect(messages({ date, includeFull: 'quizas' })).toContain('includeFull debe ser true o false')
    expect(messages({ date, windowSemantics: 1 })).toContain('windowSemantics debe ser base')
    expect(messages({ date, windowSemantics: 'final' })).toContain('windowSemantics debe ser base')
  })
})

describe('updateReservationBodySchema — rollback duration bridge', () => {
  it('accepts every whole-minute duration from 1 through 1440 and rejects values outside that wire range', () => {
    expect(updateReservationBodySchema.safeParse({ duration: 1 }).success).toBe(true)
    expect(updateReservationBodySchema.safeParse({ duration: 1_440 }).success).toBe(true)
    expect(updateReservationBodySchema.safeParse({ duration: 0 }).success).toBe(false)
    expect(updateReservationBodySchema.safeParse({ duration: 1_441 }).success).toBe(false)
    expect(updateReservationBodySchema.safeParse({ duration: 1.5 }).success).toBe(false)
  })
})

describe.each([
  {
    name: 'availability',
    safeParse: (products: Record<string, unknown>) => getAvailabilityQuerySchema.safeParse({ date: '2026-08-21', ...products }),
  },
  {
    name: 'public create',
    safeParse: (products: Record<string, unknown>) =>
      publicCreateReservationBodySchema.safeParse({
        guestName: 'Ana',
        startsAt: new Date('2026-08-21T15:00:00.000Z'),
        endsAt: new Date('2026-08-21T16:00:00.000Z'),
        duration: 60,
        ...products,
      }),
  },
  {
    name: 'public hold',
    safeParse: (products: Record<string, unknown>) =>
      publicCreateHoldBodySchema.safeParse({
        startsAt: new Date('2026-08-21T15:00:00.000Z'),
        endsAt: new Date('2026-08-21T16:00:00.000Z'),
        ...products,
      }),
  },
])('$name product wire contract', ({ safeParse }) => {
  function canonical(products: Record<string, unknown>) {
    const parsed = safeParse(products)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw parsed.error
    return normalizeBookedProductIds(parsed.data)
  }

  it('accepts scalar, matching pair, CSV, repeated-array CSV, and stable trim/empty/dedupe order', () => {
    expect(canonical({ productId: ' product-a ' })).toMatchObject({
      productIds: ['product-a'],
      leadProductId: 'product-a',
      productIdsWasProvided: false,
    })
    expect(canonical({ productId: 'product-a', productIds: 'product-a,product-b' }).productIds).toEqual(['product-a', 'product-b'])
    expect(canonical({ productIds: ' product-b, product-a, product-b ' }).productIds).toEqual(['product-b', 'product-a'])
    expect(canonical({ productIds: [' product-b, product-a ', '', 'product-c', 'product-a'] }).productIds).toEqual([
      'product-b',
      'product-a',
      'product-c',
    ])
  })

  it('defers canonical mismatch and limits to the shared normalizer', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `product-${index}`)
    expect(canonical({ productIds: twenty }).productIds).toEqual(twenty)

    for (const products of [
      { productId: 'product-b', productIds: 'product-a,product-b' },
      { productId: 'product-a', productIds: [] },
      { productId: 'product-a', productIds: ' , ' },
    ]) {
      expect(() => canonical(products)).toThrow(/coincidir/i)
    }

    const twentyOne = Array.from({ length: 21 }, (_, index) => `product-${index}`)
    expect(() => canonical({ productIds: twentyOne })).toThrow(/20/)
    expect(canonical({ productIds: Array.from({ length: 21 }, () => 'product-a') }).productIds).toEqual(['product-a'])
  })

  it('rejects non-string product wire values with Spanish messages', () => {
    const wrongContainer = safeParse({ productIds: 7 })
    const wrongMember = safeParse({ productIds: ['product-a', 7] })

    expect(wrongContainer).toMatchObject({
      success: false,
      error: { issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/debe(n)? ser texto/i) })]) },
    })
    expect(wrongMember).toMatchObject({
      success: false,
      error: { issues: expect.arrayContaining([expect.objectContaining({ message: 'Cada ID de producto debe ser texto' })]) },
    })
  })
})

describe('reschedule hold wire compatibility', () => {
  const legacyBody = {
    startsAt: '2026-08-21T15:00:00.000Z',
    endsAt: '2026-08-21T16:00:00.000Z',
  }

  it('accepts the legacy body and keeps stripping unrelated unknown keys', () => {
    expect(rescheduleHoldBodySchema.parse({ ...legacyBody, unrelated: 'legacy-value' })).toEqual(legacyBody)
  })

  it('accepts startsAt without legacy endsAt for new clients', () => {
    expect(rescheduleHoldBodySchema.parse({ startsAt: legacyBody.startsAt })).toEqual({ startsAt: legacyBody.startsAt })
  })

  it('rejects a supplied windowSemantics marker with a localized error', () => {
    expect(rescheduleHoldBodySchema.safeParse({ ...legacyBody, windowSemantics: 'base' })).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({ message: 'windowSemantics no está permitido al reservar un horario de reprogramación' }),
        ]),
      },
    })
  })
})

describe('reservation create window-semantics schemas', () => {
  const startsAt = new Date('2026-08-21T00:00:00.000Z')
  const endsAt = new Date('2026-08-22T00:00:00.000Z')

  it.each([
    ['dashboard', (body: unknown) => createReservationBodySchema.safeParse(body)],
    ['public', (body: unknown) => publicCreateReservationBodySchema.safeParse({ guestName: 'Ana', ...(body as object) })],
    ['consumer', (body: unknown) => consumerCreateReservationSchema.safeParse({ params: { venueSlug: 'venue' }, body })],
  ])('%s keeps legacy at 480 and accepts advisory duration through 1440 only for base', (_name, parse) => {
    expect(parse({ startsAt, endsAt: new Date(startsAt.getTime() + 481 * 60_000), duration: 481 }).success).toBe(false)
    expect(parse({ startsAt, endsAt, duration: 1440, windowSemantics: 'base' }).success).toBe(true)
    expect(parse({ startsAt, endsAt, duration: 1440, windowSemantics: 'final' }).success).toBe(false)
  })

  it.each([
    ['dashboard', (body: unknown) => createReservationBodySchema.safeParse(body)],
    ['public', (body: unknown) => publicCreateReservationBodySchema.safeParse({ guestName: 'Ana', ...(body as object) })],
    ['consumer', (body: unknown) => consumerCreateReservationSchema.safeParse({ params: { venueSlug: 'venue' }, body })],
  ])('%s permits one-minute base windows while keeping the five-minute legacy minimum', (_name, parse) => {
    const oneMinuteEndsAt = new Date(startsAt.getTime() + 60_000)
    const fourMinuteEndsAt = new Date(startsAt.getTime() + 4 * 60_000)
    const fiveMinuteEndsAt = new Date(startsAt.getTime() + 5 * 60_000)

    expect(parse({ startsAt, endsAt: oneMinuteEndsAt, duration: 1, windowSemantics: 'base' }).success).toBe(true)
    expect(parse({ startsAt, endsAt: fourMinuteEndsAt, duration: 4, windowSemantics: 'base' }).success).toBe(true)
    expect(parse({ startsAt, endsAt: fourMinuteEndsAt, duration: 4 }).success).toBe(false)
    expect(parse({ startsAt, endsAt: fiveMinuteEndsAt, duration: 5 }).success).toBe(true)
  })

  it.each([
    ['dashboard', (body: unknown) => createReservationBodySchema.safeParse(body)],
    ['public', (body: unknown) => publicCreateReservationBodySchema.safeParse({ guestName: 'Ana', ...(body as object) })],
    ['consumer', (body: unknown) => consumerCreateReservationSchema.safeParse({ params: { venueSlug: 'venue' }, body })],
  ])('%s localizes the absolute one-minute floor in Spanish', (_name, parse) => {
    expect(parse({ startsAt, endsAt: new Date(startsAt.getTime() + 60_000), duration: 0, windowSemantics: 'base' })).toMatchObject({
      success: false,
      error: { issues: expect.arrayContaining([expect.objectContaining({ message: 'La duracion minima es 1 minuto' })]) },
    })
  })

  it('consumer rejects mismatched legacy intervals but keeps duration advisory for base semantics', () => {
    const parse = (body: unknown) => consumerCreateReservationSchema.safeParse({ params: { venueSlug: 'venue' }, body })
    const fiveMinuteEndsAt = new Date(startsAt.getTime() + 5 * 60_000)

    expect(parse({ startsAt, endsAt: fiveMinuteEndsAt, duration: 60 }).success).toBe(false)
    expect(parse({ startsAt, endsAt: fiveMinuteEndsAt, duration: 60, windowSemantics: 'base' }).success).toBe(true)
    expect(parse({ startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), duration: 60 }).success).toBe(true)
  })

  it('dashboard and public accept bounded product lists and modifier selections', () => {
    const body = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      duration: 60,
      productId: 'a',
      productIds: ['a', 'b'],
      modifierSelections: [{ productId: 'a', modifierId: 'm1', quantity: 2 }],
      windowSemantics: 'base' as const,
    }
    expect(createReservationBodySchema.safeParse(body).success).toBe(true)
    expect(publicCreateReservationBodySchema.safeParse({ guestName: 'Ana', ...body }).success).toBe(true)
  })

  it('treats duration as advisory under base semantics', () => {
    const body = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      duration: 5,
      productId: 'a',
      windowSemantics: 'base' as const,
    }
    expect(createReservationBodySchema.safeParse(body).success).toBe(true)
    expect(publicCreateReservationBodySchema.safeParse({ guestName: 'Ana', ...body }).success).toBe(true)
  })

  it('accepts only the origin-appropriate staff and dashboard consent wire fields', () => {
    const common = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      duration: 60,
      productId: 'a',
    }
    const dashboard = createReservationBodySchema.parse({ ...common, allowOverCapacity: true })
    const publicBody = publicCreateReservationBodySchema.parse({
      ...common,
      guestName: 'Ana',
      staffId: 'staff-public',
      assignedStaffId: 'forged-staff',
      allowOverCapacity: true,
      validatedHoldId: 'forged',
    })
    const consumer = consumerCreateReservationSchema.parse({
      params: { venueSlug: 'venue' },
      body: { ...common, staffId: 'staff-consumer', allowOverCapacity: true, validatedHoldId: 'forged' },
    })

    expect(dashboard).toMatchObject({ allowOverCapacity: true })
    expect(publicBody).toMatchObject({ staffId: 'staff-public' })
    expect(publicBody).not.toHaveProperty('assignedStaffId')
    expect(publicBody).not.toHaveProperty('allowOverCapacity')
    expect(publicBody).not.toHaveProperty('validatedHoldId')
    expect(consumer.body).toMatchObject({ staffId: 'staff-consumer' })
    expect(consumer.body).not.toHaveProperty('allowOverCapacity')
    expect(consumer.body).not.toHaveProperty('validatedHoldId')
  })

  it('localizes every newly exposed create field in Spanish', () => {
    const common = {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      duration: 60,
    }
    const dashboard = createReservationBodySchema.safeParse({ ...common, allowOverCapacity: 'true' })
    const publicWrongType = publicCreateReservationBodySchema.safeParse({ ...common, guestName: 'Ana', staffId: 7 })
    const publicEmpty = publicCreateReservationBodySchema.safeParse({ ...common, guestName: 'Ana', staffId: '' })
    const consumerWrongType = consumerCreateReservationSchema.safeParse({
      params: { venueSlug: 'venue' },
      body: { ...common, staffId: 7 },
    })
    const consumerEmpty = consumerCreateReservationSchema.safeParse({
      params: { venueSlug: 'venue' },
      body: { ...common, staffId: '' },
    })

    expect(dashboard).toMatchObject({
      success: false,
      error: { issues: expect.arrayContaining([expect.objectContaining({ message: 'allowOverCapacity debe ser true o false' })]) },
    })
    for (const parsed of [publicWrongType, consumerWrongType]) {
      expect(parsed).toMatchObject({
        success: false,
        error: { issues: expect.arrayContaining([expect.objectContaining({ message: 'staffId debe ser texto' })]) },
      })
    }
    for (const parsed of [publicEmpty, consumerEmpty]) {
      expect(parsed).toMatchObject({
        success: false,
        error: { issues: expect.arrayContaining([expect.objectContaining({ message: 'staffId es requerido' })]) },
      })
    }
  })
})

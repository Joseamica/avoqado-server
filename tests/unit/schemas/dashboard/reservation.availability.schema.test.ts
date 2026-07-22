import { getAvailabilityQuerySchema } from '@/schemas/dashboard/reservation.schema'
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

  it('keeps the public minimum at five minutes even for base semantics', () => {
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '5', windowSemantics: 'base' }).success).toBe(true)
    expect(getAvailabilityQuerySchema.safeParse({ date, duration: '4', windowSemantics: 'base' }).success).toBe(false)
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

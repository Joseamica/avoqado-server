import { recordPromoterPingSchema } from '@/schemas/promoterLocation.schema'

describe('recordPromoterPingSchema', () => {
  it('accepts a valid ping payload', () => {
    const result = recordPromoterPingSchema.safeParse({
      body: { latitude: 19.4326, longitude: -99.1332, accuracy: 12, source: 'PERIODIC' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a minimal payload (only latitude + longitude)', () => {
    const result = recordPromoterPingSchema.safeParse({ body: { latitude: 19.4326, longitude: -99.1332 } })
    expect(result.success).toBe(true)
  })

  it('rejects latitude out of range with a Spanish message', () => {
    const result = recordPromoterPingSchema.safeParse({ body: { latitude: 200, longitude: -99.13 } })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.errors[0].message).toMatch(/latitud/i)
    }
  })

  it('requires latitude and longitude', () => {
    const result = recordPromoterPingSchema.safeParse({ body: {} })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid source value', () => {
    const result = recordPromoterPingSchema.safeParse({ body: { latitude: 19, longitude: -99, source: 'BOGUS' } })
    expect(result.success).toBe(false)
  })
})

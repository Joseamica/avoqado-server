import { grantVenueAccessSchema, listCandidatesSchema } from '@/routes/superadmin/venue-access.schemas'

const UUID = 'f71607dc-cade-402f-8af8-798ce6d1dc66'
const CUID = 'cmph332eq00039kg8z9cqyc4g'

describe('venue-access schemas', () => {
  it('accepts a valid batch grant (mixed cuid/uuid ids)', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: UUID },
      body: { grants: [{ staffId: CUID, role: 'MANAGER', pin: '3987' }] },
    })
    expect(r.success).toBe(true)
  })

  it('accepts a grant without a pin (optional)', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: CUID },
      body: { grants: [{ staffId: CUID, role: 'WAITER' }] },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty grants array in Spanish', () => {
    const r = grantVenueAccessSchema.safeParse({ params: { venueId: CUID }, body: { grants: [] } })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('Selecciona al menos una persona')
  })

  it('rejects an invalid role', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: CUID },
      body: { grants: [{ staffId: CUID, role: 'KING' }] },
    })
    expect(r.success).toBe(false)
  })

  it('rejects a non-numeric / wrong-length pin', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: CUID },
      body: { grants: [{ staffId: CUID, role: 'WAITER', pin: 'abc' }] },
    })
    expect(r.success).toBe(false)
  })

  it('accepts a candidates query with optional sourceVenueId', () => {
    const r = listCandidatesSchema.safeParse({ params: { venueId: CUID }, query: { sourceVenueId: UUID } })
    expect(r.success).toBe(true)
  })

  it('accepts a candidates query without sourceVenueId', () => {
    const r = listCandidatesSchema.safeParse({ params: { venueId: CUID }, query: {} })
    expect(r.success).toBe(true)
  })
})

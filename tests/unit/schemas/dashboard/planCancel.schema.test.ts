import { cancelPlanSchema, downgradeToFreeSchema } from '@/schemas/dashboard/venue.schema'

const params = { venueId: 'venue_1' }

describe('plan cancel and downgrade schemas', () => {
  it('accepts a missing body: dashboards that predate the reason keep working', () => {
    const parsed = cancelPlanSchema.safeParse({ params, body: undefined })
    expect(parsed.success).toBe(true)
    expect(parsed.success && Object.keys(parsed.data.body)).toEqual([])
  })

  it('accepts a reason and a comment on both endpoints', () => {
    expect(cancelPlanSchema.parse({ params, body: { reason: 'UNUSED', comment: ' casi no lo uso ' } }).body).toEqual({
      reason: 'UNUSED',
      comment: 'casi no lo uso',
    })
    expect(downgradeToFreeSchema.parse({ params, body: { keepStaffVenueIds: ['sv1'], reason: 'OTHER' } }).body).toEqual({
      keepStaffVenueIds: ['sv1'],
      reason: 'OTHER',
    })
  })

  it('rejects an unknown reason in Spanish', () => {
    const parsed = cancelPlanSchema.safeParse({ params, body: { reason: 'NOPE' } })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0].message).toBe('El motivo de cancelación no es válido.')
  })

  it('keeps the downgrade selection default', () => {
    expect(downgradeToFreeSchema.parse({ params, body: {} }).body.keepStaffVenueIds).toEqual([])
  })
})

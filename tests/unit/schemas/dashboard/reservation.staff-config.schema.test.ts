import {
  localDateStringSchema,
  operatingHoursSchema,
  productStaffParamsSchema,
  replaceProductStaffBodySchema,
  replaceStaffScheduleBodySchema,
  staffScheduleExceptionSchema,
  staffScheduleParamsSchema,
  weeklyScheduleSchema,
} from '@/schemas/dashboard/reservation.schema'

const openDay = { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] }
const closedDay = { enabled: false, ranges: [] }
const weekly = {
  monday: openDay,
  tuesday: openDay,
  wednesday: openDay,
  thursday: openDay,
  friday: openDay,
  saturday: closedDay,
  sunday: closedDay,
}

describe('staff schedule schemas', () => {
  it('keeps legacy operatingHours optional while weekly is required and seven-day', () => {
    expect(operatingHoursSchema.parse(undefined)).toBeUndefined()
    expect(weeklyScheduleSchema.parse(weekly)).toEqual(weekly)
    expect(() => weeklyScheduleSchema.parse({ ...weekly, sunday: undefined })).toThrow()
  })

  it.each(['2026-02-30', '2026-13-01', '2026-2-01', 'not-a-date'])('rejects impossible or malformed local date %s', value => {
    expect(localDateStringSchema.safeParse(value).success).toBe(false)
  })

  it('accepts leap-day local dates using UTC round-trip validation', () => {
    expect(localDateStringSchema.parse('2028-02-29')).toBe('2028-02-29')
  })

  it('requires an ordered exception date range', () => {
    expect(staffScheduleExceptionSchema.safeParse({ startDate: '2026-07-22', endDate: '2026-07-21', kind: 'OFF' }).success).toBe(false)
  })

  it('requires ordered times for HOURS and forbids times for OFF', () => {
    expect(
      staffScheduleExceptionSchema.safeParse({
        startDate: '2026-07-21',
        endDate: '2026-07-21',
        kind: 'HOURS',
        startTime: '09:00',
        endTime: '17:00',
      }).success,
    ).toBe(true)
    expect(
      staffScheduleExceptionSchema.safeParse({
        startDate: '2026-07-21',
        endDate: '2026-07-21',
        kind: 'HOURS',
        startTime: '17:00',
        endTime: '09:00',
      }).success,
    ).toBe(false)
    expect(
      staffScheduleExceptionSchema.safeParse({
        startDate: '2026-07-21',
        endDate: '2026-07-21',
        kind: 'OFF',
        startTime: '09:00',
        endTime: '17:00',
      }).success,
    ).toBe(false)
  })

  it('accepts at most 30 schedule exceptions', () => {
    const exception = { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'OFF' as const }
    expect(replaceStaffScheduleBodySchema.safeParse({ weekly: null, exceptions: Array(30).fill(exception) }).success).toBe(true)
    expect(replaceStaffScheduleBodySchema.safeParse({ weekly: null, exceptions: Array(31).fill(exception) }).success).toBe(false)
  })

  it('requires the complete schedule body and caps ProductStaff membership', () => {
    expect(replaceStaffScheduleBodySchema.parse({ weekly, exceptions: [] })).toEqual({ weekly, exceptions: [] })
    expect(replaceStaffScheduleBodySchema.safeParse({ exceptions: [] }).success).toBe(false)
    expect(replaceProductStaffBodySchema.safeParse({ staffVenueIds: Array(100).fill('member') }).success).toBe(true)
    expect(replaceProductStaffBodySchema.safeParse({ staffVenueIds: Array(101).fill('member') }).success).toBe(false)
  })

  it('exports tenant-aware exact route parameter schemas', () => {
    expect(staffScheduleParamsSchema.parse({ venueId: 'venue', staffVenueId: 'member' })).toEqual({
      venueId: 'venue',
      staffVenueId: 'member',
    })
    expect(productStaffParamsSchema.parse({ venueId: 'venue', productId: 'product' })).toEqual({
      venueId: 'venue',
      productId: 'product',
    })
    expect(staffScheduleParamsSchema.safeParse({ staffVenueId: 'member' }).success).toBe(false)
    expect(productStaffParamsSchema.safeParse({ venueId: 'venue' }).success).toBe(false)
  })
})

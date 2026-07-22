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
  function messages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string[] {
    return result.success ? [] : result.error!.issues.map(issue => issue.message)
  }

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

  it('localizes missing and wrong-type schedule body fields', () => {
    expect(messages(replaceStaffScheduleBodySchema.safeParse(undefined) as any)).toContain('La configuracion del horario es requerida')
    expect(messages(replaceStaffScheduleBodySchema.safeParse({ exceptions: [] }) as any)).toContain('El horario semanal es requerido')
    expect(messages(replaceStaffScheduleBodySchema.safeParse({ weekly, exceptions: 'none' }) as any)).toContain(
      'Las excepciones deben ser una lista',
    )
  })

  it('localizes exception enum, date, and optional-field type failures', () => {
    const base = { startDate: '2026-07-21', endDate: '2026-07-21' }
    expect(messages(staffScheduleExceptionSchema.safeParse({ ...base, kind: 'VACATION' }) as any)).toContain(
      'El tipo de excepcion debe ser OFF u HOURS',
    )
    expect(messages(staffScheduleExceptionSchema.safeParse({ ...base, kind: 1 }) as any)).toContain(
      'El tipo de excepcion debe ser OFF u HOURS',
    )
    expect(messages(staffScheduleExceptionSchema.safeParse({ endDate: '2026-07-21', kind: 'OFF' }) as any)).toContain(
      'La fecha local es requerida',
    )
    expect(messages(staffScheduleExceptionSchema.safeParse({ ...base, kind: 'OFF', note: 1 }) as any)).toContain('La nota debe ser texto')
  })

  it('localizes representative nested weekly paths', () => {
    expect(messages(weeklyScheduleSchema.safeParse({ ...weekly, monday: { ranges: [] } }) as any)).toContain(
      'El estado del dia es requerido',
    )
    expect(messages(weeklyScheduleSchema.safeParse({ ...weekly, monday: { enabled: false, ranges: 'none' } }) as any)).toContain(
      'Los rangos del dia deben ser una lista',
    )
    expect(
      messages(
        weeklyScheduleSchema.safeParse({
          ...weekly,
          monday: { enabled: true, ranges: [{ close: '17:00' }] },
        }) as any,
      ),
    ).toContain('La hora es requerida')
    expect(
      messages(
        weeklyScheduleSchema.safeParse({
          ...weekly,
          monday: { enabled: true, ranges: [{ open: 9, close: '17:00' }] },
        }) as any,
      ),
    ).toContain('La hora debe ser texto')
  })

  it('localizes ProductStaff body and every route identifier failure', () => {
    expect(messages(replaceProductStaffBodySchema.safeParse(undefined) as any)).toContain('La configuracion de profesionistas es requerida')
    expect(messages(replaceProductStaffBodySchema.safeParse({ staffVenueIds: 'member' }) as any)).toContain(
      'Los profesionistas deben ser una lista',
    )
    expect(messages(replaceProductStaffBodySchema.safeParse({ staffVenueIds: [''] }) as any)).toContain(
      'El ID del profesionista es requerido',
    )
    expect(messages(staffScheduleParamsSchema.safeParse({ venueId: '', staffVenueId: '' }) as any)).toEqual(
      expect.arrayContaining(['El ID del establecimiento es requerido', 'El ID del profesionista es requerido']),
    )
    expect(messages(productStaffParamsSchema.safeParse({ venueId: 1, productId: undefined }) as any)).toEqual(
      expect.arrayContaining(['El ID del establecimiento debe ser texto', 'El ID del producto es requerido']),
    )
  })

  it.each([
    [staffScheduleExceptionSchema, undefined, 'La excepcion es requerida'],
    [staffScheduleExceptionSchema, { startDate: '2026-07-21', endDate: '2026-07-21' }, 'El tipo de excepcion es requerido'],
    [staffScheduleExceptionSchema, { startDate: 1, endDate: '2026-07-21', kind: 'OFF' }, 'La fecha local debe ser texto'],
    [
      staffScheduleExceptionSchema,
      { startDate: '2026-07-21', endDate: '2026-07-21', kind: 'HOURS', startTime: 9, endTime: '17:00' },
      'La hora debe ser texto',
    ],
    [weeklyScheduleSchema, { ...weekly, sunday: undefined }, 'La configuracion del dia es requerida'],
    [weeklyScheduleSchema, { ...weekly, sunday: false }, 'La configuracion del dia debe ser un objeto'],
    [weeklyScheduleSchema, { ...weekly, monday: { enabled: 'yes', ranges: [] } }, 'El estado del dia debe ser booleano'],
    [weeklyScheduleSchema, { ...weekly, monday: { enabled: true, ranges: ['09:00'] } }, 'El rango horario debe ser un objeto'],
    [replaceStaffScheduleBodySchema, { weekly: 'always', exceptions: [] }, 'El horario semanal debe ser un objeto'],
    [replaceStaffScheduleBodySchema, { weekly, exceptions: [false] }, 'La excepcion debe ser un objeto'],
    [replaceProductStaffBodySchema, {}, 'Los profesionistas son requeridos'],
    [replaceProductStaffBodySchema, { staffVenueIds: [1] }, 'El ID del profesionista debe ser texto'],
    [staffScheduleParamsSchema, undefined, 'Los parametros del horario son requeridos'],
    [staffScheduleParamsSchema, 'params', 'Los parametros del horario deben ser un objeto'],
    [productStaffParamsSchema, undefined, 'Los parametros del servicio son requeridos'],
    [productStaffParamsSchema, 'params', 'Los parametros del servicio deben ser un objeto'],
  ])('never falls back to a default English Zod message: %#', (schema, input, expectedMessage) => {
    expect(messages((schema as typeof weeklyScheduleSchema).safeParse(input) as any)).toContain(expectedMessage)
  })
})

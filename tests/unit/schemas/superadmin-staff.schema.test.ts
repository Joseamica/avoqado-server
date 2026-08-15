import { createStaffSchema, assignVenueSchema, updateVenueAssignmentSchema } from '@/schemas/dashboard/superadmin-staff.schema'

const VENUE_ID = 'clzzzzzzzzzzzzzzzzzzzzzzz'
const STAFF_ID = 'clyyyyyyyyyyyyyyyyyyyyyyy'

describe('superadmin staff schemas — PIN de 4 a 10 dígitos', () => {
  // 1. NUEVO: el camino superadmin debe aceptar PINs largos
  it('createStaffSchema acepta un PIN de 10 dígitos', () => {
    const result = createStaffSchema.shape.body.shape.pin.safeParse('1234567890')
    expect(result.success).toBe(true)
  })

  it('assignVenueSchema acepta un PIN de 10 dígitos', () => {
    const result = assignVenueSchema.shape.body.shape.pin.safeParse('1234567890')
    expect(result.success).toBe(true)
  })

  it('updateVenueAssignmentSchema acepta un PIN de 10 dígitos', () => {
    const result = updateVenueAssignmentSchema.shape.body.shape.pin.safeParse('1234567890')
    expect(result.success).toBe(true)
  })

  it('updateVenueAssignmentSchema sigue aceptando null (borrar el PIN)', () => {
    const result = updateVenueAssignmentSchema.shape.body.shape.pin.safeParse(null)
    expect(result.success).toBe(true)
  })

  // 2. REGRESIÓN: lo que ya funcionaba sigue igual
  it('sigue aceptando el PIN de 4 dígitos de siempre', () => {
    expect(createStaffSchema.shape.body.shape.pin.safeParse('1234').success).toBe(true)
    expect(assignVenueSchema.shape.body.shape.pin.safeParse('1234').success).toBe(true)
  })

  it('sigue rechazando 3 dígitos, 11 dígitos y letras', () => {
    expect(createStaffSchema.shape.body.shape.pin.safeParse('123').success).toBe(false)
    expect(createStaffSchema.shape.body.shape.pin.safeParse('12345678901').success).toBe(false)
    expect(createStaffSchema.shape.body.shape.pin.safeParse('12a4').success).toBe(false)
  })

  it('el resto del body de createStaffSchema no cambió', () => {
    const parsed = createStaffSchema.safeParse({
      body: {
        firstName: 'Ana',
        lastName: 'Ruiz',
        email: 'ana@example.com',
        organizationId: VENUE_ID,
        orgRole: 'MEMBER',
        venueId: VENUE_ID,
        venueRole: 'MANAGER',
        pin: '1234567890',
      },
      params: {},
      query: {},
    })
    expect(parsed.success).toBe(true)
  })

  it('updateVenueAssignmentSchema exige un staffId cuid en params', () => {
    const parsed = updateVenueAssignmentSchema.safeParse({
      params: { staffId: 'no-es-cuid', venueId: VENUE_ID },
      body: { pin: '1234567890' },
      query: {},
    })
    expect(parsed.success).toBe(false)
  })

  it('updateVenueAssignmentSchema acepta un params válido', () => {
    const parsed = updateVenueAssignmentSchema.safeParse({
      params: { staffId: STAFF_ID, venueId: VENUE_ID },
      body: { pin: '1234567890' },
      query: {},
    })
    expect(parsed.success).toBe(true)
  })
})

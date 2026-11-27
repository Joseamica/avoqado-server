import { UpdateVenueSettingsSchema } from '../../../src/schemas/dashboard/venueSettings.schema'

const parseBody = (body: unknown) => UpdateVenueSettingsSchema.safeParse({ params: { venueId: 'v1' }, body })

describe('UpdateVenueSettingsSchema googleReviewLink', () => {
  it('accepts a valid Place ID', () => {
    const r = parseBody({ googleReviewLink: 'ChIJ12345abc' })
    expect(r.success).toBe(true)
  })
  it('coerces empty string to null (clearing)', () => {
    const r = parseBody({ googleReviewLink: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.googleReviewLink).toBeNull()
  })
  it('accepts explicit null', () => {
    const r = parseBody({ googleReviewLink: null })
    expect(r.success).toBe(true)
  })
  it('rejects a non-Google URL', () => {
    const r = parseBody({ googleReviewLink: 'https://facebook.com/x' })
    expect(r.success).toBe(false)
  })
  it('still accepts a body without the field (optional)', () => {
    const r = parseBody({ notifyBadReviews: false })
    expect(r.success).toBe(true)
  })
})

describe('UpdateVenueSettingsSchema cash reconciliation opt-in', () => {
  it.each([true, false])('accepts and preserves cashReconciliationEnabled=%s', value => {
    const result = parseBody({ cashReconciliationEnabled: value })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.body.cashReconciliationEnabled).toBe(value)
  })

  it('rejects non-boolean activation values', () => {
    expect(parseBody({ cashReconciliationEnabled: 'true' }).success).toBe(false)
  })
})

// La hora de corte de la «salida olvidada» por sucursal (founder 26-nov: «A»).
describe('UpdateVenueSettingsSchema salidaOlvidadaCorte', () => {
  it.each(['22:00', '04:00', '00:00', '23:59'])('acepta %s', v => {
    const r = parseBody({ salidaOlvidadaCorte: v })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.salidaOlvidadaCorte).toBe(v)
  })
  it('null regresa a la de fábrica', () => {
    const r = parseBody({ salidaOlvidadaCorte: null })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.salidaOlvidadaCorte).toBeNull()
  })
  it.each(['24:00', '22:60', '7:00', '22', 'diez', ''])('rechaza %s con mensaje en español', v => {
    const r = parseBody({ salidaOlvidadaCorte: v })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('La hora de corte debe ir de 00:00 a 23:59, como 22:00')
  })
})

import { mergeReservationBranding, DEFAULT_RESERVATION_BRANDING } from '@/services/dashboard/reservationBranding.service'

describe('mergeReservationBranding', () => {
  it('returns defaults with inherited accent when raw is null', () => {
    const r = mergeReservationBranding(null, '#ff0000')
    expect(r).toEqual({ ...DEFAULT_RESERVATION_BRANDING, accentColor: '#ff0000' })
  })

  it('falls back to legacy blue when primaryColor is not a valid color', () => {
    const r = mergeReservationBranding(null, 'not-a-color')
    expect(r.accentColor).toBe('#006aff')
  })

  it('respects an explicitly stored accentColor over primaryColor', () => {
    const r = mergeReservationBranding({ accentColor: '#00ff00' }, '#ff0000')
    expect(r.accentColor).toBe('#00ff00')
  })

  it('inherits primaryColor when stored accentColor is null', () => {
    const r = mergeReservationBranding({ accentColor: null, showPrices: false }, '#123456')
    expect(r.accentColor).toBe('#123456')
    expect(r.showPrices).toBe(false)
  })

  it('fills missing toggles from defaults (all true)', () => {
    const r = mergeReservationBranding({}, null)
    expect(r.showLogo).toBe(true)
    expect(r.showHeroImage).toBe(true)
    expect(r.showDescriptions).toBe(true)
    expect(r.showDuration).toBe(true)
    expect(r.showPrices).toBe(true)
    expect(r.buttonShape).toBe('rounded')
    expect(r.fontFamily).toBe('DM Sans')
  })
})

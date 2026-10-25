import { recentSalesWindowStart } from '@/services/mobile/recentSales.mobile.service'

describe('Recent sales venue-local window', () => {
  it('starts at the venue midnight 29 days before today', () => {
    expect(recentSalesWindowStart(new Date('2026-10-21T05:30:00Z'), 'America/Mexico_City').toISOString()).toBe('2026-09-21T06:00:00.000Z')
  })

  it('moves one day right after the venue midnight', () => {
    expect(recentSalesWindowStart(new Date('2026-10-21T06:30:00Z'), 'America/Mexico_City').toISOString()).toBe('2026-09-22T06:00:00.000Z')
  })

  it('uses the zone of the venue with daylight saving', () => {
    expect(recentSalesWindowStart(new Date('2026-10-21T05:30:00Z'), 'America/Tijuana').toISOString()).toBe('2026-09-21T07:00:00.000Z')
  })

  it('uses the offset at the start of the window across daylight saving changes', () => {
    expect(recentSalesWindowStart(new Date('2026-11-10T09:00:00Z'), 'America/Tijuana').toISOString()).toBe('2026-10-12T07:00:00.000Z')
  })

  it('handles the year boundary without mutating the input date', () => {
    const now = new Date('2026-01-01T06:00:00Z')
    expect(recentSalesWindowStart(now, 'America/Mexico_City').toISOString()).toBe('2025-12-03T06:00:00.000Z')
    expect(now.toISOString()).toBe('2026-01-01T06:00:00.000Z')
  })
})

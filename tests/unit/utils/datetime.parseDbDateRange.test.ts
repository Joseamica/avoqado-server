/**
 * parseDbDateRange runtime-TZ-independence (2026-06-15). On a UTC Node host (prod
 * default — no TZ set) a bare "YYYY-MM-DD" used to be parsed as UTC midnight, so
 * venueStartOfDay floored it to the PREVIOUS day → the whole range shifted a day
 * earlier (income statement / org dashboard reported the wrong days on prod).
 * These exact-ISO assertions hold under ANY host TZ now; they would have FAILED
 * under TZ=UTC before the fix.
 */
import { parseDbDateRange } from '../../../src/utils/datetime'

describe('parseDbDateRange — venue-local day boundaries, runtime-TZ-independent', () => {
  it('bare YYYY-MM-DD range → exact venue-local boundaries in real UTC (Mexico, UTC-6)', () => {
    const { from, to } = parseDbDateRange('2026-06-02', '2026-06-15', 'America/Mexico_City')
    expect(from.toISOString()).toBe('2026-06-02T06:00:00.000Z') // jun-2 00:00 Mexico
    expect(to.toISOString()).toBe('2026-06-16T05:59:59.999Z') // end of jun-15 Mexico (whole last day in)
  })

  it('includes the WHOLE toDate day (end-of-day, not midnight)', () => {
    const { to } = parseDbDateRange('2026-06-02', '2026-06-02', 'America/Mexico_City')
    expect(to.toISOString()).toBe('2026-06-03T05:59:59.999Z')
  })

  it('honors the venue timezone (UTC venue = literal UTC day)', () => {
    const { from, to } = parseDbDateRange('2026-06-02', '2026-06-02', 'UTC')
    expect(from.toISOString()).toBe('2026-06-02T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-06-02T23:59:59.999Z')
  })

  it('a full ISO instant is treated as the venue-day containing it (unchanged path, also TZ-independent)', () => {
    const { from, to } = parseDbDateRange('2026-06-02T06:00:00.000Z', '2026-06-02T06:00:00.000Z', 'America/Mexico_City')
    expect(from.toISOString()).toBe('2026-06-02T06:00:00.000Z')
    expect(to.toISOString()).toBe('2026-06-03T05:59:59.999Z')
  })
})

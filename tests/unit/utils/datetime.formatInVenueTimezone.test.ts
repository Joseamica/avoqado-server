/**
 * formatInVenueTimezone must render the wall-clock time of the VENUE, whatever
 * timezone the Node host runs in (prod sets no TZ → UTC; CI is UTC; dev is
 * usually America/Mexico_City, which is exactly why this hid for so long).
 *
 * Root cause (2026-08-17, caught by GitHub Actions on
 * cash-drawer-auto-close.job.test.ts): date-fns-tz `format(date, fmt, { timeZone })`
 * does NOT convert the instant — `timeZone` only feeds the `z`/`zzz` tokens — so
 * the output was the HOST's wall clock labelled with the venue's zone. On a UTC
 * host, a payment at 20:00 Mexico rendered as the NEXT day, and
 * bankReconciliation grouped it under the wrong day.
 *
 * Run under `TZ=UTC npx jest …` to prove host-independence: these assertions
 * are the same under any host TZ.
 */
import { formatInVenueTimezone } from '../../../src/utils/datetime'

describe('formatInVenueTimezone — venue wall clock, runtime-TZ-independent', () => {
  // 2026-08-16 10:00Z == 04:00 in Mexico City (UTC-6, no DST since 2022)
  const instant = new Date('2026-08-16T10:00:00.000Z')

  it('renders the venue wall clock, not the host clock', () => {
    expect(formatInVenueTimezone(instant, 'America/Mexico_City', 'yyyy-MM-dd HH:mm')).toBe('2026-08-16 04:00')
  })

  it('a late-evening payment stays on the venue day it happened (bank reconciliation grouping)', () => {
    // 20:30 Mexico on the 15th == 02:30Z on the 16th. Grouping by day must say the 15th.
    const paidAt = new Date('2026-08-16T02:30:00.000Z')
    expect(formatInVenueTimezone(paidAt, 'America/Mexico_City', 'yyyy-MM-dd')).toBe('2026-08-15')
  })

  it('honors the venue timezone (Tijuana is one hour behind CDMX)', () => {
    expect(formatInVenueTimezone(instant, 'America/Tijuana', 'HH:mm')).toBe('03:00')
    expect(formatInVenueTimezone(instant, 'UTC', 'HH:mm')).toBe('10:00')
  })

  it('keeps the documented default format', () => {
    expect(formatInVenueTimezone(instant, 'America/Mexico_City')).toBe('2026-08-16 04:00:00')
  })
})

// tests/unit/services/fiscal/globalPeriod.test.ts
//
// Pure unit tests for closedPeriodFor — injects 'now' so no Date mocking is needed.
// All assertions verify Mexico-timezone boundaries.
//
// IMPORTANT: Mexico City (America/Mexico_City) eliminated DST in 2023 via Decree.
// As of 2023, Mexico City is permanently CST (UTC-6) year-round. There is no CDT season.
// All UTC offsets for Mexico City dates in 2026 are therefore UTC-6 = "T06:00:00Z" at midnight.

import { closedPeriodFor } from '../../../../src/services/fiscal/globalPeriod'

// Helpers: create a Date that corresponds to a given Mexico-local date at noon.
// Since Mexico City is permanently UTC-6 (no DST since 2023), we always use -06:00.
function mxNoon(year: number, month: number, day: number): Date {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return new Date(`${year}-${m}-${d}T12:00:00-06:00`)
}

// Mexico midnight UTC offset (permanently UTC-6 since 2023 DST elimination)
// "2026-MM-DD 00:00 Mexico City" = "2026-MM-DDT06:00:00.000Z"
const MX_MIDNIGHT_OFFSET = '06:00:00.000Z'

describe('closedPeriodFor — MENSUAL', () => {
  it('Jun 3 → closed period = May 2026', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('05')
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('04')
    expect(p.facturaPeriodicity).toBe('month')
    // periodStart = 2026-05-01 00:00 MX = 2026-05-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-01 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 1 → closed period = Dec of previous year', () => {
    const now = mxNoon(2026, 1, 1)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
    expect(p.satPeriodicidad).toBe('04')
    // periodStart = 2025-12-01 00:00 MX = 2025-12-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-12-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Feb 15 → closed period = Jan same year', () => {
    const now = mxNoon(2026, 2, 15)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('01')
    expect(p.anio).toBe(2026)
  })
})

describe('closedPeriodFor — BIMESTRAL', () => {
  it('Jun 3 (May+Jun pair) → closed period = Mar+Apr 2026 (c_Meses=14)', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('14') // Mar+Apr
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('05')
    expect(p.facturaPeriodicity).toBe('two_months')
    // periodStart = 2026-03-01 00:00 MX = 2026-03-01T06:00:00Z (permanently UTC-6)
    expect(p.periodStart.toISOString()).toBe(`2026-03-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-05-01 00:00 MX = 2026-05-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-05-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 15 (Jan+Feb pair) → closed period = Nov+Dec 2025 (c_Meses=18)', () => {
    const now = mxNoon(2026, 1, 15)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('18') // Nov+Dec
    expect(p.anio).toBe(2025)
    // periodStart = 2025-11-01 00:00 MX = 2025-11-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-11-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Aug 1 (Jul+Aug pair) → closed period = May+Jun 2026 (c_Meses=15)', () => {
    const now = mxNoon(2026, 8, 1)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('15') // May+Jun
    expect(p.anio).toBe(2026)
  })

  it('Dec 31 (Nov+Dec pair) → closed period = Sep+Oct same year (c_Meses=17)', () => {
    const now = mxNoon(2026, 12, 31)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('17') // Sep+Oct
    expect(p.anio).toBe(2026)
  })
})

describe('closedPeriodFor — DIARIO', () => {
  it('Jun 3 → closed period = Jun 2 (yesterday)', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('DIARIO', now)
    expect(p.meses).toBe('06')
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('01')
    expect(p.facturaPeriodicity).toBe('day')
    // periodStart = 2026-06-02 00:00 MX = 2026-06-02T06:00:00Z (permanently UTC-6)
    expect(p.periodStart.toISOString()).toBe(`2026-06-02T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-03 00:00 MX = 2026-06-03T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-03T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 1 → closed period = Dec 31 of previous year', () => {
    const now = mxNoon(2026, 1, 1)
    const p = closedPeriodFor('DIARIO', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
    // periodStart = 2025-12-31 00:00 MX (UTC-6) = 2025-12-31T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-12-31T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX (UTC-6) = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })
})

describe('closedPeriodFor — SEMANAL', () => {
  it('returns the previous Mon..Sun week (2026-06-03 is Wednesday)', () => {
    // 2026-06-03 is a Wednesday. Previous week = 2026-05-25(Mon)..2026-06-01(Mon exclusive)
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('SEMANAL', now)
    expect(p.satPeriodicidad).toBe('02')
    expect(p.facturaPeriodicity).toBe('week')
    // periodStart = 2026-05-25 00:00 MX (UTC-6) = 2026-05-25T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-25T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-01 00:00 MX (UTC-6) = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
    expect(p.meses).toBe('05') // May (month of the Mon that starts the closed week)
    expect(p.anio).toBe(2026)
  })

  it('on a Monday, closed week is the one that just ended Sunday', () => {
    // 2026-06-01 is a Monday. Previous week = 2026-05-25..2026-06-01
    const now = mxNoon(2026, 6, 1)
    const p = closedPeriodFor('SEMANAL', now)
    expect(p.periodStart.toISOString()).toBe(`2026-05-25T${MX_MIDNIGHT_OFFSET}`)
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })
})

describe('closedPeriodFor — QUINCENAL', () => {
  it('day 16+ → closed period is 1st fortnight of current month', () => {
    const now = mxNoon(2026, 6, 16)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.satPeriodicidad).toBe('03')
    expect(p.facturaPeriodicity).toBe('fortnight')
    expect(p.meses).toBe('06')
    expect(p.anio).toBe(2026)
    // periodStart = Jun 1 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = Jun 16 00:00 MX = 2026-06-16T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-16T${MX_MIDNIGHT_OFFSET}`)
  })

  it('day <=15 → closed period is 2nd fortnight of previous month', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.meses).toBe('05') // May
    expect(p.anio).toBe(2026)
    // periodStart = May 16 00:00 MX = 2026-05-16T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-16T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = Jun 1 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 10 → closed period is 2nd fortnight of Dec previous year', () => {
    const now = mxNoon(2026, 1, 10)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
  })
})

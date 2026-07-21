import { sumServiceDurations, FALLBACK_SERVICE_DURATION_MIN } from '@/controllers/public/reservation.public.controller'

// Regression for the Amaena double-booking (RES-PY45XU, 2026-07-20): a service
// created without a duration silently added ZERO minutes to the appointment
// window, so a 3-hour booking was blocked as 2 hours and the venue scheduled
// the next client on top of it.
const svc = (id: string, duration: number | null, durationMinutes: number | null = null) => ({ id, duration, durationMinutes })

describe('sumServiceDurations', () => {
  // ── THE BUG ─────────────────────────────────────────────────────────────
  it('pads a duration-less service to the venue default instead of counting it as zero', () => {
    // The exact booking that broke: 3 timed services + the NULL-duration
    // "Manicure + Pedicure Spa + Gel" the venue had just created via the MCP.
    const booked = [
      svc('extension-polygel', 75),
      svc('frances-manos', 25),
      svc('retiro-geles-blandos', 20),
      svc('manicure-pedicure-spa-gel', null),
    ]

    const { totalMinutes, missingDuration } = sumServiceDurations(booked, 90)

    expect(totalMinutes).toBe(210) // 75 + 25 + 20 + 90 — NOT the 120 that overbooked
    expect(missingDuration).toEqual(['manicure-pedicure-spa-gel'])
  })

  it('reports every duration-less service so the venue can fix the catalog', () => {
    const { missingDuration } = sumServiceDurations([svc('a', null), svc('b', 30), svc('c', null)], 60)

    expect(missingDuration).toEqual(['a', 'c'])
  })

  it('falls back to the platform default when the venue has no default configured', () => {
    expect(sumServiceDurations([svc('a', null)], null).totalMinutes).toBe(FALLBACK_SERVICE_DURATION_MIN)
    expect(sumServiceDurations([svc('a', null)], undefined).totalMinutes).toBe(FALLBACK_SERVICE_DURATION_MIN)
  })

  it('never returns zero for a non-empty booking, whatever the catalog looks like', () => {
    expect(sumServiceDurations([svc('a', null), svc('b', null)], 45).totalMinutes).toBe(90)
  })

  // ── REGRESSION: correct catalogs must be untouched ──────────────────────
  it('sums normal services exactly as before', () => {
    // Pamela's booking, which was always correct: 75 + 20 = 95.
    const { totalMinutes, missingDuration } = sumServiceDurations([svc('extension-polygel', 75), svc('retiro-geles-blandos', 20)], 90)

    expect(totalMinutes).toBe(95)
    expect(missingDuration).toEqual([])
  })

  it('still prefers `duration` over `durationMinutes` when both are set', () => {
    expect(sumServiceDurations([svc('a', 40, 999)], 90).totalMinutes).toBe(40)
  })

  it('uses `durationMinutes` when `duration` is null — that is a real duration, not a gap', () => {
    const { totalMinutes, missingDuration } = sumServiceDurations([svc('a', null, 35)], 90)

    expect(totalMinutes).toBe(35)
    expect(missingDuration).toEqual([])
  })

  it('returns zero for an empty booking so the caller can fall back to the picked window', () => {
    expect(sumServiceDurations([], 90)).toEqual({ totalMinutes: 0, missingDuration: [] })
  })

  it('treats a zero-minute service as configured, not missing', () => {
    const { totalMinutes, missingDuration } = sumServiceDurations([svc('addon', 0), svc('b', 30)], 90)

    expect(totalMinutes).toBe(30)
    expect(missingDuration).toEqual([])
  })
})

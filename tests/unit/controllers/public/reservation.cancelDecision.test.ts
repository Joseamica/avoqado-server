import { computeCancelDecision } from '@/controllers/public/reservation.public.controller'

/**
 * Regression tests for the single source of truth that decides whether a
 * customer can self-cancel. This is what powers `cancellation.allowed` in the
 * public GET response (read by the booking widget + consumer app to enable the
 * cancel control) AND the POST cancel guard. The Amaena incident (RES-AQ3Q3W):
 * booking made 1.5h before start with a 2h cancel cutoff → the UI offered a
 * cancel that the server rejected. These lock the gates in order.
 */
describe('computeCancelDecision', () => {
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000)

  it('allows when toggle on, status CONFIRMED, and outside the cutoff window', () => {
    const d = computeCancelDecision({
      status: 'CONFIRMED',
      startsAt: hoursFromNow(5),
      allowCustomerCancel: true,
      minHoursBeforeStart: 2,
    })
    expect(d).toEqual({ allowed: true, reason: null })
  })

  it('blocks with TOO_LATE inside the cutoff window (the Amaena case: 1.5h < 2h)', () => {
    const d = computeCancelDecision({
      status: 'CONFIRMED',
      startsAt: hoursFromNow(1.5),
      allowCustomerCancel: true,
      minHoursBeforeStart: 2,
    })
    expect(d).toEqual({ allowed: false, reason: 'TOO_LATE' })
  })

  it('blocks with NOT_ALLOWED when the venue toggle is off (even far in the future)', () => {
    const d = computeCancelDecision({
      status: 'CONFIRMED',
      startsAt: hoursFromNow(48),
      allowCustomerCancel: false,
      minHoursBeforeStart: 2,
    })
    expect(d).toEqual({ allowed: false, reason: 'NOT_ALLOWED' })
  })

  it('blocks with NOT_CANCELLABLE_STATUS for NO_SHOW / CANCELLED / COMPLETED', () => {
    for (const status of ['NO_SHOW', 'CANCELLED', 'COMPLETED']) {
      const d = computeCancelDecision({
        status,
        startsAt: hoursFromNow(10),
        allowCustomerCancel: true,
        minHoursBeforeStart: 2,
      })
      expect(d).toEqual({ allowed: false, reason: 'NOT_CANCELLABLE_STATUS' })
    }
  })

  it('allows PENDING (deposit not yet paid) when within policy', () => {
    const d = computeCancelDecision({
      status: 'PENDING',
      startsAt: hoursFromNow(10),
      allowCustomerCancel: true,
      minHoursBeforeStart: 2,
    })
    expect(d.allowed).toBe(true)
  })

  it('treats null minHoursBeforeStart as "no time limit" (only toggle + status gate)', () => {
    const d = computeCancelDecision({
      status: 'CONFIRMED',
      startsAt: hoursFromNow(0.1),
      allowCustomerCancel: true,
      minHoursBeforeStart: null,
    })
    expect(d).toEqual({ allowed: true, reason: null })
  })

  it('checks gates in order: toggle off wins over a too-late window', () => {
    const d = computeCancelDecision({
      status: 'CONFIRMED',
      startsAt: hoursFromNow(0.5),
      allowCustomerCancel: false,
      minHoursBeforeStart: 2,
    })
    expect(d.reason).toBe('NOT_ALLOWED')
  })
})

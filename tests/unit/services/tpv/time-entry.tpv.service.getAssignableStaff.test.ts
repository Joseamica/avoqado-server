/**
 * getAssignableStaff — narrow companion to getCurrentlyClockedInStaff for the
 * ASSIGN_ORDER staff picker (Fix 2, "staff picker", 2026-08-07 — see
 * .superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/zombie-table-and-staff-picker.md).
 *
 * The whole point of this function is that it is gated by `orders:update`
 * (WAITER+) instead of `tpv-time-entries:read` (MANAGER+) — see the route
 * wiring test (tests/unit/routes/tpv.staffAssignable.routes.test.ts). That
 * only stays safe if the DATA it returns never leaks clock-in/out or break
 * timestamps to a role that isn't supposed to see the time-clock view. This
 * file pins that: the Prisma call uses `select` (an explicit allow-list), not
 * `include` (an allow-list wrapper THAT STILL ADDS fields on top of the
 * default row) — `getCurrentlyClockedInStaff` uses `include` deliberately
 * because IT is allowed to return clockInTime/breaks; this function must not.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    timeEntry: { findMany: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { getAssignableStaff } from '../../../../src/services/tpv/time-entry.tpv.service'

const mockedFindMany = (prisma as any).timeEntry.findMany as jest.Mock

describe('time-entry.tpv.service — getAssignableStaff', () => {
  beforeEach(() => jest.clearAllMocks())

  it('queries with select (never include) and asks for exactly staffId, status, and the staff name fields — no clock timestamps', async () => {
    mockedFindMany.mockResolvedValue([])

    await getAssignableStaff('venue-1')

    expect(mockedFindMany).toHaveBeenCalledTimes(1)
    const call = mockedFindMany.mock.calls[0][0]

    expect(call.include).toBeUndefined()
    expect(call.select).toEqual({
      staffId: true,
      status: true,
      staff: { select: { firstName: true, lastName: true, employeeCode: true } },
    })
    // Explicit negative — this is the regression a careless future edit would
    // reintroduce (copy-pasting getCurrentlyClockedInStaff's `include` block).
    expect(JSON.stringify(call.select)).not.toMatch(/clockInTime|breaks|photoUrl/)
  })

  it('only asks for CLOCKED_IN / ON_BREAK entries, scoped to the venue', async () => {
    mockedFindMany.mockResolvedValue([])

    await getAssignableStaff('venue-1')

    const call = mockedFindMany.mock.calls[0][0]
    expect(call.where).toEqual({ venueId: 'venue-1', status: { in: ['CLOCKED_IN', 'ON_BREAK'] } })
  })

  it('passes through whatever Prisma returns for the narrow shape — status carries the on-break flag the picker needs', async () => {
    mockedFindMany.mockResolvedValue([
      { staffId: 'staff-1', status: 'CLOCKED_IN', staff: { firstName: 'Ana', lastName: 'Lopez', employeeCode: 'EMP-1' } },
      { staffId: 'staff-2', status: 'ON_BREAK', staff: { firstName: 'Beto', lastName: 'Ruiz', employeeCode: null } },
    ])

    const result = await getAssignableStaff('venue-1')

    expect(result).toEqual([
      { staffId: 'staff-1', status: 'CLOCKED_IN', staff: { firstName: 'Ana', lastName: 'Lopez', employeeCode: 'EMP-1' } },
      { staffId: 'staff-2', status: 'ON_BREAK', staff: { firstName: 'Beto', lastName: 'Ruiz', employeeCode: null } },
    ])
  })

  // ── REGRESSION: sibling function's broader shape is untouched ───────────
  it('regression: getCurrentlyClockedInStaff (the MANAGER view) still uses include with breaks/photoUrl — this fix did not narrow that one too', async () => {
    const { getCurrentlyClockedInStaff } = await import('../../../../src/services/tpv/time-entry.tpv.service')
    mockedFindMany.mockResolvedValue([])

    await getCurrentlyClockedInStaff('venue-1')

    const call = mockedFindMany.mock.calls[0][0]
    expect(call.include).toEqual({
      staff: { select: { firstName: true, lastName: true, employeeCode: true, photoUrl: true } },
      breaks: { where: { endTime: null } },
    })
  })
})

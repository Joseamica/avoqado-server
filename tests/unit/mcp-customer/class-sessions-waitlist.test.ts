/**
 * Read tools for two RESERVATIONS-feature capabilities that shipped without MCP coverage
 * (coverage-gap sweep, 2026-06-29): group classes and the reservation waitlist.
 *
 *   - list_class_sessions  — upcoming classes with capacity / enrolled / available
 *   - class_session_detail — the attendee roster of one session
 *   - list_waitlist        — the live queue (waiting + notified)
 *
 * All three are reads gated by the PRO RESERVATIONS feature (same gate as every other
 * reservation tool — mirrors checkFeatureAccess('RESERVATIONS') on the dashboard route).
 */
import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetClassSession = jest.fn()
const mockGetWaitlist = jest.fn()
const mockPlanGate = jest.fn()
const mockSessionFindMany = jest.fn()

jest.mock('@/services/dashboard/classSession.dashboard.service', () => ({
  getClassSession: (...a: unknown[]) => mockGetClassSession(...(a as [])),
}))
jest.mock('@/services/dashboard/reservationWaitlist.service', () => ({
  getWaitlist: (...a: unknown[]) => mockGetWaitlist(...(a as [])),
}))
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  checkInReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
  updateReservation: jest.fn(),
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  getReservationSettings: jest.fn(),
  updateReservationSettings: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { classSession: { findMany: (...a: unknown[]) => mockSessionFindMany(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled (PRO) by default
})

describe('list_class_sessions (read, PRO-gated)', () => {
  it('rejects an out-of-scope venue', async () => {
    await expect(call('list_class_sessions', { venueId: 'foreign' })).rejects.toThrow('out of scope')
  })

  it('fires the PRO gate when the venue lacks RESERVATIONS', async () => {
    mockPlanGate.mockResolvedValueOnce('Las reservaciones requieren el plan PRO')
    const out = parse(await call('list_class_sessions', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockSessionFindMany).not.toHaveBeenCalled()
  })

  it('computes enrolled / available from seat-occupying bookings', async () => {
    mockSessionFindMany.mockResolvedValueOnce([
      {
        id: 'cs1',
        startsAt: new Date('2026-07-01T18:00:00Z'),
        endsAt: new Date('2026-07-01T19:00:00Z'),
        duration: 60,
        capacity: 10,
        status: 'SCHEDULED',
        product: { name: 'Yoga' },
        assignedStaff: { firstName: 'Ana', lastName: 'Ruiz' },
        reservations: [{ partySize: 2 }, { partySize: 1 }],
      },
    ])
    const out = parse(await call('list_class_sessions', { venueId: 'v1' }))
    expect(out.count).toBe(1)
    expect(out.sessions[0]).toMatchObject({
      sessionId: 'cs1',
      className: 'Yoga',
      capacity: 10,
      enrolled: 3,
      available: 7,
      instructor: 'Ana Ruiz',
      status: 'SCHEDULED',
    })
    // upcoming-only by default → the query filters startsAt >= now
    const where = mockSessionFindMany.mock.calls[0][0].where
    expect(where.startsAt).toHaveProperty('gte')
  })

  it('includePast drops the upcoming-only time filter', async () => {
    mockSessionFindMany.mockResolvedValueOnce([])
    await call('list_class_sessions', { venueId: 'v1', includePast: true })
    expect(mockSessionFindMany.mock.calls[0][0].where.startsAt).toBeUndefined()
  })
})

describe('class_session_detail (read, PRO-gated)', () => {
  it('returns the attendee roster', async () => {
    mockGetClassSession.mockResolvedValueOnce({
      id: 'cs1',
      product: { name: 'Yoga' },
      startsAt: new Date('2026-07-01T18:00:00Z'),
      endsAt: new Date('2026-07-01T19:00:00Z'),
      duration: 60,
      capacity: 10,
      enrolled: 3,
      available: 7,
      assignedStaff: { firstName: 'Ana', lastName: 'Ruiz' },
      status: 'SCHEDULED',
      reservations: [
        { confirmationCode: 'RES-AAA', status: 'CONFIRMED', partySize: 2, guestName: 'Luis', guestPhone: '555', customer: null },
        {
          confirmationCode: 'RES-BBB',
          status: 'CHECKED_IN',
          partySize: 1,
          guestName: null,
          guestPhone: null,
          customer: { firstName: 'Mar', lastName: 'Lopez', phone: '999' },
        },
      ],
    })
    const out = parse(await call('class_session_detail', { venueId: 'v1', sessionId: 'cs1' }))
    expect(out.found).toBe(true)
    expect(out.session).toMatchObject({ sessionId: 'cs1', enrolled: 3, available: 7, instructor: 'Ana Ruiz' })
    expect(out.attendees).toEqual([
      { name: 'Luis', phone: '555', partySize: 2, status: 'CONFIRMED', confirmationCode: 'RES-AAA' },
      { name: 'Mar Lopez', phone: '999', partySize: 1, status: 'CHECKED_IN', confirmationCode: 'RES-BBB' },
    ])
  })

  it('returns found:false when the session is not in this venue', async () => {
    mockGetClassSession.mockRejectedValueOnce(new Error('Sesión no encontrada'))
    const out = parse(await call('class_session_detail', { venueId: 'v1', sessionId: 'nope' }))
    expect(out.found).toBe(false)
  })
})

describe('list_waitlist (read, PRO-gated)', () => {
  it('returns the queue in position order with resolved names', async () => {
    mockGetWaitlist.mockResolvedValueOnce([
      {
        position: 1,
        customer: { firstName: 'Mar', lastName: 'Lopez', phone: '999' },
        guestName: null,
        guestPhone: null,
        partySize: 2,
        desiredStartAt: new Date('2026-07-01T20:00:00Z'),
        status: 'WAITING',
        promotedReservation: null,
      },
      {
        position: 2,
        customer: null,
        guestName: 'Pedro',
        guestPhone: '777',
        partySize: 4,
        desiredStartAt: new Date('2026-07-01T21:00:00Z'),
        status: 'NOTIFIED',
        promotedReservation: { confirmationCode: 'RES-CCC' },
      },
    ])
    const out = parse(await call('list_waitlist', { venueId: 'v1' }))
    expect(out.count).toBe(2)
    expect(out.waitlist[0]).toMatchObject({ position: 1, name: 'Mar Lopez', phone: '999', status: 'WAITING' })
    expect(out.waitlist[1]).toMatchObject({ position: 2, name: 'Pedro', phone: '777', promotedReservation: 'RES-CCC' })
    // default (no status) → the service is asked for the live queue (undefined status)
    expect(mockGetWaitlist).toHaveBeenCalledWith('v1', undefined)
  })

  it('forwards a specific status filter, mapped to the enum', async () => {
    mockGetWaitlist.mockResolvedValueOnce([])
    await call('list_waitlist', { venueId: 'v1', status: 'promoted' })
    expect(mockGetWaitlist).toHaveBeenCalledWith('v1', 'PROMOTED')
  })

  it('fires the PRO gate when the venue lacks RESERVATIONS', async () => {
    mockPlanGate.mockResolvedValueOnce('Las reservaciones requieren el plan PRO')
    const out = parse(await call('list_waitlist', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockGetWaitlist).not.toHaveBeenCalled()
  })
})

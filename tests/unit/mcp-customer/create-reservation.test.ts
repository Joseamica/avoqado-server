import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

// Verify create_reservation wiring (date parse, duration → endsAt, service args, audit) without
// touching the DB. The createReservation service itself is tested in the dashboard suite.
const mockCreate = jest.fn(async () => ({ id: 'r-new', confirmationCode: 'RES-NEW1', status: 'CONFIRMED' }))
const mockLogAction = jest.fn()

jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: (...a: unknown[]) => mockCreate(...(a as [])),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  checkInReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    reservation: { findFirst: jest.fn(), findMany: jest.fn() },
    // create_reservation resolves the venue timezone to interpret naive datetimes venue-locally.
    venue: { findUnique: async () => ({ timezone: 'America/Mexico_City' }) },
  },
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_reservation')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_reservation', () => {
  it('creates it: default 90-min duration → endsAt, attributed to the staff, returns the code', async () => {
    const res = await call({ venueId: 'v1', startsAt: '2026-06-06T19:00:00.000Z', partySize: 4, guestName: 'Ana' })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const [venueId, data, createdById] = mockCreate.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
    expect(venueId).toBe('v1')
    expect(createdById).toBe('staff-1')
    expect(data.duration).toBe(90)
    expect((data.startsAt as Date).toISOString()).toBe('2026-06-06T19:00:00.000Z')
    expect((data.endsAt as Date).toISOString()).toBe('2026-06-06T20:30:00.000Z') // +90 min
    expect(data.partySize).toBe(4)
    expect(data.guestName).toBe('Ana')

    const out = parse(res)
    expect(out.ok).toBe(true)
    expect(out.reservation.confirmationCode).toBe('RES-NEW1')
  })

  it('honors a custom durationMinutes', async () => {
    await call({ venueId: 'v1', startsAt: '2026-06-06T19:00:00.000Z', partySize: 2, durationMinutes: 120 })
    const [, data] = mockCreate.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
    expect(data.duration).toBe(120)
    expect((data.endsAt as Date).toISOString()).toBe('2026-06-06T21:00:00.000Z')
  })

  it('audits RESERVATION_CREATED tagged source=customer-mcp', async () => {
    await call({ venueId: 'v1', startsAt: '2026-06-06T19:00:00.000Z', partySize: 2 })
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'RESERVATION_CREATED',
      entity: 'Reservation',
      entityId: 'r-new',
      staffId: 'staff-1',
      venueId: 'v1',
      data: { source: 'customer-mcp' },
    })
  })

  it('rejects an invalid startsAt without calling the service', async () => {
    const out = parse(await call({ venueId: 'v1', startsAt: 'not-a-date', partySize: 2 }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('interprets a NAIVE datetime as venue-local, not host-UTC (the 6h-shift bug)', async () => {
    // "7pm" with no zone → 7pm at the venue (America/Mexico_City, -6) → 01:00Z next day.
    // The old bare-new-Date path would have stored 19:00Z under a UTC host — 6h early.
    await call({ venueId: 'v1', startsAt: '2026-06-06T19:00:00', partySize: 2 })
    const [, data] = mockCreate.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
    expect((data.startsAt as Date).toISOString()).toBe('2026-06-07T01:00:00.000Z')
    expect((data.endsAt as Date).toISOString()).toBe('2026-06-07T02:30:00.000Z') // +90 min
  })

  it('still respects an explicit Z (absolute instant) unchanged', async () => {
    await call({ venueId: 'v1', startsAt: '2026-06-06T19:00:00.000Z', partySize: 2 })
    const [, data] = mockCreate.mock.calls[0] as unknown as [string, Record<string, unknown>, string]
    expect((data.startsAt as Date).toISOString()).toBe('2026-06-06T19:00:00.000Z')
  })
})

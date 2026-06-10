import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

// Isolate the dispatch logic of set_reservation_status. Scope/permission enforcement
// is covered by guard.test.ts, so we stub the guard; we mock the reservation services,
// prisma, and the audit writer to assert the status → service mapping + audit.
const mockConfirm = jest.fn(async () => ({ id: 'r1', status: 'CONFIRMED' }))
const mockCheckIn = jest.fn(async () => ({ id: 'r1', status: 'CHECKED_IN' }))
const mockComplete = jest.fn(async () => ({ id: 'r1', status: 'COMPLETED' }))
const mockNoShow = jest.fn(async () => ({ id: 'r1', status: 'NO_SHOW' }))
const mockFindFirst = jest.fn(async () => ({ id: 'r1', venueId: 'v1', status: 'PENDING' }))
const mockLogAction = jest.fn()

jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: (...a: unknown[]) => mockConfirm(...(a as [])),
  checkInReservation: (...a: unknown[]) => mockCheckIn(...(a as [])),
  completeReservation: (...a: unknown[]) => mockComplete(...(a as [])),
  markNoShow: (...a: unknown[]) => mockNoShow(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { reservation: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) } },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))

const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (status: string) => handlers.get('set_reservation_status')!({ venueId: 'v1', confirmationCode: 'RES-1', status }, {})

beforeAll(() => {
  const srv = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) }
  registerReservationTools(srv as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('set_reservation_status dispatch', () => {
  it("'confirmed' → confirmReservation(venueId, id, 'SYSTEM')", async () => {
    await call('confirmed')
    expect(mockConfirm).toHaveBeenCalledWith('v1', 'r1', 'SYSTEM')
    expect(mockCheckIn).not.toHaveBeenCalled()
  })
  it("'checked_in' → checkInReservation", async () => {
    await call('checked_in')
    expect(mockCheckIn).toHaveBeenCalledWith('v1', 'r1', 'SYSTEM')
  })
  it("'completed' → completeReservation (no actor arg)", async () => {
    await call('completed')
    expect(mockComplete).toHaveBeenCalledWith('v1', 'r1')
  })
  it("'no_show' → markNoShow", async () => {
    await call('no_show')
    expect(mockNoShow).toHaveBeenCalledWith('v1', 'r1', 'SYSTEM')
  })
  it('audits RESERVATION_<STATUS> with from/to + source=customer-mcp, attributed to the staff', async () => {
    await call('no_show')
    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'RESERVATION_NO_SHOW',
      entity: 'Reservation',
      entityId: 'r1',
      staffId: 's1',
      venueId: 'v1',
      data: { confirmationCode: 'RES-1', from: 'PENDING', to: 'no_show', source: 'customer-mcp' },
    })
  })
  it('returns ok:false (and calls no service) when the reservation is not found', async () => {
    mockFindFirst.mockResolvedValueOnce(null as never)
    const res = await call('confirmed')
    expect(JSON.parse(res.content[0].text).ok).toBe(false)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

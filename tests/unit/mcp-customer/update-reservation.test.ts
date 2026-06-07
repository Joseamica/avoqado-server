import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

const mockReservationFindFirst = jest.fn()
const mockUpdate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing reservations:update')
    },
  }),
}))
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  checkInReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
  updateReservation: (...a: unknown[]) => mockUpdate(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { reservation: { findFirst: (...a: unknown[]) => mockReservationFindFirst(...(a as [])), findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('update_reservation')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('update_reservation (safe T1 write)', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', confirmationCode: 'A', partySize: 4 })).rejects.toThrow('out of scope')
    expect(mockReservationFindFirst).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks reservations:update', async () => {
    await expect(call({ venueId: 'no-perm', confirmationCode: 'A', partySize: 4 })).rejects.toThrow('Forbidden')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns not-found for an unknown code (no write)', async () => {
    mockReservationFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1', confirmationCode: 'NOPE', partySize: 4 }))
    expect(out.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects when no editable field is supplied', async () => {
    mockReservationFindFirst.mockResolvedValueOnce({ id: 'r1', venueId: 'v1' })
    const out = parse(await call({ venueId: 'v1', confirmationCode: 'ABC' }))
    expect(out.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('passes only the supplied fields to the service and audits the update', async () => {
    mockReservationFindFirst.mockResolvedValueOnce({ id: 'r1', venueId: 'v1' })
    mockUpdate.mockResolvedValueOnce({ id: 'r1', partySize: 6, specialRequests: 'Cumpleaños' })

    const out = parse(await call({ venueId: 'v1', confirmationCode: 'ABC', partySize: 6, specialRequests: 'Cumpleaños' }))

    expect(mockUpdate).toHaveBeenCalledWith('v1', 'r1', { partySize: 6, specialRequests: 'Cumpleaños' }, 's1')
    expect(out.ok).toBe(true)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'RESERVATION_UPDATED',
      entity: 'Reservation',
      entityId: 'r1',
      venueId: 'v1',
      data: { confirmationCode: 'ABC', fields: ['partySize', 'specialRequests'] },
    })
  })
})

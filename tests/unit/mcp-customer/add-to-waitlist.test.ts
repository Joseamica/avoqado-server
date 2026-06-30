/**
 * add_to_waitlist (write) — first appointment-services WRITE for the waitlist (coverage-gap
 * sweep, 2026-06-29). Links a known customer (resolve-don't-guess) or a walk-in guest, then
 * enqueues via addToWaitlist with the venue's reservation settings as the waitlist config.
 * Gated by reservations:create + the PRO RESERVATIONS feature (mirrors POST /waitlist).
 */
import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

const mockAdd = jest.fn()
const mockSettings = jest.fn()
const mockAudit = jest.fn()
const mockPlanGate = jest.fn()
const mockCustomerFind = jest.fn()

jest.mock('@/services/dashboard/reservationWaitlist.service', () => ({
  getWaitlist: jest.fn(),
  addToWaitlist: (...a: unknown[]) => mockAdd(...(a as [])),
}))
jest.mock('@/services/dashboard/classSession.dashboard.service', () => ({ getClassSession: jest.fn() }))
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
  getReservationSettings: (...a: unknown[]) => mockSettings(...(a as [])),
  updateReservationSettings: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v ?? 'v1'] } }
    },
    requirePermission: (_p: string, v: string) => {
      if (v === 'noperm') throw new Error('Forbidden: missing reservations:create')
    },
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('add_to_waitlist')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const when = '2026-06-29T20:00:00.000Z'

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled (PRO) by default
  mockSettings.mockResolvedValue({ waitlist: { enabled: true, maxSize: 50 } })
  mockAdd.mockResolvedValue({ id: 'wl1', position: 3, partySize: 2, status: 'WAITING' })
})

describe('add_to_waitlist (write, reservations:create + PRO)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', desiredStartAt: when })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'noperm', desiredStartAt: when, guestName: 'X' })).rejects.toThrow('Forbidden')
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('fires the PRO gate when the venue lacks RESERVATIONS', async () => {
    mockPlanGate.mockResolvedValueOnce('Las reservaciones requieren PRO')
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when, guestName: 'X' }))
    expect(out.planRequired).toBe(true)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('rejects an invalid desiredStartAt', async () => {
    const out = parse(await call({ venueId: 'v1', desiredStartAt: 'mañana', guestName: 'X' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/inválido/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('requires search or guestName', async () => {
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/search.*guestName/)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('links a known customer (resolved by search) and audits', async () => {
    mockCustomerFind.mockResolvedValueOnce([{ id: 'c1', firstName: 'María', lastName: 'L' }])
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when, partySize: 2, search: 'maria' }))
    expect(mockAdd).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ customerId: 'c1', partySize: 2, desiredStartAt: new Date(when) }),
      { waitlist: { enabled: true, maxSize: 50 } },
    )
    expect(out).toMatchObject({ ok: true, waitlistEntry: { who: 'María L', position: 3, status: 'WAITING' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'WAITLIST_ADDED', entityId: 'wl1', venueId: 'v1' })
  })

  it('adds a walk-in guest (no customer link)', async () => {
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when, guestName: 'Pedro', guestPhone: '55' }))
    expect(mockAdd).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ guestName: 'Pedro', guestPhone: '55', partySize: 1 }),
      expect.anything(),
    )
    expect(mockCustomerFind).not.toHaveBeenCalled()
    expect(out.waitlistEntry.who).toBe('Pedro')
  })

  it('returns ambiguous when several customers match (no enqueue)', async () => {
    mockCustomerFind.mockResolvedValueOnce([
      { id: 'a', firstName: 'María', lastName: 'A' },
      { id: 'b', firstName: 'María', lastName: 'B' },
    ])
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when, search: 'maria' }))
    expect(out.ambiguous).toBe(true)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('surfaces a service rejection (waitlist full) as ok:false', async () => {
    mockCustomerFind.mockResolvedValueOnce([{ id: 'c1', firstName: 'María', lastName: 'L' }])
    mockAdd.mockRejectedValueOnce(new Error('La lista de espera esta llena'))
    const out = parse(await call({ venueId: 'v1', desiredStartAt: when, search: 'maria' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/llena/)
  })
})

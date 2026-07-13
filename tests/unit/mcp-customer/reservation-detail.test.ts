import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import type { McpScope } from '../../../src/mcp/scope'

const mockReservationFindFirst = jest.fn()
const mockProductFindMany = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
// reservation write tools import these at module load — stub so registration succeeds
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  checkInReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    reservation: { findFirst: (...a: unknown[]) => mockReservationFindFirst(...(a as [])), findMany: jest.fn() },
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('reservation_detail')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerReservationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('reservation_detail', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', confirmationCode: 'ABC' })).rejects.toThrow('out of scope')
    expect(mockReservationFindFirst).not.toHaveBeenCalled()
  })

  it('returns found:false for an unknown code (scoped to the venue)', async () => {
    mockReservationFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1', confirmationCode: 'NOPE' }))
    expect(out.found).toBe(false)
    expect((mockReservationFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1'] },
      confirmationCode: 'NOPE',
    })
  })

  it('maps the full detail and never leaks the deposit processor reference', async () => {
    mockReservationFindFirst.mockResolvedValueOnce({
      confirmationCode: 'ABC123',
      status: 'CONFIRMED',
      startsAt: new Date('2026-06-10T20:00:00Z'),
      endsAt: new Date('2026-06-10T22:00:00Z'),
      partySize: 4,
      guestName: 'Ana',
      guestPhone: '555',
      guestEmail: 'ana@x.com',
      specialRequests: 'Cumpleaños',
      internalNotes: 'Cliente VIP',
      depositAmount: 200,
      depositStatus: 'PAID',
      depositPaidAt: new Date('2026-06-05T10:00:00Z'),
      checkedInAt: null,
      noShowAt: null,
      createdAt: new Date('2026-06-01T10:00:00Z'),
      table: { number: '7' },
      productId: null,
      productIds: [],
      product: null,
      modifiers: [],
    })
    const out = parse(await call({ venueId: 'v1', confirmationCode: 'ABC123' }))

    expect(out.found).toBe(true)
    expect(out.reservation).toMatchObject({
      confirmationCode: 'ABC123',
      status: 'CONFIRMED',
      partySize: 4,
      guest: { name: 'Ana', phone: '555', email: 'ana@x.com' },
      table: '7',
      service: null,
      services: [],
      modifiers: [],
      deposit: { amount: 200, status: 'PAID' },
      specialRequests: 'Cumpleaños',
      internalNotes: 'Cliente VIP',
    })
    // A table-only reservation has no services → skip the product lookup entirely
    expect(mockProductFindMany).not.toHaveBeenCalled()
    expect(JSON.stringify(out)).not.toContain('depositProcessorRef')
  })

  it('returns the FULL ordered service list for a multi-service appointment (regression)', async () => {
    // The exact prod bug: booking of two services + a modifier on the 2nd.
    // The lead service is in productId; the full ordered list in productIds[].
    mockReservationFindFirst.mockResolvedValueOnce({
      confirmationCode: 'GUNPN8',
      status: 'CONFIRMED',
      startsAt: new Date('2026-07-14T15:30:00Z'),
      endsAt: new Date('2026-07-14T17:55:00Z'),
      partySize: 1,
      guestName: 'Raquel',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      internalNotes: null,
      depositAmount: null,
      depositStatus: null,
      depositPaidAt: null,
      checkedInAt: null,
      noShowAt: null,
      createdAt: new Date('2026-07-11T21:45:00Z'),
      table: null,
      productId: 'p-baby',
      productIds: ['p-baby', 'p-manipedi'],
      product: { id: 'p-baby', name: 'Baby Boomer' },
      modifiers: [{ productId: 'p-manipedi', name: 'Gel semipermanente', quantity: 1, price: 220 }],
    })
    // findMany returns unordered — the tool must re-order to match productIds
    mockProductFindMany.mockResolvedValueOnce([
      { id: 'p-manipedi', name: 'Manicure + Pedicure + Spa', price: 800, duration: 70 },
      { id: 'p-baby', name: 'Baby Boomer', price: 150, duration: 25 },
    ])
    const out = parse(await call({ venueId: 'v1', confirmationCode: 'GUNPN8' }))

    expect(out.found).toBe(true)
    // Lead service kept for back-compat
    expect(out.reservation.service).toBe('Baby Boomer')
    // BOTH services returned, in booking order (the bug dropped the 2nd)
    expect(out.reservation.services).toEqual([
      { name: 'Baby Boomer', price: 150, durationMin: 25 },
      { name: 'Manicure + Pedicure + Spa', price: 800, durationMin: 70 },
    ])
    // Modifier surfaced, tagged to its service, price in pesos (major units)
    expect(out.reservation.modifiers).toEqual([{ name: 'Gel semipermanente', productId: 'p-manipedi', quantity: 1, price: 220 }])
    expect((mockProductFindMany.mock.calls[0][0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(['p-baby', 'p-manipedi'])
  })
})

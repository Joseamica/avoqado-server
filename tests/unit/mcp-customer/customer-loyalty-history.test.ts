import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindCustomers = jest.fn()
const mockHistoria = jest.fn()
const mockPlan = jest.fn().mockResolvedValue(null)

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlan(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findMany: (...a: unknown[]) => mockFindCustomers(...(a as [])) } },
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/loyalty.dashboard.service'),
  getLoyaltyTransactions: (...a: unknown[]) => mockHistoria(...a),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('customer_loyalty_history')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('customer_loyalty_history', () => {
  it('rechaza un negocio fuera del alcance', async () => {
    await expect(call({ venueId: 'foreign', search: 'Ana' })).rejects.toThrow('out of scope')
  })

  it('sin plan no lee nada', async () => {
    mockPlan.mockResolvedValueOnce('Requiere plan')
    expect(parse(await call({ venueId: 'v1', search: 'Ana' })).planRequired).toBe(true)
    expect(mockFindCustomers).not.toHaveBeenCalled()
  })

  it('un cliente que no existe lo dice', async () => {
    mockFindCustomers.mockResolvedValueOnce([])
    expect(parse(await call({ venueId: 'v1', search: 'Nadie' })).found).toBe(false)
  })

  it('un reembolso sale legible: tipo conocido, motivo con la venta y su referencia', async () => {
    mockFindCustomers.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', lastName: 'Ruiz' }])
    mockHistoria.mockResolvedValueOnce({
      currentBalance: 0,
      meta: { totalCount: 41, currentPage: 2, hasNextPage: true },
      data: [
        {
          type: 'ADJUST',
          points: -100,
          reason: 'Reembolso completo de la venta 123: se quitan 100 puntos',
          order: { orderNumber: '123' },
          refundPaymentId: 'r1',
          createdAt: new Date('2026-11-05T12:00:00Z'),
        },
      ],
    })
    const out = parse(await call({ venueId: 'v1', search: 'Ana', limit: 20, page: 2 }))
    expect(mockHistoria).toHaveBeenCalledWith('v1', 'c1', { page: 2, pageSize: 20 })
    expect(out.customer).toBe('Ana Ruiz')
    // Se llega a cualquier movimiento viejo: el total, la página y si hay más.
    expect(out).toMatchObject({ totalMovements: 41, page: 2, hasMore: true })
    expect(out.movements).toEqual([
      {
        type: 'ADJUST',
        points: -100,
        reason: 'Reembolso completo de la venta 123: se quitan 100 puntos',
        orderNumber: '123',
        refundPaymentId: 'r1',
        date: '2026-11-05T12:00:00.000Z',
      },
    ])
  })
})

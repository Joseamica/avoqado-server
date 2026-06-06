import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFind = jest.fn()

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
  default: { table: { findMany: (...a: unknown[]) => mockTableFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('tables_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('tables_status', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockTableFind).not.toHaveBeenCalled()
  })

  it('counts tables by status and attaches the live order to occupied ones', async () => {
    mockTableFind.mockResolvedValueOnce([
      {
        number: '12',
        capacity: 4,
        status: 'OCCUPIED',
        area: { name: 'Terraza' },
        currentOrder: {
          orderNumber: 'A-1001',
          total: 480,
          paidAmount: 0,
          remainingBalance: 480,
          paymentStatus: 'PENDING',
          createdAt: new Date('2026-06-06T18:00:00Z'),
        },
      },
      { number: '13', capacity: 2, status: 'AVAILABLE', area: { name: 'Terraza' }, currentOrder: null },
      { number: '14', capacity: 6, status: 'CLEANING', area: null, currentOrder: null },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.total).toBe(3)
    expect(out.byStatus).toEqual({ OCCUPIED: 1, AVAILABLE: 1, CLEANING: 1 })
    expect(out.tables[0]).toMatchObject({
      number: '12',
      area: 'Terraza',
      status: 'OCCUPIED',
      order: { orderNumber: 'A-1001', balance: 480 },
    })
    expect(out.tables[1].order).toBeNull()
    expect(out.tables[2].area).toBeNull()
    // default excludes inactive tables
    expect((mockTableFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1'] },
      active: true,
    })
  })

  it('filters by area when provided', async () => {
    mockTableFind.mockResolvedValueOnce([])
    await call({ venueId: 'v1', area: 'barra' })
    const where = (mockTableFind.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ area: { name: { contains: 'barra', mode: 'insensitive' } } })
  })
})

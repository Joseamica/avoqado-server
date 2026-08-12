import { registerShiftTools } from '../../../src/mcp/tools/shifts'
import type { McpScope } from '../../../src/mcp/scope'

const mockShiftFindMany = jest.fn()
const mockRequirePermission = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId: string) => {
      if (venueId === 'venue-foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [venueId] } }
    },
    requirePermission: (...args: unknown[]) => mockRequirePermission(...(args as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { shift: { findMany: (...args: unknown[]) => mockShiftFindMany(...(args as [])) } },
}))
jest.mock('@/services/dashboard/cashCloseout.dashboard.service', () => ({
  getExpectedCashAmount: jest.fn(),
  getCloseoutHistory: jest.fn(),
}))

type ToolResult = { content: Array<{ text: string }> }
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>

const handlers = new Map<string, ToolHandler>()
const scope = { staffId: 'staff-1', activeOrg: 'org-1', allowedVenueIds: ['venue-1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_shifts')!(args, {})
const parse = (result: ToolResult) => JSON.parse(result.content[0].text)

beforeAll(() => {
  registerShiftTools(
    { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as ToolHandler) } as never,
    scope,
  )
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('list_shifts cash reconciliation fields', () => {
  it('returns counted cash and variance without converting zero or null to another value', async () => {
    mockShiftFindMany.mockResolvedValueOnce([
      {
        startTime: new Date('2026-08-08T14:00:00.000Z'),
        endTime: new Date('2026-08-08T22:00:00.000Z'),
        status: 'CLOSED',
        startingCash: 500,
        endingCash: 500,
        cashDeclared: 0,
        cashDifference: 0,
        totalSales: 0,
        totalTips: 0,
        totalOrders: 0,
        totalCashPayments: 0,
        totalCardPayments: 0,
        staff: { firstName: 'Ana', lastName: 'Ruiz' },
      },
      {
        startTime: new Date('2026-08-07T14:00:00.000Z'),
        endTime: new Date('2026-08-07T22:00:00.000Z'),
        status: 'CLOSED',
        startingCash: 500,
        endingCash: null,
        cashDeclared: null,
        cashDifference: null,
        totalSales: 100,
        totalTips: 10,
        totalOrders: 1,
        totalCashPayments: 100,
        totalCardPayments: 0,
        staff: { firstName: 'Luis', lastName: 'Paz' },
      },
      {
        startTime: new Date('2026-08-06T14:00:00.000Z'),
        endTime: new Date('2026-08-06T22:00:00.000Z'),
        status: 'CLOSED',
        startingCash: 500,
        endingCash: 1374.5,
        cashDeclared: 1374.5,
        cashDifference: -25.5,
        totalSales: 1000,
        totalTips: 0,
        totalOrders: 5,
        totalCashPayments: 900,
        totalCardPayments: 100,
        staff: { firstName: 'Sol', lastName: 'Díaz' },
      },
    ])

    const output = parse(await call({ venueId: 'venue-1', status: 'closed' }))

    expect(output.shifts[0]).toMatchObject({ cashDeclared: 0, cashDifference: 0 })
    expect(output.shifts[1]).toMatchObject({ cashDeclared: null, cashDifference: null })
    expect(output.shifts[2]).toMatchObject({ cashDeclared: 1374.5, cashDifference: -25.5 })
    expect(mockRequirePermission).toHaveBeenCalledWith('shifts:read', 'venue-1')
    expect(mockShiftFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ cashDeclared: true, cashDifference: true }),
      }),
    )
  })

  it('rejects a venue outside scope before reading drawer money', async () => {
    await expect(call({ venueId: 'venue-foreign' })).rejects.toThrow('out of scope')
    expect(mockShiftFindMany).not.toHaveBeenCalled()
  })

  it('enforces shifts:read before querying', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('ScopeError: Missing permission shifts:read')
    })

    await expect(call({ venueId: 'venue-1' })).rejects.toThrow('Missing permission shifts:read')
    expect(mockShiftFindMany).not.toHaveBeenCalled()
  })
})

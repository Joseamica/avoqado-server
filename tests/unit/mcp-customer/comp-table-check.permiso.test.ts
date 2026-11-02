/**
 * `comp_table_check` (MCP) pide el mismo permiso que la cortesía en las apps y en la TPV:
 * `orders:comp`, no `orders:update` (decisión del founder «A», 21-oct-2026).
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockRequirePermission = jest.fn()
const mockCompWholeOrder = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({
  compWholeOrder: (...a: unknown[]) => mockCompWholeOrder(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { table: { findFirst: jest.fn().mockResolvedValue({ id: 't1', currentOrderId: 'o1' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'org1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

describe('comp_table_check', () => {
  it('exige orders:comp antes de regalar', async () => {
    mockCompWholeOrder.mockResolvedValueOnce({ itemsComped: 2, compedAmount: 120 })
    await handlers.get('comp_table_check')!({ venueId: 'v1', number: '8', reason: 'Reclamo' }, {})
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:comp', 'v1')
    expect(mockRequirePermission).not.toHaveBeenCalledWith('orders:update', 'v1')
  })

  it('sin el permiso no regala nada', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Forbidden: missing orders:comp')
    })
    mockCompWholeOrder.mockClear()
    await expect(handlers.get('comp_table_check')!({ venueId: 'v1', number: '8', reason: 'Reclamo' }, {})).rejects.toThrow('Forbidden')
    expect(mockCompWholeOrder).not.toHaveBeenCalled()
  })
})

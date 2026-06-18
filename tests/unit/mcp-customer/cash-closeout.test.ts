/**
 * cash_closeout MCP tool (2026-06-17): the kardex of the cash drawer — corte de caja.
 * An operator asks "¿cuánto efectivo debería haber? ¿cuál fue el corte de ayer? ¿hubo
 * faltante?" and until now the MCP had list_shifts but no closeout reader.
 *
 * The platform gates cash-closeouts by PERMISSION only (settlements:read) — NO feature/
 * module/tier paywall — so this tool mirrors that: core, permission-gated, no plan gate.
 *
 * Tests: the current-drawer expected cash + the closeout history are mapped faithfully
 * (variance sign, who/when), and the settlements:read permission is enforced.
 */
import { registerShiftTools } from '../../../src/mcp/tools/shifts'
import type { McpScope } from '../../../src/mcp/scope'

const mockExpected = jest.fn()
const mockHistory = jest.fn()
const mockRequirePermission = jest.fn()

jest.mock('@/services/dashboard/cashCloseout.dashboard.service', () => ({
  getExpectedCashAmount: (...a: unknown[]) => mockExpected(...(a as [])),
  getCloseoutHistory: (...a: unknown[]) => mockHistory(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  ScopeError: class ScopeError extends Error {},
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { shift: { findMany: jest.fn() } } }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerShiftTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockExpected.mockResolvedValue({
    expectedAmount: 1094.5,
    periodStart: new Date('2026-06-10T06:00:00Z'),
    transactionCount: 12,
    daysSinceLastCloseout: 7,
    hasCloseouts: false,
    needsCloseout: true,
  })
  mockHistory.mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 } })
})

describe('cash_closeout — current drawer', () => {
  it('reports the expected cash and whether a cut is due', async () => {
    const out = parse(await call('cash_closeout', { venueId: 'v1' }))
    expect(out.currentDrawer.expectedCash).toBe(1094.5)
    expect(out.currentDrawer.cashTransactions).toBe(12)
    expect(out.currentDrawer.needsCloseout).toBe(true)
    expect(out.totalCloseouts).toBe(0)
    expect(out.recentCloseouts).toEqual([])
  })
})

describe('cash_closeout — history mapping', () => {
  it('maps a past closeout incl. variance sign and the staff name', async () => {
    mockHistory.mockResolvedValue({
      data: [
        {
          id: 'co1',
          periodStart: new Date('2026-06-01T06:00:00Z'),
          periodEnd: new Date('2026-06-10T06:00:00Z'),
          expectedAmount: 1000,
          actualAmount: 980, // counted less than expected → faltante
          variance: -20,
          variancePercent: -2,
          depositMethod: 'BANK_DEPOSIT',
          notes: 'faltó cambio',
          createdAt: new Date('2026-06-10T07:00:00Z'),
          closedBy: { id: 'st9', firstName: 'Ana', lastName: 'Ruiz' },
        },
      ],
      pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
    })
    const out = parse(await call('cash_closeout', { venueId: 'v1', limit: 5 }))
    expect(mockHistory).toHaveBeenCalledWith('v1', 1, 5)
    expect(out.totalCloseouts).toBe(1)
    const c = out.recentCloseouts[0]
    expect(c.variance).toBe(-20) // negative = faltante
    expect(c.actual).toBe(980)
    expect(c.depositMethod).toBe('BANK_DEPOSIT')
    expect(c.closedBy).toBe('Ana Ruiz')
  })
})

describe('cash_closeout — gates', () => {
  it('requires settlements:read for the venue', async () => {
    await call('cash_closeout', { venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('settlements:read', 'v1')
  })

  it('throws on an out-of-scope venue (venueFilter) before reading anything', async () => {
    await expect(call('cash_closeout', { venueId: 'other' })).rejects.toThrow()
    expect(mockExpected).not.toHaveBeenCalled()
  })
})

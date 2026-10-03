import { registerDiscountTools } from '../../../src/mcp/tools/discounts'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing discounts:create')
    },
  }),
}))
jest.mock('@/services/dashboard/discount.dashboard.service', () => ({ createDiscount: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
const mockStaffVenue = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { discount: { findMany: jest.fn() }, staffVenue: { findUnique: (...a: unknown[]) => mockStaffVenue(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_discount')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDiscountTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_discount (write)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', name: 'X', type: 'percentage', value: 10 })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', name: 'X', type: 'percentage', value: 10 })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  // Discount.createdById apunta a StaffVenue.id, no a Staff.id: pasar el id de la persona rompía la llave foránea y
  // el MCP respondía «error interno» a todo descuento (medido en producción el 3-oct, ref 8967fd5b).
  it('maps the type, passes rules + the staff MEMBERSHIP id of that venue, and audits', async () => {
    mockStaffVenue.mockResolvedValueOnce({ id: 'sv-1' })
    mockCreate.mockResolvedValueOnce({ id: 'd-1', name: '2x1' })
    const out = parse(await call({ venueId: 'v1', name: '2x1', type: 'percentage', value: 50, minPurchase: 100 }))

    expect(mockCreate).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ name: '2x1', type: 'PERCENTAGE', value: 50, minPurchaseAmount: 100 }),
      'sv-1',
    )
    expect(mockStaffVenue).toHaveBeenCalledWith(expect.objectContaining({ where: { staffId_venueId: { staffId: 's1', venueId: 'v1' } } }))
    expect(out).toMatchObject({ ok: true, discount: { id: 'd-1', type: 'PERCENTAGE', value: 50 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'DISCOUNT_CREATED', entityId: 'd-1' })
  })

  it('un dueño de la organización sin membresía en esa sucursal crea el descuento sin autor, no lo rompe', async () => {
    mockStaffVenue.mockResolvedValueOnce(null)
    mockCreate.mockResolvedValueOnce({ id: 'd-2', name: 'Martes' })
    const out = parse(await call({ venueId: 'v1', name: 'Martes', type: 'fixed_amount', value: 20 }))
    expect(mockCreate.mock.calls[0][2]).toBeUndefined()
    expect(out).toMatchObject({ ok: true, discount: { id: 'd-2' } })
  })
})

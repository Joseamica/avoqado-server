import { registerDiscountTools } from '../../../src/mcp/tools/discounts'
import type { McpScope } from '../../../src/mcp/scope'

const mockDiscountFind = jest.fn()
const mockCreateCoupon = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing coupons:create')
    },
  }),
}))
jest.mock('@/services/dashboard/discount.dashboard.service', () => ({ createDiscount: jest.fn() }))
jest.mock('@/services/dashboard/coupon.dashboard.service', () => ({ createCouponCode: (...a: unknown[]) => mockCreateCoupon(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { discount: { findMany: (...a: unknown[]) => mockDiscountFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_coupon')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDiscountTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_coupon (write)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', discountName: 'X', code: 'AB' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', discountName: 'X', code: 'AB' })).rejects.toThrow('Forbidden')
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })

  it('requires an existing discount (no create when missing/ambiguous)', async () => {
    mockDiscountFind.mockResolvedValueOnce([])
    const none = parse(await call({ venueId: 'v1', discountName: 'nada', code: 'AB' }))
    expect(none.ok).toBe(false)
    mockDiscountFind.mockResolvedValueOnce([
      { id: 'd1', name: 'Verano' },
      { id: 'd2', name: 'Verano VIP' },
    ])
    const amb = parse(await call({ venueId: 'v1', discountName: 'verano', code: 'AB' }))
    expect(amb.ambiguous).toBe(true)
    expect(mockCreateCoupon).not.toHaveBeenCalled()
  })

  it('uppercases the code, resolves the discount, creates + audits', async () => {
    mockDiscountFind.mockResolvedValueOnce([{ id: 'd1', name: 'Verano' }])
    mockCreateCoupon.mockResolvedValueOnce({ id: 'cc1', code: 'VERANO20' })
    const out = parse(await call({ venueId: 'v1', discountName: 'Verano', code: 'verano20', maxUses: 100 }))

    expect(mockCreateCoupon).toHaveBeenCalledWith('v1', expect.objectContaining({ discountId: 'd1', code: 'VERANO20', maxUses: 100 }))
    expect(out).toMatchObject({ ok: true, coupon: { code: 'VERANO20', discount: 'Verano' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'COUPON_CREATED', entityId: 'cc1' })
  })
})

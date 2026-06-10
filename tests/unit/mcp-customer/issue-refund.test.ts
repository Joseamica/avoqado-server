import { registerPaymentTools } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockPaymentFindFirst = jest.fn()
const mockIssue = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing payments:refund')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: (...a: unknown[]) => mockIssue(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: (...a: unknown[]) => mockPaymentFindFirst(...(a as [])), findMany: jest.fn(), groupBy: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('issue_refund')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const completedPayment = {
  amount: 400,
  tipAmount: 50,
  method: 'CREDIT_CARD',
  status: 'COMPLETED',
  type: 'REGULAR',
  createdAt: new Date('2026-06-08T20:00:00Z'),
  order: { orderNumber: 'A-77' },
}
const base = { venueId: 'v1', paymentId: 'pay-1', amount: 100, reason: 'accidental_charge' }

beforeAll(() => {
  registerPaymentTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('issue_refund (critical money write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm — no reads, no refund', async () => {
    await expect(call({ ...base, venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call({ ...base, venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('refuses a payment outside scope or not found', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call(base))
    expect(out.ok).toBe(false)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('refuses non-COMPLETED payments and over-amount refunds (no service call)', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({ ...completedPayment, status: 'REFUNDED' })
    const notCompleted = parse(await call(base))
    expect(notCompleted.ok).toBe(false)

    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const tooMuch = parse(await call({ ...base, amount: 451 })) // original total = 450
    expect(tooMuch.ok).toBe(false)
    expect(tooMuch.error).toMatch(/excede/)
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS the refund and does NOT move money', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    const out = parse(await call(base))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({
      payment: { id: 'pay-1', orderNumber: 'A-77', method: 'CREDIT_CARD', originalTotal: 450 },
      refundAmount: 100,
      reason: 'ACCIDENTAL_CHARGE',
    })
    expect(mockIssue).not.toHaveBeenCalled()
  })

  it('with confirm:true: converts pesos->cents, issues, and audits', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    mockIssue.mockResolvedValueOnce({ refundId: 'ref-1', originalPaymentId: 'pay-1', amount: 100, remainingRefundable: 350, status: 'COMPLETED' })

    const out = parse(await call({ ...base, note: 'cliente insatisfecho', confirm: true }))

    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', paymentId: 'pay-1', amount: 10000, reason: 'ACCIDENTAL_CHARGE', staffId: 's1', note: 'cliente insatisfecho' }),
    )
    expect(out).toMatchObject({ ok: true, refund: { refundId: 'ref-1', amount: 100, remainingRefundable: 350 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'REFUND_ISSUED', entity: 'Payment', entityId: 'ref-1', venueId: 'v1' })
  })

  it('surfaces a service rejection (e.g. exceeds remaining) as ok:false', async () => {
    mockPaymentFindFirst.mockResolvedValueOnce(completedPayment)
    mockIssue.mockRejectedValueOnce(new Error('Refund amount exceeds remaining refundable'))
    const out = parse(await call({ ...base, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/remaining/)
  })
})

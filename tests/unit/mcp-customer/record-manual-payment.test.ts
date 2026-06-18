/**
 * record_manual_payment MCP tool (2026-06-18): record a payment by hand (cash,
 * transfer, external channel) — attach to an order or as a standalone bookkeeping
 * entry. Mirrors the dashboard gating: core, permission-only (payment:create-manual),
 * NO plan gate. Money is pesos 1:1 — the tool takes numbers and hands the service
 * Decimal-as-STRINGS (money2 → toFixed(2)), so the cents are exact.
 *
 * Tests: confirm-gating (preview never writes), the friendly method/source enums +
 * amounts map correctly to the service call, source=other requires externalSource,
 * the write is audited, and the permission/scope gates fire before anything.
 */
import { registerPaymentTools } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing payment:create-manual')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/manualPayment.service', () => ({ createManualPayment: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ issueRefund: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() }, venue: { findUnique: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('record_manual_payment')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockCreate.mockResolvedValue({
    id: 'pay-9',
    amount: '123.45',
    tipAmount: '7.50',
    method: 'CASH',
    status: 'COMPLETED',
    orderId: 'ord-shadow',
  })
})

describe('record_manual_payment — confirm gating', () => {
  it('without confirm → preview only, the service is NOT called', async () => {
    const out = parse(await call({ venueId: 'v1', amount: 123.45, method: 'cash' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.amount).toBe(123.45)
    expect(out.preview.mode).toBe('standalone-bookkeeping-entry')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('record_manual_payment — write maps + audits', () => {
  it('confirm:true hands the service Decimal-STRING amounts + mapped enums, then audits', async () => {
    const out = parse(await call({ venueId: 'v1', amount: 123.45, tipAmount: 7.5, method: 'cash', source: 'phone', confirm: true }))
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const [venueId, staffId, input] = mockCreate.mock.calls[0]
    expect(venueId).toBe('v1')
    expect(staffId).toBe('s1')
    expect(input.amount).toBe('123.45') // STRING, exact cents — pesos 1:1, not ×100
    expect(input.tipAmount).toBe('7.50')
    expect(input.method).toBe('CASH') // friendly 'cash' → Prisma enum
    expect(input.source).toBe('PHONE') // friendly 'phone' → Prisma enum
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(), // scope (first arg)
      expect.objectContaining({ action: 'MANUAL_PAYMENT_RECORDED', entity: 'Payment', entityId: 'pay-9' }),
    )
    expect(out.ok).toBe(true)
    expect(out.payment.id).toBe('pay-9')
  })

  it("defaults source to 'pos' and passes orderId through (attach mode)", async () => {
    await call({ venueId: 'v1', amount: 50, method: 'bank_transfer', orderId: 'ord-1', confirm: true })
    const input = mockCreate.mock.calls[0][2]
    expect(input.source).toBe('POS')
    expect(input.method).toBe('BANK_TRANSFER')
    expect(input.orderId).toBe('ord-1')
  })
})

describe('record_manual_payment — validation + gates', () => {
  it("source='other' without externalSource → clean error, no write", async () => {
    const out = parse(await call({ venueId: 'v1', amount: 10, method: 'cash', source: 'other', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/externalSource/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("externalSource set but source != 'other' → clean error", async () => {
    const out = parse(await call({ venueId: 'v1', amount: 10, method: 'cash', source: 'pos', externalSource: 'Rappi', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/externalSource/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('out-of-scope / missing permission → throws, never reaches the service', async () => {
    await expect(call({ venueId: 'foreign', amount: 10, method: 'cash', confirm: true })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', amount: 10, method: 'cash', confirm: true })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

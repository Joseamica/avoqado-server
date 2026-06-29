import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
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
      if (v === 'no-perm') throw new Error('Forbidden: missing payment-link:create')
    },
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ createPaymentLink: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { paymentLink: { findMany: jest.fn() } } }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_payment_link')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentLinkTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_payment_link (write)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', title: 'X', amount: 100 })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', title: 'X', amount: 100 })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('without confirm → PREVIEWS the link and does NOT create', async () => {
    const out = parse(await call({ venueId: 'v1', title: 'Anticipo', amount: 500 }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ title: 'Anticipo', amountType: 'FIXED', amount: 500, purpose: 'PAYMENT' })
    expect(out.message).toMatch(/500\.00/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('confirm:true creates a FIXED-amount link + audits', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'pl-1',
      shortCode: 'AB12',
      title: 'Anticipo',
      amountType: 'FIXED',
      amount: 500,
      status: 'ACTIVE',
    })
    const out = parse(await call({ venueId: 'v1', title: 'Anticipo', amount: 500, confirm: true }))
    expect(mockCreate).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ title: 'Anticipo', amountType: 'FIXED', amount: 500, purpose: 'PAYMENT' }),
      's1',
    )
    expect(out).toMatchObject({ ok: true, paymentLink: { id: 'pl-1', shortCode: 'AB12', amountType: 'FIXED', amount: 500 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'PAYMENT_LINK_CREATED', entityId: 'pl-1' })
  })

  it('confirm:true creates an OPEN-amount link when no amount is given', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'pl-2', shortCode: 'ZZ', title: 'Donativo', amountType: 'OPEN', amount: null, status: 'ACTIVE' })
    await call({ venueId: 'v1', title: 'Donativo', purpose: 'donation', confirm: true })
    expect(mockCreate).toHaveBeenCalledWith('v1', expect.objectContaining({ amountType: 'OPEN', purpose: 'DONATION' }), 's1')
  })
})

import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
import type { McpScope } from '../../../src/mcp/scope'

const mockLinkFind = jest.fn()

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
  default: { paymentLink: { findMany: (...a: unknown[]) => mockLinkFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_payment_links')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentLinkTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_payment_links', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockLinkFind).not.toHaveBeenCalled()
  })

  it('defaults to active links and maps fixed vs open amounts', async () => {
    mockLinkFind.mockResolvedValueOnce([
      {
        shortCode: 'AB12CD34',
        title: 'Anticipo boda',
        description: null,
        purpose: 'PAYMENT',
        amountType: 'FIXED',
        amount: 5000,
        currency: 'MXN',
        status: 'ACTIVE',
        expiresAt: null,
        createdAt: new Date('2026-06-01T10:00:00Z'),
      },
      {
        shortCode: 'ZZ99',
        title: 'Donativo',
        description: 'Apoya',
        purpose: 'DONATION',
        amountType: 'OPEN',
        amount: null,
        currency: 'MXN',
        status: 'ACTIVE',
        expiresAt: null,
        createdAt: new Date('2026-05-20T10:00:00Z'),
      },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    expect((mockLinkFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1'] },
      status: 'ACTIVE',
    })
    expect(out.count).toBe(2)
    expect(out.links[0]).toMatchObject({ shortCode: 'AB12CD34', purpose: 'PAYMENT', amount: 5000 })
    expect(out.links[1].amount).toBe('open') // OPEN amount surfaces as 'open', not a number
  })

  it('does not status-filter when status="all"', async () => {
    mockLinkFind.mockResolvedValueOnce([])
    await call({ venueId: 'v1', status: 'all' })
    const where = (mockLinkFind.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.status).toBeUndefined()
  })
})

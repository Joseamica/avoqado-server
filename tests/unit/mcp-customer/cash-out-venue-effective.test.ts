import { registerCashOutTools } from '../../../src/mcp/tools/cash-out'
import type { McpScope } from '../../../src/mcp/scope'

const mockListCommissionRatesForOrg = jest.fn()
const mockListActiveDaysForOrg = jest.fn()
const mockResolveRatesForVenue = jest.fn()
const mockResolveActiveDaysForVenue = jest.fn()

jest.mock('@/services/dashboard/cash-out/cash-out.config.service', () => ({
  __esModule: true,
  listCommissionRatesForOrg: (...a: unknown[]) => mockListCommissionRatesForOrg(...(a as [])),
  listActiveDaysForOrg: (...a: unknown[]) => mockListActiveDaysForOrg(...(a as [])),
  resolveRatesForVenue: (...a: unknown[]) => mockResolveRatesForVenue(...(a as [])),
  resolveActiveDaysForVenue: (...a: unknown[]) => mockResolveActiveDaysForVenue(...(a as [])),
}))

jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  __esModule: true,
  getSaldo: jest.fn(),
}))

jest.mock('@/services/dashboard/cash-out/cash-out.withdrawal.service', () => ({
  __esModule: true,
  listWithdrawals: jest.fn(),
}))

jest.mock('@/services/dashboard/cash-out/cash-out.org.service', () => ({
  __esModule: true,
  listWithdrawalsForOrg: jest.fn(),
  getSaldosForOrg: jest.fn(),
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(true) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerCashOutTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => jest.clearAllMocks())

describe('cash_out_org_commission_rates', () => {
  it('WITHOUT venueId returns the org-wide table', async () => {
    mockListCommissionRatesForOrg.mockResolvedValue([{ saleType: 'NEW_LINE', minCount: 0, maxCount: 10, amount: 50 }])
    const out = parse(await call('cash_out_org_commission_rates', {}))
    expect(mockListCommissionRatesForOrg).toHaveBeenCalledWith('o1')
    expect(mockResolveRatesForVenue).not.toHaveBeenCalled()
    expect(out.scope).toBe('org')
    expect(out.orgId).toBe('o1')
    expect(out.rates).toEqual([{ saleType: 'NEW_LINE', minCount: 0, maxCount: 10, amount: '50' }])
  })

  it('WITH venueId returns the EFFECTIVE (venue-override-else-org) table', async () => {
    mockResolveRatesForVenue.mockResolvedValue([{ saleType: 'PORTABILITY', minCount: 0, maxCount: null, amount: 75 }])
    const out = parse(await call('cash_out_org_commission_rates', { venueId: 'v1' }))
    expect(mockResolveRatesForVenue).toHaveBeenCalledWith('v1')
    expect(mockListCommissionRatesForOrg).not.toHaveBeenCalled()
    expect(out.scope).toBe('venue')
    expect(out.venueId).toBe('v1')
    expect(out.rates).toEqual([{ saleType: 'PORTABILITY', minCount: 0, maxCount: null, amount: '75' }])
  })
})

describe('cash_out_org_active_days', () => {
  it('WITHOUT venueId returns the org-wide calendar', async () => {
    mockListActiveDaysForOrg.mockResolvedValue(['2026-07-01', '2026-07-02'])
    const out = parse(await call('cash_out_org_active_days', {}))
    expect(mockListActiveDaysForOrg).toHaveBeenCalledWith('o1')
    expect(mockResolveActiveDaysForVenue).not.toHaveBeenCalled()
    expect(out.scope).toBe('org')
    expect(out.orgId).toBe('o1')
    expect(out.days).toEqual(['2026-07-01', '2026-07-02'])
  })

  it('WITH venueId returns the EFFECTIVE (venue-override-else-org) calendar', async () => {
    mockResolveActiveDaysForVenue.mockResolvedValue(['2026-07-05'])
    const out = parse(await call('cash_out_org_active_days', { venueId: 'v1' }))
    expect(mockResolveActiveDaysForVenue).toHaveBeenCalledWith('v1')
    expect(mockListActiveDaysForOrg).not.toHaveBeenCalled()
    expect(out.scope).toBe('venue')
    expect(out.venueId).toBe('v1')
    expect(out.days).toEqual(['2026-07-05'])
  })
})

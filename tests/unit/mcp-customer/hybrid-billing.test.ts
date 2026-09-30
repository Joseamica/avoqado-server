import type { McpScope } from '@/mcp/scope'
const createQuote = jest.fn(),
  acceptQuote = jest.fn(),
  getStatus = jest.fn(),
  provision = jest.fn(),
  createCampaign = jest.fn()
const permission = jest.fn()
const getCurrent = jest.fn(),
  replacements = jest.fn(),
  getContract = jest.fn(),
  cancelContract = jest.fn()
const featureGrid = jest.fn()
jest.mock('@/services/launchCampaigns/hybridPurchase.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridPurchase.service'),
  createHybridQuote: (...args: unknown[]) => createQuote(...args),
  acceptHybridQuote: (...args: unknown[]) => acceptQuote(...args),
  getHybridPurchaseStatus: (...args: unknown[]) => getStatus(...args),
  getCurrentHybridPurchase: (...args: unknown[]) => getCurrent(...args),
  getHybridReplacementOptions: (...args: unknown[]) => replacements(...args),
}))
jest.mock('@/services/launchCampaigns/hybridManagement.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridManagement.service'),
  getHybridContract: (...args: unknown[]) => getContract(...args),
  cancelHybridContract: (...args: unknown[]) => cancelContract(...args),
}))
jest.mock('@/services/launchCampaigns/hybridFeatureGrid.service', () => ({
  getHybridFeatureGrid: (...args: unknown[]) => featureGrid(...args),
}))
jest.mock('@/services/launchCampaigns/hybridProvision.service', () => ({
  provisionHybridPurchase: (...args: unknown[]) => provision(...args),
}))
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridCampaign.service'),
  createHybridCampaign: (...args: unknown[]) => createCampaign(...args),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: (scope: McpScope) => ({
    venueFilter: (id: string) => {
      if (!scope.allowedVenueIds.includes(id)) throw Error('foreign venue')
      return { venueId: { in: [id] } }
    },
    requirePermission: (...args: unknown[]) => permission(...args),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
import { registerHybridBillingTools, registerHybridCampaignTools } from '@/mcp/tools/hybridBilling'
import { auditMcpWrite } from '@/mcp/audit'
const scope = {
  staffId: 'staff',
  activeOrg: 'org',
  allowedVenueIds: ['venue'],
  perVenueAccess: new Map(),
  scopes: ['mcp:write'],
  isSuperAdmin: false,
} as McpScope
function toolsFor(overrides = {}) {
  const handlers = new Map<string, (args: any) => Promise<any>>()
  const server = { tool: (...args: any[]) => handlers.set(args[0], args[args.length - 1]) } as any
  registerHybridBillingTools(server, { ...scope, ...overrides })
  registerHybridCampaignTools(server, { ...scope, ...overrides })
  return handlers
}
const read = (value: any) => JSON.parse(value.content[0].text)
beforeEach(() => {
  jest.clearAllMocks()
  getStatus.mockResolvedValue({
    id: 'purchase',
    status: 'QUOTED',
    quoteHash: 'hash',
    quote: { total: '379.50', credit: '105.25', dueNow: '274.25' },
  })
  acceptQuote.mockResolvedValue({ id: 'purchase', status: 'ACCEPTED' })
  provision.mockResolvedValue({ purchaseId: 'purchase', status: 'PAYMENT_PENDING', paymentUrl: 'https://invoice.stripe.com/i/test' })
})
describe('hybrid customer MCP money and permission boundaries', () => {
  it('recovers current purchases and replacement options with tenant and read permission checks', async () => {
    const tools = toolsFor()
    getCurrent.mockResolvedValue({ id: 'pending' })
    replacements.mockResolvedValue({ items: [] })
    for (const name of ['hybrid_current_purchase', 'hybrid_replacement_options']) {
      await expect(tools.get(name)!({ venueId: 'foreign' })).rejects.toThrow('foreign')
      await tools.get(name)!({ venueId: 'venue' })
    }
    expect(getCurrent).toHaveBeenCalledWith('venue')
    expect(replacements).toHaveBeenCalledWith('venue')
    expect(permission).toHaveBeenCalledWith('billing:subscriptions:read', 'venue')
  })
  it('shows the feature grid with read permission and never for a foreign venue', async () => {
    featureGrid.mockResolvedValue({ catalogVersion: 'v', purchasesEnabled: false, plans: { PRO: null, PREMIUM: null }, entries: [] })
    const tools = toolsFor()
    expect(read(await tools.get('venue_feature_grid')!({ venueId: 'venue' }))).toMatchObject({ purchasesEnabled: false })
    expect(permission).toHaveBeenCalledWith('billing:subscriptions:read', 'venue')
    await expect(tools.get('venue_feature_grid')!({ venueId: 'other' })).rejects.toThrow('foreign venue')
  })
  it('shows the current functions price and paid boundary before changing a contract', async () => {
    getContract.mockResolvedValue({
      id: 'contract',
      name: 'Mi paquete',
      featureCodes: ['CFDI'],
      price: 379.5,
      paidThrough: '2026-10-27',
      revision: 2,
    })
    const tools = toolsFor()
    for (const name of ['schedule_hybrid_selection', 'cancel_hybrid_contract']) {
      const result = read(
        await tools.get(name)!({ venueId: 'venue', contractId: 'contract', expectedRevision: 2, featureCodes: ['INVENTORY_TRACKING'] }),
      )
      expect(result.preview.current).toMatchObject({
        name: 'Mi paquete',
        featureCodes: ['CFDI'],
        price: 379.5,
        paidThrough: '2026-10-27',
        revision: 2,
      })
    }
    expect(getContract).toHaveBeenCalledWith('venue', 'contract')
  })
  it('passes the owner reason to the contract cancellation and keeps it in the MCP audit trail', async () => {
    cancelContract.mockResolvedValue({ contractId: 'contract', revision: 3, cancelAt: '2026-10-27T00:00:00.000Z' })
    const input = { expectedRevision: 2, reason: 'TEMPORARY', comment: 'Cerramos agosto' }
    await toolsFor().get('cancel_hybrid_contract')!({ venueId: 'venue', contractId: 'contract', ...input, confirm: true })
    expect(cancelContract).toHaveBeenCalledWith('venue', 'contract', 'staff', input)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff' }),
      expect.objectContaining({
        action: 'MCP_HYBRID_RENEWAL_CANCELLED',
        entityId: 'contract',
        data: { reason: 'TEMPORARY', comment: 'Cerramos agosto' },
      }),
    )
  })
  it('cannot quote a foreign venue and checks the exact billing permission', async () => {
    const tools = toolsFor()
    await expect(tools.get('quote_hybrid_purchase')!({ venueId: 'foreign', lines: [] })).rejects.toThrow('foreign')
    expect(createQuote).not.toHaveBeenCalled()
    createQuote.mockResolvedValue({ id: 'quote', quote: { total: '379.50' } })
    await tools.get('quote_hybrid_purchase')!({ venueId: 'venue', lines: [] })
    expect(permission).toHaveBeenCalledWith('billing:subscriptions:manage', 'venue')
  })
  it('requires a human preview in pesos before accepting, and never auto-confirms a payment', async () => {
    const tools = toolsFor()
    const args = { venueId: 'venue', purchaseId: 'purchase', quoteHash: 'hash', clientKey: 'caller-attempt' }
    const preview = read(await tools.get('accept_hybrid_purchase')!(args))
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { dueNow: '274.25', total: '379.50' } })
    expect(acceptQuote).not.toHaveBeenCalled()
    const result = read(await tools.get('accept_hybrid_purchase')!({ ...args, confirm: true }))
    expect(result).toMatchObject({ status: 'PAYMENT_PENDING' })
    expect(acceptQuote).toHaveBeenCalledWith('venue', 'staff', 'purchase', { quoteHash: 'hash', clientKey: 'caller-attempt' })
    expect(JSON.stringify(result)).not.toContain('Cents')
  })
  it('rejects read-only OAuth tokens even when the observe-only rollout switch is off', async () => {
    const tools = toolsFor({ scopes: ['mcp:read'] })
    await expect(tools.get('accept_hybrid_purchase')!({ venueId: 'venue', purchaseId: 'purchase', confirm: true })).rejects.toThrow(
      /lectura/,
    )
    expect(acceptQuote).not.toHaveBeenCalled()
  })
  it('does not expose campaign management to a customer even if a handler is reached directly', async () => {
    const tools = toolsFor()
    for (const name of ['list_hybrid_campaigns', 'save_hybrid_campaign', 'publish_hybrid_campaign', 'set_hybrid_campaign_status'])
      expect(read(await tools.get(name)!({}))).toMatchObject({ ok: false })
    expect(createCampaign).not.toHaveBeenCalled()
  })
  it('campaign creation previews the supplied configurable terms without creating or activating it', async () => {
    const tools = toolsFor({ isSuperAdmin: true })
    const definition = { kind: 'CHOICE_BUNDLE', choiceCount: 5, terms: { price: 629.9 } }
    const result = read(await tools.get('save_hybrid_campaign')!({ campaign: { name: 'Mi campaña', definition } }))
    expect(result).toMatchObject({ requiresConfirmation: true, preview: { definition } })
    expect(createCampaign).not.toHaveBeenCalled()
  })
})

/**
 * Write-safety confirm-gating (2026-06-28). The MCP is LLM-driven over ~hundreds of
 * tools; a vague request must NOT silently mutate. High-impact/hard-to-reverse writes
 * are two-step: first call → human-readable preview (current → new), only confirm:true
 * executes. Covers set_menu_item_price (customer-visible price) and
 * downgrade_venue_to_free (plan/billing). See critical-warnings.md MCP invariant #4.
 */
import { registerMenuTools } from '../../../src/mcp/tools/menu'
import { registerSeatTools } from '../../../src/mcp/tools/seats'
import type { McpScope } from '../../../src/mcp/scope'

const mockProductFindMany = jest.fn()
const mockUpdateProduct = jest.fn()
const mockSchedule = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  updateProduct: (...a: unknown[]) => mockUpdateProduct(...(a as [])),
  createProduct: jest.fn(),
}))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({ createMenuCategory: jest.fn(), createModifierGroup: jest.fn() }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  getVenueSeatStatus: jest.fn(),
  getDowngradePreview: jest.fn(),
  scheduleDowngradeToFree: (...a: unknown[]) => mockSchedule(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  registerMenuTools(reg, scope)
  registerSeatTools(reg, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockUpdateProduct.mockResolvedValue({ name: 'Carnitas', price: 99 })
  mockSchedule.mockResolvedValue({ tier: 'FREE', scheduled: true })
})

describe('set_menu_item_price — confirm-gated (customer-visible price)', () => {
  it('without confirm → preview current → new, does NOT write', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Carnitas', active: true, price: 129 }])
    const out = parse(await call('set_menu_item_price', { venueId: 'v1', name: 'Carnitas', price: 99 }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change).toMatchObject({ item: 'Carnitas', from: 129, to: 99 })
    expect(mockUpdateProduct).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm:true → writes the new price and audits', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Carnitas', active: true, price: 129 }])
    const out = parse(await call('set_menu_item_price', { venueId: 'v1', name: 'Carnitas', price: 99, confirm: true }))
    expect(mockUpdateProduct).toHaveBeenCalledWith('v1', 'p1', { price: 99 })
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'MENU_ITEM_PRICE_SET' }))
    expect(out.ok).toBe(true)
  })

  it('ambiguous name → asks, never previews a write', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'Taco A', price: 1 },
      { id: 'p2', name: 'Taco B', price: 2 },
    ])
    const out = parse(await call('set_menu_item_price', { venueId: 'v1', name: 'taco', price: 99 }))
    expect(out.ambiguous).toBe(true)
    expect(out.requiresConfirmation).toBeUndefined()
    expect(mockUpdateProduct).not.toHaveBeenCalled()
  })
})

describe('downgrade_venue_to_free — confirm-gated (plan/billing)', () => {
  it('without confirm → preview, does NOT schedule the downgrade', async () => {
    const out = parse(await call('downgrade_venue_to_free', { venueId: 'v1', keepStaffVenueIds: ['sv1', 'sv2'] }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change).toMatchObject({ from: 'PRO', keepUsers: 2 })
    expect(out.message).toMatch(/AGENDAR/)
    expect(mockSchedule).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm:true → schedules the downgrade and audits', async () => {
    const out = parse(await call('downgrade_venue_to_free', { venueId: 'v1', keepStaffVenueIds: ['sv1'], confirm: true }))
    expect(mockSchedule).toHaveBeenCalledWith('v1', ['sv1'])
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'PLAN_DOWNGRADE_SCHEDULED' }))
    expect(out.ok).toBe(true)
  })
})

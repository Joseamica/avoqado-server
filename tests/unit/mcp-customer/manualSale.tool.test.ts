/**
 * record_serialized_sale MCP tool: exposes Task 4's `createOneManualSale`
 * (single-row, already-approved external SIM sale) through the customer MCP.
 *
 * Org-level write (mirrors saleVerifications.ts's requireReviewAccess pattern,
 * NOT the per-venue guard.venueFilter/requirePermission pair) — the caller
 * does not know the storeId upfront (createOneManualSale resolves storeName
 * against the org's venues internally), so the permission is checked against
 * ANY venue in the connected staff's active org, not one they pre-select.
 *
 * Tests: preview (no confirm) returns requiresConfirmation with a Spanish
 * preview and never calls the service; confirm:true calls
 * createOneManualSale(orgId, actorStaffId, row) and audits; missing
 * manual-sales:create anywhere in the org → ScopeError, no service call;
 * service {ok:false} surfaces the Spanish error without throwing.
 */
import { registerManualSaleTools } from '../../../src/mcp/tools/manualSale'
import type { McpScope } from '../../../src/mcp/scope'
import type { UserAccess } from '../../../src/services/access/access.service'

const mockCreateOneManualSale = jest.fn()
const mockAudit = jest.fn()
const mockHasPermission = jest.fn()

jest.mock('@/services/dashboard/manualSale.service', () => ({
  createOneManualSale: (...a: unknown[]) => mockCreateOneManualSale(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (...a: unknown[]) => mockHasPermission(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const call = (args: Record<string, unknown>) => handlers.get('record_serialized_sale')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const access = (organizationId: string): UserAccess =>
  ({
    userId: 's1',
    venueId: 'v1',
    organizationId,
    role: 'MANAGER',
    corePermissions: [],
    whiteLabelEnabled: false,
    enabledFeatures: [],
    featureAccess: {},
    featureMetadata: {},
  }) as unknown as UserAccess

const baseInput = {
  iccid: '8952140012345678901',
  promoterName: 'Juan Pérez',
  storeName: 'BAE Unidad Pavón (898)',
  saleDate: '2026-07-05',
  saleType: 'Línea nueva',
  paymentForm: 'Efectivo',
  amount: 250,
}

function buildScope(perVenue: Array<[string, UserAccess]>): McpScope {
  return { staffId: 's1', activeOrg: 'org-1', allowedVenueIds: perVenue.map(([id]) => id), perVenueAccess: new Map(perVenue) } as McpScope
}

beforeEach(() => {
  jest.clearAllMocks()
  mockHasPermission.mockReturnValue(true) // default: staff has manual-sales:create somewhere in the org
  handlers.clear()
  const scope = buildScope([['v1', access('org-1')]])
  registerManualSaleTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

describe('record_serialized_sale — confirm gating', () => {
  it('without confirm → requiresConfirmation with a Spanish preview, service NOT called', async () => {
    const out = parse(await call(baseInput))
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    expect(out.message).toEqual(expect.any(String))
    // Spanish, human-readable, mentions iccid/vendedor/tienda/amount, ends with the confirm:true instruction.
    expect(out.message).toContain(baseInput.iccid)
    expect(out.message).toContain(baseInput.promoterName)
    expect(out.message).toContain(baseInput.storeName)
    expect(out.message).toContain('250')
    expect(out.message).toMatch(/confirm\s*:\s*true/i)
    expect(mockCreateOneManualSale).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('falls back to promoterCode in the preview when promoterName is omitted', async () => {
    const out = parse(await call({ ...baseInput, promoterName: undefined, promoterCode: 'PROMO-42' }))
    expect(out.message).toContain('PROMO-42')
  })
})

describe('record_serialized_sale — confirm:true executes + audits', () => {
  it('calls createOneManualSale(orgId, actorStaffId, row) and audits on success', async () => {
    mockCreateOneManualSale.mockResolvedValueOnce({ ok: true, orderId: 'ord-1', verificationId: 'ver-1', venueId: 'v1' })
    const out = parse(await call({ ...baseInput, confirm: true }))

    expect(mockCreateOneManualSale).toHaveBeenCalledTimes(1)
    const [orgId, actorStaffId, row] = mockCreateOneManualSale.mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(actorStaffId).toBe('s1')
    expect(row).toMatchObject({
      iccid: baseInput.iccid,
      promoterName: baseInput.promoterName,
      storeName: baseInput.storeName,
      saleDate: baseInput.saleDate,
      saleType: baseInput.saleType,
      paymentForm: baseInput.paymentForm,
      amount: baseInput.amount, // pesos 1:1, NOT cents
    })

    expect(out.ok).toBe(true)
    expect(out.orderId).toBe('ord-1')

    expect(mockAudit).toHaveBeenCalledTimes(1)
    const [auditedScope, auditPayload] = mockAudit.mock.calls[0]
    expect(auditedScope.staffId).toBe('s1')
    expect(auditPayload).toMatchObject({
      action: expect.any(String),
      entity: 'Order',
      entityId: 'ord-1',
      venueId: 'v1',
    })
  })

  it('service {ok:false} surfaces the Spanish error via text(), no throw, no audit', async () => {
    mockCreateOneManualSale.mockResolvedValueOnce({ ok: false, error: 'No encontré el ICCID en tu organización.' })
    const out = parse(await call({ ...baseInput, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('No encontré el ICCID en tu organización.')
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('record_serialized_sale — org-level permission gate', () => {
  it('missing manual-sales:create anywhere in the active org → ScopeError, never reaches the service', async () => {
    mockHasPermission.mockReturnValue(false)
    await expect(call({ ...baseInput, confirm: true })).rejects.toThrow(/manual-sales:create/)
    expect(mockCreateOneManualSale).not.toHaveBeenCalled()
  })

  it('staff has the permission in a DIFFERENT org (not the active one) → still denied', async () => {
    // perVenueAccess entry belongs to a different org than scope.activeOrg
    const scope = buildScope([['v-other-org', access('org-2')]])
    handlers.clear()
    mockHasPermission.mockReturnValue(true) // permission itself would pass IF this venue counted
    registerManualSaleTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
    await expect(call({ ...baseInput, confirm: true })).rejects.toThrow()
    expect(mockCreateOneManualSale).not.toHaveBeenCalled()
  })
})

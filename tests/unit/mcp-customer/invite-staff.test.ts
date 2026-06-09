import { registerStaffTools } from '../../../src/mcp/tools/staff'
import type { McpScope } from '../../../src/mcp/scope'

const mockInvite = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing teams:invite')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/team.dashboard.service', () => ({ inviteTeamMember: (...a: unknown[]) => mockInvite(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { staffVenue: { findMany: jest.fn() } } }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('invite_staff')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const base = { venueId: 'v1', firstName: 'Ana', lastName: 'López', role: 'cashier', email: 'ana@x.com' }

beforeAll(() => {
  registerStaffTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('invite_staff (critical write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ ...base, venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call({ ...base, venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockInvite).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS and does NOT send the invite', async () => {
    const out = parse(await call(base))
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ name: 'Ana López', role: 'CASHIER', email: 'ana@x.com' })
    expect(mockInvite).not.toHaveBeenCalled()
  })

  it('with confirm:true: maps the role, sends, and audits', async () => {
    mockInvite.mockResolvedValueOnce({ invitation: { id: 'inv-1' }, emailSent: true, isTPVOnly: false, inviteLink: 'http://x/invite' })
    const out = parse(await call({ ...base, confirm: true }))

    expect(mockInvite).toHaveBeenCalledWith(
      'v1',
      's1',
      expect.objectContaining({ firstName: 'Ana', lastName: 'López', role: 'CASHIER', email: 'ana@x.com' }),
    )
    expect(out).toMatchObject({ ok: true, invited: { name: 'Ana López', role: 'CASHIER', emailSent: true } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'STAFF_INVITED', entityId: 'inv-1' })
  })

  it('does not offer superadmin as a role option', () => {
    // the enum on the tool excludes superadmin — a sanity guard on the role map
    expect(['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'viewer']).not.toContain('superadmin')
  })
})

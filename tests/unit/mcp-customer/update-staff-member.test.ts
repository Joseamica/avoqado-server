import { registerStaffTools } from '../../../src/mcp/tools/staff'
import type { McpScope } from '../../../src/mcp/scope'

const mockStaffVenueFind = jest.fn()
const mockUpdate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing teams:update')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/team.dashboard.service', () => ({
  inviteTeamMember: jest.fn(),
  updateTeamMember: (...a: unknown[]) => mockUpdate(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('update_staff_member')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const juan = { id: 'sv1', staffId: 'juan-staff', role: 'WAITER', staff: { firstName: 'Juan', lastName: 'Pérez', active: true } }

beforeAll(() => {
  registerStaffTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  // Caller is OWNER at v1 → outranks every grantable role (ceiling tests override per-case).
  scope.perVenueAccess.set('v1', { role: 'OWNER' } as never)
})

describe('update_staff_member (critical write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm / empty change', async () => {
    await expect(call({ venueId: 'foreign', name: 'juan', active: false })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', name: 'juan', active: false })).rejects.toThrow('Forbidden')
    const empty = parse(await call({ venueId: 'v1', name: 'juan' }))
    expect(empty.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('no-ops when the member is already in the requested state', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([juan])
    const out = parse(await call({ venueId: 'v1', name: 'juan', role: 'waiter', active: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/nada que cambiar/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS the from->to change and does NOT write', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([juan])
    const out = parse(await call({ venueId: 'v1', name: 'juan', role: 'manager', active: false }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.changes).toEqual({ role: { from: 'WAITER', to: 'MANAGER' }, active: { from: true, to: false } })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('with confirm:true: applies with performedBy attribution and audits', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([juan])
    mockUpdate.mockResolvedValueOnce({})
    const out = parse(await call({ venueId: 'v1', name: 'juan', role: 'manager', confirm: true }))

    expect(mockUpdate).toHaveBeenCalledWith('v1', 'sv1', { role: 'MANAGER', performedBy: 's1' })
    expect(out).toMatchObject({ ok: true, member: 'Juan Pérez' })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'STAFF_MEMBER_UPDATED', entityId: 'sv1', venueId: 'v1' })
  })

  it('surfaces the last-admin protection from the service as ok:false', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([{ ...juan, role: 'ADMIN' }])
    mockUpdate.mockRejectedValueOnce(new Error('Cannot remove the last venue administrator'))
    const out = parse(await call({ venueId: 'v1', name: 'juan', active: false, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/last venue administrator/)
  })

  it('ceiling: a MANAGER cannot manage a member who OUTRANKS them', async () => {
    scope.perVenueAccess.set('v1', { role: 'MANAGER' } as never) // caller MANAGER (6)
    mockStaffVenueFind.mockResolvedValueOnce([{ ...juan, role: 'OWNER' }]) // target OWNER (8) outranks
    const out = parse(await call({ venueId: 'v1', name: 'juan', active: false, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/superior al tuyo/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('ceiling: cannot GRANT a role above your own (MANAGER → ADMIN blocked)', async () => {
    scope.perVenueAccess.set('v1', { role: 'MANAGER' } as never) // caller MANAGER (6)
    mockStaffVenueFind.mockResolvedValueOnce([juan]) // target WAITER (4) — manageable
    const out = parse(await call({ venueId: 'v1', name: 'juan', role: 'admin', confirm: true })) // ADMIN (7) > 6
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/otorgar el rol ADMIN/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('refuses self-management — cannot change your OWN role/status via the agent', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([{ ...juan, staffId: 's1' }]) // the matched member IS the caller
    const out = parse(await call({ venueId: 'v1', name: 'juan', active: false, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/tu propio rol o estado/)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

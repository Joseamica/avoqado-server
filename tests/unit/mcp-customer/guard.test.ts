import { createGuard, ScopeError } from '../../../src/mcp/guard'
import type { McpScope } from '../../../src/mcp/scope'
import logger from '@/config/logger' // globally mocked in tests/__helpers__/setup.ts

jest.mock('@/services/access/access.service', () => ({
  hasPermission: (a: any, p: string) => (a.corePermissions ?? []).includes(p),
}))

const scope = (ids: string[]): McpScope => ({
  staffId: 's',
  activeOrg: 'o',
  allowedVenueIds: ids,
  perVenueAccess: new Map(ids.map(id => [id, { corePermissions: ['venue:read'] } as any])),
})

describe('guard', () => {
  it('venueFilter defaults to all allowed venues', () => {
    expect(createGuard(scope(['A', 'B'])).venueFilter()).toEqual({ venueId: { in: ['A', 'B'] } })
  })
  it('venueFilter for an in-scope venue narrows to it', () => {
    expect(createGuard(scope(['A', 'B'])).venueFilter('A')).toEqual({ venueId: { in: ['A'] } })
  })
  it('venueFilter THROWS for an out-of-scope venue (the leak test)', () => {
    expect(() => createGuard(scope(['A', 'B'])).venueFilter('C')).toThrow(ScopeError)
  })
  it('requirePermission throws when the venue lacks the permission', () => {
    expect(() => createGuard(scope(['A'])).requirePermission('payments:refund', 'A')).toThrow(ScopeError)
  })
  it('redact strips sensitive payment fields', () => {
    const out = createGuard(scope(['A'])).redact([{ amount: 10, maskedPan: '4111****1111' } as any])
    expect(out[0]).toEqual({ amount: 10 })
  })
  it('venueFilter logs an alertable warning on out-of-scope denial', () => {
    expect(() => createGuard(scope(['A'])).venueFilter('C')).toThrow(ScopeError)
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCP] venue out of scope (denied)',
      expect.objectContaining({ mcp: true, staffId: 's', requestedVenueId: 'C' }),
    )
  })
  it('requirePermission logs an alertable warning on permission denial', () => {
    expect(() => createGuard(scope(['A'])).requirePermission('payments:refund', 'A')).toThrow(ScopeError)
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCP] permission denied',
      expect.objectContaining({ mcp: true, staffId: 's', permission: 'payments:refund', venueId: 'A' }),
    )
  })
})

// OAuth scope enforcement: a mcp:read-only connection can read but not write.
describe('guard — mcp:write scope enforcement', () => {
  const withScope = (scopes: string[] | undefined, perms: string[]): McpScope => ({
    staffId: 's',
    activeOrg: 'o',
    allowedVenueIds: ['A'],
    perVenueAccess: new Map([['A', { corePermissions: perms } as any]]),
    scopes,
  })

  it('BLOCKS a write action when the token lacks mcp:write (read-only connection)', () => {
    // role HAS the permission — the block is purely the scope, not the role.
    const g = createGuard(withScope(['mcp:read'], ['loyalty:adjust']))
    expect(() => g.requirePermission('loyalty:adjust', 'A')).toThrow(/solo lectura|mcp:write/)
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCP] write blocked: token lacks mcp:write scope',
      expect.objectContaining({ permission: 'loyalty:adjust' }),
    )
  })

  it('ALLOWS a write when the token carries mcp:write (and the role permits it)', () => {
    const g = createGuard(withScope(['mcp:read', 'mcp:write'], ['loyalty:adjust']))
    expect(() => g.requirePermission('loyalty:adjust', 'A')).not.toThrow()
  })

  it('ALLOWS reads (:read / :view / :list) even on a read-only connection', () => {
    const g = createGuard(withScope(['mcp:read'], ['loyalty:read', 'cfdi:view']))
    expect(() => g.requirePermission('loyalty:read', 'A')).not.toThrow()
    expect(() => g.requirePermission('cfdi:view', 'A')).not.toThrow() // :view is a read, not a write
  })

  it('does NOT enforce when scopes are absent (dev/legacy token → full access until it refreshes)', () => {
    const g = createGuard(withScope(undefined, ['loyalty:adjust']))
    expect(() => g.requirePermission('loyalty:adjust', 'A')).not.toThrow()
  })
})

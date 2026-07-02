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

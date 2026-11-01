/**
 * The impersonation guard compares the request path against BLOCKED_PREFIXES and
 * IMPERSONATION_CONTROL_PATHS. Express routes case-insensitively, so the comparison
 * must be case-insensitive too: otherwise `/api/v1/Superadmin/...` reaches the
 * superadmin router while slipping past the block.
 */
import { Request } from 'express'
import { enforceImpersonationRules, _resetImpersonationGuardCacheForTests } from '@/middlewares/impersonationGuard.middleware'
import { IMPERSONATION_ERROR_CODES } from '@/types/impersonation'
import prisma from '@/utils/prismaClient'

function impersonatingRequest(method: string, originalUrl: string): Request {
  return {
    method,
    originalUrl,
    authContext: {
      userId: 'staff_target',
      orgId: 'org_1',
      venueId: 'venue_1',
      role: 'MANAGER',
      isImpersonating: true,
      impersonation: {
        mode: 'role',
        impersonatedUserId: null,
        impersonatedRole: 'MANAGER',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        extensionsUsed: 0,
      },
    },
  } as unknown as Request
}

describe('enforceImpersonationRules — path comparison', () => {
  beforeEach(() => {
    _resetImpersonationGuardCacheForTests()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_1' })
  })

  describe('blocked prefixes ignore letter case', () => {
    it.each([
      '/api/v1/Superadmin/venues',
      '/api/v1/SUPERADMIN/venues',
      '/API/V1/superadmin/venues',
      '/api/v1/dashboard/SuperAdmin/stats',
      '/api/v1/Dashboard/superadmin/stats?x=1',
    ])('GET %s → 403 BLOCKED_ROUTE', async url => {
      const result = await enforceImpersonationRules(impersonatingRequest('GET', url))
      expect(result).toMatchObject({ ok: false, status: 403, code: IMPERSONATION_ERROR_CODES.BLOCKED_ROUTE })
    })
  })

  describe('control paths ignore letter case', () => {
    it.each(['/api/v1/dashboard/impersonation/stop', '/api/v1/Dashboard/Impersonation/STOP', '/API/V1/dashboard/impersonation/extend?a=b'])(
      'POST %s still passes',
      async url => {
        const result = await enforceImpersonationRules(impersonatingRequest('POST', url))
        expect(result).toEqual({ ok: true })
      },
    )
  })

  describe('regression', () => {
    it('lowercase blocked prefix is still blocked', async () => {
      const result = await enforceImpersonationRules(impersonatingRequest('GET', '/api/v1/superadmin/venues'))
      expect(result).toMatchObject({ ok: false, status: 403, code: IMPERSONATION_ERROR_CODES.BLOCKED_ROUTE })
    })

    it('a normal read route still passes', async () => {
      const result = await enforceImpersonationRules(impersonatingRequest('GET', '/api/v1/dashboard/venues/venue_1/orders'))
      expect(result).toEqual({ ok: true })
    })

    it('a write on a normal route is still read-only blocked', async () => {
      const result = await enforceImpersonationRules(impersonatingRequest('POST', '/api/v1/dashboard/venues/venue_1/orders'))
      expect(result).toMatchObject({ ok: false, status: 403, code: IMPERSONATION_ERROR_CODES.READ_ONLY })
    })

    it('non-impersonation requests pass untouched, whatever the path', async () => {
      const req = { method: 'GET', originalUrl: '/api/v1/Superadmin/venues', authContext: { isImpersonating: false } } as unknown as Request
      expect(await enforceImpersonationRules(req)).toEqual({ ok: true })
    })
  })
})

/**
 * Feature Access Middleware Tests
 *
 * Tests the critical feature access control logic:
 * 1. Active subscription - Should allow access
 * 2. Trial expired - Should block access
 * 3. Feature not found - Should block access
 */

import { Request, Response, NextFunction } from 'express'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import prisma from '@/utils/prismaClient'

// Mock dependencies
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    venue: {
      findUnique: jest.fn(),
    },
    staffVenue: {
      findFirst: jest.fn(),
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('checkFeatureAccess Middleware - Critical Tests', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    // getVenueBaseTier (tier-aware blanket grant) queries findMany; default = no active base plan.
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([])

    // venueIsExemptFromPlanGating (grandfather + demo short-circuit) queries venue.findUnique
    // selecting seatCapExempt AND status; default = NOT grandfathered, regular ACTIVE venue,
    // so the tier/grant paths under test still run.
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    // requestIsSuperAdmin queries staffVenue.findFirst (role SUPERADMIN); default = NOT a superadmin,
    // so the tier/grant/exempt paths under test still run. The superadmin-bypass test overrides this.
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)

    jsonMock = jest.fn()
    statusMock = jest.fn(() => mockRes as Response)

    mockReq = {
      authContext: {
        userId: 'user_123',
        venueId: 'venue_123',
        orgId: 'org_123',
        role: 'OWNER',
      },
    } as any

    mockRes = {
      status: statusMock,
      json: jsonMock,
    }

    mockNext = jest.fn()
  })

  describe('✅ TEST 1: Active Subscription - Should Allow Access', () => {
    it('should allow access for active paid subscription (no trial)', async () => {
      const middleware = checkFeatureAccess('ANALYTICS')

      // Mock active feature with no endDate (paid forever)
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_1',
        venueId: 'venue_123',
        featureId: 'feature_1',
        active: true,
        endDate: null, // No expiration = paid subscription
        stripeSubscriptionId: 'sub_123',
        feature: {
          id: 'feature_1',
          code: 'ANALYTICS',
          name: 'Analytics Dashboard',
        },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should call next() without errors
      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(statusMock).not.toHaveBeenCalled()
      expect(jsonMock).not.toHaveBeenCalled()

      // Should attach feature info to request
      expect((mockReq as any).venueFeature).toEqual({
        id: 'vf_1',
        featureCode: 'ANALYTICS',
        featureName: 'Analytics Dashboard',
        isTrialing: false,
        trialEndsAt: null,
        subscriptionId: 'sub_123',
      })
    })

    it('should allow access for active trial (not expired yet)', async () => {
      const middleware = checkFeatureAccess('CHATBOT')

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 3) // Trial expires in 3 days
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_2',
        venueId: 'venue_123',
        featureId: 'feature_2',
        active: true,
        endDate: futureDate,
        stripeSubscriptionId: 'sub_456',
        feature: {
          id: 'feature_2',
          code: 'CHATBOT',
          name: 'AI Chatbot',
        },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should allow access
      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(statusMock).not.toHaveBeenCalled()

      // Should mark as trialing
      expect((mockReq as any).venueFeature.isTrialing).toBe(true)
      expect((mockReq as any).venueFeature.trialEndsAt).toEqual(futureDate)
    })
  })

  describe('❌ TEST 2: Trial Expired - Should Block Access', () => {
    it('should block access when trial has expired', async () => {
      const middleware = checkFeatureAccess('INVENTORY')

      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 2) // Trial expired 2 days ago
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_3',
        venueId: 'venue_123',
        featureId: 'feature_3',
        active: true, // Still marked active (webhook not fired yet)
        endDate: pastDate, // But trial expired
        feature: {
          id: 'feature_3',
          code: 'INVENTORY',
          name: 'Inventory Management',
        },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should NOT call next()
      expect(mockNext).not.toHaveBeenCalled()

      // Should return 403 Forbidden
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Feature trial expired',
        message: 'Your trial for Inventory Management has expired. Please add a payment method to continue using this feature.',
        featureCode: 'INVENTORY',
        featureName: 'Inventory Management',
        trialExpired: true,
        expirationDate: pastDate,
      })
    })

    it('should block access when trial expires exactly now', async () => {
      const middleware = checkFeatureAccess('REPORTS')

      const now = new Date()
      now.setSeconds(now.getSeconds() - 1) // Expired 1 second ago
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_4',
        venueId: 'venue_123',
        featureId: 'feature_4',
        active: true,
        endDate: now,
        feature: {
          id: 'feature_4',
          code: 'REPORTS',
          name: 'Advanced Reports',
        },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should block (endDate < now)
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(403)
    })
  })

  describe('🚫 TEST 3: Feature Not Found - Should Block Access', () => {
    it('should block access when feature is not active', async () => {
      const middleware = checkFeatureAccess('PREMIUM')

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_5',
        venueId: 'venue_123',
        featureId: 'feature_5',
        active: false, // Feature was canceled
        endDate: null,
        feature: {
          id: 'feature_5',
          code: 'PREMIUM',
          name: 'Premium Features',
        },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should block
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Feature not available',
        message: 'This venue does not have access to the PREMIUM feature. Please subscribe to enable this feature.',
        featureCode: 'PREMIUM',
        subscriptionRequired: true,
      })
    })

    it('should block access when feature does not exist at all', async () => {
      const middleware = checkFeatureAccess('NONEXISTENT')

      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(null)

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should block
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Feature not available',
        message: 'This venue does not have access to the NONEXISTENT feature. Please subscribe to enable this feature.',
        featureCode: 'NONEXISTENT',
        subscriptionRequired: true,
      })
    })

    it('should block access when venue context is missing', async () => {
      const middleware = checkFeatureAccess('ANALYTICS')

      // No authContext
      mockReq.authContext = undefined

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should block immediately
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(401)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'No venue context found',
      })

      // Should NOT query database
      expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('⚠️ TEST 4: Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      const middleware = checkFeatureAccess('ANALYTICS')

      ;(prisma.venueFeature.findFirst as jest.Mock).mockRejectedValueOnce(new Error('Database connection failed'))

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Should NOT crash, return 500
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(500)
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Internal server error',
        message: 'Failed to verify feature access',
      })
    })
  })

  describe('🎭 TEST 4b: Exemption short-circuit (grandfathered + demo venues)', () => {
    it.each([['LIVE_DEMO'], ['TRIAL']])('allows ANY feature code for a %s (demo) venue without querying VenueFeature', async status => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ seatCapExempt: false, status })

      const middleware = checkFeatureAccess('RESERVATIONS')
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(statusMock).not.toHaveBeenCalled()
      expect((mockReq as any).venueFeature).toEqual({ featureCode: 'RESERVATIONS', grantedBy: 'GRANDFATHERED_OR_DEMO' })
      // Short-circuited BEFORE the VenueFeature / tier queries.
      expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
      expect(prisma.venueFeature.findMany).not.toHaveBeenCalled()
    })

    it('allows ANY feature code for a GRANDFATHERED venue (seatCapExempt=true) regardless of status', async () => {
      ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

      const middleware = checkFeatureAccess('LOYALTY_PROGRAM')
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(statusMock).not.toHaveBeenCalled()
      expect((mockReq as any).venueFeature).toEqual({ featureCode: 'LOYALTY_PROGRAM', grantedBy: 'GRANDFATHERED_OR_DEMO' })
      expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
    })

    it.each([['ACTIVE'], ['ONBOARDING'], ['SUSPENDED']])(
      'still blocks a Free venue with non-demo status %s (no grant, no tier)',
      async status => {
        ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ seatCapExempt: false, status })
        ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(null)

        const middleware = checkFeatureAccess('RESERVATIONS')
        await middleware(mockReq as Request, mockRes as Response, mockNext)

        expect(mockNext).not.toHaveBeenCalled()
        expect(statusMock).toHaveBeenCalledWith(403)
      },
    )
  })

  describe('👑 TEST 4c: SUPERADMIN bypass', () => {
    it('a platform superadmin gets through ANY feature code on a non-entitled, non-grandfathered venue', async () => {
      // Regression (prod 2026-06-16): a superadmin inspecting a Pro venue 403'd on accounting/CFDI
      // routes because checkFeatureAccess had no superadmin bypass (only grandfathered/demo).
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_super' }) // has a SUPERADMIN venue

      const middleware = checkFeatureAccess('CFDI')
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledTimes(1)
      expect(statusMock).not.toHaveBeenCalled()
      expect((mockReq as any).venueFeature).toEqual({ featureCode: 'CFDI', grantedBy: 'SUPERADMIN' })
      // Short-circuited BEFORE the VenueFeature / tier queries (mirrors the exempt short-circuit).
      expect(prisma.venueFeature.findFirst).not.toHaveBeenCalled()
      expect(prisma.venue.findUnique).not.toHaveBeenCalled()
    })

    it('the superadmin bypass is DISABLED while impersonating (evaluate the target venue tier)', async () => {
      ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv_super' })
      ;(mockReq as any).authContext.isImpersonating = true
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce(null) // target not entitled

      const middleware = checkFeatureAccess('CFDI')
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Impersonating → no bypass → the non-entitled target gets the normal 403.
      expect(mockNext).not.toHaveBeenCalled()
      expect(statusMock).toHaveBeenCalledWith(403)
    })
  })

  describe('🏷️ TEST 5: Venue resolution (URL :venueId, not token)', () => {
    it('checks the feature against the URL :venueId, not the token venue', async () => {
      // Token is scoped to a DIFFERENT venue than the one being accessed in the URL.
      mockReq.params = { venueId: 'venue_URL' }
      ;(mockReq as any).authContext.venueId = 'venue_TOKEN'

      const middleware = checkFeatureAccess('CFDI')
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_url',
        venueId: 'venue_URL',
        active: true,
        endDate: null,
        suspendedAt: null,
        feature: { code: 'CFDI', name: 'Facturación CFDI 4.0' },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      // Resolved venueId must be the URL venue, not the token venue.
      const where = (prisma.venueFeature.findFirst as jest.Mock).mock.calls[0][0].where
      expect(where.venueId).toBe('venue_URL')
      expect(mockNext).toHaveBeenCalled()
      expect(statusMock).not.toHaveBeenCalledWith(403)
    })

    it('falls back to the token venue when no URL param / header is present', async () => {
      // No params/headers → uses authContext.venueId (backward compatible).
      const middleware = checkFeatureAccess('ANALYTICS')
      ;(prisma.venueFeature.findFirst as jest.Mock).mockResolvedValueOnce({
        id: 'vf_tok',
        venueId: 'venue_123',
        active: true,
        endDate: null,
        suspendedAt: null,
        feature: { code: 'ANALYTICS', name: 'Analytics' },
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      const where = (prisma.venueFeature.findFirst as jest.Mock).mock.calls[0][0].where
      expect(where.venueId).toBe('venue_123')
      expect(mockNext).toHaveBeenCalled()
    })
  })
})

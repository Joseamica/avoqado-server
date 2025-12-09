/**
 * VenueStatus Constants Tests
 *
 * Tests for the consolidated venue status system.
 * Verifies that demo vs production classification and operational
 * status checks work correctly.
 */

import { VenueStatus } from '@prisma/client'
import {
  DEMO_VENUE_STATUSES,
  PRODUCTION_VENUE_STATUSES,
  OPERATIONAL_VENUE_STATUSES,
  NON_OPERATIONAL_VENUE_STATUSES,
  ANALYTICS_VENUE_STATUSES,
  isVenueOperational,
  isDemoVenue,
  isProductionVenue,
  canDeleteVenue,
  isLiveDemoVenue,
  isTrialVenue,
  requiresKYC,
  includeInAnalytics,
} from '../../../src/lib/venueStatus.constants'

describe('VenueStatus Constants', () => {
  describe('Status Arrays', () => {
    it('should have DEMO_VENUE_STATUSES containing only ephemeral statuses', () => {
      expect(DEMO_VENUE_STATUSES).toContain(VenueStatus.LIVE_DEMO)
      expect(DEMO_VENUE_STATUSES).toContain(VenueStatus.TRIAL)
      expect(DEMO_VENUE_STATUSES).toHaveLength(2)
    })

    it('should have PRODUCTION_VENUE_STATUSES excluding demo statuses', () => {
      expect(PRODUCTION_VENUE_STATUSES).not.toContain(VenueStatus.LIVE_DEMO)
      expect(PRODUCTION_VENUE_STATUSES).not.toContain(VenueStatus.TRIAL)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.ONBOARDING)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.PENDING_ACTIVATION)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.ACTIVE)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.SUSPENDED)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.ADMIN_SUSPENDED)
      expect(PRODUCTION_VENUE_STATUSES).toContain(VenueStatus.CLOSED)
    })

    it('should have OPERATIONAL_VENUE_STATUSES include both demo and operational production statuses', () => {
      // Demo statuses should be operational (for exploration)
      expect(OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.LIVE_DEMO)
      expect(OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.TRIAL)
      // Production operational statuses
      expect(OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.ONBOARDING)
      expect(OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.PENDING_ACTIVATION)
      expect(OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.ACTIVE)
      // Should NOT contain blocked statuses
      expect(OPERATIONAL_VENUE_STATUSES).not.toContain(VenueStatus.SUSPENDED)
      expect(OPERATIONAL_VENUE_STATUSES).not.toContain(VenueStatus.ADMIN_SUSPENDED)
      expect(OPERATIONAL_VENUE_STATUSES).not.toContain(VenueStatus.CLOSED)
    })

    it('should have NON_OPERATIONAL_VENUE_STATUSES contain only blocked statuses', () => {
      expect(NON_OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.SUSPENDED)
      expect(NON_OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.ADMIN_SUSPENDED)
      expect(NON_OPERATIONAL_VENUE_STATUSES).toContain(VenueStatus.CLOSED)
      expect(NON_OPERATIONAL_VENUE_STATUSES).toHaveLength(3)
    })

    it('should have ANALYTICS_VENUE_STATUSES exclude demo venues', () => {
      expect(ANALYTICS_VENUE_STATUSES).not.toContain(VenueStatus.LIVE_DEMO)
      expect(ANALYTICS_VENUE_STATUSES).not.toContain(VenueStatus.TRIAL)
      expect(ANALYTICS_VENUE_STATUSES).toContain(VenueStatus.PENDING_ACTIVATION)
      expect(ANALYTICS_VENUE_STATUSES).toContain(VenueStatus.ACTIVE)
    })

    it('should cover all VenueStatus values between DEMO and PRODUCTION arrays', () => {
      const allStatuses = [...DEMO_VENUE_STATUSES, ...PRODUCTION_VENUE_STATUSES]
      const uniqueStatuses = new Set(allStatuses)
      expect(uniqueStatuses.size).toBe(Object.values(VenueStatus).length)
    })

    it('should have no overlap between OPERATIONAL and NON_OPERATIONAL', () => {
      const operationalSet = new Set(OPERATIONAL_VENUE_STATUSES)
      for (const status of NON_OPERATIONAL_VENUE_STATUSES) {
        expect(operationalSet.has(status)).toBe(false)
      }
    })
  })

  describe('isVenueOperational()', () => {
    it('should return true for demo statuses', () => {
      expect(isVenueOperational(VenueStatus.LIVE_DEMO)).toBe(true)
      expect(isVenueOperational(VenueStatus.TRIAL)).toBe(true)
    })

    it('should return true for operational production statuses', () => {
      expect(isVenueOperational(VenueStatus.ONBOARDING)).toBe(true)
      expect(isVenueOperational(VenueStatus.PENDING_ACTIVATION)).toBe(true)
      expect(isVenueOperational(VenueStatus.ACTIVE)).toBe(true)
    })

    it('should return false for non-operational statuses', () => {
      expect(isVenueOperational(VenueStatus.SUSPENDED)).toBe(false)
      expect(isVenueOperational(VenueStatus.ADMIN_SUSPENDED)).toBe(false)
      expect(isVenueOperational(VenueStatus.CLOSED)).toBe(false)
    })
  })

  describe('isDemoVenue()', () => {
    it('should return true only for LIVE_DEMO and TRIAL', () => {
      expect(isDemoVenue(VenueStatus.LIVE_DEMO)).toBe(true)
      expect(isDemoVenue(VenueStatus.TRIAL)).toBe(true)
    })

    it('should return false for production statuses', () => {
      expect(isDemoVenue(VenueStatus.ONBOARDING)).toBe(false)
      expect(isDemoVenue(VenueStatus.PENDING_ACTIVATION)).toBe(false)
      expect(isDemoVenue(VenueStatus.ACTIVE)).toBe(false)
      expect(isDemoVenue(VenueStatus.SUSPENDED)).toBe(false)
      expect(isDemoVenue(VenueStatus.ADMIN_SUSPENDED)).toBe(false)
      expect(isDemoVenue(VenueStatus.CLOSED)).toBe(false)
    })
  })

  describe('isProductionVenue()', () => {
    it('should return false for demo statuses', () => {
      expect(isProductionVenue(VenueStatus.LIVE_DEMO)).toBe(false)
      expect(isProductionVenue(VenueStatus.TRIAL)).toBe(false)
    })

    it('should return true for production statuses', () => {
      expect(isProductionVenue(VenueStatus.ONBOARDING)).toBe(true)
      expect(isProductionVenue(VenueStatus.PENDING_ACTIVATION)).toBe(true)
      expect(isProductionVenue(VenueStatus.ACTIVE)).toBe(true)
      expect(isProductionVenue(VenueStatus.SUSPENDED)).toBe(true)
      expect(isProductionVenue(VenueStatus.ADMIN_SUSPENDED)).toBe(true)
      expect(isProductionVenue(VenueStatus.CLOSED)).toBe(true)
    })
  })

  describe('canDeleteVenue()', () => {
    it('should return true only for demo venues (SAT compliance)', () => {
      expect(canDeleteVenue(VenueStatus.LIVE_DEMO)).toBe(true)
      expect(canDeleteVenue(VenueStatus.TRIAL)).toBe(true)
    })

    it('should return false for production venues (SAT requires data retention)', () => {
      expect(canDeleteVenue(VenueStatus.ONBOARDING)).toBe(false)
      expect(canDeleteVenue(VenueStatus.PENDING_ACTIVATION)).toBe(false)
      expect(canDeleteVenue(VenueStatus.ACTIVE)).toBe(false)
      expect(canDeleteVenue(VenueStatus.SUSPENDED)).toBe(false)
      expect(canDeleteVenue(VenueStatus.ADMIN_SUSPENDED)).toBe(false)
      expect(canDeleteVenue(VenueStatus.CLOSED)).toBe(false)
    })
  })

  describe('isLiveDemoVenue()', () => {
    it('should return true only for LIVE_DEMO', () => {
      expect(isLiveDemoVenue(VenueStatus.LIVE_DEMO)).toBe(true)
    })

    it('should return false for all other statuses', () => {
      expect(isLiveDemoVenue(VenueStatus.TRIAL)).toBe(false)
      expect(isLiveDemoVenue(VenueStatus.ONBOARDING)).toBe(false)
      expect(isLiveDemoVenue(VenueStatus.ACTIVE)).toBe(false)
    })
  })

  describe('isTrialVenue()', () => {
    it('should return true only for TRIAL', () => {
      expect(isTrialVenue(VenueStatus.TRIAL)).toBe(true)
    })

    it('should return false for all other statuses', () => {
      expect(isTrialVenue(VenueStatus.LIVE_DEMO)).toBe(false)
      expect(isTrialVenue(VenueStatus.ONBOARDING)).toBe(false)
      expect(isTrialVenue(VenueStatus.ACTIVE)).toBe(false)
    })
  })

  describe('requiresKYC()', () => {
    it('should return false for demo venues (no KYC required)', () => {
      expect(requiresKYC(VenueStatus.LIVE_DEMO)).toBe(false)
      expect(requiresKYC(VenueStatus.TRIAL)).toBe(false)
    })

    it('should return true for production venues', () => {
      expect(requiresKYC(VenueStatus.ONBOARDING)).toBe(true)
      expect(requiresKYC(VenueStatus.PENDING_ACTIVATION)).toBe(true)
      expect(requiresKYC(VenueStatus.ACTIVE)).toBe(true)
      expect(requiresKYC(VenueStatus.SUSPENDED)).toBe(true)
      expect(requiresKYC(VenueStatus.ADMIN_SUSPENDED)).toBe(true)
      expect(requiresKYC(VenueStatus.CLOSED)).toBe(true)
    })
  })

  describe('includeInAnalytics()', () => {
    it('should return false for demo venues', () => {
      expect(includeInAnalytics(VenueStatus.LIVE_DEMO)).toBe(false)
      expect(includeInAnalytics(VenueStatus.TRIAL)).toBe(false)
    })

    it('should return true for analytics venues', () => {
      expect(includeInAnalytics(VenueStatus.PENDING_ACTIVATION)).toBe(true)
      expect(includeInAnalytics(VenueStatus.ACTIVE)).toBe(true)
      expect(includeInAnalytics(VenueStatus.SUSPENDED)).toBe(true)
      expect(includeInAnalytics(VenueStatus.ADMIN_SUSPENDED)).toBe(true)
      expect(includeInAnalytics(VenueStatus.CLOSED)).toBe(true)
    })

    it('should return false for ONBOARDING (still being set up)', () => {
      // ONBOARDING is not in ANALYTICS_VENUE_STATUSES because
      // these venues haven't completed setup yet
      expect(includeInAnalytics(VenueStatus.ONBOARDING)).toBe(false)
    })
  })
})

describe('VenueStatus Consolidation - Backward Compatibility', () => {
  /**
   * These tests verify that the status-based approach can replace
   * the deprecated isOnboardingDemo and isLiveDemo booleans.
   */

  describe('isOnboardingDemo replacement', () => {
    it('should use status === TRIAL instead of isOnboardingDemo boolean', () => {
      // Old approach: venue.isOnboardingDemo === true
      // New approach: venue.status === VenueStatus.TRIAL
      const isOldOnboardingDemo = (status: VenueStatus) => status === VenueStatus.TRIAL

      expect(isOldOnboardingDemo(VenueStatus.TRIAL)).toBe(true)
      expect(isOldOnboardingDemo(VenueStatus.ACTIVE)).toBe(false)
      expect(isOldOnboardingDemo(VenueStatus.LIVE_DEMO)).toBe(false)
    })
  })

  describe('isLiveDemo replacement', () => {
    it('should use status === LIVE_DEMO instead of isLiveDemo boolean', () => {
      // Old approach: venue.isLiveDemo === true
      // New approach: venue.status === VenueStatus.LIVE_DEMO
      const isOldLiveDemo = (status: VenueStatus) => status === VenueStatus.LIVE_DEMO

      expect(isOldLiveDemo(VenueStatus.LIVE_DEMO)).toBe(true)
      expect(isOldLiveDemo(VenueStatus.TRIAL)).toBe(false)
      expect(isOldLiveDemo(VenueStatus.ACTIVE)).toBe(false)
    })
  })

  describe('Demo detection unified', () => {
    it('should detect both demo types with single isDemoVenue check', () => {
      // Old approach: venue.isOnboardingDemo || venue.isLiveDemo
      // New approach: isDemoVenue(venue.status)
      expect(isDemoVenue(VenueStatus.LIVE_DEMO)).toBe(true)
      expect(isDemoVenue(VenueStatus.TRIAL)).toBe(true)
      expect(isDemoVenue(VenueStatus.ACTIVE)).toBe(false)
    })
  })
})

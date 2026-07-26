/**
 * Regression: venues permanently named "Mi Negocio".
 *
 * Root cause (prod, 3 venues affected): `getV2SetupDataForCompletion` defaulted the
 * business name to 'Mi Negocio'. That made the `if (!businessName) return null` guard
 * in `ensureVenueForOnboarding` unreachable — so the GET progress call that fires on
 * WIZARD MOUNT (before Step 2 exists) created a provisional venue named after the
 * placeholder, with empty address/city/phone and type=RESTAURANT. Completion then only
 * flipped `status`, so nothing the user typed afterwards ever reached the venue.
 *
 * The pre-existing ensureVenue test missed it because it MOCKED
 * getV2SetupDataForCompletion and hand-fed it `name: ''` — a state the real collaborator
 * could never produce. These tests wire the two together for real.
 */

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    onboardingProgress: { findUnique: jest.fn() },
    staffOrganization: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

// venueCreation.service pulls in Stripe/email/KYC collaborators at import time.
jest.mock('../../../../src/services/stripe.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/superadmin/kycReview.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('../../../../src/services/resend.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/onboarding/demoSeed.service', () => ({ __esModule: true, seedDemoVenue: jest.fn() }))

import { ensureVenueForOnboarding } from '../../../../src/services/onboarding/ensureVenue.service'
import { getV2SetupDataForCompletion } from '../../../../src/services/onboarding/onboardingProgress.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import * as venueCreationModule from '../../../../src/services/onboarding/venueCreation.service'
import { applyBusinessInfoToVenue } from '../../../../src/services/onboarding/venueCreation.service'

const prisma = require('../../../../src/utils/prismaClient').default

const V2_PROGRESS = (v2SetupData: Record<string, any>) => ({
  id: 'prog-1',
  organizationId: 'org-1',
  wizardVersion: 2,
  currentStep: 2,
  completedSteps: [],
  v2SetupData,
})

describe('provisional venue naming', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getV2SetupDataForCompletion', () => {
    it('returns an EMPTY name when Step 2 has not been saved yet (no placeholder)', async () => {
      prisma.onboardingProgress.findUnique.mockResolvedValue(V2_PROGRESS({}))

      const { businessInfo } = await getV2SetupDataForCompletion('org-1')

      // The placeholder must NOT be invented here — it is what killed the guard below.
      expect(businessInfo.name).toBe('')
    })

    it('returns the real business name once Step 2 is saved', async () => {
      prisma.onboardingProgress.findUnique.mockResolvedValue(V2_PROGRESS({ step2: { businessName: 'AM club', city: 'Querétaro' } }))

      const { businessInfo } = await getV2SetupDataForCompletion('org-1')

      expect(businessInfo.name).toBe('AM club')
      expect(businessInfo.city).toBe('Querétaro')
    })
  })

  describe('ensureVenueForOnboarding (wired to the REAL progress service)', () => {
    it('does NOT create a venue on wizard mount, before Step 2 exists', async () => {
      prisma.venue.findFirst.mockResolvedValue(null)
      prisma.staffOrganization.findFirst.mockResolvedValue({ staffId: 'staff-1' })
      prisma.onboardingProgress.findUnique.mockResolvedValue(V2_PROGRESS({}))

      const result = await ensureVenueForOnboarding('org-1', 'staff-1')

      expect(result).toBeNull()
      // The bug: a venue literally named 'Mi Negocio' was created right here.
      expect(prisma.venue.update).not.toHaveBeenCalled()
    })

    it('creates the venue with the REAL name once Step 2 is saved', async () => {
      prisma.venue.findFirst.mockResolvedValue(null)
      prisma.staffOrganization.findFirst.mockResolvedValue({ staffId: 'staff-1' })
      prisma.onboardingProgress.findUnique.mockResolvedValue(V2_PROGRESS({ step2: { businessName: 'AM club', city: 'Querétaro' } }))

      const spy = jest
        .spyOn(venueCreationModule, 'createVenueFromOnboarding')
        .mockResolvedValue({ venue: { id: 'venue-new', slug: 'am-club', status: 'ONBOARDING' } } as any)

      const result = await ensureVenueForOnboarding('org-1', 'staff-1')

      expect(result?.id).toBe('venue-new')
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ businessInfo: expect.objectContaining({ name: 'AM club', city: 'Querétaro' }) }),
      )
      spy.mockRestore()
    })
  })

  describe('applyBusinessInfoToVenue', () => {
    const PROVISIONAL = {
      id: 'venue-1',
      name: 'Mi Negocio',
      slug: 'mi-negocio-1',
      address: '',
      city: '',
      state: '',
      zipCode: '',
      phone: '',
      email: 'owner@example.com',
      type: 'RESTAURANT',
    }

    // findUnique serves two callers: the venue lookup (by id) and slugExists (by slug).
    const mockVenueLookups = (venue: any, takenSlugs: string[] = []) => {
      prisma.venue.findUnique.mockImplementation(({ where }: any) => {
        if (where.id) return Promise.resolve(venue)
        if (where.slug) return Promise.resolve(takenSlugs.includes(where.slug) ? { id: 'other' } : null)
        return Promise.resolve(null)
      })
    }

    it('renames the venue, re-slugs it, and fills the location the wizard collected', async () => {
      mockVenueLookups(PROVISIONAL)
      prisma.venue.update.mockImplementation(({ data }: any) => Promise.resolve({ ...PROVISIONAL, ...data }))

      await applyBusinessInfoToVenue(
        'venue-1',
        {
          name: 'AM club',
          venueType: 'BAR' as any,
          address: 'Av. Constituyentes 100',
          city: 'Querétaro',
          state: 'QRO',
          zipCode: '76000',
          phone: '+524421234567',
          email: '',
        },
        'staff-1',
      )

      expect(prisma.venue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'venue-1' },
          data: expect.objectContaining({
            name: 'AM club',
            slug: 'am-club',
            address: 'Av. Constituyentes 100',
            city: 'Querétaro',
            state: 'QRO',
            zipCode: '76000',
            phone: '+524421234567',
            type: 'BAR',
          }),
        }),
      )
    })

    it('never blanks an existing value with an empty wizard field', async () => {
      mockVenueLookups(PROVISIONAL)
      prisma.venue.update.mockImplementation(({ data }: any) => Promise.resolve({ ...PROVISIONAL, ...data }))

      await applyBusinessInfoToVenue('venue-1', { name: 'AM club', address: '', city: '', phone: '', email: '' }, 'staff-1')

      const data = prisma.venue.update.mock.calls[0][0].data
      expect(data).not.toHaveProperty('address')
      expect(data).not.toHaveProperty('phone')
      // The signup-email fallback already on the venue survives.
      expect(data).not.toHaveProperty('email')
    })

    it('suffixes the slug when the derived one is taken', async () => {
      mockVenueLookups(PROVISIONAL, ['am-club'])
      prisma.venue.update.mockImplementation(({ data }: any) => Promise.resolve({ ...PROVISIONAL, ...data }))

      await applyBusinessInfoToVenue('venue-1', { name: 'AM club' }, 'staff-1')

      expect(prisma.venue.update.mock.calls[0][0].data.slug).toBe('am-club-1')
    })

    it('leaves the slug alone when the name did not change (slug is a Storage path prefix)', async () => {
      const named = { ...PROVISIONAL, name: 'AM club', slug: 'am-club' }
      mockVenueLookups(named)
      prisma.venue.update.mockImplementation(({ data }: any) => Promise.resolve({ ...named, ...data }))

      await applyBusinessInfoToVenue('venue-1', { name: 'AM club', city: 'Querétaro' }, 'staff-1')

      const data = prisma.venue.update.mock.calls[0][0].data
      expect(data).not.toHaveProperty('slug')
      expect(data).not.toHaveProperty('name')
      expect(data.city).toBe('Querétaro')
    })

    it('is a no-op (no write, no audit row) when the wizard adds nothing new', async () => {
      const named = { ...PROVISIONAL, name: 'AM club', slug: 'am-club' }
      mockVenueLookups(named)

      const result = await applyBusinessInfoToVenue('venue-1', { name: 'AM club' }, 'staff-1')

      expect(prisma.venue.update).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
      expect(result).toEqual(named)
    })

    it('writes an ActivityLog row when it does change the venue', async () => {
      mockVenueLookups(PROVISIONAL)
      prisma.venue.update.mockImplementation(({ data }: any) => Promise.resolve({ ...PROVISIONAL, ...data }))

      await applyBusinessInfoToVenue('venue-1', { name: 'AM club' }, 'staff-1')

      // logAction is globally mocked in tests/__helpers__/setup.ts.
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VENUE_ONBOARDING_DATA_APPLIED',
          entity: 'Venue',
          entityId: 'venue-1',
          staffId: 'staff-1',
          venueId: 'venue-1',
          data: expect.objectContaining({ previousName: 'Mi Negocio', newName: 'AM club' }),
        }),
      )
    })
  })
})

/**
 * completeV2Onboarding — rehydrating the PROVISIONAL venue.
 *
 * Regression: when `ensureVenueForOnboarding` had already created a venue mid-wizard,
 * completion only flipped its `status`. Everything the user typed after that point
 * (business name, address, city, phone, business type) was silently discarded — which
 * is how prod ended up with venues named "Mi Negocio" and an empty address while the
 * real values sat in `v2SetupData`.
 *
 * Mock-first, mirroring tests/unit/controllers/completeV2.confirmationEmail.test.ts.
 */

import { Request, Response, NextFunction } from 'express'

jest.mock('../../../src/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  getV2SetupDataForCompletion: jest.fn(),
  parseV2Plan: jest.fn(),
}))

jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  createVenueFromOnboarding: jest.fn(),
  applyBusinessInfoToVenue: jest.fn(),
}))

jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn(),
}))

jest.mock('../../../src/services/onboarding/signup.service', () => ({ __esModule: true }))
jest.mock('../../../src/services/onboarding/testPaymentLink.service', () => ({ __esModule: true }))

jest.mock('../../../src/services/stripe.service', () => ({
  __esModule: true,
  createOnboardingSetupIntent: jest.fn(),
  createPlanSetupIntent: jest.fn(),
  createPlanSubscription: jest.fn(),
  getOrCreateStripeCustomer: jest.fn(),
}))

jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue(null),
}))

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn() },
}))

jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    onboardingProgress: { updateMany: jest.fn(), update: jest.fn() },
    venue: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    organization: { update: jest.fn() },
  },
}))

import { completeV2Onboarding } from '../../../src/controllers/onboarding.controller'
import * as onboardingProgressService from '../../../src/services/onboarding/onboardingProgress.service'
import * as venueCreationService from '../../../src/services/onboarding/venueCreation.service'
import prisma from '../../../src/utils/prismaClient'

const buildReq = (): Partial<Request> =>
  ({
    params: { organizationId: 'org_1' },
    body: {},
    authContext: { userId: 'user_1', orgId: 'org_1', venueId: '', role: 'OWNER' },
  }) as any

const buildRes = (): Partial<Response> => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() })

const BUSINESS_INFO = {
  name: 'AM club',
  venueType: 'BAR',
  address: 'Av. Constituyentes 100',
  city: 'Querétaro',
  state: 'QRO',
  zipCode: '76000',
  phone: '+524421234567',
  email: '',
}

describe('completeV2Onboarding — provisional venue rehydration', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_VENUE_BASE_SUBSCRIPTION

  beforeEach(() => {
    jest.clearAllMocks()
    // Plan gate off — this suite is only about the venue data.
    process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'false'
    ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
      progress: { v2SetupData: {} },
      businessInfo: BUSINESS_INFO,
      bankInfo: null,
      identityInfo: null,
      entityInfo: null,
    })
    ;(onboardingProgressService.parseV2Plan as jest.Mock).mockReturnValue(null)
    ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.venue.update as jest.Mock).mockResolvedValue({ id: 'venue_1', slug: 'am-club', name: 'AM club', status: 'ACTIVE' })
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue_1', slug: 'am-club', name: 'AM club', email: null })
  })

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_VENUE_BASE_SUBSCRIPTION
    else process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = ORIGINAL_FLAG
  })

  it('applies the wizard business info to the provisional venue before activating it', async () => {
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue_1', slug: 'mi-negocio-1', status: 'ONBOARDING' })
    ;(venueCreationService.applyBusinessInfoToVenue as jest.Mock).mockResolvedValue({ id: 'venue_1', name: 'AM club' })

    await completeV2Onboarding(buildReq() as Request, buildRes() as Response, jest.fn() as NextFunction)

    expect(venueCreationService.applyBusinessInfoToVenue).toHaveBeenCalledWith(
      'venue_1',
      expect.objectContaining({ name: 'AM club', city: 'Querétaro', venueType: 'BAR' }),
      'user_1',
    )
    // And it still does NOT create a second venue.
    expect(venueCreationService.createVenueFromOnboarding).not.toHaveBeenCalled()
  })

  it('still activates the venue when the rehydration fails (never blocks completion)', async () => {
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue({ id: 'venue_1', slug: 'mi-negocio-1', status: 'ONBOARDING' })
    ;(venueCreationService.applyBusinessInfoToVenue as jest.Mock).mockRejectedValue(new Error('db down'))

    const res = buildRes()
    const next = jest.fn()
    await completeV2Onboarding(buildReq() as Request, res as Response, next as NextFunction)

    expect(next).not.toHaveBeenCalled()
    expect(prisma.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ACTIVE' }) }))
  })

  it('falls back to the placeholder name only when the wizard truly has none', async () => {
    ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
      progress: { v2SetupData: {} },
      businessInfo: { ...BUSINESS_INFO, name: '' },
      bankInfo: null,
      identityInfo: null,
      entityInfo: null,
    })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null) // create path
    ;(venueCreationService.createVenueFromOnboarding as jest.Mock).mockResolvedValue({
      venue: { id: 'venue_1', slug: 'mi-negocio', name: 'Mi Negocio' },
      kycStatus: 'NOT_SUBMITTED',
      emailSent: false,
    })

    await completeV2Onboarding(buildReq() as Request, buildRes() as Response, jest.fn() as NextFunction)

    // An unslugifiable empty name would throw — the last-resort placeholder lives here now.
    expect(venueCreationService.createVenueFromOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ businessInfo: expect.objectContaining({ name: 'Mi Negocio' }) }),
    )
  })
})

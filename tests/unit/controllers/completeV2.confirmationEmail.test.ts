/**
 * completeV2Onboarding — plan confirmation email + venue.language persistence
 *
 * Covers Task 5 (send confirmation email after PLAN_PRO subscription) and Task 11
 * (persist the wizard locale onto Venue.language) of the subscription-lifecycle-emails plan.
 *
 * Mocks every collaborator (services + prisma + email + resolver) so the controller
 * runs in isolation, mirroring the mock-first pattern in
 * tests/unit/controllers/onboarding/onboarding.controller.test.ts.
 */

import { Request, Response, NextFunction } from 'express'

// --- Mocks (declared before importing the controller) ---

jest.mock('../../../src/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  getV2SetupDataForCompletion: jest.fn(),
  parseV2Plan: jest.fn(),
}))

jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  createVenueFromOnboarding: jest.fn(),
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
  createPlanSubscription: jest.fn().mockResolvedValue({ subscriptionId: 'sub_123' }),
  getOrCreateStripeCustomer: jest.fn().mockResolvedValue('cus_123'),
}))

jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
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
import * as stripeService from '../../../src/services/stripe.service'
import * as venueCreationService from '../../../src/services/onboarding/venueCreation.service'
import { resolvePlanNotificationTarget } from '../../../src/services/access/planNotification.service'
import emailService from '../../../src/services/email.service'
import prisma from '../../../src/utils/prismaClient'

const VENUE = { id: 'venue_1', slug: 'bar-test', name: 'Bar Test' }

function buildReq(body: Record<string, any> = {}): Partial<Request> {
  return {
    params: { organizationId: 'org_1' },
    body,
    authContext: { userId: 'user_1', orgId: 'org_1', venueId: '', role: 'OWNER' },
  } as any
}

function buildRes(): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
}

/** Wire up the happy path: plan enabled, venue created fresh, email recipient resolved. */
function primeHappyPath(planOverrides: Record<string, any> = {}, targetOverrides: Record<string, any> = {}) {
  ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
    progress: { v2SetupData: {} },
    businessInfo: { businessName: 'Bar Test' },
    bankInfo: null,
    identityInfo: null,
    entityInfo: null,
  })
  ;(onboardingProgressService.parseV2Plan as jest.Mock).mockReturnValue({
    tier: 'PRO',
    paymentMethodId: 'pm_1',
    interval: 'monthly',
    payNow: false,
    acceptedAt: null,
    ...planOverrides,
  })
  ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null) // no provisional venue → create path
  ;(venueCreationService.createVenueFromOnboarding as jest.Mock).mockResolvedValue({
    venue: VENUE,
    kycStatus: 'NOT_SUBMITTED',
    emailSent: false,
  })
  ;(prisma.venue.update as jest.Mock).mockResolvedValue(VENUE)
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ ...VENUE, email: 'bar@test.com' })
  ;(prisma.organization.update as jest.Mock).mockResolvedValue({})
  ;(resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
    email: 'bar@test.com',
    locale: 'es',
    venueName: 'Bar Test',
    ownerName: null,
    ...targetOverrides,
  })
}

describe('completeV2Onboarding — plan confirmation email + venue.language', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_VENUE_BASE_SUBSCRIPTION

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'
  })

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_VENUE_BASE_SUBSCRIPTION
    else process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = ORIGINAL_FLAG
  })

  // ---------------------------------------------------------------------------
  // NEW FEATURE: confirmation email
  // ---------------------------------------------------------------------------

  it('sends the confirmation email with payNow/interval derived from planData (trial monthly)', async () => {
    primeHappyPath({ payNow: false, interval: 'monthly' })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledTimes(1)
    const [recipient, data] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(recipient).toBe('bar@test.com')
    expect(data).toMatchObject({
      locale: 'es',
      venueName: 'Bar Test',
      payNow: false,
      interval: 'monthly',
      firstChargeAmountCents: 115884, // monthly IVA-inclusive
    })
    // trial → no intro amount
    expect(data.introAmountCents).toBeUndefined()
    expect(data.billingPortalUrl).toContain('/dashboard/venues/bar-test/billing')
    expect(res.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('derives interval=annual + grossCents accordingly, no intro for annual', async () => {
    primeHappyPath({ payNow: true, interval: 'annual' })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'en' }) as Request, res as Response, next)

    const [, data] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(data).toMatchObject({ payNow: true, interval: 'annual', firstChargeAmountCents: 1158840 })
    expect(data.introAmountCents).toBeUndefined() // intro only for pay-now monthly
  })

  it('includes introAmountCents for pay-now monthly', async () => {
    primeHappyPath({ payNow: true, interval: 'monthly' })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    const [, data] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(data.introAmountCents).toBe(69484)
  })

  // ---------------------------------------------------------------------------
  // 4-tier plan step (2026-06): PREMIUM subscribes PLAN_PREMIUM, FREE skips the
  // base subscription entirely (no card, no email) and still completes.
  // ---------------------------------------------------------------------------

  it('PREMIUM: creates a PLAN_PREMIUM subscription, premium gross cents, no intro promo', async () => {
    primeHappyPath({ tier: 'PREMIUM', payNow: true, interval: 'monthly' })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(stripeService.createPlanSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ tierCode: 'PLAN_PREMIUM', coupon: undefined }),
    )
    const [, data] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(data).toMatchObject({ planName: 'Premium', firstChargeAmountCents: 197084 })
    expect(data.introAmountCents).toBeUndefined() // $599×3 intro is PRO-monthly only
    // venue planTier persisted as PREMIUM
    const planTierUpdate = (prisma.venue.update as jest.Mock).mock.calls.map(c => c[0]).find(u => u?.data?.planTier !== undefined)
    expect(planTierUpdate?.data.planTier).toBe('PREMIUM')
    expect(res.status).toHaveBeenCalledWith(201)
  })

  it('FREE: completes without a paymentMethodId, creates no subscription and sends no email', async () => {
    primeHappyPath({ tier: 'FREE', paymentMethodId: null, payNow: false })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
    const planTierUpdate = (prisma.venue.update as jest.Mock).mock.calls.map(c => c[0]).find(u => u?.data?.planTier !== undefined)
    expect(planTierUpdate).toBeUndefined() // FREE never writes planTier
    expect(res.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('PRO legacy payload (no tier from parse) still gates: paid tier without card rejects', async () => {
    primeHappyPath({ tier: 'PRO', paymentMethodId: null })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('método de pago') }))
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
  })

  it('skips the email (logger.warn) when no recipient, without throwing', async () => {
    primeHappyPath({}, { email: null })
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
    // onboarding still completes
    expect(res.status).toHaveBeenCalledWith(201)
    expect(next).not.toHaveBeenCalled()
  })

  it('does NOT reject completeV2 when the email send throws (caught, non-blocking)', async () => {
    primeHappyPath()
    ;(emailService.sendPlanConfirmationEmail as jest.Mock).mockRejectedValueOnce(new Error('Resend down'))
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    // completion is unaffected by the email failure
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, venue: VENUE }))
    expect(next).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // NEW FEATURE: venue.language persistence (Task 11)
  // ---------------------------------------------------------------------------

  it('persists venue.language from req.body.language (en)', async () => {
    primeHappyPath()
    const next: NextFunction = jest.fn()

    await completeV2Onboarding(buildReq({ language: 'en' }) as Request, buildRes() as Response, next)

    const updateCalls = (prisma.venue.update as jest.Mock).mock.calls.map(c => c[0])
    const languageUpdate = updateCalls.find(u => u?.data?.language !== undefined)
    expect(languageUpdate).toBeDefined()
    expect(languageUpdate.where).toEqual({ id: 'venue_1' })
    expect(languageUpdate.data.language).toBe('en')
  })

  it('defaults venue.language to es when body.language is omitted', async () => {
    primeHappyPath()
    const next: NextFunction = jest.fn()

    await completeV2Onboarding(buildReq({}) as Request, buildRes() as Response, next)

    const updateCalls = (prisma.venue.update as jest.Mock).mock.calls.map(c => c[0])
    const languageUpdate = updateCalls.find(u => u?.data?.language !== undefined)
    expect(languageUpdate?.data.language).toBe('es')
  })

  it('defaults venue.language to es for an unexpected body.language value', async () => {
    primeHappyPath()
    const next: NextFunction = jest.fn()

    await completeV2Onboarding(buildReq({ language: 'fr' }) as Request, buildRes() as Response, next)

    const updateCalls = (prisma.venue.update as jest.Mock).mock.calls.map(c => c[0])
    const languageUpdate = updateCalls.find(u => u?.data?.language !== undefined)
    expect(languageUpdate?.data.language).toBe('es')
  })

  // ---------------------------------------------------------------------------
  // REGRESSION: existing behavior unaffected
  // ---------------------------------------------------------------------------

  it('does not send the confirmation email when the plan feature is disabled', async () => {
    process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'false'
    primeHappyPath()
    // with the flag off, parseV2Plan still returns data but the plan block is skipped
    const next: NextFunction = jest.fn()
    const res = buildRes()

    await completeV2Onboarding(buildReq({ language: 'es' }) as Request, res as Response, next)

    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
    // language is still persisted, completion still succeeds
    expect(res.status).toHaveBeenCalledWith(201)
  })
})

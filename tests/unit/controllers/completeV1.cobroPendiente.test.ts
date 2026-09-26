/**
 * 🔴 Codex R13: el carril VIEJO de finalización (`POST /organizations/:org/complete`) no cobra ni recupera nada en
 * Stripe. Si el alta V2 dejó un cobro de plan sin cerrar, terminar por aquí fijaba `completedAt` y `activate-plan` ya
 * no podía recuperarlo: el negocio quedaba cobrado y sin acceso.
 */
import { Request, Response, NextFunction } from 'express'

jest.mock('../../../src/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  getOnboardingProgress: jest.fn(),
}))
jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({ __esModule: true, createVenueFromOnboarding: jest.fn() }))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({ __esModule: true, ensureVenueForOnboarding: jest.fn() }))
jest.mock('../../../src/services/onboarding/signup.service', () => ({ __esModule: true }))
jest.mock('../../../src/services/onboarding/testPaymentLink.service', () => ({ __esModule: true }))
jest.mock('../../../src/services/stripe.service', () => ({ __esModule: true }))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { onboardingProgress: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, venue: { findFirst: jest.fn() } },
}))

import { completeOnboarding } from '../../../src/controllers/onboarding.controller'
import * as onboardingProgressService from '../../../src/services/onboarding/onboardingProgress.service'
import prisma from '../../../src/utils/prismaClient'

const req = {
  params: { organizationId: 'org_1' },
  body: {},
  authContext: { userId: 'user_1', orgId: 'org_1', venueId: '', role: 'OWNER' },
} as unknown as Request
const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response

function progreso(extra: Record<string, unknown>) {
  ;(onboardingProgressService.getOnboardingProgress as jest.Mock).mockResolvedValue({
    step2_onboardingType: { type: 'MANUAL' },
    step3_businessInfo: { name: 'Bar' },
    planActivationStatus: 'NONE',
    planActivationAttempt: 1,
    planStripeSubscriptionId: null,
    ...extra,
  })
}

describe('completeOnboarding (V1) con un cobro del alta sin cerrar', () => {
  afterEach(() => jest.restoreAllMocks())

  it('🔴 cobro abierto: 409 PLAN_CHARGE_PENDING y NO se toma el lock', async () => {
    progreso({ planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: 'sub_1' })
    const next = jest.fn() as unknown as NextFunction

    await completeOnboarding(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'PLAN_CHARGE_PENDING' }))
    expect(prisma.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('sin cobro abierto sigue su camino (toma el lock)', async () => {
    progreso({})
    const next = jest.fn() as unknown as NextFunction

    await completeOnboarding(req, res, next)

    expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'PLAN_CHARGE_PENDING' }))
    expect(prisma.onboardingProgress.updateMany).toHaveBeenCalled()
  })
})

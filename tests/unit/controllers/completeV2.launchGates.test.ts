/**
 * S7 y S9 — los candados nuevos de la finalización y las dos fugas del carril legacy
 * (spec 2026-09-17 § 3.7).
 *
 * 🔴 Las cuatro cosas que se guardan aquí, y tres son de dinero:
 *   1. sin consentimiento NO se termina el alta (y NO se toma el lock);
 *   2. con un cobro EN CURSO se responde 409 en vez de cobrar en paralelo;
 *   3. si `activate-plan` ya cobró, el carril legacy NO vuelve a cobrar ni a mandar correo;
 *   4. pagando hoy, el carril legacy manda `error_if_incomplete` — sin él una tarjeta
 *      rechazada deja `VenueFeature.active = true` —, y su correo dice la renovación REAL.
 *
 * El andamiaje de mocks es el mismo de `completeV2.confirmationEmail.test.ts`.
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
import AppError from '../../../src/errors/AppError'

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
    // El alta sólo se puede terminar con el consentimiento firmado (spec 2026-09-17 § 3.7),
    // así que la base de estas pruebas —que miden el CORREO, no el candado legal— lo trae puesto.
    // El candado tiene sus propias pruebas en `completeV2.launchGates.test.ts`.
    progress: { v2SetupData: {}, termsAcceptedAt: new Date('2026-09-17T00:00:00Z'), planActivationStatus: 'NONE' },
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

describe('completeV2Onboarding — candados del lanzamiento (S7) y fugas del legacy (S9)', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_VENUE_BASE_SUBSCRIPTION

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'
  })

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_VENUE_BASE_SUBSCRIPTION
    else process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = ORIGINAL_FLAG
  })

  function conProgreso(progressOverrides: Record<string, any>, planOverrides: Record<string, any> = {}) {
    primeHappyPath(planOverrides)
    ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
      progress: { v2SetupData: {}, termsAcceptedAt: new Date('2026-09-17T00:00:00Z'), planActivationStatus: 'NONE', ...progressOverrides },
      businessInfo: { businessName: 'Bar Test' },
      bankInfo: null,
      identityInfo: null,
      entityInfo: null,
    })
  }

  async function correr(body: Record<string, any> = {}) {
    const next = jest.fn() as unknown as NextFunction
    await completeV2Onboarding(buildReq(body) as Request, buildRes() as Response, next)
    return next as unknown as jest.Mock
  }

  it('🔴 sin consentimiento: 400 TERMS_NOT_ACCEPTED y NO se toma el lock', async () => {
    conProgreso({ termsAcceptedAt: null })

    const next = await correr()

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, code: 'TERMS_NOT_ACCEPTED' }))
    // La afirmación que de verdad importa: rechazar DESPUÉS del lock dejaría el alta marcada
    // como completada y sin local, que es el estado del que nadie sale solo.
    expect(prisma.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(venueCreationService.createVenueFromOnboarding).not.toHaveBeenCalled()
  })

  it('🔴 con un cobro EN CURSO: 409 y tampoco se toma el lock', async () => {
    conProgreso({ planActivationStatus: 'IN_PROGRESS' })

    const next = await correr()

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'PLAN_ACTIVATION_IN_PROGRESS' }))
    expect(prisma.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
  })

  it('🔴 si activate-plan YA cobró: el local se crea pero NO se cobra otra vez ni se manda correo', async () => {
    conProgreso({ planActivationStatus: 'ACTIVE' }, { payNow: true })

    await correr()

    expect(venueCreationService.createVenueFromOnboarding).toHaveBeenCalled()
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
  })

  it('un alta vieja (estado NONE) conserva el carril legacy intacto', async () => {
    conProgreso({ planActivationStatus: 'NONE' }, { payNow: true })

    await correr()

    expect(stripeService.createPlanSubscription).toHaveBeenCalledTimes(1)
    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledTimes(1)
  })

  it('🔴 S9(a): pagando hoy, el legacy manda error_if_incomplete', async () => {
    conProgreso({}, { payNow: true, interval: 'monthly' })

    await correr()

    expect(stripeService.createPlanSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ paymentBehavior: 'error_if_incomplete', trialPeriodDays: 0, coupon: 'INTRO_PRO_3M' }),
    )
  })

  it('con prueba gratis NO se manda error_if_incomplete (no hay primer cobro que pueda fallar)', async () => {
    conProgreso({}, { payNow: false })

    await correr()

    const arg = (stripeService.createPlanSubscription as jest.Mock).mock.calls[0][0]
    expect(arg.paymentBehavior).toBeUndefined()
    expect(arg.trialPeriodDays).toBe(30)
  })

  it('🔴 S9(b): con INTRO_PRO_3M el correo legacy dice $694.84 de próxima renovación, no $1,158.84', async () => {
    conProgreso({}, { payNow: true, interval: 'monthly' })

    await correr()

    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledWith(
      'bar@test.com',
      expect.objectContaining({ introAmountCents: 69484, nextChargeAmountCents: 69484, firstChargeAmountCents: 115884 }),
    )
  })

  it('sin promoción legacy, la próxima renovación es el precio de lista', async () => {
    conProgreso({}, { payNow: true, interval: 'annual' })

    await correr()

    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledWith(
      'bar@test.com',
      expect.objectContaining({ introAmountCents: undefined, nextChargeAmountCents: 1158840 }),
    )
  })

  it('🔴 si el negocio desaparece mientras se crea su cliente de Stripe: 404, se suelta la marca y NO se da el alta por terminada', async () => {
    // R0 ronda 5 (Codex): `getOrCreateStripeCustomer` ya no devuelve un cliente huérfano, pero este
    // `catch` se tragaba su 404 y respondía 201 con un negocio borrado.
    conProgreso({}, { payNow: true })
    ;(stripeService.getOrCreateStripeCustomer as jest.Mock).mockRejectedValueOnce(
      new AppError('El negocio venue_1 ya no existe.', 404, true, 'VENUE_NOT_FOUND'),
    )
    const res = buildRes()
    const next = jest.fn() as unknown as NextFunction

    await completeV2Onboarding(buildReq() as Request, res as Response, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, code: 'VENUE_NOT_FOUND' }))
    expect(res.status).not.toHaveBeenCalledWith(201)
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(prisma.organization.update).not.toHaveBeenCalled()
    expect(prisma.onboardingProgress.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org_1' }), data: { completedAt: null } }),
    )
  })

  it('un tropiezo de Stripe cualquiera sigue sin bloquear el alta (el negocio existe)', async () => {
    conProgreso({}, { payNow: true })
    ;(stripeService.getOrCreateStripeCustomer as jest.Mock).mockRejectedValueOnce(new Error('socket hang up'))
    const res = buildRes()

    await completeV2Onboarding(buildReq() as Request, res as Response, jest.fn() as unknown as NextFunction)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(prisma.organization.update).toHaveBeenCalled()
  })
})

/**
 * Al terminar el alta, la sesión se reemite con la sucursal REAL (monitor de producción, 19-oct).
 *
 * El alta emite el token del panel con `venueId = 'pending'` (signup.service.ts) y la cookie dura 24 h. Terminar
 * el alta creaba la sucursal pero NO reemitía la cookie: todo lo que toma la sucursal sólo del token
 * (`/dashboard/tokens/status`, `/google-calendar/oauth/init`…) contestaba 500 durante un día entero. FriedBros
 * (cliente real) se llevó 5×500 en su primera hora.
 *
 * La regla: terminar el alta (V2 y V1, también la respuesta «ya estaba terminada») reemite la sesión EXACTAMENTE
 * como el cambio de sucursal: `switchVenueForStaff` (misma verificación de acceso, mismos tokens) y las mismas
 * cookies. Nunca bloquea el alta, y nunca se hace a nombre de alguien a quien un superadmin está suplantando.
 */

import { Request, Response, NextFunction } from 'express'

jest.mock('../../../../src/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  getV2SetupDataForCompletion: jest.fn(),
  parseV2Plan: jest.fn(),
  getOnboardingProgress: jest.fn(),
}))

jest.mock('../../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  createVenueFromOnboarding: jest.fn(),
  applyBusinessInfoToVenue: jest.fn(),
}))

jest.mock('../../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn(),
}))

jest.mock('../../../../src/services/onboarding/signup.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/onboarding/testPaymentLink.service', () => ({ __esModule: true }))

jest.mock('../../../../src/services/stripe.service', () => ({
  __esModule: true,
  createOnboardingSetupIntent: jest.fn(),
  createPlanSetupIntent: jest.fn(),
  createPlanSubscription: jest.fn(),
  getOrCreateStripeCustomer: jest.fn(),
}))

jest.mock('../../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue(null),
}))

jest.mock('../../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn() },
}))

// La pieza que se reusa del cambio de sucursal: verifica el acceso y emite los tokens.
jest.mock('../../../../src/services/dashboard/auth.service', () => ({
  __esModule: true,
  switchVenueForStaff: jest.fn(),
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    hybridPurchase: { findFirst: jest.fn().mockResolvedValue(null) },
    onboardingProgress: { updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    venue: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    organization: { update: jest.fn() },
  },
}))

import { completeOnboarding, completeV2Onboarding } from '../../../../src/controllers/onboarding.controller'
import * as onboardingProgressService from '../../../../src/services/onboarding/onboardingProgress.service'
import * as venueCreationService from '../../../../src/services/onboarding/venueCreation.service'
import * as authService from '../../../../src/services/dashboard/auth.service'
import prisma from '../../../../src/utils/prismaClient'

const VENUE = { id: 'venue_real', slug: 'friedbros', name: 'FriedBros', status: 'ACTIVE' }

const buildReq = (authContext: Record<string, unknown> = {}): Partial<Request> =>
  ({
    params: { organizationId: 'org_1' },
    body: {},
    authContext: { userId: 'user_1', orgId: 'org_1', venueId: 'pending', role: 'OWNER', ...authContext },
  }) as any

const buildRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  cookie: jest.fn().mockReturnThis(),
})

const cookie = (res: ReturnType<typeof buildRes>, name: string) => res.cookie.mock.calls.find(c => c[0] === name)

const DIA_MS = 24 * 60 * 60 * 1000

describe('terminar el alta reemite la sesión con la sucursal real', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_VENUE_BASE_SUBSCRIPTION

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async fn => fn(prisma))
    process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'false' // sin cobro: esta suite mide la sesión
    ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
      progress: { v2SetupData: {}, termsAcceptedAt: new Date('2026-10-18T00:00:00Z'), planActivationStatus: 'NONE' },
      businessInfo: { name: 'FriedBros' },
      bankInfo: null,
      identityInfo: null,
      entityInfo: null,
    })
    ;(onboardingProgressService.parseV2Plan as jest.Mock).mockReturnValue(null)
    ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null) // camino que crea la sucursal
    ;(prisma.venue.update as jest.Mock).mockResolvedValue(VENUE)
    ;(venueCreationService.createVenueFromOnboarding as jest.Mock).mockResolvedValue({
      venue: VENUE,
      kycStatus: 'NOT_SUBMITTED',
      emailSent: false,
      categoriesCreated: 0,
      productsCreated: 0,
      demoDataSeeded: false,
    })
    ;(authService.switchVenueForStaff as jest.Mock).mockResolvedValue({ accessToken: 'access-real', refreshToken: 'refresh-real' })
  })

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_VENUE_BASE_SUBSCRIPTION
    else process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = ORIGINAL_FLAG
  })

  it('V2: pone la cookie nueva con la sucursal creada, igual que el cambio de sucursal', async () => {
    const res = buildRes()
    const next = jest.fn()
    await completeV2Onboarding(buildReq() as Request, res as unknown as Response, next as NextFunction)

    expect(next).not.toHaveBeenCalled()
    // La verificación de acceso y los tokens son los del cambio de sucursal, con la sucursal REAL.
    expect(authService.switchVenueForStaff).toHaveBeenCalledWith('user_1', 'org_1', 'venue_real')
    expect(cookie(res, 'accessToken')).toEqual([
      'accessToken',
      'access-real',
      expect.objectContaining({ httpOnly: true, path: '/', maxAge: DIA_MS }),
    ])
    expect(cookie(res, 'refreshToken')).toEqual([
      'refreshToken',
      'refresh-real',
      expect.objectContaining({ httpOnly: true, path: '/', maxAge: 7 * DIA_MS }),
    ])
    // La respuesta no cambia (sólo se agregan cookies).
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, venue: VENUE }))
  })

  it('V2 «ya estaba terminada» (reintento): también reemite con la sucursal existente', async () => {
    ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
      completedAt: new Date(),
      organization: { onboardingCompletedAt: new Date() },
    })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(VENUE)

    const res = buildRes()
    await completeV2Onboarding(buildReq() as Request, res as unknown as Response, jest.fn() as NextFunction)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(authService.switchVenueForStaff).toHaveBeenCalledWith('user_1', 'org_1', 'venue_real')
    expect(cookie(res, 'accessToken')?.[1]).toBe('access-real')
  })

  it('V1 (asistente largo): también reemite con la sucursal creada', async () => {
    ;(onboardingProgressService.getOnboardingProgress as jest.Mock).mockResolvedValue({
      step2_onboardingType: 'REAL',
      step3_businessInfo: { name: 'FriedBros' },
      planActivationStatus: 'NONE',
    })

    const res = buildRes()
    const next = jest.fn()
    await completeOnboarding(buildReq() as Request, res as unknown as Response, next as NextFunction)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(authService.switchVenueForStaff).toHaveBeenCalledWith('user_1', 'org_1', 'venue_real')
    expect(cookie(res, 'accessToken')?.[1]).toBe('access-real')
  })

  it('si reemitir falla (p. ej. sin acceso), el alta termina igual y no se toca la cookie', async () => {
    ;(authService.switchVenueForStaff as jest.Mock).mockRejectedValue(new Error('No tienes acceso a este establecimiento'))

    const res = buildRes()
    const next = jest.fn()
    await completeV2Onboarding(buildReq() as Request, res as unknown as Response, next as NextFunction)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.cookie).not.toHaveBeenCalled()
  })

  it('suplantando (superadmin): NO se emite una sesión normal a nombre de la persona suplantada', async () => {
    const res = buildRes()
    await completeV2Onboarding(buildReq({ isImpersonating: true }) as Request, res as unknown as Response, jest.fn() as NextFunction)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(authService.switchVenueForStaff).not.toHaveBeenCalled()
    expect(res.cookie).not.toHaveBeenCalled()
  })
})

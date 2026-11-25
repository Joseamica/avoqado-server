/*
  Planes editables B2, Task 3: POST /api/v1/onboarding/organizations/:organizationId/v2/complete con una versión del editor.

  🔴 Lo que fija:
  - con una versión del editor, el carril viejo del alta larga (plan de pago con tarjeta, sin campaña y sin cobro previo) responde
    409 PLAN_FLOW_RETIRED ANTES del candado optimista: no marca `completedAt`, no crea cliente ni suscripción en Stripe;
  - sin versión del editor ese carril cobra como hoy (mismas llamadas);
  - un plan ya cobrado por `activate-plan` termina el alta como hoy, y un alta ACTIVE sin tarjeta no cae en el 400 «Falta el método de pago».
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

const mockSubCreate = jest.fn()
const mockCustomersCreate = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: jest.fn(), list: jest.fn() },
    prices: { list: mockPriceList, retrieve: jest.fn() },
    customers: { create: mockCustomersCreate, retrieve: jest.fn(), update: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })),
)
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
const mockAutorizar = jest.fn()
jest.mock('../../../src/services/access/autorizarObligacionNueva', () => ({
  ...jest.requireActual('../../../src/services/access/autorizarObligacionNueva'),
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
const mockEntregar = jest.fn()
jest.mock('../../../src/services/stripe.service', () => ({
  ...jest.requireActual('../../../src/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
  getOrCreateStripeCustomer: (...a: unknown[]) => mockCustomersCreate(...a),
  retrievePlanSubscription: jest.fn().mockResolvedValue({ status: 'trialing', currentPeriodEnd: null, cancelAtPeriodEnd: false }),
  modalidadDeLaSuscripcion: jest.fn().mockResolvedValue({}),
}))
const mockTerminar = jest.fn()
jest.mock('../../../src/services/onboarding/terminarAltaCobrada', () => ({
  ...jest.requireActual('../../../src/services/onboarding/terminarAltaCobrada'),
  terminarAltaCobrada: (...a: unknown[]) => mockTerminar(...a),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/onboarding/sesionTrasElAlta', () => ({
  __esModule: true,
  renovarSesionConLaSucursal: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  applyBusinessInfoToVenue: jest.fn().mockResolvedValue(undefined),
  createVenueFromOnboarding: jest.fn(),
}))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue(null),
}))
jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true), sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const ORG = 'clorgplanoferta0000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/v2/complete`

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const terminar = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send({})

const PLAN_CON_TARJETA = { tier: 'PRO', paymentMethodId: 'pm_1', interval: 'monthly', payNow: false, acceptedAt: '2026-11-20T00:00:00Z' }

const progreso = (plan: object, extra: object = {}) => ({
  id: 'op-1',
  organizationId: ORG,
  completedAt: null,
  wizardVersion: 2,
  v2SetupData: { step2: { businessName: 'Negocio de prueba' }, plan },
  launchCampaignId: null,
  termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
  planActivationStatus: 'NONE',
  planActivationAttempt: 0,
  planActivationLeaseUntil: null,
  planStripeSubscriptionId: null,
  ...extra,
})

const v2 = () => definicionDePrueba({ ids: idsDeLaVersion('v2') })

/** Una llamada a `onboardingProgress.updateMany` que marca `completedAt` (el candado optimista). */
const marcoCompletedAt = () =>
  prismaMock.onboardingProgress.updateMany.mock.calls.some((c: unknown[]) => {
    const data = (c[0] as { data?: { completedAt?: unknown } }).data
    return data?.completedAt instanceof Date
  })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.onboardingProgress.update.mockResolvedValue({} as never)
  prismaMock.venue.findFirst.mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', name: 'Negocio', status: 'ONBOARDING' } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    timezone: 'America/Mexico_City',
  } as never)
  prismaMock.venue.update.mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', name: 'Negocio', status: 'ACTIVE' } as never)
  mockCustomersCreate.mockReset().mockResolvedValue('cus_1')
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1' })
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: 115884 }] })
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  mockEntregar
    .mockReset()
    .mockResolvedValue({ venueId: 'venue-1', featureId: 'feat-pro', featureCode: 'PLAN_PRO', subscriptionId: 'sub_1' })
  mockTerminar.mockReset().mockResolvedValue({ estado: 'TERMINADA', venue: { id: 'venue-1', slug: 'negocio-de-prueba' } })
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
})

describe('POST /onboarding/organizations/:organizationId/v2/complete — el alta larga con una versión del editor', () => {
  it('🔴 con la v2 y un plan del alta larga (Pro con tarjeta, sin cobro previo) → 409 PLAN_FLOW_RETIRED; completedAt sigue null y ni cliente ni suscripción en Stripe', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)

    const res = await terminar()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_FLOW_RETIRED')
    expect(res.body.message).toBe(
      'Esta forma de contratar ya no está disponible. Recarga la página para elegir tu plan. No se te cobró nada.',
    )
    expect(marcoCompletedAt()).toBe(false)
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockCustomersCreate).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })

  it('sin versión del editor el carril viejo cobra como hoy (mismas llamadas)', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)

    const res = await terminar()

    expect(res.status).toBe(201)
    expect(marcoCompletedAt()).toBe(true)
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1)
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][0].items).toEqual([{ price: 'price_key_pro_m' }])
  })

  it('con la v2 y el plan ya cobrado por activate-plan (ACTIVE) → termina el alta como hoy', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso(PLAN_CON_TARJETA, { planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' }) as never,
    )

    const res = await terminar()

    expect(res.status).toBe(201)
    expect(mockTerminar).toHaveBeenCalledTimes(1)
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 alta ACTIVE sin tarjeta (plan raíz sinTarjeta) → termina el alta, sin el 400 «Falta el método de pago»; un plan de pago sin tarjeta y sin alta ACTIVE → el 400 de hoy', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    const SIN_TARJETA = { ...PLAN_CON_TARJETA, paymentMethodId: null, sinTarjeta: true }
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso(SIN_TARJETA, { planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' }) as never,
    )
    const activa = await terminar()
    expect(activa.status).toBe(201)
    expect(mockTerminar).toHaveBeenCalledTimes(1)

    // El mismo plan sin que el alta esté ACTIVE: el 400 de hoy.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(SIN_TARJETA) as never)
    const sinAlta = await terminar()
    expect(sinAlta.status).toBe(400)
    expect(sinAlta.body.message).toContain('Falta el método de pago del plan')

    // Un plan de pago sin tarjeta y sin la marca, aunque el alta esté ACTIVE: también el de hoy.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso(
        { ...PLAN_CON_TARJETA, paymentMethodId: null },
        { planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' },
      ) as never,
    )
    const sinMarca = await terminar()
    expect(sinMarca.status).toBe(400)
  })
})

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
const mockPriceRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: jest.fn(), list: jest.fn() },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
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
  // La modalidad sale de UNA lectura acotada (B2 Task 6, fix round 1): una suscripción activa no tiene modalidad de prueba.
  suscripcionConTopeCorto: jest.fn().mockResolvedValue({ id: 'sub_x', status: 'active', metadata: {} }),
}))
const mockHayCobro = jest.fn()
jest.mock('../../../src/services/onboarding/planActivation.service', () => ({
  ...jest.requireActual('../../../src/services/onboarding/planActivation.service'),
  hayCobroDelAltaSinCerrar: (...a: unknown[]) => mockHayCobro(...a),
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
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import { renovarSesionConLaSucursal } from '../../../src/services/onboarding/sesionTrasElAlta'
import AppError from '../../../src/errors/AppError'
import { Prisma } from '@prisma/client'

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
  mockHayCobro.mockReset().mockResolvedValue(false)
  mockCustomersCreate.mockReset().mockResolvedValue('cus_1')
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1' })
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: 115884 }] })
  mockPriceRetrieve.mockReset()
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

  it('🔴 con la v2 y un intento anterior IN_PROGRESS con cobro posible → PLAN_CHARGE_PENDING (no «No se te cobró nada»); sin cobro posible → PLAN_FLOW_RETIRED', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA, { planActivationStatus: 'IN_PROGRESS' }) as never)

    mockHayCobro.mockResolvedValue(true)
    const pendiente = await terminar()
    expect(pendiente.status).toBe(409)
    expect(pendiente.body.code).toBe('PLAN_CHARGE_PENDING')
    expect(mockHayCobro).toHaveBeenCalledTimes(1)
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()

    mockHayCobro.mockResolvedValue(false)
    const retirado = await terminar()
    expect(retirado.status).toBe(409)
    expect(retirado.body.code).toBe('PLAN_FLOW_RETIRED')
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('con la v2 y una campaña reclamada, o con el plan FREE: no sale PLAN_FLOW_RETIRED', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA, { launchCampaignId: 'camp_1' }) as never)
    const conCampana = await terminar()
    expect(conCampana.body.code).not.toBe('PLAN_FLOW_RETIRED')

    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso({ tier: 'FREE', acceptedAt: '2026-11-20T00:00:00Z' }) as never)
    const gratis = await terminar()
    expect(gratis.body.code).not.toBe('PLAN_FLOW_RETIRED')
    expect(gratis.status).toBe(201)
  })

  it('🔴 Codex b2-code #1: la compuerta no ve versión del editor y la v2 se publica antes de resolver el precio → 409 OFFER_CHANGED reason VERSION, sin cobrar en Stripe ni abrir sesión; completedAt se suelta', async () => {
    // La 1.ª lectura (la compuerta, antes del candado) no ve versión; la relectura del precio, dentro del carril, ya ve la v2.
    prismaMock.planOfferPointer.findUnique.mockResolvedValueOnce(null).mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 115884 })
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)

    const res = await terminar()

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'VERSION', offerVersion: 2 },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()
    expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
    // El candado temprano se suelta: el siguiente intento entra por la compuerta (ahora con la v2: PLAN_FLOW_RETIRED).
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenLastCalledWith({
      where: { organizationId: ORG, completedAt: { not: null } },
      data: { completedAt: null },
    })
  })

  it('🔴 Codex b2-code r4 #10: sin cobro anterior, la compuerta lee la v1 y la relectura dentro de la regla común no puede leer la oferta → 503 PLAN_NOT_CONFIGURED que se puede reintentar: completedAt se suelta, sin sesión y sin cobrar (nunca 201 en Gratis sin el plan elegido)', async () => {
    prismaMock.planOfferPointer.findUnique
      .mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
      .mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, roto: true }) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)

    const res = await terminar()

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()
    expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenLastCalledWith({
      where: { organizationId: ORG, completedAt: { not: null } },
      data: { completedAt: null },
    })
  })

  it('🔴 Codex b2-code r5 A: sin cobro anterior, la compuerta lee la v1 y la relectura dentro de la regla común lanza un error crudo de la base (Prisma o de conexión) → el mismo 503 PLAN_NOT_CONFIGURED reintentable: completedAt se suelta, sin sesión y sin cobrar', async () => {
    for (const caida of [
      new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: '6.19.3' }),
      new Error("Can't reach database server at `localhost:5432`"),
    ]) {
      jest.clearAllMocks()
      prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
      prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
      prismaMock.planOfferPointer.findUnique
        .mockReset()
        .mockResolvedValueOnce(punteroA('cv1', 1, versionUno()) as never)
        .mockRejectedValue(caida)
      prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)

      const res = await terminar()

      expect(res.status).toBe(503)
      expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
      expect(mockAutorizar).toHaveBeenCalledTimes(1)
      expect(mockSubCreate).not.toHaveBeenCalled()
      expect(mockEntregar).not.toHaveBeenCalled()
      expect(renovarSesionConLaSucursal).not.toHaveBeenCalled()
      expect(prismaMock.onboardingProgress.updateMany).toHaveBeenLastCalledWith({
        where: { organizationId: ORG, completedAt: { not: null } },
        data: { completedAt: null },
      })
    }
  })

  it('Codex b2-code r4 #10, la guarda de la salida: sin versiones y sin precio de Stripe para la llave (B0), el alta larga termina como hoy en Gratis (201), sin cobrar', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)
    mockPriceList.mockResolvedValue({ data: [] })

    const res = await terminar()

    expect(res.status).toBe(201)
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(renovarSesionConLaSucursal).toHaveBeenCalled()
  })

  it('con sólo la v1 el carril viejo cobra como hoy', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)
    const res = await terminar()
    expect(res.status).toBe(201)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('🔴 Codex b2-code r3 R3-3: con una v1 dañada y un cobro anterior sin cerrar (IN_PROGRESS con su suscripción viva), el reintento sigue el camino de hoy: la regla común ve el plan cobrando, se entrega y el alta termina (201), sin el 503 «No se cobró nada»', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, roto: true }) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso(PLAN_CON_TARJETA, {
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 0,
        planStripeSubscriptionId: 'sub_1',
      }) as never,
    )
    mockHayCobro.mockResolvedValue(true)
    // La regla común (simulada en su borde) ve que el negocio YA tiene su plan cobrando.
    mockAutorizar.mockRejectedValue(
      Object.assign(new AppError('Este negocio ya tiene un plan que Stripe sigue cobrando.', 409, true, 'PLAN_YA_CONTRATADO'), {
        suscripciones: ['sub_1'],
      }),
    )

    const res = await terminar()

    expect(res.status).toBe(201)
    expect(res.body.code).toBeUndefined()
    expect(mockHayCobro).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, planStripeSubscriptionId: 'sub_1' }))
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_1' }))
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' }) }),
    )
  })

  it('Codex b2-code r3 R3-3: con una v1 dañada y SIN cobro anterior (IN_PROGRESS sin cobro posible), el 503 PLAN_NOT_CONFIGURED de T3-3, sin candado ni Stripe', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, roto: true }) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA, { planActivationStatus: 'IN_PROGRESS' }) as never)
    mockHayCobro.mockResolvedValue(false)

    const res = await terminar()

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 una v1 rota hace lanzar a versionQueCobra en el carril que cobra → 503 PLAN_NOT_CONFIGURED, sin updateMany ni Stripe', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, roto: true }) as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(PLAN_CON_TARJETA) as never)
    const res = await terminar()
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockCustomersCreate).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

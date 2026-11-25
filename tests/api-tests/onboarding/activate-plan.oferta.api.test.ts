/*
  Planes editables B1, Task 2: el precio con el que el alta cobra el plan, por la ruta real.

  POST /api/v1/onboarding/organizations/:organizationId/v2/activate-plan
    { tier: 'PRO', interval: 'annual', payNow: true, paymentMethodId: 'pm_1',
      offer: { kind: 'STANDARD', expectedFirstChargeCents: 1158840 } }

  🔴 Lo que fija:
  - sin versiones y con sólo la v1 sembrada se cobra el precio de la LLAVE, como B0 (aunque la llave se haya movido y la
    foto de la v1 esté archivada), con los mismos códigos de error de hoy: la llave sin precio es 409 PLAN_PRICE_MISMATCH,
    no el 503 del resolver;
  - con una versión del editor (v2) se cobra su priceId, y un precio suyo que ya no sirve es ese mismo 409, sin cobrar.

  Arranca el Express real: authenticateToken → requireOnboardingOrgOwner → validateRequest → controlador → servicio.
  Stripe y la regla común de compra (`autorizarObligacionNueva`, que corre su callback) se simulan como en
  `planActivation.service.test.ts`, igual que la entrega del acceso y los avisos.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
// La ruta sólo existe con el plan obligatorio encendido; se lee al cargar las rutas, así que va ANTES de `src/app`.
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: jest.fn() },
    invoices: { list: jest.fn(), voidInvoice: jest.fn() },
    invoicePayments: { list: jest.fn() },
    creditNotes: { list: jest.fn() },
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
}))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', status: 'ONBOARDING' }),
}))
jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('../../../src/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const ORG = 'clorgplanoferta0000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/v2/activate-plan`
const CUERPO = {
  tier: 'PRO',
  interval: 'annual',
  payNow: true,
  paymentMethodId: 'pm_1',
  offer: { kind: 'STANDARD', expectedFirstChargeCents: 1158840 },
}

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

const pedir = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send(CUERPO)

/** El precio con el que se creó la suscripción. */
const itemsCobrados = () => mockSubCreate.mock.calls[0][0].items

beforeEach(() => {
  jest.clearAllMocks()
  // Dueño de la organización (el guardia del alta lo pregunta así).
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-pro',
    featureCode: 'PLAN_PRO',
    subscriptionId,
    endDate: null,
  }))
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset()
  mockPmRetrieve.mockReset().mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1' })
  mockSubList.mockReset()
  mockSubRetrieve.mockReset().mockResolvedValue({
    id: 'sub_1',
    status: 'active',
    current_period_end: Math.floor(new Date('2027-11-25T00:00:00Z').getTime() / 1000),
    latest_invoice: { amount_paid: 1158840 },
    discounts: [],
  })
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.onboardingProgress.findUnique.mockResolvedValue({
    id: 'op-1',
    organizationId: ORG,
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: null,
    termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
    planActivationStatus: 'NONE',
    planActivationAttempt: 0,
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: null,
  } as never)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  // `createPlanSubscription` es el REAL (sólo Stripe está simulado): necesita su Feature y su VenueFeature.
  prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
})

describe('POST /onboarding/organizations/:organizationId/v2/activate-plan — el precio que se cobra', () => {
  it('con la v2 vigente cobra con su priceId anual', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_a', active: true, unit_amount: 1158840 })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', alreadyActive: false })
    expect(itemsCobrados()).toEqual([{ price: 'price_v2_pro_a' }])
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('sin versiones cobra con el precio de la llave, igual que B0', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_a', unit_amount: 1158840 }] })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(itemsCobrados()).toEqual([{ price: 'price_key_pro_a' }])
    // El PASO 4 y la relectura antes de cobrar, las dos por la llave.
    expect(mockPriceList).toHaveBeenCalledTimes(2)
    expect(mockPriceList.mock.calls.map(c => c[0])).toEqual([
      { lookup_keys: ['plan_pro_annual'], limit: 1 },
      { lookup_keys: ['plan_pro_annual'], limit: 1 },
    ])
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 con sólo la v1 y la llave movida a price_llave_b (la foto archivada) cobra price_llave_b, como B0', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_llave_b', unit_amount: 1158840 }] })
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v1_pro_a', active: false, unit_amount: 1158840 })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(itemsCobrados()).toEqual([{ price: 'price_llave_b' }])
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 tablas vacías y la llave sin precio en Stripe → 409 PLAN_PRICE_MISMATCH, como hoy (no 503) y sin cobrar', async () => {
    mockPriceList.mockResolvedValue({ data: [] })

    const res = await pedir()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })

  it('con la v2 vigente y su precio archivado a mano → el mismo 409 PLAN_PRICE_MISMATCH y sin cobrar', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_a', active: false, unit_amount: 1158840 })

    const res = await pedir()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })

  it('con la v2 vigente y su precio borrado en Stripe (404) → el mismo 409, nunca el 503 del resolver', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockRejectedValue(
      Object.assign(new Error('No such price'), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }),
    )

    const res = await pedir()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

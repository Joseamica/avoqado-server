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
  - B2 (Task 4): con la v2, el alta manda su comprobante (`offer.quoteToken`); sin él, 409 OFFER_CHANGED. El comprobante
    nunca se guarda ni se devuelve, y sin versión del editor ni se lee.

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
// La evidencia del primer cobro de un 3DS (`primerCobroPagado`, el lector REAL): la factura, sus pagos y el saldo.
const mockInvList = jest.fn()
const mockIpList = jest.fn()
const mockBalTx = jest.fn()
const mockCnList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: (...a: unknown[]) => mockBalTx(...a) },
    invoices: { list: (...a: unknown[]) => mockInvList(...a), voidInvoice: jest.fn() },
    invoicePayments: { list: (...a: unknown[]) => mockIpList(...a) },
    creditNotes: { list: (...a: unknown[]) => mockCnList(...a) },
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
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import * as planActivationService from '@/services/onboarding/planActivation.service'

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
const pedirCon = (cuerpo: object) => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send(cuerpo)

/** El precio con el que se creó la suscripción. */
const itemsCobrados = () => mockSubCreate.mock.calls[0][0].items

/** La v2 del editor con los precios de hoy y Pro de 0 días (el CUERPO paga hoy el anual). */
const v2PagaHoy = (planes: NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes'] = {}) =>
  definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PRO: { trialDays: 0 }, ...planes } })
const conV2PagaHoy = (planes?: Parameters<typeof v2PagaHoy>[0]) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2PagaHoy(planes)) as never)

/** Un comprobante del alta de esta organización: por default, el del CUERPO (Pro anual de 0 días, $11,588.40 hoy). */
const comprobante = (c: Partial<CotizacionFirmable> = {}, emitido?: Date) =>
  comprobanteDePrueba(
    { alcance: `org:${ORG}`, interval: 'annual', firstChargeCents: 1158840, precioCents: 1158840, trialEndsAt: null, ...c },
    emitido,
  )
const cuerpoCon = (quoteToken: unknown, extra: object = {}) => ({ ...CUERPO, ...extra, offer: { ...CUERPO.offer, quoteToken } })

/** El `plan` que el cierre agregó al formulario (`fusionarV2SetupData`, un `$executeRaw` sobre `"v2SetupData"`). */
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

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
  // El producto del plan: un precio de campaña (del lugar, de su suscripción o de la versión) tiene que ser de él.
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
})

describe('POST /onboarding/organizations/:organizationId/v2/activate-plan — el precio que se cobra', () => {
  it('con la v2 vigente cobra con su priceId anual', async () => {
    conV2PagaHoy()
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_a', active: true, unit_amount: 1158840 })

    const res = await pedirCon(cuerpoCon(comprobante()))

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
    conV2PagaHoy()
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_a', active: false, unit_amount: 1158840 })

    const res = await pedirCon(cuerpoCon(comprobante()))

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })

  it('con la v2 vigente y su precio borrado en Stripe (404) → el mismo 409, nunca el 503 del resolver', async () => {
    conV2PagaHoy()
    mockPriceRetrieve.mockRejectedValue(
      Object.assign(new Error('No such price'), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' }),
    )

    const res = await pedirCon(cuerpoCon(comprobante()))

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B1, Task 7: un pago de CAMPAÑA ya apartado cierra con SU precio, por la ruta real.
 *
 * IDs distintos a propósito: la llave apunta a 'price_llave_b', la campaña guardó 'price_campana_a' (archivado) y el lugar
 * 'price_lugar_c'. La v2 vigente trae OTRO mensual de Pro, así que un intento nuevo con ella ya no cuadraría con la campaña.
 */
describe('POST …/v2/activate-plan con una campaña — el precio de su lugar apartado', () => {
  const LISTA = 115884
  const ANUNCIADO = 2200
  const CAMPANA = {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    featuredForVertical: false,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: ANUNCIADO,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: LISTA,
    discountAmountCents: LISTA - ANUNCIADO,
    stripePriceId: 'price_campana_a',
    stripeCouponId: 'LC_POS22_V1',
    validFrom: new Date('2020-01-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 1,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'ACTIVE',
    statusReason: null,
    activatedAt: new Date('2026-11-01T00:00:00Z'),
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  }
  const LANZAMIENTO = {
    tier: 'PRO',
    interval: 'monthly',
    payNow: true,
    paymentMethodId: 'pm_1',
    offer: { kind: 'LAUNCH', code: 'POS22', offerVersion: 1, expectedFirstChargeCents: ANUNCIADO },
  }
  const pedirLaOferta = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send(LANZAMIENTO)
  const precio = (id: string, unitAmount: number, extra: Record<string, unknown> = {}) => ({
    id,
    active: true,
    product: 'prod_pro',
    currency: 'mxn',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    unit_amount: unitAmount,
    ...extra,
  })
  const precios: Record<string, ReturnType<typeof precio>> = {
    price_campana_a: precio('price_campana_a', LISTA, { active: false }),
    price_lugar_c: precio('price_lugar_c', LISTA),
    price_v2_pro_m: precio('price_v2_pro_m', 150684),
  }
  const conV2 = () =>
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 129900 } })) as never,
    )
  const conLugar = (stripePriceId: string | null) =>
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
      stripePriceId,
    } as never)
  const progreso = (o: Record<string, unknown> = {}) =>
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: {},
      launchCampaignId: 'lc-1',
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'NONE',
      planActivationAttempt: 0,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: null,
      ...o,
    } as never)

  beforeEach(() => {
    progreso()
    prismaMock.launchCampaign.findUnique.mockResolvedValue(CAMPANA as never)
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
    prismaMock.launchCampaignRedemption.create.mockResolvedValue({ id: 'red-nuevo' } as never)
    prismaMock.launchCampaignRedemption.updateMany.mockResolvedValue({ count: 1 } as never)
    mockPriceRetrieve.mockImplementation(async (id: string) => {
      if (!precios[id]) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
      return precios[id]
    })
    mockPriceList.mockResolvedValue({ data: [precio('price_llave_b', LISTA)] })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })
    mockInvList.mockReset()
    mockIpList.mockReset()
    mockBalTx.mockReset().mockResolvedValue({ has_more: false, data: [] })
    mockCnList.mockReset().mockResolvedValue({ has_more: false, data: [] })
  })

  it('🔴 por la ruta: LAUNCH con lugar RESERVED (price_lugar_c) y v2 vigente → 200 ACTIVE cobrando price_lugar_c', async () => {
    conV2()
    conLugar('price_lugar_c')

    const res = await pedirLaOferta()

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', firstChargeCents: ANUNCIADO })
    expect(itemsCobrados()).toEqual([{ price: 'price_lugar_c' }])
    expect(mockSubCreate.mock.calls[0][0].discounts).toEqual([{ coupon: 'LC_POS22_V1' }])
    expect(mockPriceRetrieve.mock.calls.map(c => c[0])).toEqual(['price_lugar_c'])
  })

  it('🔴 por la ruta: LAUNCH nuevo sin versiones → 200 cobrando price_llave_b, no price_campana_a', async () => {
    const res = await pedirLaOferta()

    expect(res.status).toBe(200)
    expect(itemsCobrados()).toEqual([{ price: 'price_llave_b' }])
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    // El lugar nuevo guarda el precio con el que se cobró.
    expect(prismaMock.launchCampaignRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripePriceId: 'price_llave_b' }) }),
    )
  })

  it('🔴 por la ruta: lugar de antes de B1 (stripePriceId null) con 3DS autorizado y v2 vigente → 200 ACTIVE con la suscripción de su intento', async () => {
    conV2()
    conLugar(null)
    progreso({
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_3ds',
    })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_3ds',
      status: 'active',
      default_payment_method: 'pm_1',
      metadata: {
        organizationId: ORG,
        featureCode: 'PLAN_PRO',
        launchCampaignId: 'lc-1',
        launchCampaignCode: 'POS22',
        launchOfferVersion: '1',
        launchRedemptionId: 'red-1',
        planActivationKey: `plan-activation:${ORG}:1`,
        primerCobroEsperadoCents: String(ANUNCIADO),
      },
      latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO },
      current_period_end: Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000),
      items: { data: [{ price: precio('price_sub_d', LISTA) }] },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })
    // La primera factura del 3DS, pagada con tarjeta por lo consentido.
    mockInvList.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'in_1',
          customer: 'cus_1',
          currency: 'mxn',
          billing_reason: 'subscription_create',
          status: 'paid',
          total: ANUNCIADO,
          amount_paid: ANUNCIADO,
          starting_balance: 0,
          ending_balance: 0,
          post_payment_credit_notes_amount: 0,
        },
      ],
    })
    mockIpList.mockResolvedValue({
      has_more: false,
      data: [
        {
          status: 'paid',
          currency: 'mxn',
          amount_paid: ANUNCIADO,
          payment: {
            type: 'charge',
            charge: { id: 'ch_1', paid: true, currency: 'mxn', amount: ANUNCIADO, amount_refunded: 0, disputed: false },
          },
        },
      ],
    })

    const res = await pedirLaOferta()

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ACTIVE' })
    // Cerró la suscripción de su intento: nada se creó, y ni la versión ni la llave decidieron el precio.
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
  })

  it('🔴 por la ruta, sin versión del editor: lugar de antes de B1, sin suscripción, y la llave sin precio en Stripe → 409 PLAN_PRICE_MISMATCH como hoy (no 503)', async () => {
    conLugar(null)
    // Después de una caída: el intento quedó abierto con el lease vencido y sin suscripción.
    progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: new Date('2026-11-20T00:00:00Z') })
    mockPriceList.mockResolvedValue({ data: [] })

    const res = await pedirLaOferta()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('lo mismo con una versión del editor → el mismo 409 PLAN_PRICE_MISMATCH', async () => {
    conV2()
    conLugar(null)
    progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: new Date('2026-11-20T00:00:00Z') })
    mockPriceList.mockResolvedValue({ data: [] })

    const res = await pedirLaOferta()

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PRICE_MISMATCH')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B2, Task 4: el comprobante del alta por la ruta real.
 *
 * El esquema declara `offer.quoteToken` como `unknown` (cualquier valor pasa, como hoy que Zod lo descartaba) y el
 * controlador lo saca de `offer` antes de llamar al servicio: así nunca se guarda en `v2SetupData` ni lo devuelve
 * `GET progress`. Sin versión del editor ni se lee; con ella, es obligatorio.
 */
describe('POST …/v2/activate-plan — el comprobante de la cotización (B2)', () => {
  const sinCobrar = () => {
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  }

  it('🔴 por la ruta: con la v2 y sin quoteToken → 409 OFFER_CHANGED reason QUOTE_REQUIRED y sin cobrar', async () => {
    conV2PagaHoy()

    const res = await pedir()

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 },
    })
    sinCobrar()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 b2-r2 regresión #2: sin versión del editor, un cuerpo de hoy con un quoteToken de 3,000 caracteres → 200 como hoy (el campo se ignora)', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_a', unit_amount: 1158840 }] })

    const res = await pedirCon(cuerpoCon('x'.repeat(3000)))

    expect(res.status).toBe(200)
    expect(itemsCobrados()).toEqual([{ price: 'price_key_pro_a' }])
    expect(mockPriceList).toHaveBeenCalledTimes(2)
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('con la v2, el mismo comprobante de 3,000 caracteres → 400 QUOTE_INVALID', async () => {
    conV2PagaHoy()

    const res = await pedirCon(cuerpoCon('x'.repeat(3000)))

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('QUOTE_INVALID')
    sinCobrar()
  })

  it.each([
    ['null', null],
    ['un texto cualquiera', 'hola'],
    ['un número', 7],
  ])(
    '🔴 b2-r3 #8 y b2-r4 regresión: sin versión del editor, un alta con tarjeta con offer.quoteToken %s → 200 como hoy; el servicio recibe offer sin la llave quoteToken y lo que escribe v2SetupData.plan.offer es exactamente { kind: "STANDARD", expectedFirstChargeCents }',
    async (_caso, quoteToken) => {
      mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_a', unit_amount: 1158840 }] })
      const espia = jest.spyOn(planActivationService, 'activatePlan')

      try {
        const res = await pedirCon(cuerpoCon(quoteToken))

        expect(res.status).toBe(200)
        expect(espia).toHaveBeenCalledTimes(1)
        const recibido = espia.mock.calls[0][0]
        expect(recibido.offer).toStrictEqual({ kind: 'STANDARD', expectedFirstChargeCents: 1158840 })
        expect(planDelCierre().offer).toStrictEqual({ kind: 'STANDARD', expectedFirstChargeCents: 1158840 })
        expect(planDelCierre()).not.toHaveProperty('offerVersion')
      } finally {
        espia.mockRestore()
      }
    },
  )

  it('🔴 con la v2, el alta cobrada guarda plan.offer sin quoteToken y GET progress no lo devuelve', async () => {
    conV2PagaHoy()
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_a', active: true, unit_amount: 1158840 })
    // Emitido hace un minuto: ningún comprobante que firme `GET progress` ahora puede ser idéntico.
    const quoteToken = comprobante({}, new Date(Date.now() - 60_000))

    const res = await pedirCon(cuerpoCon(quoteToken))

    expect(res.status).toBe(200)
    const plan = planDelCierre()
    expect(plan.offer).toStrictEqual({ kind: 'STANDARD', expectedFirstChargeCents: 1158840 })
    expect(plan.offerVersion).toBe(2)
    expect(JSON.stringify(plan)).not.toContain(quoteToken)

    // Lo que quedó guardado es lo que `GET progress` devuelve en `v2SetupData`.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      currentStep: 10,
      completedSteps: [],
      completedAt: null,
      startedAt: new Date('2026-11-20T00:00:00Z'),
      wizardVersion: 2,
      v2SetupData: { plan },
      launchCampaignId: null,
      termsVersion: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'ACTIVE',
      planActivationAttempt: 1,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_1',
    } as never)
    const progreso = await request(app).get(`/api/v1/onboarding/organizations/${ORG}/progress`).set('Authorization', `Bearer ${token()}`)

    expect(progreso.status).toBe(200)
    expect(progreso.body.progress.v2SetupData.plan.offer).toStrictEqual({ kind: 'STANDARD', expectedFirstChargeCents: 1158840 })
    expect(JSON.stringify(progreso.body)).not.toContain(quoteToken)
    expect(JSON.stringify(progreso.body.progress.v2SetupData)).not.toContain('quoteToken')
  })

  it('con la v2, offer.quoteToken null → 409 OFFER_CHANGED reason QUOTE_REQUIRED; un número → 400 QUOTE_INVALID', async () => {
    conV2PagaHoy()

    const nulo = await pedirCon(cuerpoCon(null))
    expect(nulo.status).toBe(409)
    expect(nulo.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 } })

    const numero = await pedirCon(cuerpoCon(7))
    expect(numero.status).toBe(400)
    expect(numero.body.code).toBe('QUOTE_INVALID')
    sinCobrar()
  })

  it('🔴 b2-r9 #1 (el caso de Codex): el cliente trae un cupón de 10 % y Stripe lo aplica igual; Premium de 0 días con 3DS → 409 con el reto; la factura se paga por 177376 con su descuento declarado; el barrido (cerrarAltaSinNavegador) → CERRADA, el alta ACTIVE y el VenueFeature ligado', async () => {
    const PREMIUM_M = 197084
    const PAGADO = 177376 // con el 10 % (19708) que Stripe aplicó del cliente
    const SECRETO = 'pi_3ds_secret_x'
    conV2PagaHoy({ PREMIUM: { trialDays: 0 } })
    prismaMock.feature.findFirst.mockResolvedValue({
      id: 'feat-premium',
      code: 'PLAN_PREMIUM',
      monthlyPrice: 1699,
      stripeProductId: 'prod_premium',
    } as never)
    mockEntregar.mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
      venueId: 'venue-1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId,
      endDate: null,
    }))
    mockPriceRetrieve.mockResolvedValue({
      id: 'price_v2_premium_m',
      active: true,
      unit_amount: PREMIUM_M,
      currency: 'mxn',
      recurring: { interval: 'month', interval_count: 1 },
    })
    // El #1 pide autenticar; el #2 queda esperando al banco con el secreto del reto.
    mockSubCreate
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new Error('Payment for this subscription requires additional user action…'), {
          type: 'StripeCardError',
          code: 'subscription_payment_intent_requires_action',
          statusCode: 402,
        }),
      )
      .mockResolvedValueOnce({
        id: 'sub_3ds',
        status: 'incomplete',
        latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: SECRETO } },
      })

    const reto = await pedirCon({
      tier: 'PREMIUM',
      interval: 'monthly',
      payNow: true,
      paymentMethodId: 'pm_1',
      offer: {
        kind: 'STANDARD',
        expectedFirstChargeCents: PREMIUM_M,
        quoteToken: comprobante({ tier: 'PREMIUM', interval: 'monthly', firstChargeCents: PREMIUM_M, precioCents: PREMIUM_M }),
      },
    })

    expect(reto.status).toBe(409)
    expect(reto.body).toMatchObject({ code: 'PLAN_PAYMENT_REQUIRES_ACTION', details: { clientSecret: SECRETO } })
    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    // Los dos create con descuentos explícitos (ninguno) y la marca del reto con el precio de la versión.
    expect(mockSubCreate.mock.calls[0][0].discounts).toBe('')
    expect(mockSubCreate.mock.calls[1][0].discounts).toBe('')
    expect(mockSubCreate.mock.calls[1][0].items).toEqual([{ price: 'price_v2_premium_m' }])
    expect(mockSubCreate.mock.calls[1][0].metadata).toMatchObject({
      primerCobroEsperadoCents: String(PREMIUM_M),
      planOfferVersion: '2',
      planActivationKey: `plan-activation:${ORG}:1`,
    })

    // El cliente autorizó y cerró la pestaña. Stripe cobró 177376: el 10 % del cliente se aplicó igual y la factura lo declara.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: {},
      launchCampaignId: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_3ds',
    } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: 'staff_dueno' } as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_3ds',
      status: 'active',
      default_payment_method: 'pm_1',
      metadata: {
        organizationId: ORG,
        featureCode: 'PLAN_PREMIUM',
        planActivationKey: `plan-activation:${ORG}:1`,
        primerCobroEsperadoCents: String(PREMIUM_M),
        planOfferVersion: '2',
        planOfferPrecioDe: '2',
      },
      latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PAGADO },
      current_period_end: Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000),
      items: { data: [{ price: { id: 'price_v2_premium_m', unit_amount: PREMIUM_M, recurring: { interval: 'month' } } }] },
      discounts: [{ source: { coupon: { id: 'COUPON_DEL_CLIENTE' } } }],
    })
    mockInvList.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'in_1',
          customer: 'cus_1',
          currency: 'mxn',
          billing_reason: 'subscription_create',
          status: 'paid',
          total: PAGADO,
          amount_paid: PAGADO,
          total_discount_amounts: [{ amount: PREMIUM_M - PAGADO, discount: 'di_cliente' }],
          starting_balance: 0,
          ending_balance: 0,
          post_payment_credit_notes_amount: 0,
        },
      ],
    })
    mockIpList.mockResolvedValue({
      has_more: false,
      data: [
        {
          status: 'paid',
          currency: 'mxn',
          amount_paid: PAGADO,
          payment: {
            type: 'charge',
            charge: { id: 'ch_1', paid: true, currency: 'mxn', amount: PAGADO, amount_refunded: 0, disputed: false },
          },
        },
      ],
    })
    mockBalTx.mockReset().mockResolvedValue({ has_more: false, data: [] })
    mockCnList.mockReset().mockResolvedValue({ has_more: false, data: [] })
    mockSubCreate.mockClear()
    ;(prismaMock.onboardingProgress.updateMany as jest.Mock).mockClear()

    await expect(planActivationService.cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_3ds' }) }),
    )
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue-1', subscriptionId: 'sub_3ds' }))
    expect(prismaMock.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { planTier: 'PREMIUM' } }))
  })
})

/**
 * Planes editables B1 (Task 7): el barrido de altas a medio pago cierra un 3DS de CAMPAÑA con SU precio, aunque después se
 * haya publicado otra versión de los planes con otro mensual.
 *
 * La entrada real del job: `new AltasAMedioPagoJob({ cron }).runNow()` con su resolver real (`cerrarAltaSinNavegador`, que
 * llama a `activatePlan` con `soloRecuperar`). Sin esto, el PASO 4 comparaba el snapshot de la campaña contra el mensual de
 * la v2 y respondía 409 `PLAN_PRICE_MISMATCH` en cada pasada: cobrado y sin acceso.
 *
 * Se simulan sus bordes, como en `planActivation.service.test.ts`: Stripe, la entrega del acceso, la evidencia del primer
 * cobro (probada en su suite), los avisos y el cierre del alta.
 */
const mockSubRetrieve = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockSubCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: jest.fn() },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: jest.fn() },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: jest.fn() },
    invoices: { list: jest.fn(), voidInvoice: jest.fn() },
    invoicePayments: { list: jest.fn() },
    creditNotes: { list: jest.fn() },
  })),
)
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const mockEntregar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
jest.mock('@/services/onboarding/primerCobroPagado', () => ({ primerCobroCubierto: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', status: 'ONBOARDING' }),
}))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('@/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: jest.fn().mockResolvedValue({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import { AltasAMedioPagoJob } from '@/jobs/altas-a-medio-pago.job'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const LISTA = 115884
const ANUNCIADO = 2200
const FIN_DEL_PERIODO = Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000)

const campana = {
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

const precio = (id: string, unitAmount: number) => ({
  id,
  active: true,
  product: 'prod_pro',
  currency: 'mxn',
  recurring: { interval: 'month', interval_count: 1 },
  tax_behavior: 'inclusive',
  unit_amount: unitAmount,
})

/** La suscripción del 3DS: el cliente autorizó y cerró la pestaña. Cobró con `priceDelIntento`. */
const suscripcion = (priceDelIntento: ReturnType<typeof precio>) => ({
  id: 'sub_3ds',
  status: 'active',
  default_payment_method: 'pm_1',
  metadata: {
    organizationId: 'org-1',
    featureCode: 'PLAN_PRO',
    launchCampaignId: 'lc-1',
    launchCampaignCode: 'POS22',
    launchOfferVersion: '1',
    launchRedemptionId: 'red-1',
    planActivationKey: 'plan-activation:org-1:1',
    primerCobroEsperadoCents: String(ANUNCIADO),
  },
  latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO },
  current_period_end: FIN_DEL_PERIODO,
  items: { data: [{ current_period_end: FIN_DEL_PERIODO, price: priceDelIntento }] },
  discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
})

const precios: Record<string, ReturnType<typeof precio>> = {
  price_lugar_c: precio('price_lugar_c', LISTA),
  // La v2 publicada DESPUÉS de apartar el lugar trae otro mensual de Pro ($1,299 + IVA).
  price_v2_pro_m: precio('price_v2_pro_m', 150684),
}

const nuevoJob = () => new AltasAMedioPagoJob({ cron: { start: jest.fn(), stop: jest.fn() } })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  // El barrido: un alta a medio pago (IN_PROGRESS) y ninguna con el plan ya confirmado.
  prismaMock.onboardingProgress.findMany.mockImplementation((async ({ where }: { where: { planActivationStatus: string } }) =>
    where.planActivationStatus === 'IN_PROGRESS' ? [{ id: 'op-1', organizationId: 'org-1' }] : []) as never)
  prismaMock.onboardingProgress.findUnique.mockResolvedValue({
    id: 'op-1',
    organizationId: 'org-1',
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: 'lc-1',
    termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
    planActivationStatus: 'IN_PROGRESS',
    planActivationAttempt: 1,
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: 'sub_3ds',
  } as never)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ staffId: 'owner-1' } as never)
  prismaMock.launchCampaign.findUnique.mockResolvedValue(campana as never)
  prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.launchCampaignRedemption.updateMany.mockResolvedValue({ count: 1 } as never)
  // El producto del plan: un precio de campaña (del lugar, de su suscripción o de la versión) tiene que ser de él.
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.planOfferPointer.findUnique
    .mockReset()
    .mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 129900 } })) as never)
  mockPriceList.mockReset().mockResolvedValue({ data: [precio('price_llave_b', LISTA)] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (!precios[id]) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return precios[id]
  })
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-pro',
    featureCode: 'PLAN_PRO',
    subscriptionId,
    endDate: null,
  }))
})

describe('altas-a-medio-pago con una campaña, después de publicar la v2', () => {
  it('🔴 un 3DS de campaña autorizado después de publicar v2 cierra ACTIVE con su precio guardado (cerradas: 1, fallidas: 0)', async () => {
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
      stripePriceId: 'price_lugar_c',
    } as never)
    mockSubRetrieve.mockResolvedValue(suscripcion(precios.price_lugar_c))

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    expect(prismaMock.onboardingProgress.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE')).toBe(true)
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' }, data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    // Lo decidió el precio guardado del lugar, no el mensual de la v2; y nada se cobró de nuevo.
    expect(mockPriceRetrieve.mock.calls.map(c => c[0])).toEqual(['price_lugar_c'])
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 lo mismo con un lugar de antes de B1 (stripePriceId null): cierra con el precio de su suscripción (cerradas: 1, fallidas: 0)', async () => {
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
      stripePriceId: null,
    } as never)
    mockSubRetrieve.mockResolvedValue(suscripcion(precio('price_sub_d', LISTA)))

    const r = await nuevoJob().runNow()

    expect(r).toMatchObject({ revisadas: 1, cerradas: 1, fallidas: 0 })
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' }, data: expect.objectContaining({ status: 'APPLIED' }) }),
    )
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

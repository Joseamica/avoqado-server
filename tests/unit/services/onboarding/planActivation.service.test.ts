/**
 * S8 — `activate-plan`, el camino del dinero (spec 2026-09-17 § 3.6).
 *
 * 🔴 CERO llamadas reales a Stripe. Cada prueba de esta lista nombra un cobro equivocado que el
 * código impide; si una cae, el defecto que describe volvió.
 */
const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPmRetrieve = jest.fn()
// D2: lo que lee la evidencia del primer cobro (`primerCobroPagado` y el lector REAL de cobertura).
const mockInvList = jest.fn()
/** `invoicePayments.list` SIN `status`: lo que lee el resolver del PASO 6 (S3), el PaymentIntent de la factura. */
const mockIpList = jest.fn()
/** `invoicePayments.list` con `status: 'paid'`: los pagos que suma el lector de cobertura. Lo arma `facturaInicial`. */
const mockPagosCobrados = jest.fn()
const mockCnList = jest.fn()
const mockBalTx = jest.fn()
/** S3: anular la factura de un intento que no se pagó (nunca `subscriptions.cancel`). */
const mockVoid = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: mockBalTx },
    invoices: { list: mockInvList, voidInvoice: mockVoid },
    invoicePayments: {
      list: (p: { status?: string }, ...resto: unknown[]) =>
        p?.status === 'paid' ? mockPagosCobrados(p, ...resto) : mockIpList(p, ...resto),
    },
    creditNotes: { list: mockCnList },
  })),
)

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
// V5-A paso 6: el cobro nuevo pasa por la regla común (probada en su suite) y el acceso lo escribe la entrega (probada en la
// suya). Aquí se simulan en su borde para probar lo que decide ESTE servicio. Lo demás del módulo (su plazo) es el real.
const mockAutorizar = jest.fn()
jest.mock('@/services/access/autorizarObligacionNueva', () => ({
  ...jest.requireActual('@/services/access/autorizarObligacionNueva'),
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
const mockEntregar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
jest.mock('@/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'bar-test', status: 'ONBOARDING' }),
}))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Bar' }),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))

import {
  activatePlan,
  cerrarAltaSinNavegador,
  hayCobroDelAltaSinCerrar,
  liberarLugar,
  LEASE_MS,
} from '@/services/onboarding/planActivation.service'
import { standardPlanQuote } from '@/services/access/planPricing.constants'
import { standardFirstChargeCents } from '@/services/launchCampaigns/launchOfferMath'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'
import { inspect } from 'util'

const LISTA = 115884
const ANUNCIADO = 2200

function campania(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: ANUNCIADO,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: LISTA,
    discountAmountCents: LISTA - ANUNCIADO,
    stripePriceId: 'price_x',
    stripeCouponId: 'LC_POS22_V1',
    validFrom: new Date('2020-01-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'ACTIVE',
    statusReason: null,
    activatedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

function progreso(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    organizationId: 'org-1',
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: 'lc-1',
    termsAcceptedAt: new Date('2026-09-17T00:00:00Z'),
    planActivationStatus: 'NONE',
    planActivationAttempt: 0,
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: null,
    ...overrides,
  }
}

const OFERTA_LAUNCH = { kind: 'LAUNCH' as const, code: 'POS22', offerVersion: 1, expectedFirstChargeCents: ANUNCIADO }
const BASE = {
  organizationId: 'org-1',
  staffId: 'staff-1',
  tier: 'PRO' as const,
  interval: 'monthly' as const,
  payNow: true,
  paymentMethodId: 'pm_1',
}

/**
 * El `plan` que el cierre agregó al formulario. Desde el 20-oct se escribe SÓLO esa sección con `fusionarV2SetupData`
 * (un `$executeRaw` sobre `"v2SetupData"`), no dentro del `updateMany` del candado: reescribir el formulario entero borraba
 * lo que otra pestaña guardó en medio.
 */
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

/** Un `$transaction(cb)` que le pasa el mismo mock como `tx`, igual que el setup global. */
function prepararTransaccion() {
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
}

const CONCEDIDO_PRO = { venueId: 'venue-1', featureId: 'feat-pro', featureCode: 'PLAN_PRO', subscriptionId: 'sub_1', endDate: null }

/**
 * D2 (y S3): la PRIMERA factura de `sub_3ds` (`in_1`, `billing_reason: 'subscription_create'`), coherente para el lector
 * REAL de cobertura (`hybridFundingGraph`, formas de su suite): `total` es después del cupón y antes del saldo,
 * `tarjeta` lo cobrado a la tarjeta (`amount_paid`), `saldo` el saldo a favor aplicado (con su abono y su uso en
 * `listBalanceTransactions`). Arma `mockInvList`, los pagos de la factura (`mockPagosCobrados`, la llamada con
 * `status: 'paid'`) y el saldo; la llamada del resolver de S3 (sin `status`) sigue en `mockIpList`.
 */
function facturaInicial({ total, tarjeta, saldo, status }: { total: number; tarjeta: number; saldo: number; status: 'paid' | 'open' }) {
  const factura = {
    id: 'in_1',
    customer: 'cus_1',
    currency: 'mxn',
    billing_reason: 'subscription_create',
    status,
    total,
    amount_paid: tarjeta,
    starting_balance: saldo ? -saldo : 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
  }
  mockInvList.mockResolvedValue({ data: [factura], has_more: false })
  mockPagosCobrados.mockResolvedValue({
    has_more: false,
    data: tarjeta
      ? [
          {
            status: 'paid',
            currency: 'mxn',
            amount_paid: tarjeta,
            payment: {
              type: 'charge',
              charge: { id: 'ch_1', paid: true, currency: 'mxn', amount: tarjeta, amount_refunded: 0, disputed: false },
            },
          },
        ]
      : [],
  })
  // De la más nueva a la más vieja, como las devuelve Stripe: el abono del saldo y su uso en `in_1`.
  mockBalTx.mockResolvedValue({
    has_more: false,
    data: saldo
      ? [
          {
            id: 'cbtxn_uso',
            customer: 'cus_1',
            currency: 'mxn',
            type: 'applied_to_invoice',
            amount: saldo,
            ending_balance: 0,
            invoice: 'in_1',
          },
          {
            id: 'cbtxn_abono',
            customer: 'cus_1',
            currency: 'mxn',
            type: 'adjustment',
            amount: -saldo,
            ending_balance: -saldo,
            invoice: null,
          },
        ]
      : [],
  })
  return factura
}

beforeEach(() => {
  jest.clearAllMocks()
  prepararTransaccion()
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  mockEntregar
    .mockReset()
    .mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({ ...CONCEDIDO_PRO, subscriptionId }))
  // `clearAllMocks` no tira las respuestas `…Once` sin usar: una prueba que falla a medias se las heredaba a la siguiente.
  mockPriceList.mockReset().mockResolvedValue({
    data: [{ id: 'price_x', unit_amount: LISTA, currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive' }],
  })
  mockPmRetrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1' })
  mockInvList.mockReset()
  mockIpList.mockReset()
  mockPagosCobrados.mockReset()
  mockBalTx.mockReset()
  mockVoid.mockReset()
  mockCnList.mockReset().mockResolvedValue({ data: [], has_more: false })
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null as never)
  // Stripe siempre trae `status`: el cierre lo exige (D2, candado del PASO 9).
  mockSubRetrieve.mockReset().mockResolvedValue({
    id: 'sub_1',
    status: 'active',
    current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
    latest_invoice: { amount_paid: ANUNCIADO },
    discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
  })
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Bar',
    slug: 'bar-test',
    email: 'b@x.com',
    organization: { email: 'o@x.com', name: 'Org' },
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.launchCampaignRedemption.create.mockResolvedValue({ id: 'red-1' } as never)
  prismaMock.launchCampaignRedemption.updateMany.mockResolvedValue({ count: 1 } as never)
  // `createPlanSubscription` es el REAL (sólo Stripe está mockeado): necesita su Feature y su
  // VenueFeature. Sin esto lanza «Feature PLAN_PRO not found» y el servicio lo clasifica como
  // resultado desconocido — la prueba fallaría por el motivo equivocado.
  prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
  // El cliente de Stripe del local ya existe, así que `getOrCreateStripeCustomer` no crea nada.
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Bar',
    slug: 'bar-test',
    email: 'b@x.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'o@x.com', name: 'Org' },
  } as never)
})

describe('camino feliz con campaña', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('cobra $22 con el cupón de la ficha, sin prueba gratis y con error_if_incomplete', async () => {
    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo, opciones] = mockSubCreate.mock.calls[0]
    expect(cuerpo.discounts).toEqual([{ coupon: 'LC_POS22_V1' }])
    expect(cuerpo.trial_period_days).toBe(0)
    expect(cuerpo.payment_behavior).toBe('error_if_incomplete')
    expect(cuerpo.metadata).toMatchObject({ planActivationKey: 'plan-activation:org-1:1', launchCampaignCode: 'POS22' })
    expect(opciones).toEqual({ idempotencyKey: 'plan-activation:org-1:1', timeout: 15_000, maxNetworkRetries: 0 })
    expect(r).toMatchObject({ status: 'ACTIVE', alreadyActive: false, firstChargeCents: ANUNCIADO })
    expect(r.launchOffer).toMatchObject({ code: 'POS22', months: 3, renewalMonthlyCents: ANUNCIADO })
    // D2: el cobro clásico que pasa a la primera no pide la evidencia nueva.
    expect(mockInvList).not.toHaveBeenCalled()
  })

  it('🔴 aparta el lugar con UPDATE … WHERE conteo < cupo, nunca leyendo primero', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    const llamada = prismaMock.launchCampaign.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.redemptionCount)
    expect(llamada?.[0].where).toMatchObject({ id: 'lc-1', status: 'ACTIVE', offerVersion: 1 })
    expect(llamada?.[0].where.redemptionCount).toBeDefined()
    expect(llamada?.[0].data).toEqual({ redemptionCount: { increment: 1 } })
  })

  it('🔴 el local queda con su tier, NUNCA en TRIAL', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })
    expect(prismaMock.venue.update).toHaveBeenCalledWith({ where: { id: 'venue-1' }, data: { planTier: 'PRO' } })
  })

  it('🔴 `plan` se guarda en la RAÍZ de v2SetupData (es lo que parseV2Plan busca primero), sin reescribir el formulario', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })
    const escritura = prismaMock.onboardingProgress.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE')
    // El candado ya no reescribe el formulario entero (borraba lo que otra pestaña guardó en medio; 20-oct).
    expect(escritura?.[0].data.v2SetupData).toBeUndefined()
    expect(planDelCierre()).toMatchObject({
      tier: 'PRO',
      interval: 'monthly',
      payNow: true,
    })
  })

  it('🔴 el correo de confirmación dice la fecha del siguiente cobro de Stripe, no «hoy + 30 días»', async () => {
    const { resolvePlanNotificationTarget } = jest.requireMock('@/services/access/planNotification.service')
    resolvePlanNotificationTarget.mockResolvedValueOnce({ email: 'dueno@x.com', locale: 'es', venueName: 'Bar' })
    const { default: emailService } = jest.requireMock('@/services/email.service')

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)) // el correo sale sin bloquear la respuesta

    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledWith(
      'dueno@x.com',
      expect.objectContaining({ firstChargeDate: new Date('2026-10-17T00:00:00Z') }), // current_period_end de la suscripción
    )
  })

  it('la redención queda APPLIED con la suscripción y la huella de tarjeta', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith({
      where: { id: 'red-1', status: 'RESERVED' },
      data: expect.objectContaining({ status: 'APPLIED', stripeSubscriptionId: 'sub_1', cardFingerprint: 'fp_1' }),
    })
  })
})

describe('el servidor manda el precio', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('🔴 un `expectedFirstChargeCents` distinto → OFFER_CHANGED y CERO cobros', async () => {
    await expect(activatePlan({ ...BASE, offer: { ...OFERTA_LAUNCH, expectedFirstChargeCents: 100 } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 una `offerVersion` distinta → OFFER_CHANGED y CERO cobros', async () => {
    await expect(activatePlan({ ...BASE, offer: { ...OFERTA_LAUNCH, offerVersion: 2 } })).rejects.toMatchObject({ code: 'OFFER_CHANGED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 el precio de Stripe ≠ el snapshot → PLAN_PRICE_MISMATCH y CERO cobros', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_x', unit_amount: 129999 }] })
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_PRICE_MISMATCH' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 una ficha PAUSADA → 409 y CERO llamadas a Stripe', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ status: 'PAUSED' }) as never)
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAUNCH_OFFER_UNAVAILABLE',
      details: expect.objectContaining({ reason: 'PAUSED' }),
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it.each([
    ['con payNow=false', { payNow: false }],
    ['con otro tier', { tier: 'PREMIUM' as const }],
    ['con intervalo anual', { interval: 'annual' as const }],
  ])('🔴 una oferta LAUNCH %s → NOT_APPLICABLE y cero cobros', async (_caso, cambios) => {
    await expect(activatePlan({ ...BASE, ...cambios, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      code: 'LAUNCH_OFFER_NOT_APPLICABLE',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 un `pm_` de otro cliente → 400 y cero cobros', async () => {
    mockPmRetrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_otro' })
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_METHOD_MISMATCH',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('el cupo lleno → LAUNCH_OFFER_UNAVAILABLE SOLD_OUT y cero cobros', async () => {
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ redemptionCount: 100 }) as never)
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      code: 'LAUNCH_OFFER_UNAVAILABLE',
      details: { reason: 'SOLD_OUT' },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

describe('idempotencia y estados ya activos', () => {
  it('🔴 ACTIVE por PRUEBA DE 30 DÍAS + petición LAUNCH del mismo plan → 409 PLAN_ACTIVE_WITHOUT_OFFER, cero cobros, cero cupo', async () => {
    // Es el defecto P1-1: con la regla de DOS datos (tier e intervalo) esto respondía 200
    // `alreadyActive`, el cliente creía que pagó, nadie cobraba $22 y a los 30 días Stripe le
    // cobraba $1,158.84.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'ACTIVE',
        planStripeSubscriptionId: 'sub_trial',
        v2SetupData: { plan: { tier: 'PRO', interval: 'monthly', payNow: false } },
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_ACTIVE_WITHOUT_OFFER',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('ACTIVE con OTRO plan → PLAN_ALREADY_ACTIVATED', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({ planActivationStatus: 'ACTIVE', v2SetupData: { plan: { tier: 'PREMIUM', interval: 'monthly' } } }) as never,
    )
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_ALREADY_ACTIVATED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 el reintento del MISMO cobro responde alreadyActive con los importes LEÍDOS de la suscripción', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'ACTIVE',
        planStripeSubscriptionId: 'sub_1',
        v2SetupData: { plan: { tier: 'PRO', interval: 'monthly' } },
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      campaignId: 'lc-1',
      advertisedPriceCents: ANUNCIADO,
      discountMonths: 3,
      listPriceCents: LISTA,
      offerVersion: 1,
      campaign: { code: 'POS22' },
    } as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      current_period_end: Math.floor(new Date('2026-12-01T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
    })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r).toMatchObject({ alreadyActive: true, firstChargeCents: ANUNCIADO, nextChargeAt: '2026-12-01T00:00:00.000Z' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('un lease VIGENTE de otro intento → 409 PLAN_ACTIVATION_IN_PROGRESS', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() + 60_000),
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_ACTIVATION_IN_PROGRESS' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('un doble clic pierde el CAS del lease y recibe 409, sin cobrar', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_ACTIVATION_IN_PROGRESS' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

describe('recuperación de un intento desconocido', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
    } as never)
  })

  it('🔴 la encuentra en la SEGUNDA página y NO crea una segunda suscripción', async () => {
    // Con `limit: 20` y una sola página, la suscripción buena en la página 2 se leía como
    // «no se creó»: llave nueva y SEGUNDO cobro.
    const pagina1 = Array.from({ length: 100 }, (_, i) => ({ id: `sub_otra_${i}`, metadata: {} }))
    const buena = { id: 'sub_buena', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:1' } }
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [...pagina1, buena]) {
          const seguir = await cb(s)
          if (seguir === false) return
        }
      },
    })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_buena',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'ACTIVE', alreadyActive: false })
    // 🔴 Y se pide la página COMPLETA (100, el tope de Stripe) y TODOS los estados: con una
    // página chica la suscripción buena se va a la siguiente y el recorrido concluye «no
    // existe» — que es exactamente lo que cobra dos veces.
    expect(mockSubList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', status: 'all', limit: 100 }))
    // 🔴 Y SIN cota por fecha (Codex, 21-sep): cualquier ventana deja fuera un intento más viejo.
    expect(mockSubList.mock.calls[0][0]).not.toHaveProperty('created')
  })

  it('🔴 una suscripción RECUPERADA sin el cupón de la oferta NO se cierra como campaña aplicada', async () => {
    // Codex, 20-sep: la comprobación del cupón sólo corría con `reused`, y al RECUPERAR un intento
    // `reused` queda en false. Resultado medido: campaña APPLIED, $0 pagados y «renovación a $22»,
    // mientras Stripe conservaba la suscripción SIN descuento.
    const recuperada = { id: 'sub_rec', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:1' } }
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean) => {
        cb(recuperada)
      },
    })
    // La suscripción recuperada NO lleva el cupón de la campaña.
    mockSubRetrieve.mockResolvedValue({
      ...recuperada,
      discounts: [],
      latest_invoice: { amount_paid: 197084 },
      current_period_end: Math.floor(new Date('2026-10-26T00:00:00Z').getTime() / 1000),
    })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      code: 'PLAN_ACTIVE_WITHOUT_OFFER',
      details: expect.objectContaining({ charged: true }),
    })
    // Nunca queda APPLIED ni se anuncia la campaña…
    const aplicada = prismaMock.launchCampaignRedemption.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.status === 'APPLIED')
    expect(aplicada).toBeUndefined()
  })

  it('🔴 26-sep: ese cobro recuperado SIN el cupón se ENTREGA (cobrado y sin acceso era un callejón sin salida)', async () => {
    // «Ver otros planes» → Premium, falla la entrega, vuelve y toca la oferta: el reintento recupera el cobro anterior.
    // Antes: cerrar el intento + 409 → cobrado, sin plan, y la pantalla diciendo «no te cobramos nada».
    const recuperada = { id: 'sub_rec', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:1' } }
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean) => {
        cb(recuperada)
      },
    })
    mockSubRetrieve.mockResolvedValue({
      ...recuperada,
      discounts: [],
      latest_invoice: { amount_paid: 197084 },
      current_period_end: Math.floor(new Date('2026-10-26T00:00:00Z').getTime() / 1000),
    })
    mockEntregar.mockResolvedValue({ ...CONCEDIDO_PRO, featureCode: 'PLAN_PREMIUM', subscriptionId: 'sub_rec' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_ACTIVE_WITHOUT_OFFER' })

    expect(mockSubCreate).not.toHaveBeenCalled() // nunca un segundo cobro
    expect(mockEntregar).toHaveBeenCalledWith({ venueId: 'venue-1', subscriptionId: 'sub_rec', detectedBy: 'onboarding.activatePlan' })
    // El alta queda ACTIVE con lo cobrado…
    const cierre = prismaMock.onboardingProgress.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE')
    expect(cierre).toBeDefined()
    expect(planDelCierre()).toMatchObject({ tier: 'PREMIUM', offer: { kind: 'STANDARD' } })
    expect(prismaMock.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { planTier: 'PREMIUM' } }))
    // …el lugar de la oferta se libera, y la bitácora dice lo que pasó (nunca «campaña canjeada»).
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    )
    const acciones = (logAction as jest.Mock).mock.calls.map(c => c[0])
    expect(acciones).toContainEqual(
      expect.objectContaining({ action: 'PLAN_ACTIVATED_ONBOARDING', data: expect.objectContaining({ offerNotApplied: true }) }),
    )
    expect(acciones.find(a => a.action === 'LAUNCH_CAMPAIGN_REDEEMED')).toBeUndefined()
  })

  it('🔴 el id se persiste EN CUANTO la suscripción existe, no al cerrar el éxito', async () => {
    // Lo que importa es el ORDEN: el id tiene que quedar guardado ANTES de cerrar el éxito. Si
    // sólo se guardara al cerrar, un fallo entre el cobro y ese cierre deja al reintento sin
    // rastro — y entonces hay que BUSCARLA, con una ventana que puede dejarla fuera y cobrar otra
    // vez. Comprobar el orden distingue las dos cosas; comprobar «que en algún momento se guarde»
    // no, porque el cierre también lo guarda.
    mockSubList.mockReturnValue({ autoPagingEach: async () => undefined })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    const llamadas = prismaMock.onboardingProgress.updateMany.mock.calls
    const iId = llamadas.findIndex(
      (c: unknown[]) => (c[0] as { data?: { planStripeSubscriptionId?: string } })?.data?.planStripeSubscriptionId,
    )
    const iCierre = llamadas.findIndex(
      (c: unknown[]) => (c[0] as { data?: { planActivationStatus?: string } })?.data?.planActivationStatus === 'ACTIVE',
    )
    expect(iId).toBeGreaterThanOrEqual(0)
    if (iCierre >= 0) expect(iId).toBeLessThan(iCierre)
  })

  it('🔴 SEGUNDO reintento con una suscripción de hace 40 días sin id guardado: la encuentra, NO cobra otra vez', async () => {
    // Codex, 21-sep (P1, reproducido): la regla anterior comparaba la fecha del LEASE, que se
    // renueva en cada reintento. El primer reintento respondía 503 pero dejaba el lease recién
    // renovado; en el segundo, esa fecha reciente hacía pasar la búsqueda vacía por «no existe» y
    // se creaba un SEGUNDO COBRO. La salida no es otra fecha: es no depender de ninguna.
    const segundoReintento = progreso({
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      // El estado EXACTO del segundo reintento: el lease se renovó en el primero y acaba de vencer.
      planActivationLeaseUntil: new Date(Date.now() - 60_000),
      planStripeSubscriptionId: null,
    }) as Record<string, unknown>
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(segundoReintento as never)
    const hace40Dias = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000)
    const laQueYaCobro = {
      id: 'sub_vieja',
      status: 'active',
      created: hace40Dias,
      metadata: { planActivationKey: 'plan-activation:org-1:1' },
    }
    // 🔑 Este Stripe simulado FILTRA por `created` igual que el real. Sin eso la prueba pasaría
    // con la ventana puesta y no vería el defecto.
    mockSubList.mockImplementation((params: { created?: { gte?: number } }) => ({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const sub of [laQueYaCobro]) {
          if (params.created?.gte !== undefined && sub.created < params.created.gte) continue
          if ((await cb(sub)) === false) return
        }
      },
    }))
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_vieja',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('recorrió TODAS las suscripciones del cliente y no está ⇒ no existe ⇒ estrena intento', async () => {
    // El caso legítimo no se rompe: con la búsqueda completa, no encontrarla SÍ es prueba.
    mockSubList.mockReturnValue({ autoPagingEach: async () => undefined })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('🔴 si el cliente tiene más suscripciones de las que se pueden recorrer, NO cobra: pendiente', async () => {
    // Recorrer todo sólo prueba ausencia si de verdad se recorrió todo. Si se llega al tope sin
    // encontrarla, el desenlace es incierto — y ante lo incierto nunca se autoriza otro cobro.
    const muchas = Array.from({ length: 1_200 }, (_, i) => ({ id: `sub_${i}`, metadata: {} }))
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const sub of muchas) if ((await cb(sub)) === false) return
      },
    })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 si el id de la suscripción quedó guardado, se recupera por ID y NO se busca por ventana', async () => {
    // Codex, 20-sep: cualquier ventana (1 h, 30 días) deja fuera un intento más viejo y crea un
    // segundo cobro. La salida no es agrandarla: es no depender de ella. El id se persiste en
    // cuanto la suscripción existe, así que el reintento la recupera EXACTA.
    const progresoConId = progreso({
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: new Date(Date.now() - 60_000),
      planStripeSubscriptionId: 'sub_guardada',
    }) as Record<string, unknown>
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progresoConId as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_guardada',
      status: 'active',
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
      metadata: { featureCode: 'PLAN_PRO' },
    })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_guardada', expect.anything())
    expect(mockSubList).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 si `subscriptions.list` FALLA → 503, NUNCA «no existe»', async () => {
    mockSubList.mockReturnValue({
      autoPagingEach: async () => {
        throw new Error('Stripe caído')
      },
    })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('si de verdad no existe, se estrena intento y llave', async () => {
    mockSubList.mockReturnValue({ autoPagingEach: async () => undefined })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][1]).toEqual({ idempotencyKey: 'plan-activation:org-1:2', timeout: 15_000, maxNetworkRetries: 0 })
  })
})

describe('desenlaces del cobro', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('🔴 un rechazo del banco: 402, el lugar se LIBERA y el conteo baja', async () => {
    mockSubCreate.mockRejectedValue(
      Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', decline_code: 'generic_decline' }),
    )

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 402,
      code: 'PLAN_PAYMENT_DECLINED',
      details: { declineCode: 'generic_decline' },
    })

    // CAS sobre RESERVED: sin él, dos liberaciones del mismo lugar bajarían el contador dos veces.
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith({
      where: { id: 'red-1', status: 'RESERVED' },
      data: expect.objectContaining({ status: 'RELEASED' }),
    })
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', redemptionCount: { gt: 0 } },
      data: { redemptionCount: { decrement: 1 } },
    })
    // Y el progreso queda DECLINED, para que el siguiente intento estrene llave.
    const decl = prismaMock.onboardingProgress.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.planActivationStatus === 'DECLINED')
    expect(decl).toBeDefined()
    // D2: un rechazo de verdad no dispara el 2.º create ni la evidencia nueva.
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockInvList).not.toHaveBeenCalled()
  })

  it('🔴 un resultado DESCONOCIDO: 503 y el lugar sigue RESERVED', async () => {
    mockSubCreate.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })
    // Nada se libera: el cobro PUDO haber ocurrido.
    expect(prismaMock.launchCampaignRedemption.updateMany).not.toHaveBeenCalled()
    const liberado = prismaMock.launchCampaign.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.redemptionCount?.decrement)
    expect(liberado).toBeUndefined()
  })

  it('🔴 una suscripción REUSADA sin el cupón esperado: 409, lugar liberado, SIN correo y SIN APPLIED', async () => {
    mockSubCreate.mockResolvedValue({ id: 'sub_vieja' })
    // `createPlanSubscription` reusa cuando el venue ya tiene VenueFeature con suscripción.
    prismaMock.venueFeature.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_vieja' } as never)
    prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat', code: 'PLAN_PRO', monthlyPrice: 999 } as never)
    mockSubRetrieve.mockResolvedValue({ id: 'sub_vieja', discounts: [] })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_ACTIVE_WITHOUT_OFFER',
    })
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    )
    const aplicada = prismaMock.launchCampaignRedemption.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.status === 'APPLIED')
    expect(aplicada).toBeUndefined()
  })
})

describe('camino ESTÁNDAR (sin campaña)', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso({ launchCampaignId: null }) as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 69484 },
      discounts: [{ coupon: { id: 'INTRO_PRO_3M' } }],
    })
  })

  it('🔴 PRO mensual pagando hoy conserva INTRO_PRO_3M (el carril legacy sigue intacto)', async () => {
    const r = await activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 69484 } })

    expect(mockSubCreate.mock.calls[0][0].discounts).toEqual([{ coupon: 'INTRO_PRO_3M' }])
    expect(mockSubCreate.mock.calls[0][0].trial_period_days).toBe(0)
    expect(r.launchOffer).toBeUndefined()
    // Cero cupo consumido: no hay campaña.
    expect(prismaMock.launchCampaignRedemption.create).not.toHaveBeenCalled()
  })

  it('con prueba gratis: trial 30, sin cupón y sin cobro hoy', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'trialing',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_due: 0 },
    })
    await activatePlan({ ...BASE, payNow: false, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 } })

    expect(mockSubCreate.mock.calls[0][0].trial_period_days).toBe(30)
    expect(mockSubCreate.mock.calls[0][0].discounts).toBeUndefined()
  })

  it('🔴 la promoción legacy NO se derrama a PREMIUM anual', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_pa', unit_amount: 1970840 }] })
    await activatePlan({ ...BASE, tier: 'PREMIUM', interval: 'annual', offer: { kind: 'STANDARD', expectedFirstChargeCents: 1970840 } })
    expect(mockSubCreate.mock.calls[0][0].discounts).toBeUndefined()
  })
})

describe('liberarLugar', () => {
  it('🔴 sólo libera un RESERVED, y baja el contador en la MISMA transacción', async () => {
    prepararTransaccion()
    prismaMock.launchCampaignRedemption.updateMany.mockResolvedValue({ count: 1 } as never)

    await expect(liberarLugar('red-1', 'lc-1', 'motivo')).resolves.toBe(true)
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', redemptionCount: { gt: 0 } },
      data: { redemptionCount: { decrement: 1 } },
    })
  })

  it('🔴 un lugar que ya no está RESERVED NO baja el contador otra vez', async () => {
    prepararTransaccion()
    prismaMock.launchCampaignRedemption.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(liberarLugar('red-1', 'lc-1', 'motivo')).resolves.toBe(false)
    const bajada = prismaMock.launchCampaign.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.redemptionCount?.decrement)
    expect(bajada).toBeUndefined()
  })
})

/**
 * 🔴 EL LUGAR YA APARTADO QUE ES DE OTRA OFERTA (`apartarLugar`, PASO 7).
 *
 * Reusar un `RESERVED` es correcto —es lo que impide que un reintento consuma DOS lugares del
 * cupo—, pero sólo si es de ESTA campaña y de ESTA versión de oferta. El snapshot de la redención
 * es lo que el cliente consintió y NUNCA se reescribe: si se reusara el de otra versión, Stripe
 * cobraría con el cupón de HOY mientras el correo y el importe saldrían del snapshot VIEJO.
 *
 * Hasta ahora ninguna prueba tocaba esta rama: la que dice «`offerVersion` distinta» ejercita la
 * comprobación de la COTIZACIÓN (paso 3), que corre mucho antes y con otro dato.
 */
describe('un lugar RESERVED de otra oferta no se reusa', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  /** El `updateMany` que de verdad consume cupo (los otros mueven el lease o la redención). */
  function apartoLugar(): boolean {
    return prismaMock.launchCampaign.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.redemptionCount?.increment === 1)
  }

  it.each([
    ['de OTRA campaña', { id: 'red-vieja', status: 'RESERVED', campaignId: 'lc-OTRA', offerVersion: 1 }],
    ['de OTRA versión de la MISMA campaña', { id: 'red-vieja', status: 'RESERVED', campaignId: 'lc-1', offerVersion: 2 }],
  ])('🔴 un lugar %s → OFFER_CHANGED, CERO cobros y CERO cupo consumido', async (_caso, vivo) => {
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(vivo as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ statusCode: 409, code: 'OFFER_CHANGED' })

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(apartoLugar()).toBe(false)
    expect(prismaMock.launchCampaignRedemption.create).not.toHaveBeenCalled()
    // Y el lease vuelve a como estaba: no hubo cobro, así que nadie queda atrapado en IN_PROGRESS.
    expect(prismaMock.onboardingProgress.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.planActivationStatus === 'NONE')).toBe(true)
  })

  // ── REGRESIÓN: el reintento legítimo sigue reusando su lugar ───────────────
  it('el MISMO lugar de la MISMA oferta se REUSA: se cobra sin consumir un segundo lugar del cupo', async () => {
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
    } as never)

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r).toMatchObject({ status: 'ACTIVE', firstChargeCents: ANUNCIADO })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(apartoLugar()).toBe(false)
    expect(prismaMock.launchCampaignRedemption.create).not.toHaveBeenCalled()
  })

  it('un lugar ya APPLIED sigue siendo PLAN_ALREADY_ACTIVATED, no OFFER_CHANGED', async () => {
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'APPLIED',
      campaignId: 'lc-OTRA',
      offerVersion: 9,
    } as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_ALREADY_ACTIVATED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Medido EN VIVO el 18-sep durante el QA del lanzamiento, en un navegador real:
 * la base de prueba no tenía sembrada la Feature `PLAN_PRO`, el cobro murió ANTES de tocar
 * Stripe, y el cliente vio «Tu pago se está confirmando. Vuelve a intentar en unos segundos.».
 *
 * Un fallo que ocurre antes de la primera llamada a Stripe es DETERMINISTA: no existe ningún
 * cobro que pueda haber quedado a medias, así que tratarlo como «no sé» le miente al cliente
 * y deja el lugar de la campaña apartado sin motivo.
 *
 * El 503 de lo GENUINAMENTE ambiguo se conserva tal cual — es lo que impide el cobro doble —,
 * pero su texto deja de mandar al cliente a reintentar (Stripe recomienda prometer el aviso:
 * «Payment processing. We'll update you when payment is received»).
 */
type ErrorDeApp = { code?: string; statusCode?: number; message?: string }

describe('🔴 un fallo de CONFIGURACIÓN no puede disfrazarse de «pago en confirmación»', () => {
  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('falta la Feature del plan ⇒ dice que es un problema de configuración, NO «se está confirmando»', async () => {
    prismaMock.feature.findFirst.mockResolvedValue(null as never)

    const err = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).then<ErrorDeApp, ErrorDeApp>(
      () => {
        throw new Error('no debió resolver: activatePlan tenía que rechazar')
      },
      (e: unknown) => e as ErrorDeApp,
    )

    expect(err.code).toBe('PLAN_NOT_CONFIGURED')
    expect(err.code).not.toBe('PLAN_ACTIVATION_PENDING')
    expect(err.message).not.toMatch(/se está confirmando/i)
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('el 503 de lo GENUINAMENTE desconocido sigue existiendo, pero promete aviso en vez de mandar a reintentar', async () => {
    mockSubCreate.mockRejectedValue(new Error('socket hang up'))

    const err = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).then<ErrorDeApp, ErrorDeApp>(
      () => {
        throw new Error('no debió resolver: activatePlan tenía que rechazar')
      },
      (e: unknown) => e as ErrorDeApp,
    )

    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('PLAN_ACTIVATION_PENDING')
    expect(err.message).not.toMatch(/vuelve a intentar|intenta de nuevo/i)
    expect(err.message).toMatch(/te avisamos|avisaremos/i)
  })
})

/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #3): la ÚLTIMA plaza bloquea su propia recuperación.
 *
 * Secuencia real: queda un lugar → el negocio lo reserva → Stripe cobra → se pierde la respuesta
 * (red, cierre de pestaña, timeout) → el cliente reintenta.
 *
 * `cotizar()` comprueba la disponibilidad de la campaña en el PASO 3, y la recuperación del intento
 * anterior vive en el PASO 6. Con el cupo lleno POR SU PROPIA RESERVA, el PASO 3 corta con
 * `SOLD_OUT` y nunca se llega al 6: el negocio queda **cobrado, con el lugar apartado a su nombre, y
 * recibiendo la respuesta que se le da a un comprador nuevo que llegó tarde**.
 *
 * El lugar ya es suyo — el cupo protege de vender de MÁS, no de dejar terminar a quien ya apartó.
 * `apartarLugar` ya sabe reusar un `RESERVED` propio (PASO 7); el defecto es sólo el orden.
 */
describe('la recuperación no puede quedar fuera por un cupo que el propio negocio consumió', () => {
  function campanaLlenaConMiLugarApartado() {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ redemptionCount: 100, redemptionCap: 100 }) as never)
    // El lugar está apartado a NOMBRE DE ESTA organización, misma campaña y misma versión.
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-mia',
      organizationId: 'org-1',
      campaignId: 'lc-1',
      offerVersion: 1,
      status: 'RESERVED',
      advertisedPriceCents: ANUNCIADO,
      listPriceCents: LISTA,
      discountMonths: 3,
    } as never)
  }

  it('🔴 con el cupo lleno por SU PROPIA reserva, el reintento NO recibe «agotado»', async () => {
    campanaLlenaConMiLugarApartado()
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date('2020-01-01'),
      }) as never,
    )

    // No importa cómo termine el intento; lo que NO puede pasar es que se le diga «agotado» a
    // quien ya tiene el lugar y probablemente ya pagó.
    const resultado = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch((e: unknown) => e)
    const codigo = (resultado as { code?: string })?.code
    expect(codigo).not.toBe('LAUNCH_OFFER_UNAVAILABLE')
  })

  it('un negocio SIN lugar apartado sí recibe «agotado»: el cupo sigue protegiendo de sobrevender', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ redemptionCount: 100, redemptionCap: 100 }) as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({
      code: 'LAUNCH_OFFER_UNAVAILABLE',
    })
  })

  it('🔴 un lugar de OTRA versión de oferta NO sirve de salvoconducto: eso es `OFFER_CHANGED`', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ redemptionCount: 100, redemptionCap: 100 }) as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-vieja',
      organizationId: 'org-1',
      campaignId: 'lc-1',
      offerVersion: 99, // el precio que consintió NO es el de hoy
      status: 'RESERVED',
    } as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)

    const resultado = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch((e: unknown) => e)
    expect((resultado as { code?: string })?.code).not.toBe('LAUNCH_OFFER_UNAVAILABLE')
  })
})

/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #4): COBRADO SIN ACCESO.
 *
 * Si Stripe crea y cobra la suscripción pero falla el `upsert` de `VenueFeature` (un fallo de DB en
 * el peor segundo posible), el reintento ENCUENTRA la suscripción en Stripe y por eso **salta
 * `createPlanSubscription`** — que es justo quien escribe esa fila. Después marca el onboarding
 * ACTIVE, la redención APPLIED y `Venue.planTier`… sin reconstruir el acceso.
 *
 * El acceso efectivo se resuelve consultando `VenueFeature`. Los webhooks tampoco lo reparan: buscan
 * la fila y si no está, abandonan.
 *
 * Resultado: el negocio pagó, la campaña lo cuenta como convertido, y el producto no le funciona.
 * Es el peor desenlace posible de esta pantalla — peor que un cobro fallido, porque nadie se entera.
 */
describe('recuperar un cobro también reconstruye el ACCESO, no sólo el estado', () => {
  function intentoPerdidoConSuscripcionViva() {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date('2020-01-01'),
      }) as never,
    )
    // Stripe SÍ tiene la suscripción del intento anterior: se va a recuperar.
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        await cb({ id: 'sub_recuperada', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:1' } })
      },
    })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_recuperada',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })
    // …y la fila de acceso NO existe (es exactamente el fallo que se está recuperando).
    prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  }

  it('🔴 al recuperar la suscripción, el acceso se ENTREGA (V5-A: la entrega escribe la fila, no un upsert ciego)', async () => {
    intentoPerdidoConSuscripcionViva()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(() => undefined)

    expect(mockEntregar).toHaveBeenCalled()
  })

  it('🔴 y queda ligado a la suscripción RECUPERADA, no a una inventada', async () => {
    intentoPerdidoConSuscripcionViva()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(() => undefined)

    expect(mockEntregar).toHaveBeenCalledWith({
      venueId: 'venue-1',
      subscriptionId: 'sub_recuperada',
      detectedBy: 'onboarding.activatePlan',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 AUDITORÍA DE CODEX (2026-09-18, hallazgo #7b): se puede COBRAR sin consentimiento.
 *
 * `activate-plan` es el camino que cobra la oferta, y **no exige `termsAcceptedAt`**. La única
 * comprobación vive en `completeV2Onboarding` (`onboarding.controller.ts:1104`) — es decir,
 * DESPUÉS del punto donde el cargo ya pudo ocurrir.
 *
 * No es formalismo: el cargo es RECURRENTE y se hace a una tarjeta. Cobrar un plan mensual a
 * alguien que nunca aceptó los términos ni el aviso de privacidad es exactamente lo que un
 * contracargo discute, y en México el aviso de privacidad tiene además su propia exigencia legal.
 *
 * El consentimiento se comprueba ANTES de tocar Stripe, no después: lo contrario es pedir perdón
 * con el dinero ya movido.
 */
describe('no se cobra sin consentimiento', () => {
  it('🔴 sin términos aceptados, `activate-plan` NO llega a cobrar', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso({ termsAcceptedAt: null }) as never)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({
      code: 'TERMS_NOT_ACCEPTED',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('con términos aceptados sigue cobrando igual que siempre', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)

    expect(mockSubCreate).toHaveBeenCalled()
  })
})

/**
 * 🔴 SEGUNDA AUDITORÍA DE CODEX (2026-09-18): la recuperación concede el tier que pide el
 * REINTENTO, sin comprobar cuál se cobró de verdad, y reusa suscripciones que ya no están vivas.
 *
 * `status: 'all'` en la búsqueda es correcto para NO cobrar dos veces (hay que encontrarla aunque
 * esté rara), pero después el código hacía dos cosas distintas con el hallazgo:
 *
 *   - `asegurarAccesoDelPlan({ tierCode: input.tier … })` — o sea, lo que manda ESTE intento. Si el
 *     primero cobró PRO y el reintento pide PREMIUM, se reusa la suscripción PRO (bien, no cobra
 *     dos veces) y se concede acceso PREMIUM (mal: paga $1,158 de Pro y recibe Premium).
 *   - ningún filtro de estado: una `canceled` o `incomplete_expired` — donde el dinero NO quedó
 *     cobrado — también «recupera» y cierra el onboarding en ACTIVE.
 *
 * La suscripción ya trae la verdad en `metadata.featureCode` (lo escribe `createPlanSubscription`).
 */
describe('la recuperación honra lo que SE COBRÓ, no lo que pide el reintento', () => {
  const recuperada = (extra: Record<string, unknown>) => ({
    id: 'sub_buena',
    status: 'active',
    metadata: { planActivationKey: 'plan-activation:org-1:1', featureCode: 'PLAN_PRO' },
    ...extra,
  })

  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
    } as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_buena',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })
  })

  const listar = (sub: unknown) =>
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        await cb(sub)
      },
    })

  it('🔴 concede el tier de la suscripción COBRADA, no el que manda el reintento', async () => {
    // Camino estándar (sin campaña): con campaña, pedir otro tier rebota antes por la propia oferta.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        launchCampaignId: null,
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
      }) as never,
    )
    // Lo COBRADO fue Premium; este reintento pide Pro.
    listar(recuperada({ metadata: { planActivationKey: 'plan-activation:org-1:1', featureCode: 'PLAN_PREMIUM' } }))

    // La entrega lee el tier del PRECIO vigente de la suscripción cobrada (su suite lo prueba): aquí concede Premium.
    mockEntregar.mockResolvedValue({ ...CONCEDIDO_PRO, featureCode: 'PLAN_PREMIUM', subscriptionId: 'sub_buena' })

    await activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 }, payNow: false })

    // Se entrega la suscripción COBRADA (sin pasarle el tier pedido)…
    expect(mockEntregar).toHaveBeenCalledWith({ venueId: 'venue-1', subscriptionId: 'sub_buena', detectedBy: 'onboarding.activatePlan' })
    // …y el negocio queda con el tier CONCEDIDO, no con el que pide el reintento.
    expect(prismaMock.venue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { planTier: 'PREMIUM' } }))
  })

  it('🔴 26-sep: un reintento «Pagar hoy» (cupón INTRO) sobre un cobro de Premium SIN cupón entrega lo cobrado, no 409', async () => {
    // Lo vio el founder: pagó Premium ($1,970.84), la entrega falló, recargó, la pantalla volvió con Pro y «Pagar hoy».
    // El server juzgaba el cobro RECUPERADO contra el cupón del REINTENTO («INTRO_PRO_3M»), no lo encontraba y cerraba
    // con PLAN_ACTIVE_WITHOUT_OFFER SIN conceder nada: cobrado y sin acceso, con «no te cobramos nada» en pantalla.
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        launchCampaignId: null,
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
      }) as never,
    )
    listar(recuperada({ metadata: { planActivationKey: 'plan-activation:org-1:1', featureCode: 'PLAN_PREMIUM' } }))
    mockEntregar.mockResolvedValue({ ...CONCEDIDO_PRO, featureCode: 'PLAN_PREMIUM', subscriptionId: 'sub_buena' })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_buena',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 197084 },
      discounts: [],
    })

    const r = await activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 69484 }, payNow: true })

    expect(mockSubCreate).not.toHaveBeenCalled() // nunca un segundo cobro
    expect(mockEntregar).toHaveBeenCalledWith({ venueId: 'venue-1', subscriptionId: 'sub_buena', detectedBy: 'onboarding.activatePlan' })
    expect(r).toMatchObject({ status: 'ACTIVE', tier: 'PREMIUM' })
  })

  it('🔴 Codex C12: lo que se GUARDA y se RESPONDE es lo cobrado (tier e intervalo), no lo que pide el reintento', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        launchCampaignId: null,
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
      }) as never,
    )
    listar(recuperada({ metadata: { planActivationKey: 'plan-activation:org-1:1', featureCode: 'PLAN_PREMIUM' } }))
    mockEntregar.mockResolvedValue({ ...CONCEDIDO_PRO, featureCode: 'PLAN_PREMIUM', subscriptionId: 'sub_buena' })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_buena',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 169900 },
      items: { data: [{ price: { recurring: { interval: 'year' } } }] },
    })

    // Lo COBRADO fue Premium ANUAL; este reintento pide Pro mensual.
    const r = await activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 }, payNow: false })

    expect(r).toMatchObject({ tier: 'PREMIUM', interval: 'annual' })
    const cierre = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      c => c[0].data?.planActivationStatus === 'ACTIVE',
    )
    expect(cierre).toBeDefined()
    expect(planDelCierre()).toMatchObject({ tier: 'PREMIUM', interval: 'annual' })
  })

  it('🔴 una suscripción CANCELADA no se lee como cobro recuperado', async () => {
    listar(recuperada({ status: 'canceled' }))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ statusCode: 503 })
    // Y sobre todo: no se cobra otra vez encima de una suscripción que existe.
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('una suscripción `incomplete_expired` nunca cobró: se estrena intento', async () => {
    listar(recuperada({ status: 'incomplete_expired' }))

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('sin `featureCode` en la metadata (suscripción vieja) cae al tier pedido, como antes', async () => {
    listar({ id: 'sub_buena', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:1' } })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 V5-A paso 6 (diseño v5, puntos 5 y 6): el alta que cobra converge en la regla común y en la entrega.
 *
 * - El cobro NUEVO pasa por la regla (candado por negocio + lo VIVO en Stripe): si el negocio ya tiene un plan cobrando
 *   —p. ej. pagó por el dashboard— el alta NO cobra encima y lo dice.
 * - El acceso lo escribe la entrega (ve las dos filas de plan), no un `upsert` ciego que concedía aunque otra obligación
 *   viva ocupara el plan.
 */
describe('🔴 V5-A paso 6: el alta cobra dentro de la regla común y el acceso lo escribe la entrega', () => {
  beforeEach(() => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
  })

  it('el cobro pasa por la regla, marcado como alta (para no bloquearse con su propio «cobro en curso»)', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)

    expect(mockAutorizar).toHaveBeenCalledWith('venue-1', 'cus_1', { tipo: 'PLAN', tier: 'PRO' }, expect.any(Function), {
      desdeElAlta: true,
    })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('🔴 si la regla rechaza ANTES de cobrar (ya hay un plan vivo): su 409 se propaga, el lease se suelta y el lugar se libera', async () => {
    mockAutorizar.mockRejectedValue(Object.assign(new Error('Ya hay un plan cobrando'), { statusCode: 409, code: 'PLAN_YA_CONTRATADO' }))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_YA_CONTRATADO' })

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planActivationStatus: 'NONE', planActivationLeaseUntil: null } }),
    )
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    )
    expect(mockEntregar).not.toHaveBeenCalled()
  })

  it('el acceso lo escribe la entrega, con la suscripción recién cobrada (nada de upsert)', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)

    expect(mockEntregar).toHaveBeenCalledWith({ venueId: 'venue-1', subscriptionId: 'sub_1', detectedBy: 'onboarding.activatePlan' })
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
  })

  it('🔴 si la entrega falla DESPUÉS del cobro: 503 pendiente, el lease NO se suelta y el lugar sigue apartado', async () => {
    mockEntregar.mockRejectedValue(new Error('lock timeout'))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationLeaseUntil: null }) }),
    )
    expect(prismaMock.launchCampaignRedemption.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    )
  })

  it('🔴 si la entrega NO concede con la suscripción vigente (quedó en conflicto), el alta no se cierra como ACTIVE', async () => {
    mockEntregar.mockResolvedValue(null)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ statusCode: 503 })

    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationStatus: 'ACTIVE' }) }),
    )
  })
})

/**
 * 🔴 Codex C6 (22-sep): la toma del lease no era exclusiva al RECUPERAR uno vencido. El CAS comprobaba estado e intento,
 * que no cambian al recuperar: dos peticiones lo tomaban a la vez; una cobraba y la otra —rechazada después por la regla—
 * liberaba el lugar de la oferta que la primera estaba usando.
 */
describe('🔴 C6: el lease del alta tiene UN dueño', () => {
  const VENCIDO = new Date('2020-01-01T00:00:00Z')
  beforeEach(() => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('la toma exige el vencimiento que se LEYÓ: la segunda recuperación no lo toma', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: VENCIDO }) as never,
    )
    mockSubList.mockReturnValue({ autoPagingEach: async () => undefined })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(() => undefined)

    const toma = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls[0][0]
    expect(toma.where).toMatchObject({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: VENCIDO })
  })

  it('si el avance de intento no toca la fila (ya no es nuestra), NO cobra', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: VENCIDO }) as never,
    )
    mockSubList.mockReturnValue({ autoPagingEach: async () => undefined })
    ;(prismaMock.onboardingProgress.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_ACTIVATION_IN_PROGRESS' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('si al cerrar el lugar de la oferta ya no estaba apartado, el alta NO se da por aplicada', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    ;(prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('si al cerrar el intento ya no es nuestro, tampoco', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    ;(prismaMock.onboardingProgress.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('🔴 Codex C15: «pudo cobrarse» se marca justo ANTES del POST, no al empezar a preparar', () => {
  it('un fallo PREVIO al envío (el plan desaparece del catálogo) no se trata como cobro desconocido: suelta el lease y el lugar', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    ;(prismaMock.feature.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 }) // verificarPlanConfigurado
      .mockResolvedValueOnce(null) // createPlanSubscription, antes de tocar Stripe

    const error = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(e => e)

    expect(error?.code).not.toBe('PLAN_ACTIVATION_PENDING')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planActivationStatus: 'NONE', planActivationLeaseUntil: null } }),
    )
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    )
  })
})

/**
 * 🔴 Codex R4 (22-sep, ronda 2): C6 le puso dueño a la TOMA del lease y se lo dejó sin dueño al SOLTARLO. Tres escrituras
 * cierran el intento (soltar, DECLINED, ACTIVE) mirando sólo estado+intento, que no cambian cuando otra petición recupera
 * un lease vencido: la petición vieja le pisaba el IN_PROGRESS a la nueva mientras ésta cobraba. Y el vencimiento nacía
 * de un reloj capturado ANTES de cinco llamadas externas, así que podía tomarse ya casi vencido.
 */
describe('🔴 R4: el lease también tiene dueño al SOLTARLO', () => {
  beforeEach(() => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
  })

  /** El `updateMany` que TOMA el lease es el primero: de ahí sale la marca del dueño. */
  function tomaDelLease() {
    return (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls[0][0]
  }

  it('🔴 el vencimiento se mide desde que se TOMA, no desde que entró la petición', async () => {
    // El reloj corre de verdad durante las llamadas externas previas (precio, plan, cliente, tarjeta).
    let finDeLasLlamadas = 0
    mockPmRetrieve.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30))
      finDeLasLlamadas = Date.now()
      return { id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } }
    })

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)

    const vence = (tomaDelLease().data.planActivationLeaseUntil as Date).getTime()
    expect(finDeLasLlamadas).toBeGreaterThan(0)
    expect(vence).toBeGreaterThanOrEqual(finDeLasLlamadas + LEASE_MS)
  })

  it('🔴 soltar el lease exige ser su dueño (si no, le pisa el intento a quien está cobrando)', async () => {
    mockAutorizar.mockRejectedValue(Object.assign(new Error('Ya hay un plan cobrando'), { statusCode: 409, code: 'PLAN_YA_CONTRATADO' }))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_YA_CONTRATADO' })

    const nuestro = tomaDelLease().data.planActivationLeaseUntil
    const soltar = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'NONE',
    )
    expect(soltar?.[0].where).toMatchObject({ planActivationLeaseUntil: nuestro })
  })

  it('🔴 el paso a DECLINED exige ser su dueño', async () => {
    mockSubCreate.mockRejectedValue(
      Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', decline_code: 'generic_decline' }),
    )

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_PAYMENT_DECLINED' })

    const nuestro = tomaDelLease().data.planActivationLeaseUntil
    const decl = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'DECLINED',
    )
    expect(decl?.[0].where).toMatchObject({ planActivationLeaseUntil: nuestro })
  })

  it('🔴 un DECLINED que YA no tocó la fila no libera el lugar de la oferta', async () => {
    mockSubCreate.mockRejectedValue(
      Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', decline_code: 'generic_decline' }),
    )
    // El intento ya no es nuestro: otra petición recuperó el lease y está cobrando con ESE lugar.
    ;(prismaMock.onboardingProgress.updateMany as jest.Mock).mockImplementation(async (args: any) =>
      args?.data?.planActivationStatus === 'DECLINED' ? { count: 0 } : { count: 1 },
    )

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_PAYMENT_DECLINED' })

    const liberado = (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'RELEASED',
    )
    expect(liberado).toBeUndefined()
  })

  it('🔴 el cierre ACTIVE exige ser su dueño', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)

    const nuestro = tomaDelLease().data.planActivationLeaseUntil
    const cierre = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE',
    )
    expect(cierre?.[0].where).toMatchObject({ planActivationLeaseUntil: nuestro })
  })
})

/**
 * 🔴 Codex R13 (ronda 2): al RECUPERAR un cobro anterior, lo que se guarda y se responde tiene que ser lo que de verdad
 * se cobró, nunca lo que pide el formulario de este reintento. Faltaban dos: con la entrega sin conceder (la suscripción
 * recuperada está en `past_due`, que el guard no detiene) el tier caía en `input.tier` y el alta se cerraba anunciando
 * PREMIUM sobre un cobro PRO; y `payNow` salía igual del formulario, así que recuperar un pago YA hecho podía anunciarse
 * como prueba gratis.
 */
describe('🔴 R13: lo que se guarda es lo COBRADO, no lo que pide el reintento', () => {
  const VENCIDO = new Date('2020-01-01T00:00:00Z')
  beforeEach(() => {
    // `tierQueVendeLaSuscripcion` clasifica con el catálogo de planes.
    prismaMock.feature.findMany.mockResolvedValue([
      { code: 'PLAN_PRO', stripeProductId: 'prod_pro' },
      { code: 'PLAN_PREMIUM', stripeProductId: 'prod_premium' },
    ] as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(null as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        launchCampaignId: null,
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: VENCIDO,
        planStripeSubscriptionId: 'sub_vieja',
      }) as never,
    )
  })

  it('🔴 una suscripción PRO recuperada en past_due que la entrega NO concede: el alta NO se cierra como PREMIUM', async () => {
    mockEntregar.mockResolvedValue(null)
    // El precio de lista que Stripe reporta es el de PREMIUM mensual, o la verificación previa corta antes de llegar.
    mockPriceList.mockResolvedValue({
      data: [
        {
          id: 'price_x',
          unit_amount: standardPlanQuote().grossCents.PREMIUM.monthly,
          currency: 'mxn',
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
        },
      ],
    })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_vieja',
      status: 'past_due',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 0 },
      items: {
        data: [{ price: { id: 'price_pro', product: 'prod_pro', lookup_key: 'plan_pro_monthly', recurring: { interval: 'month' } } }],
      },
    })

    const r = await activatePlan({
      ...BASE,
      tier: 'PREMIUM',
      payNow: false,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: standardFirstChargeCents(standardPlanQuote(), 'PREMIUM', 'monthly', false) },
    } as never)

    // Lo que se cobró es PRO: eso es lo que se guarda, se responde y se le pone al negocio — nunca el PREMIUM del
    // formulario. El guard anterior sólo detenía `active`/`trialing`, así que este `past_due` pasaba y mentía.
    expect(r.tier).toBe('PRO')
    expect(prismaMock.venue.update).toHaveBeenCalledWith({ where: { id: 'venue-1' }, data: { planTier: 'PRO' } })
    expect(prismaMock.venue.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { planTier: 'PREMIUM' } }))
    const cierre = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE',
    )
    expect(cierre).toBeDefined()
    expect(planDelCierre()).toMatchObject({ tier: 'PRO' })
  })

  it('🔴 y si no se puede determinar qué plan vende (dos planes en la misma suscripción), no se cierra el alta', async () => {
    mockEntregar.mockResolvedValue(null)
    mockPriceList.mockResolvedValue({
      data: [
        {
          id: 'price_x',
          unit_amount: standardPlanQuote().grossCents.PREMIUM.monthly,
          currency: 'mxn',
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
        },
      ],
    })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_vieja',
      status: 'past_due',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 0 },
      items: {
        data: [
          { price: { id: 'price_pro', product: 'prod_pro', lookup_key: 'plan_pro_monthly', recurring: { interval: 'month' } } },
          { price: { id: 'price_prem', product: 'prod_premium', lookup_key: 'plan_premium_monthly', recurring: { interval: 'month' } } },
        ],
      },
    })

    await expect(
      activatePlan({
        ...BASE,
        tier: 'PREMIUM',
        payNow: false,
        offer: { kind: 'STANDARD', expectedFirstChargeCents: standardFirstChargeCents(standardPlanQuote(), 'PREMIUM', 'monthly', false) },
      } as never),
    ).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_ACTIVATION_PENDING' })

    const cierre = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE',
    )
    expect(cierre).toBeUndefined()
  })

  it('🔴 recuperar un cobro YA hecho no se guarda como prueba gratis aunque el formulario diga `payNow: false`', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_vieja',
      status: 'active',
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 115884 },
      items: {
        data: [{ price: { id: 'price_pro', product: 'prod_pro', lookup_key: 'plan_pro_monthly', recurring: { interval: 'month' } } }],
      },
    })

    await activatePlan({
      ...BASE,
      payNow: false,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: standardFirstChargeCents(standardPlanQuote(), 'PRO', 'monthly', false) },
    } as never)

    const cierre = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE',
    )
    expect(cierre).toBeDefined()
    expect(planDelCierre()).toMatchObject({ payNow: true })
  })
})

/**
 * 🔴 Codex #14 (ronda 3 y 4, P1): rechazar el intento y liberar el lugar del cupo estaban en transacciones DISTINTAS.
 * Entre una y otra, otra petición tomaba un intento nuevo y reusaba la reserva —que seguía `RESERVED`— y la primera la
 * liberaba por debajo: la segunda podía cobrar y fallar al marcarla `APPLIED`, y el contador dejaba vender ese lugar
 * otra vez. Comprobar `count === 1` antes de abrir OTRA transacción no cierra esa ventana. Y las salidas por «no
 * autorizado» y «reusada sin cupón» liberaban sin acreditar siquiera la propiedad del intento.
 */
describe('🔴 #14: liberar el lugar exige ser el dueño, y va con el cambio de estado', () => {
  beforeEach(() => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
  })

  /** El lease ya no es nuestro: cualquier escritura condicionada a él no toca ninguna fila. */
  const elLeaseYaNoEsNuestro = () =>
    (prismaMock.onboardingProgress.updateMany as jest.Mock).mockImplementation(async (args: any) =>
      args?.where?.planActivationLeaseUntil && args?.data?.planActivationStatus !== 'IN_PROGRESS' ? { count: 0 } : { count: 1 },
    )

  it('🔴 la regla rechaza ANTES de cobrar y el lease ya no es nuestro: NO se libera el lugar', async () => {
    mockAutorizar.mockRejectedValue(Object.assign(new Error('otro plan vivo'), { statusCode: 409, code: 'PLAN_YA_CONTRATADO' }))
    elLeaseYaNoEsNuestro()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({ code: 'PLAN_YA_CONTRATADO' })

    const liberado = (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'RELEASED',
    )
    expect(liberado).toBeUndefined()
  })

  it('🔴 una suscripción reusada SIN el cupón y el lease ya no es nuestro: NO se libera el lugar', async () => {
    mockSubCreate.mockResolvedValue({ id: 'sub_vieja' })
    prismaMock.venueFeature.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_vieja' } as never)
    mockSubRetrieve.mockResolvedValue({ id: 'sub_vieja', discounts: [] })
    elLeaseYaNoEsNuestro()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never)).rejects.toMatchObject({
      code: 'PLAN_ACTIVE_WITHOUT_OFFER',
    })

    const liberado = (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'RELEASED',
    )
    expect(liberado).toBeUndefined()
  })
})

describe('🔴 Codex R12: hayCobroDelAltaSinCerrar — lo que consulta `complete` antes de dejar cerrar en Gratis', () => {
  const base = { organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 2, planStripeSubscriptionId: null }
  const lista = (subs: unknown[]) =>
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean) => {
        for (const s of subs) if (cb(s) === false) break
      },
    })

  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', stripeCustomerId: 'cus_1' }] as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.billingObligationConflict.findMany.mockResolvedValue([])
    prismaMock.feature.findMany.mockResolvedValue([{ code: 'CFDI', stripeProductId: 'prod_cfdi' }] as never)
  })

  it('sin intento en curso: no hay nada abierto (ni se consulta Stripe)', async () => {
    expect(await hayCobroDelAltaSinCerrar({ ...base, planActivationStatus: 'NONE' })).toBe(false)
    expect(mockSubList).not.toHaveBeenCalled()
  })
  it('con id guardado: abierto', async () => {
    expect(await hayCobroDelAltaSinCerrar({ ...base, planStripeSubscriptionId: 'sub_x' })).toBe(true)
  })
  it('🔴 sin id pero Stripe tiene la suscripción de ESE intento: abierto', async () => {
    lista([
      { id: 'sub_otro', status: 'active', metadata: {} },
      { id: 'sub_perdida', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:2' } },
    ])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
    expect(mockSubList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', status: 'all' }))
  })
  it('sin id y Stripe confirma que no existe (o murió sin cobrar): se puede cerrar en Gratis', async () => {
    lista([{ id: 'sub_muerta', status: 'incomplete_expired', metadata: { planActivationKey: 'plan-activation:org-1:2' } }])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(false)
  })
  it('🔴 Codex R13: una suscripción VIVA sin la llave (la del carril viejo de `complete`) cuenta como abierta', async () => {
    lista([{ id: 'sub_legacy', status: 'active', metadata: { featureCode: 'PLAN_PRO' } }])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
  })
  it('🔴 Codex R14: una suscripción viva de OTRA cosa (CFDI) no es un cobro del alta: no bloquea Gratis', async () => {
    lista([
      {
        id: 'sub_cfdi',
        status: 'active',
        metadata: { featureCode: 'CFDI' },
        items: { data: [{ price: { id: 'price_cfdi', product: 'prod_cfdi' } }] },
      },
    ])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(false)
  })
  it.each([
    [
      'dos planes',
      {
        data: [
          { price: { id: 'price_pro', product: 'prod_pro', lookup_key: 'plan_pro_monthly' } },
          { price: { id: 'price_premium', product: 'prod_premium', lookup_key: 'plan_premium_monthly' } },
        ],
      },
    ],
    ['ítems incompletos', { has_more: true, data: [{ price: { id: 'price_cfdi', product: 'prod_cfdi' } }] }],
    ['producto desconocido', { data: [{ price: { id: 'price_unknown', product: 'prod_unknown' } }] }],
  ])('R15: %s no demuestra ausencia de un cobro pendiente', async (_caso, items) => {
    lista([{ id: 'sub_legacy', status: 'active', metadata: {}, items }])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
  })
  it('R15: el precio de plan prevalece sobre metadata que dice CFDI', async () => {
    lista([
      {
        id: 'sub_legacy',
        status: 'active',
        metadata: { featureCode: 'CFDI' },
        items: { data: [{ price: { id: 'price_pro', product: 'prod_pro', lookup_key: 'plan_pro_monthly' } }] },
      },
    ])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
  })
  it('una suscripción sin la llave que ya NO cobra (cancelada) no bloquea', async () => {
    lista([{ id: 'sub_vieja', status: 'canceled', metadata: {} }])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(false)
  })
  it('🔴 «no pude ver» NUNCA es «no existe»: Stripe caído ⇒ abierto', async () => {
    mockSubList.mockReturnValue({ autoPagingEach: async () => Promise.reject(new Error('stripe caído')) })
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
  })
  it('sin cliente de Stripe no pudo crearse ninguna suscripción', async () => {
    prismaMock.venue.findMany.mockResolvedValue([] as never)
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(false)
  })

  it.each([true, false])('revisa también la siguiente página de sucursales antes de cerrar (cobro pendiente: %s)', async pending => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: `venue-${String(i).padStart(3, '0')}`, stripeCustomerId: 'cus_empty' }))
    prismaMock.venue.findMany
      .mockResolvedValueOnce(firstPage as never)
      .mockResolvedValueOnce([{ id: 'venue-last', stripeCustomerId: 'cus_last' }] as never)
    mockSubList.mockImplementation(({ customer }: { customer: string }) => ({
      autoPagingEach: async (cb: (s: unknown) => boolean) => {
        if (pending && customer === 'cus_last') {
          cb({ id: 'sub_pending', status: 'active', metadata: { planActivationKey: 'plan-activation:org-1:2' } })
        }
      },
    }))

    expect(await hayCobroDelAltaSinCerrar(base)).toBe(pending)
    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.venue.findMany).toHaveBeenNthCalledWith(1, {
      where: { organizationId: 'org-1', stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
    expect(prismaMock.venue.findMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-1', stripeCustomerId: { not: null }, id: { gt: 'venue-099' } },
      select: { id: true, stripeCustomerId: true },
      orderBy: { id: 'asc' },
      take: 100,
    })
  })
})

/**
 * 🔴 D2 (18-oct): con una tarjeta que pide 3D Secure en el primer cobro, `error_if_incomplete` responde 402
 * `subscription_payment_intent_requires_action` y el alta lo trataba como RECHAZO (DECLINED, lugar liberado, «Tu banco
 * rechazó el cargo»). Ahora se crea la suscripción `default_incomplete` (S1), se responde 409 con el secreto para el reto
 * del banco, y el acceso sólo se entrega con la PRIMERA factura pagada por el monto consentido.
 */
describe('🔴 D2: el banco pide autenticar el primer cobro (primer pedido)', () => {
  const errorDeAutenticacion = () =>
    Object.assign(new Error('Payment for this subscription requires additional user action…'), {
      type: 'StripeCardError',
      code: 'subscription_payment_intent_requires_action',
      statusCode: 402,
    })
  const errorDeConexion = () => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
  const porAutenticar = {
    id: 'sub_3ds',
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: 'pi_1_secret_x' } },
  }
  /** #1 pide autenticar; #2 queda `incomplete` con el secreto. */
  const pideAutenticar = () => mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion()).mockResolvedValueOnce(porAutenticar)
  /** #1 pide autenticar; #2 vuelve `active` sin reto (p. ej. factura de $0): el monto lo exige activatePlan. */
  const segundoActivo = () =>
    mockSubCreate
      .mockRejectedValueOnce(errorDeAutenticacion())
      .mockResolvedValueOnce({ id: 'sub_3ds', status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: 0 } })
  const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map(c => c[0])
  const redenciones = () => (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.map(c => c[0])
  const conEstado = (estado: string) => progresos().filter(a => a?.data?.planActivationStatus === estado)
  const redencionCon = (estado: string) => redenciones().filter(a => a?.data?.status === estado)
  const soltoElLease = () =>
    progresos().some(a => a?.data && 'planActivationLeaseUntil' in a.data && a.data.planActivationLeaseUntil === null)

  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
  })

  it('responde 409 PLAN_PAYMENT_REQUIRES_ACTION con el secreto, y NO es un rechazo', async () => {
    pideAutenticar()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PAYMENT_REQUIRES_ACTION',
      details: { clientSecret: 'pi_1_secret_x' },
    })

    expect(conEstado('DECLINED')).toEqual([])
    expect(redencionCon('RELEASED')).toEqual([])
    expect(redencionCon('APPLIED')).toEqual([])
    const bajada = (prismaMock.launchCampaign.updateMany as jest.Mock).mock.calls.find((c: any[]) => c[0]?.data?.redemptionCount?.decrement)
    expect(bajada).toBeUndefined()
    expect(mockEntregar).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it('🔴 el id de la suscripción incompleta queda guardado en cuanto existe', async () => {
    pideAutenticar()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planStripeSubscriptionId: 'sub_3ds' } }),
    )
  })

  it('🔴 suelta el lease SIN salir de IN_PROGRESS y con la marca del dueño', async () => {
    pideAutenticar()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_PAYMENT_REQUIRES_ACTION' })

    const nuestro = progresos()[0].data.planActivationLeaseUntil
    expect(nuestro).toBeInstanceOf(Date)
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: nuestro },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
  })

  it('el 2.º create lleva la llave «:autenticar» y la MISMA planActivationKey en la metadata', async () => {
    pideAutenticar()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    expect(mockSubCreate.mock.calls[1][1].idempotencyKey).toBe('plan-activation:org-1:1:autenticar')
    expect(mockSubCreate.mock.calls[1][0].metadata.planActivationKey).toBe('plan-activation:org-1:1')
    // El monto contra el que se exigirá la factura pagada es el que cotizó el servidor.
    expect(mockSubCreate.mock.calls[1][0].metadata.primerCobroEsperadoCents).toBe(String(ANUNCIADO))
  })

  it('🔴 el secreto nunca llega al log', async () => {
    pideAutenticar()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_PAYMENT_REQUIRES_ACTION' })

    expect(logger.info).toHaveBeenCalledWith('activate-plan: el banco pide autorizar el primer cobro', {
      organizationId: 'org-1',
      subscriptionId: 'sub_3ds',
    })
    const todo = (['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => (logger[nivel] as jest.Mock).mock.calls)
    expect(inspect(todo, { depth: 10 })).not.toContain('_secret_')
  })

  it('el 2.º create sin respuesta de Stripe ⇒ 503, lugar RESERVED, lease VIVO', async () => {
    mockSubCreate
      .mockRejectedValueOnce(errorDeAutenticacion())
      .mockRejectedValueOnce(errorDeConexion())
      .mockRejectedValueOnce(errorDeConexion())

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockSubCreate).toHaveBeenCalledTimes(3)
    expect(redencionCon('RELEASED')).toEqual([])
    expect(soltoElLease()).toBe(false)
  })

  it('🔴 sin tiempo en el candado para el 2.º create ⇒ 503, intento IN_PROGRESS y lugar RESERVED', async () => {
    // Codex r1 #4: cada consulta de precio tarda 140 s en este reloj; la de DENTRO del candado deja sin tiempo al #2.
    let reloj = Date.now()
    const ahora = jest.spyOn(Date, 'now').mockImplementation(() => reloj)
    mockPriceList.mockImplementation(async () => {
      reloj += 140_000
      return { data: [{ id: 'price_x', unit_amount: LISTA, currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive' }] }
    })
    mockSubCreate.mockRejectedValueOnce(errorDeAutenticacion())

    try {
      await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
        statusCode: 503,
        code: 'PLAN_ACTIVATION_PENDING',
      })
    } finally {
      ahora.mockRestore()
    }

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(redencionCon('RELEASED')).toEqual([])
    expect(conEstado('DECLINED')).toEqual([])
    expect(soltoElLease()).toBe(false)
  })

  it('🔴 candado del cierre: una suscripción REUSADA en incomplete nunca cierra ACTIVE ni APPLIED', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_inc' } as never)
    prismaMock.feature.findMany.mockResolvedValue([
      { code: 'PLAN_PRO', stripeProductId: 'prod_pro' },
      { code: 'PLAN_PREMIUM', stripeProductId: 'prod_premium' },
    ] as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_inc',
      status: 'incomplete',
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
      latest_invoice: { amount_paid: 0 },
      items: {
        has_more: false,
        data: [
          {
            current_period_end: Math.floor(new Date('2026-11-17T00:00:00Z').getTime() / 1000),
            price: { id: 'price_x', product: 'prod_pro', lookup_key: 'plan_pro_monthly', recurring: { interval: 'month' } },
          },
        ],
      },
    })
    mockEntregar.mockResolvedValue(null)

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ statusCode: 503 })

    expect(conEstado('ACTIVE')).toEqual([])
    expect(redencionCon('APPLIED')).toEqual([])
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
  })

  it('🔴 un intento nuevo desde DECLINED nace sin el id del anterior, en el MISMO CAS de la toma', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({ planActivationStatus: 'DECLINED', planActivationAttempt: 1, planStripeSubscriptionId: 'sub_A' }) as never,
    )

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    const toma = progresos()[0]
    expect(toma.where).toMatchObject({ planActivationStatus: 'DECLINED', planActivationAttempt: 1 })
    expect(toma.data).toEqual(
      expect.objectContaining({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 2, planStripeSubscriptionId: null }),
    )
  })

  it.each([
    ['desde NONE', {}],
    [
      'al recuperar un IN_PROGRESS vencido (ese id es el suyo)',
      {
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date('2020-01-01'),
        planStripeSubscriptionId: 'sub_A',
      },
    ],
  ])('contraprueba: %s, la toma NO toca el id de la suscripción', async (_caso, estado) => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso(estado) as never)

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH }).catch(() => undefined)

    expect(progresos()[0].data).not.toHaveProperty('planStripeSubscriptionId')
  })

  it('🔴 el 2.º create vuelve active pero su PRIMERA factura es de $0 cuando se consintieron $22 ⇒ 503 🚨, sin entrega ni APPLIED', async () => {
    segundoActivo()
    facturaInicial({ total: 0, tarjeta: 0, saldo: 0, status: 'paid' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockEntregar).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([])
    expect(redencionCon('RELEASED')).toEqual([])
    expect(conEstado('ACTIVE')).toEqual([])
    expect((logger.error as jest.Mock).mock.calls.some(c => String(c[0]).startsWith('🚨'))).toBe(true)
  })

  it('🔴 el 2.º create vuelve active con la primera factura ABIERTA ⇒ 503, sin entrega', async () => {
    segundoActivo()
    facturaInicial({ total: ANUNCIADO, tarjeta: 0, saldo: 0, status: 'open' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockEntregar).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([])
  })

  it('el 2.º create con la primera factura pagada con tarjeta por el monto consentido ⇒ entrega, ACTIVE y APPLIED', async () => {
    segundoActivo()
    facturaInicial({ total: ANUNCIADO, tarjeta: ANUNCIADO, saldo: 0, status: 'paid' })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
    expect(mockEntregar).toHaveBeenCalledWith({ venueId: 'venue-1', subscriptionId: 'sub_3ds', detectedBy: 'onboarding.activatePlan' })
    expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
  })

  it('separación: la prueba de 30 días no pide la evidencia', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso({ launchCampaignId: null }) as never)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'trialing',
      current_period_end: Math.floor(new Date('2026-11-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: 0, amount_due: 0 },
    })

    const r = await activatePlan({ ...BASE, payNow: false, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 } })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubCreate.mock.calls[0][0].trial_period_days).toBe(30)
    expect(mockInvList).not.toHaveBeenCalled()
  })

  it('🔴 saldo a favor + tarjeta ($8 de saldo + $14 de tarjeta sobre $22) ⇒ ACTIVE y APPLIED, no 503', async () => {
    segundoActivo()
    facturaInicial({ total: ANUNCIADO, tarjeta: 1400, saldo: 800, status: 'paid' })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockEntregar).toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
  })

  /**
   * La otra mitad de la regla: una suscripción RECUPERADA en el PASO 6 que salió del #2 (trae `primerCobroEsperadoCents`)
   * también exige su primera factura pagada por ese monto antes de entregar. Sin la metadata (cobro clásico), como hoy.
   */
  describe('recuperada del camino de autenticación (trae primerCobroEsperadoCents)', () => {
    beforeEach(() => {
      prismaMock.onboardingProgress.findUnique.mockResolvedValue(
        progreso({
          planActivationStatus: 'IN_PROGRESS',
          planActivationAttempt: 1,
          planActivationLeaseUntil: null,
          planStripeSubscriptionId: 'sub_3ds',
        }) as never,
      )
      prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
        id: 'red-1',
        status: 'RESERVED',
        campaignId: 'lc-1',
        offerVersion: 1,
      } as never)
      mockSubRetrieve.mockResolvedValue({
        id: 'sub_3ds',
        status: 'active',
        metadata: { planActivationKey: 'plan-activation:org-1:1', featureCode: 'PLAN_PRO', primerCobroEsperadoCents: String(ANUNCIADO) },
        discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
        latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO },
        current_period_end: Math.floor(new Date('2026-11-17T00:00:00Z').getTime() / 1000),
      })
    })

    it('🔴 con la primera factura ABIERTA ⇒ 503, sin entrega ni APPLIED', async () => {
      facturaInicial({ total: ANUNCIADO, tarjeta: 0, saldo: 0, status: 'open' })

      await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
        statusCode: 503,
        code: 'PLAN_ACTIVATION_PENDING',
      })

      expect(mockSubCreate).not.toHaveBeenCalled()
      expect(mockEntregar).not.toHaveBeenCalled()
      expect(redencionCon('APPLIED')).toEqual([])
    })

    it('con la primera factura pagada por el monto de su metadata ⇒ ACTIVE y APPLIED, sin cobrar otra vez', async () => {
      facturaInicial({ total: ANUNCIADO, tarjeta: ANUNCIADO, saldo: 0, status: 'paid' })

      const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

      expect(r.status).toBe('ACTIVE')
      expect(mockSubCreate).not.toHaveBeenCalled()
      expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
      expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
    })
  })
})

/**
 * 🔴 D2 (S3, spec §6.3): el pedido que el navegador manda DESPUÉS del reto del banco —o al recargar, o con otra tarjeta—
 * entra por el PASO 6 con la suscripción del intento todavía `incomplete`. Antes: 503 durante 23 h. Ahora se decide con el
 * estado REAL en Stripe: pagada ⇒ se entrega; esperando ⇒ el MISMO secreto; reto fallido ⇒ se anula la factura y es un
 * rechazo; otra tarjeta u otra oferta ⇒ se anula y se estrena intento. Anular es condicional; nunca `cancel`.
 */
describe('🔴 D2: el pedido de después del reto (PASO 6 con una suscripción incompleta)', () => {
  const FIN_DEL_PERIODO = Math.floor(new Date('2026-11-18T00:00:00Z').getTime() / 1000)
  const VENCIDO = new Date('2020-01-01T00:00:00Z')
  const incompleta = (o: Record<string, unknown> = {}) => ({
    id: 'sub_3ds',
    status: 'incomplete',
    default_payment_method: 'pm_1',
    metadata: {
      featureCode: 'PLAN_PRO',
      launchCampaignId: 'lc-1',
      launchOfferVersion: '1',
      launchRedemptionId: 'red-1',
      planActivationKey: 'plan-activation:org-1:1',
      primerCobroEsperadoCents: String(ANUNCIADO),
    },
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { client_secret: 'pi_1_secret_x' } },
    items: { data: [{ current_period_end: FIN_DEL_PERIODO, price: { recurring: { interval: 'month' } } }] },
    discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    ...o,
  })
  /** La suscripción que crea el intento NUEVO (cualquier id que no sea el del intento), ya vigente. */
  const vigente = (id: string, status = 'active') => ({
    id,
    status,
    items: { data: [{ current_period_end: FIN_DEL_PERIODO, price: { recurring: { interval: 'month' } } }] },
    latest_invoice: { amount_paid: status === 'trialing' ? 0 : ANUNCIADO },
    discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
  })
  /** `subscriptions.retrieve` por id: las del mapa; cualquier otra es la recién creada. */
  const enStripe = (subs: Record<string, unknown>) =>
    mockSubRetrieve.mockImplementation(async (id: string) => subs[id] ?? vigente(id, id === 'sub_1' ? 'trialing' : 'active'))
  /** El PaymentIntent de la primera factura, como lo devuelve `invoicePayments.list` (sin `status`: lo lee el resolver). */
  const elPagoEsta = (status: string, last_payment_error: Record<string, unknown> | null = null) =>
    mockIpList.mockResolvedValue({
      has_more: false,
      data: [{ is_default: true, payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', status, last_payment_error } } }],
    })
  const errorDeConexion = () => Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' })
  const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map(c => c[0])
  const redencionCon = (estado: string) =>
    (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.map(c => c[0]).filter(a => a?.data?.status === estado)
  const conEstado = (estado: string) => progresos().filter(a => a?.data?.planActivationStatus === estado)
  const bajadas = () =>
    (prismaMock.launchCampaign.updateMany as jest.Mock).mock.calls.filter((c: any[]) => c[0]?.data?.redemptionCount?.decrement)
  const soltoElLease = () =>
    progresos().some(a => a?.data && 'planActivationLeaseUntil' in a.data && a.data.planActivationLeaseUntil === null)
  /** El avance de intento (sube a 2): la toma de la recuperación escribe el MISMO número. */
  const avance = () => progresos().find(a => a?.data?.planActivationAttempt === 2)
  const ofertaEstandarDePrueba = { kind: 'STANDARD' as const, expectedFirstChargeCents: 0 }
  /** QA 18-oct: descartar el intento incompleto no dejaba ninguna línea en el log. Ahora deja una, sin el secreto. */
  const dejoRastroDelDescarte = (motivo: string) => {
    expect(logger.info).toHaveBeenCalledWith('activate-plan: se descartó la suscripción incompleta del intento anterior (no se cobró)', {
      organizationId: 'org-1',
      subscriptionId: 'sub_3ds',
      motivo,
    })
    const todo = (['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => (logger[nivel] as jest.Mock).mock.calls)
    expect(inspect(todo, { depth: 10 })).not.toContain('_secret_')
  }

  /**
   * Qué transacción estaba abierta (1, 2, …; 0 = ninguna) en cada escritura de progreso, redención y cupo: prueba que dos
   * escrituras van JUNTAS en el mismo `$transaction` (el mock le pasa el mismo cliente como `tx`).
   */
  function rastrearTransacciones() {
    let abierta = 0
    let n = 0
    const escrituras: Array<{ modelo: string; args: any; tx: number }> = []
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => {
      const previa = abierta
      abierta = ++n
      try {
        return await (cb as (tx: unknown) => unknown)(prismaMock)
      } finally {
        abierta = previa
      }
    })
    const modelos = [
      ['progreso', prismaMock.onboardingProgress.updateMany],
      ['redencion', prismaMock.launchCampaignRedemption.updateMany],
      ['cupo', prismaMock.launchCampaign.updateMany],
    ] as const
    for (const [modelo, mock] of modelos) {
      ;(mock as jest.Mock).mockImplementation(async (args: any) => {
        escrituras.push({ modelo, args, tx: abierta })
        return { count: 1 }
      })
    }
    return escrituras
  }

  /** El avance (intento 2, sin el id anterior), la liberación de `red-1` y el decremento, en la MISMA transacción. */
  function liberoElLugarEnElAvance(escrituras: ReturnType<typeof rastrearTransacciones>) {
    const elAvance = escrituras.find(e => e.modelo === 'progreso' && e.args?.data?.planActivationAttempt === 2)
    const liberada = escrituras.find(e => e.modelo === 'redencion' && e.args?.data?.status === 'RELEASED')
    const bajada = escrituras.find(e => e.modelo === 'cupo' && e.args?.data?.redemptionCount?.decrement)
    expect(elAvance?.args.data).toEqual({ planActivationAttempt: 2, planStripeSubscriptionId: null })
    expect(liberada?.args).toEqual({
      where: { id: 'red-1', status: 'RESERVED' },
      data: expect.objectContaining({ status: 'RELEASED', lastError: 'PLAN_ATTEMPT_DISCARDED' }),
    })
    expect(bajada?.args).toEqual({ where: { id: 'lc-1', redemptionCount: { gt: 0 } }, data: { redemptionCount: { decrement: 1 } } })
    expect(elAvance?.tx).toBeGreaterThan(0)
    expect(liberada?.tx).toBe(elAvance?.tx)
    expect(bajada?.tx).toBe(elAvance?.tx)
  }

  beforeEach(() => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: 'sub_3ds',
      }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
    } as never)
    enStripe({ sub_3ds: incompleta() })
    elPagoEsta('requires_action')
    // Ruling 4: la primera factura por defecto, coherente para el lector REAL (pagada con tarjeta por lo anunciado).
    facturaInicial({ total: ANUNCIADO, tarjeta: ANUNCIADO, saldo: 0, status: 'paid' })
    mockVoid.mockResolvedValue({ id: 'in_1', status: 'void' })
  })

  it('1. el banco autorizó y la sub ya está active ⇒ evidencia del primer cobro, entrega, ACTIVE y APPLIED, sin crear ni anular nada', async () => {
    enStripe({ sub_3ds: incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO } }) })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVoid).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
      }),
    ])
  })

  it('2. el PI sigue esperando (mismo pm) ⇒ 409 con el MISMO secreto, sin anular ni crear, y el lease se suelta en IN_PROGRESS', async () => {
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PAYMENT_REQUIRES_ACTION',
      details: { clientSecret: 'pi_1_secret_x' },
    })

    // Se decide con lo que dice Stripe AHORA: la sub con su secreto y el PI de la primera factura.
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_3ds', { expand: ['latest_invoice.confirmation_secret'] })
    expect(mockIpList).toHaveBeenCalledWith({ invoice: 'in_1', expand: ['data.payment.payment_intent'] })
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    const nuestro = progresos()[0].data.planActivationLeaseUntil
    expect(nuestro).toBeInstanceOf(Date)
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: nuestro },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
    expect(conEstado('DECLINED')).toEqual([])
    expect(redencionCon('RELEASED')).toEqual([])
    expect(mockEntregar).not.toHaveBeenCalled()
  })

  it('3. requires_confirmation (el navegador nunca confirmó) ⇒ igual que el anterior', async () => {
    elPagoEsta('requires_confirmation')

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PAYMENT_REQUIRES_ACTION',
      details: { clientSecret: 'pi_1_secret_x' },
    })

    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(soltoElLease()).toBe(true)
    expect(conEstado('IN_PROGRESS').at(-1)?.data).toEqual({ planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null })
  })

  it('4. 🔴 el reto falló (mismo pm, requires_payment_method) ⇒ anula la factura, DECLINED, lugar liberado y 402 payment_intent_authentication_failure', async () => {
    elPagoEsta('requires_payment_method', { code: 'payment_intent_authentication_failure', message: 'auth failed' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 402,
      code: 'PLAN_PAYMENT_DECLINED',
      message: 'auth failed',
      details: { declineCode: 'payment_intent_authentication_failure' },
    })

    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(conEstado('DECLINED')).toHaveLength(1)
    expect(prismaMock.launchCampaignRedemption.updateMany).toHaveBeenCalledWith({
      where: { id: 'red-1', status: 'RESERVED' },
      data: expect.objectContaining({ status: 'RELEASED' }),
    })
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', redemptionCount: { gt: 0 } },
      data: { redemptionCount: { decrement: 1 } },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()
    dejoRastroDelDescarte('PAGO_NO_AUTORIZADO')
  })

  it('5. rechazo DESPUÉS de autenticar ⇒ 402 con su decline_code', async () => {
    elPagoEsta('requires_payment_method', { code: 'card_declined', decline_code: 'generic_decline' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 402,
      code: 'PLAN_PAYMENT_DECLINED',
      message: 'Tu banco no autorizó el pago',
      details: { declineCode: 'generic_decline' },
    })

    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(conEstado('DECLINED')).toHaveLength(1)
    expect(redencionCon('RELEASED')).toHaveLength(1)
  })

  it('6. 🔴 tarjeta nueva (otro pm) ⇒ anula la anterior, estrena intento 2 y reusa el MISMO lugar', async () => {
    mockPmRetrieve.mockResolvedValue({ id: 'pm_2', customer: 'cus_1', card: { fingerprint: 'fp_2' } })
    mockSubCreate.mockResolvedValue({ id: 'sub_2' })

    const r = await activatePlan({ ...BASE, paymentMethodId: 'pm_2', offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    const nuestro = progresos()[0].data.planActivationLeaseUntil
    expect(avance()).toEqual({
      where: { organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: nuestro },
      data: { planActivationAttempt: 2, planStripeSubscriptionId: null },
    })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    expect(mockSubCreate.mock.calls[0][0].metadata).toMatchObject({
      planActivationKey: 'plan-activation:org-1:2',
      launchRedemptionId: 'red-1',
    })
    // El MISMO lugar: ni se libera, ni se crea otro, ni se consume cupo.
    expect(redencionCon('RELEASED')).toEqual([])
    expect(bajadas()).toEqual([])
    expect(prismaMock.launchCampaignRedemption.create).not.toHaveBeenCalled()
    const subida = (prismaMock.launchCampaign.updateMany as jest.Mock).mock.calls.find((c: any[]) => c[0]?.data?.redemptionCount?.increment)
    expect(subida).toBeUndefined()
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_2' }),
      }),
    ])
    dejoRastroDelDescarte('OTRO_INTENTO')
  })

  it('7. 🔴 anular falla porque ya se pagó ⇒ relee, la entrega como recuperada y NO cobra otra vez', async () => {
    mockPmRetrieve.mockResolvedValue({ id: 'pm_2', customer: 'cus_1', card: { fingerprint: 'fp_2' } })
    mockVoid.mockRejectedValue(
      Object.assign(new Error('Invoices with `paid` payments cannot be voided.'), { type: 'StripeInvalidRequestError', statusCode: 400 }),
    )
    // Por id e incompleta, la relectura con el secreto también; la de DESPUÉS de anular ya la ve pagada.
    mockSubRetrieve
      .mockReset()
      .mockResolvedValueOnce(incompleta())
      .mockResolvedValueOnce(incompleta())
      .mockResolvedValue(incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO } }))

    const r = await activatePlan({ ...BASE, paymentMethodId: 'pm_2', offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(avance()).toBeUndefined()
    // Trae la marca del reto: se exige su primera factura pagada antes de entregar.
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
      }),
    ])
  })

  it('8. anular falla y Stripe no contesta ⇒ 503 con el lease VIVO, nada se crea y el lugar sigue RESERVED', async () => {
    mockPmRetrieve.mockResolvedValue({ id: 'pm_2', customer: 'cus_1', card: { fingerprint: 'fp_2' } })
    mockVoid.mockRejectedValue(errorDeConexion())
    mockSubRetrieve.mockReset().mockResolvedValueOnce(incompleta()).mockResolvedValueOnce(incompleta()).mockRejectedValue(errorDeConexion())

    await expect(activatePlan({ ...BASE, paymentMethodId: 'pm_2', offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(soltoElLease()).toBe(false)
    expect(avance()).toBeUndefined()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(redencionCon('RELEASED')).toEqual([])
    expect(conEstado('DECLINED')).toEqual([])
  })

  it('9. pagado pero Stripe aún dice incomplete ⇒ 503 con el lease SUELTO y sin anular', async () => {
    elPagoEsta('succeeded')

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    const nuestro = progresos()[0].data.planActivationLeaseUntil
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: nuestro },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
    expect(redencionCon('RELEASED')).toEqual([])
    expect(mockEntregar).not.toHaveBeenCalled()
  })

  it('10. 🔴 descartar hacia un pedido SIN campaña (la prueba) libera el lugar del intento descartado en la MISMA transacción', async () => {
    const escrituras = rastrearTransacciones()

    const r = await activatePlan({ ...BASE, payNow: false, offer: ofertaEstandarDePrueba })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    liberoElLugarEnElAvance(escrituras)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][0].trial_period_days).toBe(30)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
  })

  it('11. sin id guardado, la búsqueda por metadata que encuentra una incompleta sigue el mismo camino (409 con el secreto)', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: null,
      }) as never,
    )
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        await cb(incompleta())
      },
    })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PAYMENT_REQUIRES_ACTION',
      details: { clientSecret: 'pi_1_secret_x' },
    })

    expect(mockSubList).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', status: 'all' }))
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(soltoElLease()).toBe(true)
  })

  it('12. 🔴 el secreto nunca llega al log al reanudar', async () => {
    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({ code: 'PLAN_PAYMENT_REQUIRES_ACTION' })

    const todo = (['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => (logger[nivel] as jest.Mock).mock.calls)
    expect(todo.length).toBeGreaterThan(0)
    expect(inspect(todo, { depth: 10 })).not.toContain('_secret_')
  })

  it('13. 🔴 varias peticiones: A anulada → B cobrada con la respuesta perdida → B se recupera por metadata y conserva su reserva', async () => {
    const subA = incompleta({
      id: 'sub_A',
      latest_invoice: { id: 'in_A', status: 'open', confirmation_secret: { client_secret: 'pi_A_secret_x' } },
    })
    mockPmRetrieve.mockResolvedValue({ id: 'pm_2', customer: 'cus_1', card: { fingerprint: 'fp_2' } })

    // ---- Petición 1: tarjeta nueva sobre la incompleta A; el create de B se manda y la respuesta se pierde ----
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: 'sub_A',
      }) as never,
    )
    enStripe({ sub_A: subA })
    mockSubCreate.mockRejectedValue(errorDeConexion())

    await expect(activatePlan({ ...BASE, paymentMethodId: 'pm_2', offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockVoid).toHaveBeenCalledWith('in_A')
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    const escriturasDeLa1 = progresos()
    const creadosEnLa1 = mockSubCreate.mock.calls.length
    // El estado que dejó la petición 1 en la base: el ÚLTIMO id de suscripción que escribió (o el que ya tenía).
    const idQueQuedo = escriturasDeLa1.reduce<string | null>(
      (id, a) => (a?.data && 'planStripeSubscriptionId' in a.data ? a.data.planStripeSubscriptionId : id),
      'sub_A',
    )

    // ---- Petición 2: el lease venció; B existe en Stripe (cobrada a la primera, sin marca del reto) ----
    const subB = {
      id: 'sub_B',
      status: 'active',
      default_payment_method: 'pm_2',
      metadata: {
        featureCode: 'PLAN_PRO',
        launchCampaignId: 'lc-1',
        launchOfferVersion: '1',
        launchRedemptionId: 'red-1',
        planActivationKey: 'plan-activation:org-1:2',
      },
      latest_invoice: { id: 'in_B', status: 'paid', amount_paid: ANUNCIADO },
      items: { data: [{ current_period_end: FIN_DEL_PERIODO, price: { recurring: { interval: 'month' } } }] },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    }
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 2,
        planActivationLeaseUntil: VENCIDO,
        planStripeSubscriptionId: idQueQuedo,
      }) as never,
    )
    // A quedó anulada (incomplete_expired) y B vive: la regla común la ve y no deja cobrar otra encima.
    enStripe({ sub_A: { ...subA, status: 'incomplete_expired' }, sub_B: subB })
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [{ ...subA, status: 'incomplete_expired' }, subB]) if ((await cb(s)) === false) return
      },
    })
    mockAutorizar.mockRejectedValue(Object.assign(new Error('Ya hay un plan cobrando'), { statusCode: 409, code: 'PLAN_YA_CONTRATADO' }))

    const r = await activatePlan({ ...BASE, paymentMethodId: 'pm_2', offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubCreate.mock.calls.length).toBe(creadosEnLa1) // la petición 2 no crea nada
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_B' }),
      }),
    ])
    // En NINGUNA de las dos peticiones se liberó el lugar.
    expect(redencionCon('RELEASED')).toEqual([])
    expect(bajadas()).toEqual([])
    // La petición 1 estrenó el intento 2 SIN el id de A.
    expect(escriturasDeLa1.find(a => a?.data?.planActivationAttempt === 2)?.data).toEqual({
      planActivationAttempt: 2,
      planStripeSubscriptionId: null,
    })
  })

  it('14. 🔴 la sub ya llega incomplete_expired (las 23 h) y el cliente elige la prueba ⇒ se libera su lugar en la MISMA transacción del avance', async () => {
    enStripe({ sub_3ds: incompleta({ status: 'incomplete_expired' }) })
    const escrituras = rastrearTransacciones()

    const r = await activatePlan({ ...BASE, payNow: false, offer: ofertaEstandarDePrueba })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).not.toHaveBeenCalled()
    liberoElLugarEnElAvance(escrituras)
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][0].trial_period_days).toBe(30)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    dejoRastroDelDescarte('YA_EXPIRADA')
  })

  it('15. 🔴 caída entre anular y escribir: el reintento ve incomplete_expired ⇒ con la MISMA oferta conserva el lugar y estrena intento', async () => {
    enStripe({ sub_3ds: incompleta({ status: 'incomplete_expired' }) })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(avance()?.data).toEqual({ planActivationAttempt: 2, planStripeSubscriptionId: null })
    expect(redencionCon('RELEASED')).toEqual([])
    expect(bajadas()).toEqual([])
    // `apartarLugar` reusa red-1: ni redención nueva ni cupo consumido.
    expect(prismaMock.launchCampaignRedemption.create).not.toHaveBeenCalled()
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
  })

  it('16. 🔴 la relectura dentro del resolver ya dice incomplete_expired ⇒ descartada sin anular, y su lugar se libera si no se reusa', async () => {
    mockSubRetrieve
      .mockReset()
      .mockResolvedValueOnce(incompleta())
      .mockResolvedValueOnce(incompleta({ status: 'incomplete_expired' }))
      .mockResolvedValue(vigente('sub_1', 'trialing'))

    const r = await activatePlan({ ...BASE, payNow: false, offer: ofertaEstandarDePrueba })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubRetrieve).toHaveBeenNthCalledWith(2, 'sub_3ds', { expand: ['latest_invoice.confirmation_secret'] })
    expect(mockVoid).not.toHaveBeenCalled()
    expect(redencionCon('RELEASED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
    expect(bajadas()).toHaveLength(1)
    expect(avance()?.data).toEqual({ planActivationAttempt: 2, planStripeSubscriptionId: null })
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    dejoRastroDelDescarte('YA_EXPIRADA')
  })

  it('17a. 🔴 recuperada active pero su PRIMERA factura no está pagada por el monto consentido ⇒ 503 sin entrega', async () => {
    enStripe({ sub_3ds: incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'open', amount_paid: 0 } }) })
    facturaInicial({ total: ANUNCIADO, tarjeta: 0, saldo: 0, status: 'open' })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockEntregar).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([])
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('17b. 🔴 a los 40 días se mira la PRIMERA factura, no la última (la renovación)', async () => {
    enStripe({
      sub_3ds: incompleta({
        status: 'active',
        latest_invoice: { id: 'in_2', status: 'paid', billing_reason: 'subscription_cycle', amount_paid: LISTA },
      }),
    })
    const primera = facturaInicial({ total: ANUNCIADO, tarjeta: ANUNCIADO, saldo: 0, status: 'paid' })
    const renovacion = { ...primera, id: 'in_2', billing_reason: 'subscription_cycle', total: LISTA, amount_paid: LISTA }
    mockInvList.mockResolvedValue({ data: [renovacion, primera], has_more: false })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-1', status: 'RESERVED' } })])
  })

  it('18. 🔴 recuperada con saldo a favor + tarjeta ⇒ ACTIVE y APPLIED', async () => {
    enStripe({ sub_3ds: incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: 1400 } }) })
    facturaInicial({ total: ANUNCIADO, tarjeta: 1400, saldo: 800, status: 'paid' })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
      }),
    ])
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVoid).not.toHaveBeenCalled()
  })

  // Ruling 6b: si la evidencia NO se puede leer (Stripe o el lector), es «no sé» (503 + 🚨), nunca el 409 del lector.
  it.each([
    ['Stripe no contesta al listar las facturas', () => mockInvList.mockRejectedValue(errorDeConexion())],
    ['el lector no puede verificar (pagos truncados)', () => mockPagosCobrados.mockResolvedValue({ has_more: true, data: [] })],
  ])('🔴 Ruling 6b: la evidencia falla (%s) ⇒ 503 PLAN_ACTIVATION_PENDING con 🚨, sin entrega', async (_caso, falla) => {
    enStripe({ sub_3ds: incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO } }) })
    falla()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(mockEntregar).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([])
    expect((logger.error as jest.Mock).mock.calls.some(c => String(c[0]).startsWith('🚨'))).toBe(true)
  })

  // ---- Ronda de arreglos 1 (revisión de S3, Ruling 8) ----

  it('19. 🔴 Ruling 8: la campaña subió de versión a media autorización (v1 → v2, misma tarjeta) ⇒ NO se reanuda el PI de v1: se anula, se libera el lugar de v1 y se aparta uno de v2', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania({ offerVersion: 2, stripeCouponId: 'LC_POS22_V2' }) as never)
    // Cuando `apartarLugar` busca, el lugar de v1 ya se liberó en el avance: no queda fila viva.
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
    prismaMock.launchCampaignRedemption.create.mockResolvedValue({ id: 'red-2' } as never)
    mockSubCreate.mockResolvedValue({ id: 'sub_2' })
    const escrituras = rastrearTransacciones()

    const r = await activatePlan({ ...BASE, offer: { ...OFERTA_LAUNCH, offerVersion: 2 } })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    liberoElLugarEnElAvance(escrituras)
    expect(prismaMock.launchCampaignRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ offerVersion: 2, stripeCouponId: 'LC_POS22_V2' }) }),
    )
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
    expect(mockSubCreate.mock.calls[0][0].discounts).toEqual([{ coupon: 'LC_POS22_V2' }])
    expect(mockSubCreate.mock.calls[0][0].metadata).toMatchObject({ launchOfferVersion: '2', launchRedemptionId: 'red-2' })
    expect(redencionCon('APPLIED')).toEqual([expect.objectContaining({ where: { id: 'red-2', status: 'RESERVED' } })])
  })

  it('20. 🔴 el PI ya pagó y la relectura del resolver la ve active ⇒ se recupera: ACTIVE y APPLIED con sub_3ds, sin anular ni crear', async () => {
    elPagoEsta('succeeded')
    const pagada = incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO } })
    // Por id: incompleta; con el secreto: incompleta; la relectura de «ya pagó»: active.
    mockSubRetrieve.mockReset().mockResolvedValueOnce(incompleta()).mockResolvedValueOnce(incompleta()).mockResolvedValue(pagada)

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubRetrieve).toHaveBeenNthCalledWith(3, 'sub_3ds')
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(avance()).toBeUndefined()
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
    expect(redencionCon('RELEASED')).toEqual([])
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
      }),
    ])
  })

  it('21. la relectura con el secreto ya viene cobrada ⇒ se recupera sin leer el PI, sin anular ni crear', async () => {
    const pagada = incompleta({ status: 'active', latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO } })
    mockSubRetrieve.mockReset().mockResolvedValueOnce(incompleta()).mockResolvedValue(pagada)

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubRetrieve).toHaveBeenNthCalledWith(2, 'sub_3ds', { expand: ['latest_invoice.confirmation_secret'] })
    expect(mockIpList).not.toHaveBeenCalled()
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(redencionCon('APPLIED')).toEqual([
      expect.objectContaining({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
      }),
    ])
  })

  it.each([
    [
      'la relectura con el secreto',
      () => mockSubRetrieve.mockReset().mockResolvedValueOnce(incompleta()).mockRejectedValue(errorDeConexion()),
    ],
    ['el PaymentIntent de la factura', () => mockIpList.mockRejectedValue(errorDeConexion())],
    [
      'la relectura de una ya pagada',
      () => {
        elPagoEsta('succeeded')
        mockSubRetrieve
          .mockReset()
          .mockResolvedValueOnce(incompleta())
          .mockResolvedValueOnce(incompleta())
          .mockRejectedValue(errorDeConexion())
      },
    ],
  ])('22. 🔴 Stripe no contesta dentro del resolver (%s) ⇒ 503 con el lease VIVO, sin anular ni crear', async (_caso, falla) => {
    falla()

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(soltoElLease()).toBe(false)
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(avance()).toBeUndefined()
    expect(redencionCon('RELEASED')).toEqual([])
  })

  it('23. mismo intento esperando al banco pero la factura no trae su secreto ⇒ 503 con el lease VIVO y aviso en el log', async () => {
    enStripe({ sub_3ds: incompleta({ latest_invoice: { id: 'in_1', status: 'open' } }) })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(soltoElLease()).toBe(false)
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-plan'), {
      organizationId: 'org-1',
      subscriptionId: 'sub_3ds',
      status: 'requires_action',
    })
  })

  /** La incompleta que deja STANDARD pagando hoy: sin datos de campaña, con la promo legacy. */
  const incompletaEstandar = () =>
    incompleta({
      metadata: { featureCode: 'PLAN_PRO', planActivationKey: 'plan-activation:org-1:1', primerCobroEsperadoCents: '69484' },
      discounts: [{ coupon: { id: 'INTRO_PRO_3M' } }],
    })
  const ESTANDAR_HOY = {
    kind: 'STANDARD' as const,
    expectedFirstChargeCents: standardFirstChargeCents(standardPlanQuote(), 'PRO', 'monthly', true),
  }

  it('24. control: STANDARD pagando hoy con la MISMA tarjeta sobre su incompleta ⇒ es el mismo intento (409 con el secreto)', async () => {
    enStripe({ sub_3ds: incompletaEstandar() })

    await expect(activatePlan({ ...BASE, offer: ESTANDAR_HOY })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_PAYMENT_REQUIRES_ACTION',
      details: { clientSecret: 'pi_1_secret_x' },
    })
    expect(mockVoid).not.toHaveBeenCalled()
  })

  const meta = incompleta().metadata
  it.each([
    [
      'featureCode (la incompleta es de Premium; el pedido, de Pro)',
      incompleta({ metadata: { ...meta, featureCode: 'PLAN_PREMIUM' } }),
      {},
    ],
    [
      'la campaña (la incompleta es de otra)',
      incompleta({ metadata: { ...meta, launchCampaignId: 'lc-OTRA', launchRedemptionId: 'red-viejo' } }),
      {},
    ],
    [
      'la versión de la oferta (la incompleta es de otra versión de la MISMA campaña)',
      incompleta({ metadata: { ...meta, launchOfferVersion: '0', launchRedemptionId: 'red-viejo' } }),
      {},
    ],
    [
      'payNow (STANDARD: la prueba de 30 días sobre una incompleta de pagar hoy)',
      incompletaEstandar(),
      { payNow: false, offer: ofertaEstandarDePrueba },
    ],
  ])('25. 🔴 cambia SÓLO %s, con la misma tarjeta ⇒ no es el mismo intento: se anula y se estrena intento', async (_caso, sub, pedido) => {
    enStripe({ sub_3ds: sub })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH, ...pedido })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(avance()?.data).toEqual({ planActivationAttempt: 2, planStripeSubscriptionId: null })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][1].idempotencyKey).toBe('plan-activation:org-1:2')
  })

  it('26. 🔴 la relectura dice un estado que no se sabe resolver (canceled) ⇒ 503, lease VIVO y aviso con organización, suscripción y estado', async () => {
    mockSubRetrieve
      .mockReset()
      .mockResolvedValueOnce(incompleta())
      .mockResolvedValue(incompleta({ status: 'canceled' }))

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(soltoElLease()).toBe(false)
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-plan'), {
      organizationId: 'org-1',
      subscriptionId: 'sub_3ds',
      status: 'canceled',
    })
  })

  it('27. 🔴 mismo intento con el PI en un estado que no está en la tabla ⇒ 503, lease VIVO, sin anular, y aviso con su estado (sin el secreto)', async () => {
    elPagoEsta('canceled')

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLAN_ACTIVATION_PENDING',
    })

    expect(soltoElLease()).toBe(false)
    expect(mockVoid).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('activate-plan'), {
      organizationId: 'org-1',
      subscriptionId: 'sub_3ds',
      status: 'canceled',
    })
    const todo = (['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => (logger[nivel] as jest.Mock).mock.calls)
    expect(inspect(todo, { depth: 10 })).not.toContain('_secret_')
  })
})

/**
 * 🔴 R1 y R2 (promesa docs/audit/2026-10-18-campana-3ds-r1r2/promesa.md): el alta que se quedó «esperando al banco» sin nadie
 * en la pantalla se resuelve sola. R2: el cliente autorizó y cerró la pestaña ⇒ se cierra igual que si hubiera vuelto (con
 * la evidencia del primer cobro). R1: Stripe dio el cobro por expirado ⇒ su lugar vuelve a la campaña. El revisor NUNCA
 * cobra, anula ni crea nada en Stripe.
 */
describe('🔴 R1/R2: el alta a medio pago se resuelve sin el navegador', () => {
  const FIN_DEL_PERIODO = Math.floor(new Date('2026-11-18T00:00:00Z').getTime() / 1000)
  const VENCIDO = new Date('2020-01-01T00:00:00Z')
  const METADATA = {
    organizationId: 'org-1',
    featureCode: 'PLAN_PRO',
    launchCampaignId: 'lc-1',
    launchCampaignCode: 'POS22',
    launchOfferVersion: '1',
    launchRedemptionId: 'red-1',
    planActivationKey: 'plan-activation:org-1:1',
    primerCobroEsperadoCents: String(ANUNCIADO),
  }
  const laSub = (o: Record<string, unknown> = {}) => ({
    id: 'sub_3ds',
    status: 'active',
    default_payment_method: 'pm_1',
    metadata: METADATA,
    latest_invoice: { id: 'in_1', status: 'paid', amount_paid: ANUNCIADO },
    current_period_end: FIN_DEL_PERIODO,
    items: { data: [{ current_period_end: FIN_DEL_PERIODO, price: { recurring: { interval: 'month' } } }] },
    discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    ...o,
  })
  const enStripe = (sub: Record<string, unknown>) => mockSubRetrieve.mockResolvedValue(sub)
  const elAlta = (o: Record<string, unknown> = {}) =>
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: null,
        planStripeSubscriptionId: 'sub_3ds',
        ...o,
      }) as never,
    )
  const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map(c => c[0])
  const conEstado = (estado: string) => progresos().filter(a => a?.data?.planActivationStatus === estado)
  const redencionCon = (estado: string) =>
    (prismaMock.launchCampaignRedemption.updateMany as jest.Mock).mock.calls.map(c => c[0]).filter(a => a?.data?.status === estado)
  const bajadas = () =>
    (prismaMock.launchCampaign.updateMany as jest.Mock).mock.calls.filter((c: any[]) => c[0]?.data?.redemptionCount?.decrement)
  /** Nada se escribió en Stripe: ni cobro, ni anulación. */
  const nadaEnStripe = () => {
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVoid).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    elAlta()
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({
      id: 'red-1',
      status: 'RESERVED',
      campaignId: 'lc-1',
      offerVersion: 1,
    } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ staffId: 'owner-1' } as never)
    facturaInicial({ total: ANUNCIADO, tarjeta: ANUNCIADO, saldo: 0, status: 'paid' })
    enStripe(laSub())
  })

  describe('R2: autorizó y cerró la pestaña', () => {
    it('R2.1 ⇒ cierra el alta como si hubiera vuelto: evidencia del primer cobro, entrega, ACTIVE, APPLIED, a nombre de la dueña, sin cobrar ni anular', async () => {
      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('CERRADA')

      expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_3ds', limit: 100 })
      expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
      expect(conEstado('ACTIVE')).toHaveLength(1)
      expect(redencionCon('APPLIED')).toEqual([
        expect.objectContaining({
          where: { id: 'red-1', status: 'RESERVED' },
          data: expect.objectContaining({ stripeSubscriptionId: 'sub_3ds' }),
        }),
      ])
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'owner-1', action: 'LAUNCH_CAMPAIGN_REDEEMED' }))
      nadaEnStripe()
    })

    it('R2.2 🔴 la primera factura NO está pagada por lo consentido ⇒ no cierra (503, sin entrega ni APPLIED)', async () => {
      facturaInicial({ total: ANUNCIADO, tarjeta: 0, saldo: 0, status: 'open' })

      await expect(cerrarAltaSinNavegador('org-1')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_ACTIVATION_PENDING' })

      expect(mockEntregar).not.toHaveBeenCalled()
      expect(conEstado('ACTIVE')).toEqual([])
      expect(redencionCon('APPLIED')).toEqual([])
      nadaEnStripe()
    })

    it('R2.3 sin campaña: reconstruye la oferta ESTÁNDAR con el monto de la marca y cierra', async () => {
      const estandar = standardFirstChargeCents(standardPlanQuote(), 'PRO', 'monthly', true)
      elAlta({ launchCampaignId: null })
      const { launchCampaignId, launchCampaignCode, launchOfferVersion, launchRedemptionId, ...sinCampania } = METADATA
      enStripe(laSub({ metadata: { ...sinCampania, primerCobroEsperadoCents: String(estandar) }, discounts: [] }))
      facturaInicial({ total: estandar, tarjeta: estandar, saldo: 0, status: 'paid' })

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('CERRADA')

      expect(conEstado('ACTIVE')).toHaveLength(1)
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'owner-1', action: 'PLAN_ACTIVATED_ONBOARDING' }))
      nadaEnStripe()
    })

    it('R2.4 🔴 un cobro CLÁSICO (sin la marca del reto) no es de este revisor ⇒ no toca nada', async () => {
      const { primerCobroEsperadoCents, ...sinMarca } = METADATA
      enStripe(laSub({ metadata: sinMarca }))

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      expect(mockEntregar).not.toHaveBeenCalled()
    })

    it('R2.5 🔴 la suscripción es de OTRO intento (su llave no es la del intento actual) ⇒ no toca nada', async () => {
      enStripe(laSub({ metadata: { ...METADATA, planActivationKey: 'plan-activation:org-1:7' } }))

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      expect(mockEntregar).not.toHaveBeenCalled()
    })

    it('R2.6 🔴 (Codex plan r1 #1) la tarjeta se retiró del cliente después de pagar ⇒ igual cierra lo YA pagado y guarda su id', async () => {
      mockPmRetrieve.mockResolvedValue({ id: 'pm_1', customer: null, card: { fingerprint: 'fp_1' } })

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('CERRADA')

      expect(conEstado('ACTIVE')).toHaveLength(1)
      expect(planDelCierre().paymentMethodId).toBe('pm_1')
      expect(redencionCon('APPLIED')).toHaveLength(1)
      nadaEnStripe()
    })

    it('R2.7 🔴 (Codex r1 #1) la suscripción ya NO trae tarjeta ⇒ no la cierra el revisor (sin tarjeta guardada «Terminar alta» se atora): 🚨 y queda el camino de hoy', async () => {
      enStripe(laSub({ default_payment_method: null }))

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      expect(mockEntregar).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨'), { organizationId: 'org-1', subscriptionId: 'sub_3ds' })
      nadaEnStripe()
    })
  })

  describe('el candado `soloRecuperar` de activatePlan (el revisor nunca cobra, anula ni estrena intento)', () => {
    const OFERTA = { ...BASE, staffId: 'owner-1', offer: OFERTA_LAUNCH }

    it('S.1 🔴 la sub del intento sigue `incomplete` con el reto fallido ⇒ 503 y lease suelto en IN_PROGRESS, SIN anular, sin avance, sin crear', async () => {
      enStripe(
        laSub({
          status: 'incomplete',
          latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { client_secret: 'pi_1_secret_x' } },
        }),
      )
      mockIpList.mockResolvedValue({
        has_more: false,
        data: [
          { is_default: true, payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', status: 'requires_payment_method' } } },
        ],
      })

      await expect(activatePlan(OFERTA, { soloRecuperar: 'sub_3ds' })).rejects.toMatchObject({ statusCode: 503 })

      nadaEnStripe()
      expect(progresos().some(a => a?.data?.planActivationAttempt === 2)).toBe(false)
      expect(conEstado('DECLINED')).toEqual([])
      expect(progresos()).toContainEqual(
        expect.objectContaining({ data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null } }),
      )
    })

    it('S.2 🔴 la sub ya expiró ⇒ 503 sin estrenar intento ni cobrar (eso es de R1, no de la recuperación)', async () => {
      enStripe(laSub({ status: 'incomplete_expired' }))

      await expect(activatePlan(OFERTA, { soloRecuperar: 'sub_3ds' })).rejects.toMatchObject({ statusCode: 503 })

      nadaEnStripe()
      expect(progresos().some(a => a?.data?.planActivationAttempt === 2)).toBe(false)
      expect(bajadas()).toEqual([])
    })

    it.each([
      ['el alta no está IN_PROGRESS', { planActivationStatus: 'DECLINED' }],
      ['el alta apunta a OTRA suscripción', { planStripeSubscriptionId: 'sub_otra' }],
    ])('S.3 🔴 %s ⇒ 409 sin escribir nada ni tocar Stripe', async (_caso, o) => {
      elAlta(o)

      await expect(activatePlan(OFERTA, { soloRecuperar: 'sub_3ds' })).rejects.toMatchObject({ statusCode: 409 })

      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      nadaEnStripe()
    })

    it('S.4 la toma del lease exige que el alta siga apuntando a ESA suscripción (CAS)', async () => {
      await activatePlan(OFERTA, { soloRecuperar: 'sub_3ds' })

      expect(progresos()[0].where).toMatchObject({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planStripeSubscriptionId: 'sub_3ds',
      })
    })
  })

  describe('R1: el cobro murió sin autorizar (Stripe lo dio por expirado)', () => {
    beforeEach(() => enStripe(laSub({ status: 'incomplete_expired', latest_invoice: { id: 'in_1', status: 'void' } })))

    /** Qué transacción estaba abierta en cada escritura (0 = ninguna): prueba que el CAS del alta y la liberación van JUNTOS. */
    function rastrearTransacciones() {
      let abierta = 0
      let n = 0
      const escrituras: Array<{ modelo: string; args: any; tx: number }> = []
      prismaMock.$transaction.mockImplementation(async (cb: unknown) => {
        abierta = ++n
        try {
          return await (cb as (tx: unknown) => unknown)(prismaMock)
        } finally {
          abierta = 0
        }
      })
      for (const [modelo, mock] of [
        ['progreso', prismaMock.onboardingProgress.updateMany],
        ['redencion', prismaMock.launchCampaignRedemption.updateMany],
        ['cupo', prismaMock.launchCampaign.updateMany],
      ] as const) {
        ;(mock as jest.Mock).mockImplementation(async (args: any) => {
          escrituras.push({ modelo, args, tx: abierta })
          return { count: 1 }
        })
      }
      return escrituras
    }

    it('R1.1 🔴 alta → DECLINED y el lugar de ESA suscripción se libera, en la MISMA transacción, sin tocar Stripe', async () => {
      const escrituras = rastrearTransacciones()

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('LIBERADA')

      const cas = escrituras.find(e => e.modelo === 'progreso')
      const liberada = escrituras.find(e => e.modelo === 'redencion')
      const bajada = escrituras.find(e => e.modelo === 'cupo')
      expect(cas?.args).toEqual({
        where: {
          organizationId: 'org-1',
          completedAt: null,
          planActivationStatus: 'IN_PROGRESS',
          planActivationAttempt: 1,
          planActivationLeaseUntil: null,
          planStripeSubscriptionId: 'sub_3ds',
        },
        data: { planActivationStatus: 'DECLINED', planActivationLeaseUntil: null },
      })
      expect(liberada?.args).toEqual({
        where: { id: 'red-1', status: 'RESERVED' },
        data: expect.objectContaining({ status: 'RELEASED', lastError: 'PLAN_ATTEMPT_ABANDONED' }),
      })
      expect(bajada?.args).toEqual({ where: { id: 'lc-1', redemptionCount: { gt: 0 } }, data: { redemptionCount: { decrement: 1 } } })
      expect(cas?.tx).toBeGreaterThan(0)
      expect(liberada?.tx).toBe(cas?.tx)
      expect(bajada?.tx).toBe(cas?.tx)
      nadaEnStripe()
    })

    it('R1.2 🔴 el CAS no tocó la fila (el cliente volvió y tomó el lease) ⇒ NO libera nada', async () => {
      prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(prismaMock.launchCampaignRedemption.updateMany).not.toHaveBeenCalled()
      expect(bajadas()).toEqual([])
    })

    it('R1.3 un lease VENCIDO (no nulo) entra al CAS tal como se leyó', async () => {
      elAlta({ planActivationLeaseUntil: VENCIDO })

      await cerrarAltaSinNavegador('org-1')

      expect(progresos()[0].where.planActivationLeaseUntil).toEqual(VENCIDO)
    })

    it('R1.4 sin lugar en la metadata (pago de hoy sin campaña) ⇒ DECLINED sin tocar ningún lugar', async () => {
      const { launchRedemptionId, launchCampaignId, ...sinLugar } = METADATA
      enStripe(laSub({ status: 'incomplete_expired', metadata: sinLugar }))

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('LIBERADA')

      expect(conEstado('DECLINED')).toHaveLength(1)
      expect(prismaMock.launchCampaignRedemption.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('lo que el revisor no toca', () => {
    it.each([
      ['el cobro sigue esperando al banco (incomplete)', () => enStripe(laSub({ status: 'incomplete' }))],
      ['la suscripción quedó cancelada (ambiguo)', () => enStripe(laSub({ status: 'canceled' }))],
    ])('N.1 %s ⇒ NADA, sin escribir', async (_caso, preparar) => {
      preparar()

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      nadaEnStripe()
    })

    it.each([
      ['el lease está VIVO (alguien está cobrando)', { planActivationLeaseUntil: new Date(Date.now() + LEASE_MS) }],
      ['el alta ya terminó', { completedAt: new Date() }],
      ['el alta no está a medio pago', { planActivationStatus: 'ACTIVE' }],
      ['el alta no tiene suscripción', { planStripeSubscriptionId: null }],
    ])('N.2 %s ⇒ NADA, sin preguntarle a Stripe', async (_caso, o) => {
      elAlta(o)

      await expect(cerrarAltaSinNavegador('org-1')).resolves.toBe('NADA')

      expect(mockSubRetrieve).not.toHaveBeenCalled()
      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    })
  })
})

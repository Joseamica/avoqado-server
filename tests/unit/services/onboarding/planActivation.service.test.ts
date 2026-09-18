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

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn() },
  })),
)

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
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

import { activatePlan, liberarLugar } from '@/services/onboarding/planActivation.service'
import { prismaMock } from '@tests/__helpers__/setup'

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

/** Un `$transaction(cb)` que le pasa el mismo mock como `tx`, igual que el setup global. */
function prepararTransaccion() {
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
}

beforeEach(() => {
  jest.clearAllMocks()
  prepararTransaccion()
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_x', unit_amount: LISTA, currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive' }] })
  mockPmRetrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockResolvedValue({ id: 'sub_1' })
  mockSubRetrieve.mockResolvedValue({
    id: 'sub_1',
    current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
    latest_invoice: { amount_paid: ANUNCIADO },
    discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
  })
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue-1', name: 'Bar', slug: 'bar-test', email: 'b@x.com', organization: { email: 'o@x.com', name: 'Org' } } as never)
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
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue-1', name: 'Bar', slug: 'bar-test', email: 'b@x.com', stripeCustomerId: 'cus_1', organization: { email: 'o@x.com', name: 'Org' } } as never)
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
    expect(opciones).toEqual({ idempotencyKey: 'plan-activation:org-1:1' })
    expect(r).toMatchObject({ status: 'ACTIVE', alreadyActive: false, firstChargeCents: ANUNCIADO })
    expect(r.launchOffer).toMatchObject({ code: 'POS22', months: 3, renewalMonthlyCents: ANUNCIADO })
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

  it('🔴 `plan` se guarda en la RAÍZ de v2SetupData (es lo que parseV2Plan busca primero)', async () => {
    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })
    const escritura = prismaMock.onboardingProgress.updateMany.mock.calls.find((c: any[]) => c[0]?.data?.planActivationStatus === 'ACTIVE')
    expect((escritura?.[0].data.v2SetupData as Record<string, unknown>).plan).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: true })
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
    await expect(
      activatePlan({ ...BASE, offer: { ...OFERTA_LAUNCH, expectedFirstChargeCents: 100 } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'OFFER_CHANGED' })
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
      progreso({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_trial', v2SetupData: { plan: { tier: 'PRO', interval: 'monthly', payNow: false } } }) as never,
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
      progreso({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1', v2SetupData: { plan: { tier: 'PRO', interval: 'monthly' } } }) as never,
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
      progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: new Date(Date.now() + 60_000) }) as never,
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
      progreso({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planActivationLeaseUntil: new Date(Date.now() - 60_000) }) as never,
    )
    prismaMock.launchCampaign.findUnique.mockResolvedValue(campania() as never)
    prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue({ id: 'red-1', status: 'RESERVED', campaignId: 'lc-1', offerVersion: 1 } as never)
  })

  it('🔴 la encuentra en la SEGUNDA página y NO crea una segunda suscripción', async () => {
    // Con `limit: 20` y una sola página, la suscripción buena en la página 2 se leía como
    // «no se creó»: llave nueva y SEGUNDO cobro.
    const pagina1 = Array.from({ length: 100 }, (_, i) => ({ id: `sub_otra_${i}`, metadata: {} }))
    const buena = { id: 'sub_buena', metadata: { planActivationKey: 'plan-activation:org-1:1' } }
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
      current_period_end: Math.floor(new Date('2026-10-17T00:00:00Z').getTime() / 1000),
      latest_invoice: { amount_paid: ANUNCIADO },
      discounts: [{ coupon: { id: 'LC_POS22_V1' } }],
    })

    const r = await activatePlan({ ...BASE, offer: OFERTA_LAUNCH })

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'ACTIVE', alreadyActive: false })
    // 🔴 Y se pide la página COMPLETA (100, el tope de Stripe) y TODOS los estados: con una
    // página chica la suscripción buena se va a la siguiente y el recorrido concluye «no
    // existe» — que es exactamente lo que cobra dos veces. La cota por `created` deja el
    // recorrido en O(1) páginas en el caso normal.
    expect(mockSubList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', status: 'all', limit: 100, created: expect.objectContaining({ gte: expect.any(Number) }) }),
    )
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
    expect(mockSubCreate.mock.calls[0][1]).toEqual({ idempotencyKey: 'plan-activation:org-1:2' })
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

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

/** Un `$transaction(cb)` que le pasa el mismo mock como `tx`, igual que el setup global. */
function prepararTransaccion() {
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
}

beforeEach(() => {
  jest.clearAllMocks()
  prepararTransaccion()
  mockPriceList.mockResolvedValue({
    data: [{ id: 'price_x', unit_amount: LISTA, currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive' }],
  })
  mockPmRetrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockResolvedValue({ id: 'sub_1' })
  mockSubRetrieve.mockResolvedValue({
    id: 'sub_1',
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
    expect((escritura?.[0].data.v2SetupData as Record<string, unknown>).plan).toMatchObject({
      tier: 'PRO',
      interval: 'monthly',
      payNow: true,
    })
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
    mockSubRetrieve.mockResolvedValue({ ...recuperada, discounts: [] })

    await expect(activatePlan({ ...BASE, offer: OFERTA_LAUNCH })).rejects.toMatchObject({
      code: 'PLAN_ACTIVE_WITHOUT_OFFER',
    })
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

  it('🔴 al recuperar la suscripción, el acceso (`VenueFeature`) queda escrito', async () => {
    intentoPerdidoConSuscripcionViva()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(() => undefined)

    expect(prismaMock.venueFeature.upsert).toHaveBeenCalled()
  })

  it('🔴 y queda ligado a la suscripción RECUPERADA, no a una inventada', async () => {
    intentoPerdidoConSuscripcionViva()

    await activatePlan({ ...BASE, offer: OFERTA_LAUNCH } as never).catch(() => undefined)

    const llamada = (prismaMock.venueFeature.upsert as jest.Mock).mock.calls[0]?.[0]
    expect(llamada?.create?.stripeSubscriptionId ?? llamada?.update?.stripeSubscriptionId).toBe('sub_recuperada')
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

    await activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 }, payNow: false })

    // El acceso se resuelve contra lo cobrado (PLAN_PREMIUM), no contra lo pedido (PLAN_PRO).
    const codigosConsultados = prismaMock.feature.findFirst.mock.calls.map(
      (c: unknown[]) => (c[0] as { where?: { code?: string } })?.where?.code,
    )
    expect(codigosConsultados).toContain('PLAN_PREMIUM')
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

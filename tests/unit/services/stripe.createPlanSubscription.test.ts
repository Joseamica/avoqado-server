const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockPriceList = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve },
    prices: { list: mockPriceList },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
    feature: {
      findFirst: jest.fn().mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', stripePriceId: 'price_monthly', monthlyPrice: 999 }),
    },
  },
}))

import { createPlanSubscription } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockPriceList.mockResolvedValue({ data: [{ id: 'price_monthly' }] })
  mockSubCreate.mockResolvedValue({ id: 'sub_1', status: 'trialing' })
})

describe('createPlanSubscription', () => {
  it('trial path: 30-day trial, no coupon, no Stripe Tax (IVA baked into the price)', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(30)
    expect(arg.discounts).toBeUndefined()
    // Stripe Tax is intentionally NOT used: the IVA is baked into the price (tax_behavior
    // 'inclusive'), so automatic_tax must be absent — enabling it would 400 in prod where
    // Stripe Tax isn't configured.
    expect(arg.automatic_tax).toBeUndefined()
  })

  it('pay-now monthly: no trial + INTRO_PRO_3M coupon', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      coupon: 'INTRO_PRO_3M',
    })
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.trial_period_days).toBe(0)
    expect(arg.discounts).toEqual([{ coupon: 'INTRO_PRO_3M' }])
  })

  it('annual: uses the annual price lookup_key, no coupon', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_annual' }] })
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'annual',
      trialPeriodDays: 0,
    })
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_annual'] }), expect.anything())
    const arg = mockSubCreate.mock.calls[0][0]
    expect(arg.items[0].price).toBe('price_annual')
  })
})

/**
 * 🔴 V5-A paso 6 (v5 punto 6): `createPlanSubscription` sólo COBRA. El acceso lo escribe la entrega
 * (`entregarSuscripcionDePlan`), que ve las dos filas de plan bajo el candado del negocio; el `upsert` ciego que
 * había aquí concedía aunque otra obligación viva ocupara el plan, y sin mirar el estado de la suscripción.
 */
describe('cobra, pero NO escribe el acceso', () => {
  it('🔴 no toca VenueFeature: la fila la decide la entrega', async () => {
    const prismaMod = (await import('@/utils/prismaClient')).default as unknown as { venueFeature: { upsert: jest.Mock } }

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
    })

    expect(mockSubCreate).toHaveBeenCalled()
    expect(prismaMod.venueFeature.upsert).not.toHaveBeenCalled()
  })
})

describe('reusar sólo lo que todavía puede cobrar', () => {
  const conFilaLigada = async () => {
    const prismaMod = (await import('@/utils/prismaClient')).default as unknown as { venueFeature: { findUnique: jest.Mock } }
    prismaMod.venueFeature.findUnique.mockResolvedValueOnce({ stripeSubscriptionId: 'sub_viejo' })
  }
  const pedir = () =>
    createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
    })

  it('una suscripción ligada que sigue viva se REUSA (un reintento del mismo cobro no cobra otra vez)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockResolvedValue({ id: 'sub_viejo', status: 'active' })

    await expect(pedir()).resolves.toEqual({ subscriptionId: 'sub_viejo', reused: true })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 una ligada que Stripe ya dio por TERMINADA no se reusa: se cobra de nuevo (antes se cerraba el alta con una suscripción muerta)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockResolvedValue({ id: 'sub_viejo', status: 'canceled' })

    await expect(pedir()).resolves.toEqual({ subscriptionId: 'sub_1', reused: false })
  })

  it('🔴 si no se puede saber si sigue viva, no se decide a ciegas: se lanza (el llamador lo trata como desconocido)', async () => {
    await conFilaLigada()
    mockSubRetrieve.mockRejectedValue(new Error('socket hang up'))

    await expect(pedir()).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_UNVERIFIED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 EL GANCHO DEL CARGO (Codex, 21-sep).
 *
 * Entre crear la suscripción en Stripe —el momento en que el dinero se mueve— y que esta función
 * devuelva su id, todavía corre `asegurarAccesoDelPlan`. Si ESA escritura falla, el llamador nunca
 * ve el id y pierde el rastro del cobro que ya ocurrió; su reintento tiene entonces que BUSCAR la
 * suscripción, y ahí es donde nacía el segundo cargo. Por eso el gancho corre ANTES.
 */
describe('alCrearEnStripe: el rastro del cargo, antes que cualquier otra escritura', () => {
  it('🔴 se invoca con el id en cuanto la suscripción existe (el rastro del cargo, antes de devolver)', async () => {
    const orden: string[] = []

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
      alCrearEnStripe: async (id: string) => {
        orden.push(`gancho:${id}`)
      },
    })

    expect(orden).toEqual(['gancho:sub_1'])
  })

  it('🔴 si el gancho falla, NO se tumba el cobro que ya ocurrió', async () => {
    const r = await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 30,
      alCrearEnStripe: async () => {
        throw new Error('la base se cayó')
      },
    })

    expect(r.subscriptionId).toBeTruthy()
  })
})

describe('antesDeCobrar: la frontera entre «preparar» y «pudo cobrarse» (Codex C15)', () => {
  it('se invoca justo antes del POST de Stripe', async () => {
    const orden: string[] = []
    mockSubCreate.mockImplementation(async () => {
      orden.push('post')
      return { id: 'sub_1', status: 'active' }
    })

    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      antesDeCobrar: () => orden.push('antes'),
    })

    expect(orden).toEqual(['antes', 'post'])
  })

  it('NO se invoca si falla la preparación (no hay precio): nada pudo cobrarse', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    const antesDeCobrar = jest.fn()

    await expect(
      createPlanSubscription({
        venueId: 'v1',
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        tierCode: 'PLAN_PRO',
        interval: 'monthly',
        trialPeriodDays: 0,
        antesDeCobrar,
      }),
    ).rejects.toThrow()
    expect(antesDeCobrar).not.toHaveBeenCalled()
  })
})

describe('🔴 Codex C3: cobra bajo el candado de la regla', () => {
  it('cada llamada a Stripe sin reintentos del SDK (los decide `retry`, con la llave)', async () => {
    await createPlanSubscription({
      venueId: 'v1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      tierCode: 'PLAN_PRO',
      interval: 'monthly',
      trialPeriodDays: 0,
      idempotencyKey: 'k1',
    })

    expect(mockPriceList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }),
    )
    expect(mockSubCreate.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'k1', maxNetworkRetries: 0, timeout: expect.any(Number) })
  })
})

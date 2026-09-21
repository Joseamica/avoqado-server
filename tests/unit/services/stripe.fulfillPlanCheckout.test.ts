/**
 * PLAN_PRO Checkout Fulfillment Tests
 *
 * Regression for the fulfillment gap: `createPlanCheckoutSession` hands Stripe the
 * subscription to create, but on `checkout.session.completed` NOTHING created the local
 * VenueFeature PLAN_PRO row (handleSubscriptionUpdated returns early when no VenueFeature
 * maps to the new subscription). `fulfillPlanCheckout` closes that gap by upserting the
 * PLAN_PRO VenueFeature, mirroring `createPlanSubscription`'s upsert shape.
 *
 * Mock shape mirrors stripe.createPlanSubscription.test.ts: Stripe SDK + prisma are mocked.
 */

const mockSubRetrieve = jest.fn()
const mockSessionRetrieve = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { create: jest.fn(), retrieve: mockSubRetrieve },
    prices: { list: jest.fn() },
    checkout: { sessions: { retrieve: mockSessionRetrieve } },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    feature: {
      findFirst: jest.fn(),
    },
  },
}))

import { fulfillPlanCheckout } from '../../../src/services/stripe.service'
import prisma from '../../../src/utils/prismaClient'

// Resolve the feature row by the code the service queries (tier-aware).
const FECHA_LEIDA = new Date('2026-09-19T10:00:00.000Z')

const featureByCode = ({ where }: any) => {
  if (where?.code === 'PLAN_PREMIUM') return Promise.resolve({ id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 })
  return Promise.resolve({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 })
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  ;(prisma.feature.findFirst as jest.Mock).mockImplementation(featureByCode)
  ;(prisma.venueFeature.upsert as jest.Mock).mockResolvedValue({})
  ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prisma.venueFeature.create as jest.Mock).mockResolvedValue({})
})

const makeSession = (overrides: any = {}) =>
  ({
    id: 'cs_test_123',
    object: 'checkout.session',
    mode: 'subscription',
    subscription: 'sub_pro_new',
    metadata: { tierCode: 'PLAN_PRO', venueId: 'v1', interval: 'monthly' },
    ...overrides,
  }) as any

describe('fulfillPlanCheckout', () => {
  it('upserts an active PLAN_PRO VenueFeature with the right subscription + price (paid, no trial)', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession())

    // Retrieved the subscription Stripe created to read price/interval/trial state.
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_pro_new')

    // Sin registro previo: se CREA (la escritura dejó de ser un upsert ciego — ver el describe
    // del detalle 1: ahora es create, o updateMany con CAS cuando el registro ya existe).
    expect(prisma.venueFeature.create).toHaveBeenCalledTimes(1)
    expect((prisma.venueFeature.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      active: true,
      monthlyPrice: 999,
      stripeSubscriptionId: 'sub_pro_new',
      stripePriceId: 'price_monthly',
      endDate: null,
      trialEndDate: null,
      suspendedAt: null,
      paymentFailureCount: 0,
    })

    expect(result).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-pro',
      featureCode: 'PLAN_PRO',
      subscriptionId: 'sub_pro_new',
      endDate: null,
    })
  })

  it('sets endDate/trialEndDate when the subscription is trialing', async () => {
    const trialEndUnix = Math.floor(Date.now() / 1000) + 30 * 86400
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'trialing',
      trial_end: trialEndUnix,
      items: { data: [{ price: { id: 'price_annual' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO', venueId: 'v1', interval: 'annual' } }))

    const arg = { data: (prisma.venueFeature.create as jest.Mock).mock.calls[0][0].data }
    expect(arg.data.endDate).toEqual(new Date(trialEndUnix * 1000))
    expect(arg.data.trialEndDate).toEqual(new Date(trialEndUnix * 1000))
    expect(arg.data.stripePriceId).toBe('price_annual')
    expect(result?.endDate).toEqual(new Date(trialEndUnix * 1000))
  })

  it('upserts a PLAN_PREMIUM VenueFeature when the session metadata.tierCode is PLAN_PREMIUM', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_premium_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_premium_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(
      makeSession({ subscription: 'sub_premium_new', metadata: { tierCode: 'PLAN_PREMIUM', venueId: 'v1', interval: 'monthly' } }),
    )

    // Looked up the PLAN_PREMIUM feature, not PLAN_PRO.
    expect(prisma.feature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PREMIUM', active: true } }))

    const arg = { data: (prisma.venueFeature.create as jest.Mock).mock.calls[0][0].data }
    expect(arg.data).toMatchObject({ venueId: 'v1', featureId: 'feat-premium' })
    expect(arg.data).toMatchObject({
      active: true,
      stripeSubscriptionId: 'sub_premium_new',
      stripePriceId: 'price_premium_monthly',
      monthlyPrice: 1999,
      endDate: null,
      trialEndDate: null,
      suspendedAt: null,
      paymentFailureCount: 0,
    })
    expect(arg.data).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-premium',
      active: true,
      monthlyPrice: 1999,
      stripeSubscriptionId: 'sub_premium_new',
      stripePriceId: 'price_premium_monthly',
    })

    expect(result).toMatchObject({
      venueId: 'v1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId: 'sub_premium_new',
      endDate: null,
    })
  })

  it('defaults to PLAN_PRO when metadata.tierCode is absent (back-compat)', async () => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ metadata: { venueId: 'v1', interval: 'monthly' } }))

    expect(prisma.feature.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'PLAN_PRO', active: true } }))
    expect(result?.featureCode).toBe('PLAN_PRO')
  })

  it('falls back to expanding the session when subscription id is not inlined', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: 'sub_from_expand' })
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_from_expand',
      status: 'active',
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession({ subscription: null }))

    expect(mockSessionRetrieve).toHaveBeenCalledWith('cs_test_123', { expand: ['subscription'] })
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_from_expand')
    expect(result?.subscriptionId).toBe('sub_from_expand')
  })

  it('returns null and does not upsert when there is no subscription id at all', async () => {
    mockSessionRetrieve.mockResolvedValue({ id: 'cs_test_123', subscription: null })

    const result = await fulfillPlanCheckout(makeSession({ subscription: null }))

    expect(result).toBeNull()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
    expect(prisma.venueFeature.create).not.toHaveBeenCalled()
  })

  it('returns null when metadata.venueId is missing', async () => {
    const result = await fulfillPlanCheckout(makeSession({ metadata: { tierCode: 'PLAN_PRO' } }))

    expect(result).toBeNull()
    expect(mockSubRetrieve).not.toHaveBeenCalled()
    expect(prisma.venueFeature.upsert).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 AUDITORÍAS 11ª Y DE CIERRE (Codex gpt-6-astra xhigh, 19-sep).
 *
 * 11ª: `fulfillPlanCheckout` consultaba la suscripción y usaba la respuesta SÓLO para el
 * `trial_end`. El `status` estaba en la mano y se ignoraba, así que un `checkout.session.completed`
 * reprocesado o atrasado sobre una suscripción CANCELADA devolvía el plan completo.
 *
 * Cierre: el primer arreglo (negar y `return null`) dejaba al cliente SIN RESCATE, porque los dos
 * eventos que podrían salvarlo buscan el registro por `stripeSubscriptionId`. El segundo intento
 * —guardar el vínculo inactivo— abrió TRES defectos nuevos de concurrencia (sustituir el vínculo de
 * otra suscripción recuperable, una lectura-escritura no atómica sobre el plan vivo, y el rescate
 * adelantándose a la escritura).
 *
 * 🔑 La salida no era un cuarto parche: era **usar el mecanismo que el repo ya tiene endurecido**
 * para «no puedo decidir ahora» — lanzar, que deja el evento `FAILED` y lo reprocesa el cron
 * `stripe-webhook-reconciliation` (5 reintentos, ventana de 7 días). Sin inventar vínculos, sin
 * escrituras que compitan, y con menos código que cualquiera de los parches.
 */
describe('🔴 el checkout NO concede acceso sobre una suscripción que no está vigente', () => {
  // Terminales: no hay nada que esperar, así que no se reintenta.
  it.each(['canceled', 'incomplete_expired'])('con `%s` (terminal) no escribe nada y devuelve null', async estado => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: estado,
      trial_end: null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession())

    expect(result).toBeNull()
    expect(prisma.venueFeature.upsert).not.toHaveBeenCalled()
  })

  // Recuperables: el cobro todavía puede prosperar ⇒ se guarda el VÍNCULO (para que el rescate lo
  // encuentre) sin conceder acceso, y SIN lanzar (lanzar gastaba los 5 reintentos del cron).
  it.each(['past_due', 'unpaid', 'incomplete', 'paused'])(
    'con `%s` (recuperable) guarda el vínculo, no concede acceso y NO lanza',
    async estado => {
      ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
        id: 'vf1',
        active: false,
        stripeSubscriptionId: null,
      })
      mockSubRetrieve.mockResolvedValue({
        id: 'sub_pro_new',
        status: estado,
        trial_end: null,
        items: { data: [{ price: { id: 'price_monthly' } }] },
      })

      const result = await fulfillPlanCheckout(makeSession())

      expect(result).toBeNull()
      const data = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0].data
      expect(data.stripeSubscriptionId).toBe('sub_pro_new')
      expect(data).not.toHaveProperty('active')
    },
  )

  it.each(['active', 'trialing'])('con `%s` sí activa (el camino normal no se rompe)', async estado => {
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_pro_new',
      status: estado,
      trial_end: estado === 'trialing' ? 1790000000 : null,
      items: { data: [{ price: { id: 'price_monthly' } }] },
    })

    const result = await fulfillPlanCheckout(makeSession())

    expect(prisma.venueFeature.create).toHaveBeenCalledTimes(1)
    expect((prisma.venueFeature.create as jest.Mock).mock.calls[0][0].data.active).toBe(true)
    expect(result).not.toBeNull()
  })
})

/**
 * 🔴 LOS TRES DETALLES QUE PIDIÓ EL FOUNDER (19-sep), tras la 14ª pasada de Codex.
 *
 * (1) LA CARRERA: `retrieve` decía `active`, y entre esa consulta y la escritura llegaba una
 *     cancelación que desactivaba el registro — el `upsert` ciego lo volvía a poner `active:true`.
 *     Quedaba acceso vivo para una suscripción cancelada. Era PREEXISTENTE.
 *     Arreglo: la escritura es CAS sobre los dos campos que gobiernan la decisión (`active` y el
 *     vínculo). Si alguien los cambió mientras consultábamos Stripe, no escribimos y se reintenta.
 *
 * (2) LOS REINTENTOS: lanzar en los estados recuperables gastaba los 5 intentos del cron en
 *     ~15-20 min, y quien pagaba dos horas después se quedaba sin plan. Con el CAS ya es seguro
 *     guardar el VÍNCULO inactivo, que es lo que permite al rescate encontrarlo sin límite de
 *     tiempo — así que ya no se lanza ni se gastan reintentos.
 */
describe('🔴 detalle 1: la escritura no puede pisar lo que cambió mientras consultábamos Stripe', () => {
  const subActiva = () => ({
    id: 'sub_pro_new',
    status: 'active',
    trial_end: null,
    items: { data: [{ price: { id: 'price_monthly' } }] },
  })

  it('🔴 lee el registro ANTES de consultar Stripe (si no, el CAS vigila la ventana equivocada)', async () => {
    // Codex lo midió: con `retrieve` primero, una cancelación que llega en medio se escribe ANTES
    // de nuestra lectura local — la leemos ya desactivada, el CAS coincide y la reactivamos.
    // Leyendo primero, cualquier escritura ajena posterior hace fallar el CAS, y el dato de Stripe
    // es por construcción más nuevo que lo que comparamos.
    const orden: string[] = []
    ;(prisma.venueFeature.findUnique as jest.Mock).mockImplementation(async () => {
      orden.push('findUnique')
      return { id: 'vf1', active: false, stripeSubscriptionId: null }
    })
    mockSubRetrieve.mockImplementation(async () => {
      orden.push('retrieve')
      return subActiva()
    })

    await fulfillPlanCheckout(makeSession())

    expect(orden).toEqual(['findUnique', 'retrieve'])
  })

  it('escribe con CAS sobre `active` y el vínculo que leyó (no un upsert ciego)', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: false,
      stripeSubscriptionId: null,
      updatedAt: FECHA_LEIDA,
    })
    mockSubRetrieve.mockResolvedValue(subActiva())

    await fulfillPlanCheckout(makeSession())

    expect(prisma.venueFeature.updateMany).toHaveBeenCalledTimes(1)
    const { where, data } = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0]
    expect(where).toMatchObject({ id: 'vf1', updatedAt: FECHA_LEIDA })
    expect(data.active).toBe(true)
    expect(prisma.venueFeature.upsert).not.toHaveBeenCalled()
  })

  it('🔴 si una cancelación tocó el registro mientras consultábamos, NO concede y se reintenta', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: true,
      stripeSubscriptionId: 'sub_pro_new',
    })
    mockSubRetrieve.mockResolvedValue(subActiva())
    // El CAS no encuentra la fila como la leyó: alguien la cambió en medio.
    ;(prisma.venueFeature.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(fulfillPlanCheckout(makeSession())).rejects.toThrow(/cambió|reintent/i)
  })

  it('cuando el registro no existe lo CREA, y si otro se adelanta (P2002) se reintenta', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue(null)
    mockSubRetrieve.mockResolvedValue(subActiva())
    ;(prisma.venueFeature.create as jest.Mock).mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))

    await expect(fulfillPlanCheckout(makeSession())).rejects.toThrow(/reintent/i)
  })
})

describe('🔴 detalle 2: un estado recuperable NO gasta los reintentos del cron', () => {
  const subPastDue = () => ({
    id: 'sub_pro_new',
    status: 'past_due',
    trial_end: null,
    items: { data: [{ price: { id: 'price_monthly' } }] },
  })

  it('guarda el VÍNCULO sin conceder acceso y NO lanza', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: false,
      stripeSubscriptionId: null,
      updatedAt: FECHA_LEIDA,
    })
    mockSubRetrieve.mockResolvedValue(subPastDue())

    const result = await fulfillPlanCheckout(makeSession())

    expect(result).toBeNull()
    const { where, data } = (prisma.venueFeature.updateMany as jest.Mock).mock.calls[0][0]
    expect(where).toMatchObject({ id: 'vf1', updatedAt: FECHA_LEIDA })
    expect(data.stripeSubscriptionId).toBe('sub_pro_new')
    expect(data).not.toHaveProperty('active')
    expect(data).not.toHaveProperty('suspendedAt')
  })

  it('🔴 NO toca un plan que ya está ACTIVO (le quitaría el acceso a quien paga)', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: true,
      stripeSubscriptionId: 'sub_A',
    })
    mockSubRetrieve.mockResolvedValue(subPastDue())

    const result = await fulfillPlanCheckout(makeSession())

    expect(result).toBeNull()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
    expect(prisma.venueFeature.create).not.toHaveBeenCalled()
  })

  it('🔴 NO toca un plan ACTIVO ni siquiera con el MISMO vínculo (aísla esa guarda de la del vínculo)', async () => {
    // Sin este caso, desactivar la guarda del plan activo no rompía ninguna prueba: la guarda del
    // vínculo distinto la tapaba. Aquí el vínculo COINCIDE, así que sólo la primera puede parar
    // el flujo — y si no para, se intenta escribir sobre el registro de quien está pagando.
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: true,
      stripeSubscriptionId: 'sub_pro_new',
    })
    mockSubRetrieve.mockResolvedValue(subPastDue())

    const result = await fulfillPlanCheckout(makeSession())

    expect(result).toBeNull()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
    expect(prisma.venueFeature.create).not.toHaveBeenCalled()
  })

  it('🔴 NO sustituye el vínculo de OTRA suscripción recuperable (perdería su rescate)', async () => {
    ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({
      id: 'vf1',
      active: false,
      stripeSubscriptionId: 'sub_A',
    })
    mockSubRetrieve.mockResolvedValue(subPastDue())

    const result = await fulfillPlanCheckout(makeSession())

    expect(result).toBeNull()
    expect(prisma.venueFeature.updateMany).not.toHaveBeenCalled()
  })
})
